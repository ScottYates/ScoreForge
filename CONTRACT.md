# Build contract — internal interfaces

Everything here is bundled into ONE self-contained HTML file. No network at runtime,
no external assets, no `type="module"` on external scripts (inline modules are fine),
runs from `file://`.

## Module map

| File | Purpose |
|---|---|
| `src/js/score/model.js` | Score model, `Timing`, `resolveScore`, pitch/key math |
| `src/js/io/musicxml.js` | MusicXML → internal score |
| `src/js/io/smf.js` | Standard MIDI File → internal score |
| `src/js/io/mscx.js` | MuseScore `.mscx` / `.mscz` → internal score |
| `src/js/io/files.js` | File intake, zip, type sniffing |
| `src/js/io/omr.js` | Recognition backend client (health, upload, MusicXML → scores) |
| `src/js/audio/instruments.js` | Synthesised instrument voices |
| `src/js/audio/fx.js` | Reverb / EQ / compressor bus |
| `src/js/audio/engine.js` | Realtime player + offline renderer |
| `src/js/audio/mp3.js` | OfflineAudioContext → MP3 bytes |
| `src/js/render/notation.js` | OSMD wrapper + cursor |
| `src/js/render/roll.js` | Piano roll canvas |
| `src/js/ui/*` | UI |
| `tools/build.mjs` | esbuild bundle → single HTML |
| `backend/app.py` | FastAPI: `/api/omr`, `/api/health`, `/api/accuracy` |
| `backend/omr_engine.py` | homr wrapper — CPU-only config, variant ranking |
| `backend/preprocess.py` | decode / PDF raster / deskew / contrast / resize |
| `tools/score_omr.py` | Ground-truth accuracy suite for the recogniser |

---

## 1. Score model (`src/js/score/model.js`) — READ IT

Use `createScore`, `createPart`/`makePart`, `makeNote`, `Timing`, `resolveScore`,
`midiToName`, `keyNameFromFifths`, `keyFifthsFromName`, `availableKeys`.

Key invariants:
- Time unit is the **quarter note** (float). Never store MIDI ticks.
- `part.notes[]` is sorted ascending by `quarter`.
- A note's `durationQuarters` is post-tuplet, post-tie-merge, in quarter units.
- `score.tempoMap: [{quarter, bpm}]` ascending; first entry must be `{quarter: 0, ...}`.
- `score.totalQuarters` = length of the piece in quarter notes.
- `score.rawMusicXml` = the original XML string, kept for the OSMD notation view.

---

## 2. Instrument contract (`src/js/audio/instruments.js`)

```js
export const INSTRUMENTS = [
  { id, name, group, description, defaults:{...} },
  ...
];

export function createInstrument(id, ctx, outputNode) -> Instrument
```

`ctx` is an `AudioContext` **or** `OfflineAudioContext`. The instrument must therefore:
- create every node from `ctx` (never `new AudioContext()`),
- schedule with absolute `ctx.currentTime`-domain timestamps only,
- never use `setTimeout`, `Date.now()`, `requestAnimationFrame` or any promise for timing.

### `Instrument`

```js
{
  id: string,
  /** Start a sounding note. Returns a handle the caller may ignore. */
  noteOn({ midi, velocity, when, duration, channel, legato, tiedFromPrevious }) -> handle,

  /** Release a note early (damper / key lift). Default: optional. */
  noteOff(handle, when),

  /** Sustain pedal: while down, released notes keep ringing (piano, harp, organ). */
  setSustain(down, when),

  /** Release everything currently sounding. Used on stop/seek/export. */
  allNotesOff(when),

  /** Live parameter change, e.g. { brightness: 0..1 } or { detune: cents }. */
  setParam(name, value, when),

  /** Free resources. */
  dispose(when),
}
```

Parameters:
- `midi`: 0–127, the **sounding** pitch after all transposition. 60 = middle C.
- `velocity`: 0–1, where ~0.5 is mezzo-forte, 1.0 is fortissimo.
- `when`: absolute time in `ctx.currentTime` seconds.
- `duration`: sounding length in seconds, *before* release tail. Voices add their own
  natural decay/release on top; do not cut the sound at `when + duration`.

### Hard performance rules
- A 6-minute piece at 160 bpm can be ~4,000 notes. Pool and recycle voices; cap the
  polyphony of percussive voices (bell/pluck) to a sensible maximum (e.g. 12–16) and
  steal the oldest.
- Target < 40 audio nodes per sounding voice, and < 300 nodes total for a piano chord
  of 4 notes. Prefer `OscillatorNode` + `GainNode` + shared filter chains over
  per-note `ConvolverNode`/`DelayNode`.
