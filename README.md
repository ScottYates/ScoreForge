# ScoreForge

Turn sheet music into an MP3, in the browser, in one file.

Drop in a **MusicXML**, **MuseScore** or **MIDI** file, pick a key, a tempo and an
instrument, listen to it play with the notation following along, then export an
MP3 you can play anywhere.

Drop in a **photo or PDF of sheet music** and a local Python service reads the
notes off it with optical music recognition — on the CPU, no graphics card — and
hands back a score you can edit, transpose and export like any other.

The build output is **`ScoreForge.html`** - a single self-contained file. Double-click
it and it works. No server, no install, no network, no accounts. Everything it needs
(notation engine, MP3 encoder, zip reader, 21 synthesised instruments) is inlined.

![ScoreForge with a score loaded](docs/screenshots/app.png)

A photo in, a score out - the panel shows the image the recogniser was given next
to what it read, so the result can be checked rather than trusted:

![Transcription panel](docs/screenshots/transcription.png)

---

## Using it

Open `ScoreForge.html` in Chrome, Edge, Firefox or Safari.

1. **Drop a score on the page** (or click *Choose files*).
2. Choose a **key** and a **tempo** in the inspector.
3. Choose an **instrument** — per part, if the score has more than one.
4. Press **Space** to play. The notation cursor follows the music.
5. Click **Export MP3**, wait for the render, **listen to the result in the page**,
   then download it.

The export dialog renders the audio, plays it back through a blob URL so you can
hear it before committing to a download, and checks the resulting MPEG frames
before calling the file valid:

![Export dialog with preview and validity badge](docs/screenshots/export.png)

### What it accepts

| Format | Extensions | Notes |
|---|---|---|
| MusicXML | `.musicxml` `.xml` `.mxl` | MuseScore, Sibelius, Dorico, Finale, Noteflight. `.mxl` (zipped) is unpacked automatically. |
| MuseScore | `.mscz` `.mscx` | Native project files. No notation view - shown on the piano roll instead. |
| MIDI | `.mid` `.midi` `.kar` `.rmi` | Format 0/1/2, running status, SMPTE division, tempo and key meta events. |
| Scan | `.png` `.jpg` `.jpeg` `.webp` `.gif` `.bmp` `.pdf` | Transcribed into notes by the **local Python service** (see below). Each PDF page becomes its own score. |

Scans need the recognition backend running. Without it the page still works
exactly as before - MusicXML and MIDI parse locally and a scan is kept as
reference material only, with the panel saying so.

Parts without a notation source — MuseScore projects, MIDI — are shown as a
piano roll, which is often easier to check timing against than notation:

![Piano roll view](docs/screenshots/piano-roll.png)

### Keyboard

| Key | Action |
|---|---|
| `Space` | Play / pause |
| `←` `→` | Seek 3 s (`Shift` = 10 s) |
| `Home` | Back to start |
| `E` | Export MP3 |

---

## The instruments

There are no audio samples. Shipping a convincing grand piano as samples costs tens
of megabytes, which would defeat "one file". Instead each instrument is **physically
modelled synthesis** written directly against the Web Audio API.

The **Concert Grand** is the flagship and is built from the physics of a real piano:
inharmonic partials `f_n = n·f₀·√(1+B·n²)` with a stiffness coefficient that rises in
the bass, per-partial decay times so upper partials die before the fundamental,
three detuned unison strings per note for slow beating, a filtered-noise hammer
transient scaled by velocity, pitch- and velocity-dependent brightness, a body
resonance that glues chords into one instrument, and dampers that lift under the
sustain pedal.

The rest follow the same idea: tuned-bar inharmonic ratios for the bells and mallets,
Karplus–Strong-style excitation for the plucked strings, formant-shaped bowed and
vocal sounds with vibrato that ramps in, breath noise for the winds, and drawbar-style
additive synthesis for the organ.

### Why synthesise instead of sample?

