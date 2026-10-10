# WAV vs MP3 — the same recording, two formats

One recorded sample, played two ways:

- **A — `A2vL-original.wav`** — the recording itself, byte for byte. SHA-256
  `d96fbe791fbcb5dd…`, copied by `tools/make-audio-compare.mjs` and never opened
  for writing since.
- **B — `A2vL-direct-192k.mp3`** — encoded from that same WAV and nothing else.
  No trimming, no normalisation, no resampling, no marker silence prepended. The
  conversion is the only thing between the two files, so anything you hear
  different between A and B is the codec and nothing downstream.

## Open it

```
node tools/make-audio-compare.mjs <path-to-a.wav> --serve
```

It prints `http://127.0.0.1:8731/`. The page has to be served rather than opened
from `file://`, because it fetches its audio and a `file://` page cannot fetch
anything.

## What the page does

Two buttons, and a readout showing what was actually asked of the node rather
than what the source code says it wanted:

| | |
|---|---|
| file | the file that was played |
| playbackRate | read back off the source node |
| detune | read back off the source node |
| loop | read back off the source node |
| start offset | read back off the `start()` call, so a skipped attack cannot hide |
| stop scheduled | always "never scheduled" — nothing is cut off |
| decoded / peak | rate, channels, duration, and peak of the decoded buffer |

There is no oscillator, no additive or FM synthesis and no generated waveform
anywhere in it. No envelope node, no filter, no gain change: the source node is
connected straight to the destination. Each click makes a new
`AudioBufferSourceNode` and nothing is ever stopped, so repeated clicks overlap
instead of cutting each other off.

## What the check measured

`node tools/check-audio-compare.mjs` renders both files in the same headless
Chromium the other browser checks use, with the identical node settings, and
presses both buttons for real.

```
file                       rate  detune  loop   decoded             peak     onset
A2vL-original.wav             1       0  false  44100 Hz 2ch 8.190s  1.00000  1.5ms
A2vL-direct-192k.mp3          1       0  false  44100 Hz 2ch 8.229s  0.96991  25.4ms
```

Two things worth reading off that:

**WAV playback works in the browser.** The WAV begins 1.5 ms in, which is one
1.5 ms measurement window — effectively the first sample. That settles the
question this page was built to ask, and it means the format is not what stands
between the recording and the speakers.

**The MP3 starts 23.94 ms late and runs 38.7 ms longer.** That is LAME's encoder
delay and frame padding, which Chrome does not strip. An MP3 played from sample
zero starts every note about 24 ms late. The pack works around this by
prepending 1024 samples of silence to every encoded file and finding the real
onset after decoding; a WAV needs none of that.

Peak differs by −0.27 dB, which is ordinary for a lossy codec on a recording
that touches digital full scale.

## The recording

`A2vL.wav` from the FreePats bank `upright-piano-kw`. 44.1 kHz, 24-bit, stereo,
8.190 s, peak at exactly full scale on a single sample out of 722,346 — the
approach to that peak is smooth, so it is the recording's own peak rather than
clipping.