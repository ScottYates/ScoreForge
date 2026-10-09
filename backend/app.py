"""backend/app.py -- ScoreForge optical music recognition service.

Exposes:
    GET  /api/health      engine status, device, licence note
    POST /api/omr         image or PDF upload -> MusicXML transcription
    GET  /api/preview/{id}  the exact raster the recogniser was given
    GET  /api/accuracy    the measured round-trip accuracy of the engine
    GET  /                 the built frontend

Runs on CPU only. `python backend/app.py` (or uvicorn backend.app:app).
"""

from __future__ import annotations

import io
import json
import sys
import time
import uuid
from pathlib import Path
from typing import Optional

BACKEND_DIR = Path(__file__).resolve().parent
ROOT = BACKEND_DIR.parent
sys.path.insert(0, str(BACKEND_DIR))

import os
from typing import Optional

import cv2  # noqa: E402
from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.middleware.trustedhost import TrustedHostMiddleware  # noqa: E402
from fastapi.responses import FileResponse, JSONResponse, Response  # noqa: E402

import omr_engine  # noqa: E402
import preprocess  # noqa: E402

MAX_UPLOAD_BYTES = 40 * 1024 * 1024  # 40 MB
MAX_PDF_PAGES = 20

HOST = os.environ.get("SCOREFORGE_HOST", "127.0.0.1")
PORT = int(os.environ.get("SCOREFORGE_PORT", "8000"))


def _split_env(name: str) -> list[str]:
    return [v.strip() for v in os.environ.get(name, "").split(",") if v.strip()]


def _origins() -> list[str]:
    """Origins allowed to call this API from a browser.

    Chrome reports a page opened off disk as origin "file://" (and "null" for
    other opaque origins). Both are needed: ScoreForge is meant to be
    double-clicked, and without them the page cannot reach the backend at all.

    The extra ports are for serving the page from a plain static server instead
    of from this service -- `python -m http.server 8080` puts the page on a
    different origin, and it still has to be able to reach the API. These are
    loopback only: no page can claim one of these origins unless something on
    this machine is already listening there.

    Anything else has to be named explicitly. An allow-list of "*" would let
    every website you visit read whatever this service exposes, which is the
    reason this is a list rather than a wildcard.

    SCOREFORGE_WEB_PORT adds further ports, comma separated, for when 8080 and
    8081 are not the ones you serve the page from. PORT is always included, so
    moving this service never breaks a page it is serving itself.
    """
    ports = [PORT, 8080, 8081]
    ports += [int(p) for p in _split_env("SCOREFORGE_WEB_PORT") if p.isdigit()]
    base = ["null", "file://"]
    for p in dict.fromkeys(ports):
        base += [f"http://127.0.0.1:{p}", f"http://localhost:{p}"]
    return base + [o for o in _split_env("SCOREFORGE_ALLOWED_ORIGINS") if o not in base]


def _hosts() -> list[str]:
    """Host header values we answer to.

    Validating this is what stops DNS rebinding: without it, a page whose domain
    is pointed at 127.0.0.1 looks same-origin to the browser, and no CORS rule
    applies at all.
    """
    if os.environ.get("SCOREFORGE_ALLOW_ANY_HOST"):
        return ["*"]
    hosts = ["127.0.0.1", "localhost", "[::1]"]
    bound = HOST.strip()
    if bound not in ("0.0.0.0", "::", "*", ""):
        hosts.append(bound)
    return hosts + [h for h in _split_env("SCOREFORGE_ALLOWED_HOSTS") if h not in hosts]


ALLOWED_ORIGINS = _origins()
ALLOWED_HOSTS = _hosts()

app = FastAPI(title="ScoreForge OMR", version="2.0.0", docs_url="/api/docs")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["*"],
)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=ALLOWED_HOSTS)

_previews: dict[str, bytes] = {}
_PREVIEW_LIMIT = 24


def _store_preview(png: bytes) -> str:
    key = uuid.uuid4().hex
    _previews[key] = png
    if len(_previews) > _PREVIEW_LIMIT:
        for stale in list(_previews)[: len(_previews) - _PREVIEW_LIMIT]:
            _previews.pop(stale, None)
    return key


@app.get("/api/health")
def health() -> dict:
    return omr_engine.health()


@app.get("/api/accuracy")
def accuracy() -> dict:
    """The measured round-trip accuracy of the recogniser on this machine.

    Written by tools/score_omr.py --json; absent until the suite has been run.
    """
    path = ROOT / "fixtures" / "accuracy.json"
    if not path.exists():
        return {
            "available": False,
            "howto": "python tools/score_omr.py --write fixtures/accuracy.json",
        }
    # Normalise the shape so the client can rely on `available` being present
    # whichever branch it gets.
    report = json.loads(path.read_text(encoding="utf-8"))
    return {"available": True, **report}


