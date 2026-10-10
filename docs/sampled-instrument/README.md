# Upright Piano — sampled, as recorded

The FreePats `upright-piano-kw` bank played as a real sampled instrument. Every
note you hear is decoded PCM from a recording. Nothing in this folder generates
a waveform.

```
node tools/make-sampled-instrument.mjs --freepats <banks> --bank upright-piano-kw
node tools/serve.mjs docs/sampled-instrument          # or whatever you use
```

`tools/check-sampled-instrument.mjs` serves and verifies it.

## What the builder does to the recordings: nothing

This document was written when the pack builder still trimmed, normalised,
prepended a marker, truncated at 4 s and applied a family loudness target. It no
longer does any of those — the pack is the recordings, re-encoded — so the table
that used to set this instrument against it has nothing to compare.

What is left is that both do the same thing, and this is the smaller, fully
auditable version of it:

| | pack builder | this |
|---|---|---|
| trims leading/trailing silence | no | **no** |
| peak-normalises every note | no | **no** |
| prepends silence | no | **no** |
| truncates a take | no | **no** |
| edits the samples at all | **no** | **no** |
| mixes the roster | a per-take gain in the manifest | nothing — one instrument |
| checks itself against the source WAVs | yes | yes |

Levels came out at **0.999 – 1.000 peak** across all 66 source files — that is the
bank's own recording level, left alone. `tools/check-pack-is-unprocessed.mjs`
makes the same comparison for all 4,141 takes in `pack/`.

## Key mapping comes from the bank's SFZ

`UprightPianoKW-20220221.sfz`, read with the repo's own parser. `pitch_keycenter`,
`lokey`/`hikey`, and the `vL` / `vH` velocity layers in the filenames are all
taken from the bank rather than guessed.

- **88 keys**, 21–108, from 66 source files encoded once each.
- **All 88 keys have both hammers**, so velocity has something to choose between.
- **110 of the 176 layers** — 66 of them native, the other 110 at −100 to +300
  cents — are covered by a take the bank recorded at a neighbouring pitch. That
  is the bank's own key map and it is recorded in the manifest rather than
  papered over. Key 69 has both hammers recorded at A4: a real change of hammer
  on the same string. Key 45 has a native A2 soft hammer and an F#2 hard hammer
  three semitones away, because that is what the bank's SFZ maps.

## Codec delay is measured, not worked around

LAME writes its encoder delay into an MP3 and Chrome hands it back as leading
silence, so starting at sample zero puts every hammer about 24 ms late. The pack
used to prepend 1024 samples of silence to every file to hide this.

Neither does now. The sampler decodes each file once, **measures where the sound
actually starts**, and starts the source node there — measured at 0.024 – 0.030 s
depending on the file. No marker, no guess, and it stays correct if the encoder
or the bitrate changes.

## Playback rules

Per note: a new `AudioBufferSourceNode`, `loop = false`, `detune = 0`,
`playbackRate` = 1 when the take was recorded at that key, and **no `stop()`
call at all** — the sample plays out and is left alone. Nothing is connected
between the source and the speakers but the source. Clicking a key low gives a
hard strike and high a soft one; the recordings already carry their own levels,
so that only chooses which hammer was recorded.

## What the check verified

`node tools/check-sampled-instrument.mjs --freepats <banks>` renders all 176
layers through the exact node settings the page uses:

```
rendered             : 176 layer renders over 88 keys
silent               : none
attack not on time   : none
distinct takes used  : 66
looped / detuned     : 0 / 0
level moved from source: none
keys with one hammer only: 0
```

Three things it found that were not expected:

**`D#1vH` does not fetch.** FreePats writes sharps with a `#`, and a `#` in a URL
is a fragment separator, so the browser asked for `/samples/D` and got a 404.
Six of the bank's sixty-six files are named that way. `encodeURI` does not help
— it leaves `#` alone because `#` is a reserved character — so the path is
encoded a segment at a time.

**The level assertion was decorative.** It compared each render against the
peak declared in the instrument's own manifest, which the builder writes. A
normaliser moves the audio and the declared peak together, so peak-normalising
every take to 0.45 passed a check reading its expectations out of the thing it
was checking. The comparison now reads the original WAVs and is skipped, with
a line saying so, when they are not on disk.

**It was only measuring half the bank.** It rendered the layer a hard strike
would pick, which is the `vH` file, and left every `vL` file unrendered. All
176 layers are rendered now.

Both mutations were confirmed to fail it: starting at 0 instead of the measured
onset (all 88 keys land 22–30 ms late), and peak-normalising every take to 0.45
in the builder (all 66 takes, 1.0 → 0.436).