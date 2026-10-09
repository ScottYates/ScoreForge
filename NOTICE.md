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