- it keeps the whole app in one file that works offline;
- no licensing questions, no multi-megabyte download;
- and every note can be genuinely velocity-responsive, which sampled instruments
  only are if you ship dozens of velocity layers.

---

## Development

```bash
npm install
npm run build      # -> ScoreForge.html (minified)
npm run dev        # -> ScoreForge.html (readable, for debugging)
npm test           # build + headless self-test + screenshot
```

### Layout

```
src/
  index.html            shell + icon sprite (placeholders: {{CSS}} {{VENDOR}} {{APP}})
  styles/app.css        design system
  js/
    main.js             bootstrap, demo score, self-test harness
    score/model.js      score model, Timing, resolveScore, key/pitch math
    io/musicxml.js      MusicXML  -> score
    io/smf.js           Standard MIDI File -> score
    io/mscx.js          MuseScore project -> score
    io/files.js         file intake, zip, type sniffing
    io/omr.js           recognition backend client (health, upload, -> scores)
    audio/instruments.js the 21 voices
    audio/engine.js     lookahead scheduler (live) + scheduleAll (offline)
    audio/fx.js         procedural convolution reverb, EQ, compressor
    audio/mp3.js        OfflineAudioContext render -> LAME -> MP3/WAV
    audio/gm.js         General MIDI program -> instrument id
    render/notation.js  OpenSheetMusicDisplay wrapper + playback cursor
    render/roll.js      piano roll canvas
    ui/                 controller, DOM helpers
tools/
  build.mjs             esbuild bundle -> single HTML
  cdp.mjs               headless-Chrome harness (no npm deps, uses Node's WebSocket)
  verify.mjs            build + self-test + screenshot
  make-fixtures.mjs     render ground-truth score images + gt.json
  score-render.html     engraves one known fixture for make-fixtures
backend/
  app.py                FastAPI: /api/omr, /api/health, /api/accuracy, static
  omr_engine.py         homr wrapper: CPU config, variants, MusicXML summary
  preprocess.py         decode / PDF rasterise / deskew / contrast / resize
  .venv/                Python environment (see above)
fixtures/               ground-truth images + accuracy.json
tests/                  per-module test pages, all runnable headless
```

### Testing

`npm test` builds the single file and then opens it in headless Edge with
`?selftest`, which:

- parses a known score and checks note counts, barlines, tempo and key;
- parses a hand-built MIDI byte fixture (running status, tempo, key, note pairs);
- checks the timing arithmetic (tempo changes, half-speed, quarter↔seconds round trip);
- checks transposition;
- renders a chord on **all 21 instruments** and asserts none is silent, clipping or
  producing non-finite samples;
- renders the demo score offline and asserts it is faster than real time;
- encodes MP3 and **walks the MPEG frame headers** to confirm the file really is
  MPEG-1 Layer III at the requested bitrate, with a duration matching the score;
- renders real notation and counts the SVG glyph paths.

Individual module tests run the same way — pass an absolute `file://` URL to the
test page:

```bash
node tools/cdp.mjs --url "file:///$(pwd)/tests/musicxml-test.html" \
  --wait "window.__DONE__===true" --timeout 60000 \
  --eval "document.getElementById('out').textContent"
```

In PowerShell use `file:///$PWD/tests/musicxml-test.html`. The four suites are
`musicxml-test.html` (179 assertions), `smf-test.html` (97),
`instruments-test.html` (194 checks) and `mscx-test.html`.

The recogniser has its own suite, which needs the Python environment:

```bash
npm run test:omr                                     # all three conditions
python tools/score_omr.py --write fixtures/accuracy.json   # publish to /api/accuracy
```

It engraves the fixtures in `fixtures/` to PNG, reads them back, and scores the
result note for note. A fixture whose declared notes disagree with what was
actually rendered is rejected rather than scored — the check refuses to blame
the recogniser for a fixture bug.

---

## Reading scans and PDFs (optical music recognition)

