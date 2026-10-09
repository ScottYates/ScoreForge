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
| Salamander Grand Piano V3 | Alexander Holm | CC BY 3.0 | Concert Grand (Salamander) |
| Versilian Community Edition | Versilian Studios and contributors | CC0 1.0 Universal (public domain) | Concert Grand (Versilian), Glockenspiel (recorded), Harpsichord (recorded), Koto (recorded), Marimba (recorded), Vibraphone (recorded), Viola da gamba (recorded), Xylophone (recorded) |

`Salamander Grand Piano V3` is licensed **CC BY 3.0** and requires attribution. Author: Alexander Holm. Source: <https://github.com/sfzinstruments/SalamanderGrandPiano>.

Changes made to the recordings: leading and trailing silence trimmed; mixed to mono; truncated to 6 s; peak-normalised per instrument; encoded to MP3 at 64 kbps.

Music made with these samples is covered by the licence above. The sample
recordings themselves remain the property of their authors, and neither the
licence nor their inclusion here implies their endorsement of this project.

<!-- END generated credits -->