@app.post("/api/omr")
async def omr(
    file: UploadFile = File(...),
    mode: str = Form("auto"),
    pages: Optional[str] = Form(None),
    pdf_dpi: int = Form(300),
    debug: bool = Form(False),
) -> JSONResponse:
    """Transcribe sheet music from a photo, scan or PDF.

    `mode` selects the preprocessing variant set:
        original -- size-normalise only
        auto     -- try several renderings, keep the one that reads most notes
        clean    -- deskew + contrast + denoise, for faint photocopies
    """
    started = time.perf_counter()
    data = await file.read()
    if not data:
        raise HTTPException(400, "the uploaded file was empty")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            413, f"file is {len(data) / 1e6:.1f} MB; the limit is {MAX_UPLOAD_BYTES / 1e6:.0f} MB"
        )
    if mode not in {"auto", "original", "clean"}:
        raise HTTPException(400, f"unknown preprocessing mode {mode!r}")

    wanted: Optional[set] = None
    if pages:
        try:
            wanted = {int(p) for p in pages.split(",") if p.strip() != ""}
        except ValueError:
            raise HTTPException(400, "pages must be a comma-separated list of page numbers")

    try:
        raster_pages = preprocess.load_pages(
            data, file.filename or "upload", pdf_dpi=pdf_dpi, max_pages=MAX_PDF_PAGES
        )
    except ValueError as exc:
        raise HTTPException(415, str(exc))
    except Exception as exc:
        raise HTTPException(415, f"could not read the file: {type(exc).__name__}: {exc}")

    if wanted is not None:
        raster_pages = [p for p in raster_pages if p.index in wanted]
        if not raster_pages:
            raise HTTPException(400, f"none of the requested pages exist (file has {len(raster_pages)})")

    results = []
    errors = []
    for page in raster_pages:
        try:
            result = omr_engine.transcribe_page(page, mode=mode, debug=debug)
        except RuntimeError as exc:
            raise HTTPException(503, f"recognition engine unavailable: {exc}")
        except ValueError as exc:
            errors.append({"page": page.index, "error": str(exc)})
            continue
        except Exception as exc:
            errors.append({"page": page.index, "error": f"{type(exc).__name__}: {exc}"})
            continue

        results.append({
            "page": result.index,
            "variant": result.variant,
            "seconds": round(result.seconds, 2),
            "musicxml": result.musicxml,
            "stats": result.stats,
            "variantsTried": result.variants_tried,
            "preview": _store_preview(result.preview_png) if result.preview_png else None,
            "log": result.log,
        })

    if not results:
        detail = errors[0]["error"] if errors else "no readable music found"
        raise HTTPException(422, detail)

    total_notes = sum(r["stats"].get("notes", 0) for r in results)
    return JSONResponse({
        "ok": True,
        "engine": omr_engine.ENGINE_NAME,
        "version": omr_engine.ENGINE_VERSION,
        "device": omr_engine.DEVICE,
        "filename": file.filename,
        "mode": mode,
        "pages": results,
        "pageCount": len(raster_pages),
        "totalNotes": total_notes,
        "seconds": round(time.perf_counter() - started, 2),
        "errors": errors,
    })


@app.get("/api/preview/{key}")
def preview(key: str) -> Response:
    png = _previews.get(key)
    if png is None:
        raise HTTPException(404, "preview expired -- upload the page again")
    return Response(content=png, media_type="image/png",
                    headers={"Cache-Control": "public, max-age=600"})


# Serve the built page and nothing else. Mounting the project directory would
# publish the source tree, .git/ and any scores dropped alongside it.
_INDEX = ROOT / "ScoreForge.html"


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    if not _INDEX.exists():
        raise HTTPException(404, "ScoreForge.html is not built - run `npm run build`")
    return FileResponse(_INDEX, media_type="text/html",
                        headers={"Cache-Control": "no-cache"})


def main() -> None:
    import argparse

    import uvicorn

    ap = argparse.ArgumentParser(description="ScoreForge OMR backend (CPU only)")
    ap.add_argument("--host", default=HOST,
                    help="loopback by default; anything else exposes the service on the network")
    ap.add_argument("--port", type=int, default=PORT)
    ap.add_argument("--reload", action="store_true")
    args = ap.parse_args()

    if args.host not in ("127.0.0.1", "localhost", "::1"):
        print(f"\n  WARNING: binding to {args.host} exposes this service to your network.\n"
              "  It has no authentication and will transcribe anything sent to it.\n",
              file=sys.stderr)

    print(f"ScoreForge OMR  engine={omr_engine.ENGINE_NAME} {omr_engine.ENGINE_VERSION} "
          f"device={omr_engine.DEVICE}  ->  http://{args.host}:{args.port}/")
    print(f"allowed origins: {', '.join(ALLOWED_ORIGINS)}")
    uvicorn.run("app:app" if args.reload else app, host=args.host, port=args.port,
                reload=args.reload, log_level="info")


if __name__ == "__main__":
    main()