Photos and PDFs are transcribed by a small Python service in `backend/`. It runs
**entirely on the CPU** — ONNX Runtime with every GPU and CoreML execution
provider switched off — so it needs no graphics card and no CUDA.

```powershell
python backend/app.py            # http://127.0.0.1:8000
```

The first run downloads ~37 MB of ONNX model weights. The service also serves
`ScoreForge.html`, so the simplest workflow is to open
<http://127.0.0.1:8000/> and work there. Opening `ScoreForge.html` straight off
disk works too; it just points at `http://127.0.0.1:8000` for scans.

Dropping a scan on the page:

1. decodes it (honouring EXIF rotation) or rasterises each PDF page,
2. builds several candidate renderings — plain, contrast-lifted, deskewed, and
   both — and reads each one,
3. keeps the version that produced the most notes, and
4. parses the resulting MusicXML into an ordinary score.

The **Transcription** panel shows the page the recogniser was given next to what
it read, which page was best, and how long each attempt took, so the result is
checkable against the original rather than something to take on faith.

### Measured accuracy

`tools/score_omr.py` engraves known MusicXML to PNG, reads it back through the
recogniser, and compares note for note against what was printed:

| Condition | Notes | Precision | Recall | F1 |
|---|---|---|---|---|
| Printed score | 75 | 100.0% | 100.0% | **100.0%** |
| Phone photo (1.4° tilt, uneven lighting, noise, JPEG 62) | 75 | 100.0% | 100.0% | **100.0%** |
| Photocopy scan (low contrast, blur, adaptive threshold) | 75 | 100.0% | 100.0% | **100.0%** |

Roughly **0.9 s per page** on the CPU. Duration accuracy is 100% on printed and
photographed scores, and 96% on photocopies. Reproduce it with:

```powershell
python tools/score_omr.py --write fixtures/accuracy.json
```

The page displays these numbers, read back from the service.

**What this does not cover.** The fixtures are engraved music, including
synthetically degraded images. Handwriting, curved book pages, very low contrast
and dense polyphony are harder and are not represented. Read the result against
your scan. The recogniser also reports a time signature from the bar lines it
can see, so a page engraved without interior barlines may come back as one long
bar rather than the usual 4/4.

---

## Third-party components

Bundled into `ScoreForge.html`:

| Component | Licence |
|---|---|
| OpenSheetMusicDisplay 2.2 + VexFlow 1.2.93 | MIT / MIT |
| lamejs 1.2.1 (MP3 encoder) | LGPL-3.0 |
| fflate 0.8 (zip) | MIT |

Installed into `backend/.venv`, **not** bundled into the page:

| Component | Licence |
|---|---|
| [homr](https://github.com/liebharc/homr) 0.7.0 (recognition) | **AGPL-3.0** |
| onnxruntime 1.30 | MIT |
| rapidocr (title detection) | Apache-2.0 |
| opencv-python-headless 5.0 | Apache-2.0 |
| pypdfium2 5.14 | Apache-2.0 / PDFium (BSD-3) |

> **Licence note.** homr is AGPL-3.0, unlike the MIT-licensed alternative
> `oemer`. That is fine for a service you run yourself on your own machine, but
> if you ever expose this backend to other users over a network, AGPL obligations
> attach to the service. The bundled page itself stays MIT/LGPL as above.

Music glyphs are drawn as vector paths from VexFlow's built-in font data, so no
webfont is downloaded at runtime.

---

## Limitations

- **Scans need the Python backend.** Without it they are reference-only. MusicXML,
  MuseScore and MIDI never need it.
- Optical music recognition reads engraved music well; see *Measured accuracy*
  for what that does and does not cover. It is not a handwriting reader.
- No MIDI-from-audio, no audio-to-score.
- Playback and export use the same code path, but `OfflineAudioContext` output is
  bit-identical only because "humanise" is forced off for renders.
- Very long scores render in the notation view progressively as you scroll.probe
