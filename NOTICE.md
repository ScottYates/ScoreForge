# Notice

## Optional Python backend

The bundled web page — `index.html` and everything in `src/` — is MIT, as
is this repository's own source.

The optional recognition service in `backend/` is also MIT source, but it
installs and depends on **homr**, which is licensed **AGPL-3.0**.

Running homr as a separate process and talking to it over HTTP keeps this
repository's own code under MIT. If you modify homr, or combine it into your own
program rather than calling it as a service, the AGPL terms apply to that
combined work.

If you intend to expose the backend to other users over a network, read the
AGPL-3.0 terms first. The bundled page stays MIT either way — it never links
against homr.

## Bundled third-party components

Inlined into `index.html`:

| Component | Licence |
|---|---|
| OpenSheetMusicDisplay 2.2, VexFlow 1.2.93 | MIT |
| lamejs 1.2.1 | LGPL-3.0 |
| fflate 0.8 | MIT |

Installed into `backend/.venv` and not bundled:

| Component | Licence |
|---|---|
| homr 0.7.0 | AGPL-3.0 |
| onnxruntime 1.30 | MIT |
| rapidocr 3.9.2 | Apache-2.0 |
| opencv-python-headless 5.0 | Apache-2.0 |
| pypdfium2 5.14 | Apache-2.0 / PDFium BSD-3 |

<!-- BEGIN generated credits -->

## Recorded-instrument samples

`pack/` is built by `tools/make-pack.mjs` from the libraries below. The block
between these two markers is generated from `pack/manifest.json` — edit the
`SOURCES` table in `tools/make-pack.mjs` and rebuild, never this file.

| Samples | By | Licence | Instruments |
|---|---|---|---|
| FreePats | The FreePats project and its contributors | CC0 1.0 Universal (public domain) | Bagpipe (recorded), Bass Guitar (recorded), Button Accordion (recorded), Church Organ (recorded), Clarinet (recorded), Concert Harp (recorded), Drawbar Organ (recorded), Electric Guitar, Clean (recorded), Electric Guitar, Direct (recorded), Electric Guitar, Distorted I (recorded), Electric Guitar, Distorted II (recorded), Electric Guitar, Jazz (recorded), FM Piano I (recorded), FM Piano II (recorded), Glasses (recorded), Hang (recorded), Honky-Tonk Piano (recorded), Jaw Harp (recorded), Kalimba (recorded), Lately Bass (recorded), Nylon-String Guitar (recorded), Ocarina (recorded), Percussive Organ (recorded), Rock Organ (recorded), Synth Bass & Lead (recorded), Synth Bass I (recorded), Synth Bass II (recorded), Synth Brass I (recorded), Synth Brass II (recorded), Synth Crystal (recorded), Synth Fifths (recorded), Synth Goblins (recorded), Synth Lead, Calliope (recorded), Synth Lead, Square (recorded), Synth Pad, Bowed (recorded), Synth Pad, Choir (recorded), Synth Pad, New Age (recorded), Synth Sci-Fi (recorded), Synth Soundtrack (recorded), Synth Strings I (recorded), Synth Strings II (recorded), Synth Sweep Pad (recorded), Tenor Saxophone (recorded), Timpani (recorded), Tubular Bells (recorded), Ukulele (recorded), Upright Piano (recorded), Wooden Recorder (recorded), Xylophone (recorded) |
| FreePats FSS Steel-String Acoustic Guitar | The FreePats project; FSS samples recorded by its contributors | GPL-3.0-or-later, with the FreePats sound-sample exception | Steel-String Guitar (recorded) |

`FreePats FSS Steel-String Acoustic Guitar` is licensed **GPL-3.0-or-later, with the FreePats sound-sample exception**. The sample files in
this pack are distributed under those terms, and the terms are part of the
pack:

> As a special exception, if you create a composition which uses these sounds,
> and mix these sounds or unaltered portions of these sounds into the
> composition, these sounds do not by themselves cause the entire composition
> as a whole to be covered by the GNU General Public License.

Author: The FreePats project; FSS samples recorded by its contributors. Source: <https://freepats.zenvoid.org/Guitar/steel-acoustic-guitar.html>.

Changes made to the recordings: leading and trailing silence trimmed; mixed to mono; truncated to 4 s; no loop points; peak-normalised per instrument; encoded to MP3 at 64 kbps.

Music made with these samples is covered by the licence above. The sample
recordings themselves remain the property of their authors, and neither the
licence nor their inclusion here implies their endorsement of this project.

<!-- END generated credits -->
