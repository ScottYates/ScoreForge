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

import cv2  # noqa: E402
from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import FileResponse, JSONResponse, Response  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402

import omr_engine  # noqa: E402
import preprocess  # noqa: E402

MAX_UPLOAD_BYTES = 40 * 1024 * 1024  # 40 MB
MAX_PDF_PAGES = 20

app = FastAPI(title="ScoreForge OMR", version="2.0.0", docs_url="/api/docs")

# The page is normally opened straight off disk (file://), where the browser
# sends a null origin. MusicXML and MIDI stay fully offline; only the scan
# upload needs this origin.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["*"],
)

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


# The built page is served from the same origin so the fetch is same-origin and
# the app works as one unit. Opening ScoreForge.html directly off disk still
# works; it just needs the backend URL pointed at this service.
_INDEX = ROOT / "ScoreForge.html"
if _INDEX.exists():
    app.mount("/", StaticFiles(directory=str(ROOT), html=True), name="app")


def main() -> None:
    import argparse

    import uvicorn

    ap = argparse.ArgumentParser(description="ScoreForge OMR backend (CPU only)")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--reload", action="store_true")
    args = ap.parse_args()

    print(f"ScoreForge OMR  engine={omr_engine.ENGINE_NAME} {omr_engine.ENGINE_VERSION} "
          f"device={omr_engine.DEVICE}  ->  http://{args.host}:{args.port}/")
    uvicorn.run("app:app" if args.reload else app, host=args.host, port=args.port,
                reload=args.reload, log_level="info")


if __name__ == "__main__":
    main()