- Generate noise buffers **once per instrument instance** (lazily, via a shared cache
  keyed on `ctx`), not per note.

### Required behaviours
- Must be phase-coherent enough that repeated renders are deterministic.
- Must render identically offline and online.
- Should have a short fade-in (< 2 ms) to avoid clicks, and a proper release tail
  (never an abrupt `gain.value = 0`).

### Required roster (ids are load-bearing; the UI renders this list)
Groups: `Pianos`, `Bells & Mallet`, `Plucked`, `Bowed & Sustained`, `Brass & Wind`, `Synth`.

```
Pianos          grand          Concert Grand      (flagship — must be excellent)
                 bright-piano   Bright Piano
                 felt-piano     Felt Piano
                 rhodes         Rhodes Electric Piano
Bells & Mallet   celesta        Celesta
                 glockenspiel   Glockenspiel
                 music-box      Music Box
                 marimba        Marimba
                 vibraphone     Vibraphone
                 timpani        Timpani
Plucked          harpsichord    Harpsichord
                 harp           Concert Harp
                 nylon-guitar   Nylon-String Guitar
                 electric-bass  Electric Bass
Bowed/Sustained  strings        String Ensemble
                 choir          Choir (aah)
                 warm-pad       Warm Analog Pad
                 pipe-organ     Pipe Organ
Brass & Wind     flute          Flute
                 clarinet       Clarinet
                 alto-sax       Alto Sax
Synth            analog-lead    Analog Lead
```

Grand piano requirements specifically: additive partials with real **inharmonicity**
(`f_n = n·f0·sqrt(1+B·n²)`, B growing for the bass), per-partial decay (high partials die
first), 2–3 detuned unison strings, a filtered-noise hammer transient scaled by velocity,
pitch-dependent brightness, and a damper release. It should not sound like a sine bank.

---

## 3. Parser contract

```js
// src/js/io/musicxml.js
export function parseMusicXml(xmlString, opts) -> Score   // may throw with a clear message

// src/js/io/smf.js
export function parseMidi(arrayBuffer, opts) -> Score
```

Both must:
- return a score built from `src/js/score/model.js`,
- push human-readable strings into `score.warnings` rather than throwing for
  recoverable problems, and only throw for genuinely unusable input,
- be defensive: unknown elements, missing `<divisions>`, absent `<voice>`, grace notes,
  `<cue>` notes, backup/forward chains, multi-staff parts, and `<sound tempo="…">`
  directions must not crash the parse,
- never depend on the DOM being in a particular state beyond `DOMParser`
  (MusicXML only) and `DataView` (MIDI only).

---

## 4. Recognition backend contract (`backend/`)

The page stays self-contained for MusicXML, MuseScore and MIDI. Images and PDFs
are the only formats that leave the browser, and only to a service on this
machine. The page must work identically when that service is absent.

```python
# backend/app.py
GET  /api/health    -> {ok, engine, version, device:"cpu", gpu:false, error}
POST /api/omr       -> multipart file + mode + pages + pdf_dpi + debug
GET  /api/accuracy  -> {available, summary:{f1, fixtures, secondsPerPage}, modes}
GET  /api/preview/{key} -> PNG of the page the recogniser was shown
```

Rules the backend must not break:
- **CPU only.** `transformer_use_gpu`, `segnet_use_gpu` and `coreml_encoder` are
  all `False`. No CUDA, no GPU execution provider, ever.
- **It returns MusicXML.** That is what lets a scan reuse the existing parser,
  notation view, playback and MP3 export with no second code path.
- **Every response must say what it did.** Per page: note count, staves,
  measures, time signature, tempo, seconds, and which preprocessing variant won.
  A transcription you cannot check is worse than an error.
- **Never silently return a partial result.** A page that could not be read is an
  error for that page, not an empty score.
- **Preview honesty.** The preview is for display only and may be cropped to the
  music; recognition always runs on the untrimmed image, and the UI says so.

Rules for the fixtures (`tools/score_omr.py`, `tools/score-render.html`):
- A ground truth must be an **independent record of what was drawn**, checked
  against the rendered page. Copying the fixture source is how the two-staff
  fixture came to claim four bars of music in which only two were printed — and
  the OCR was blamed for the fixture's bug.
- A grand staff interleaves both hands. Compare **per staff**; a flat comparison
  calls correct music wrong on ordering alone.
- A check that has never been seen to fail is not a check. Break the fixture on
  purpose and confirm the scorer refuses it.

---

## 5. Global conventions
- Plain ES modules, no TypeScript, no JSX, no runtime deps beyond what the bundle inlines.
- Every file must parse as a standalone ES module under `esbuild --bundle`.
- Do not add `console.log` except inside an explicit `DEBUG` guard.