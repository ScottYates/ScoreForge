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
import threading
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


class JobCancelled(Exception):
    """The user asked to stop. Not an error; reported as its own state."""


class EngineUnavailable(Exception):
    pass


class NoMusicFound(Exception):
    pass


def _validate_upload(data: bytes, filename: Optional[str]) -> None:
    if not data:
        raise HTTPException(400, "the uploaded file was empty")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            413, f"file is {len(data) / 1e6:.1f} MB; the limit is {MAX_UPLOAD_BYTES / 1e6:.0f} MB"
        )

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


def _transcribe(
    data: bytes,
    filename: str,
    mode: str = "auto",
    pages: Optional[str] = None,
    pdf_dpi: int = 300,
    debug: bool = False,
    progress=None,
    cancelled=None,
) -> dict:
    """Rasterise and recognise. Raises ValueError with a user-facing message.

    Shared by the synchronous endpoint and the background job so the two cannot
    drift apart -- a job that reported different notes from the request the
    installer smoke-tests would be worse than no job at all.

    progress(fraction, message) is called as the work advances; cancelled() is
    checked between pages and between the phases that surround inference.
    Inference itself is a blocking call into the engine, so a cancel lands at
    the next boundary rather than mid-note -- hence the UI says so.
    """
    started = time.perf_counter()

    def report(fraction: float, message: str) -> None:
        if progress:
            progress(max(0.0, min(1.0, fraction)), message)

    def check_cancel() -> None:
        if cancelled and cancelled():
            raise JobCancelled()

    check_cancel()
    report(0.02, "Reading the file")
    wanted: Optional[set] = None
    if pages:
        try:
            wanted = {int(p) for p in pages.split(",") if p.strip() != ""}
        except ValueError:
            raise ValueError("pages must be a comma-separated list of page numbers")

    check_cancel()
    report(0.05, "Rasterising")
    try:
        raster_pages = preprocess.load_pages(
            data, filename or "upload", pdf_dpi=pdf_dpi, max_pages=MAX_PDF_PAGES
        )
    except ValueError as exc:
        raise ValueError(str(exc))
    except Exception as exc:
        raise ValueError(f"could not read the file: {type(exc).__name__}: {exc}")

    if wanted is not None:
        raster_pages = [p for p in raster_pages if p.index in wanted]
        if not raster_pages:
            raise ValueError(f"none of the requested pages exist (file has {len(raster_pages)})")

    results = []
    errors = []
    for i, page in enumerate(raster_pages):
        check_cancel()
        # Each page gets a fixed slice of the bar so multi-page scans advance
        # steadily instead of jumping a whole fraction per page. The page's own
        # 0..1 progress is mapped into its slice by page_progress below.
        page_base = 0.1 + 0.85 * (i / max(1, len(raster_pages)))
        page_span = 0.85 / max(1, len(raster_pages))
        report(page_base, f"Page {page.index + 1} of {len(raster_pages)}")

        def page_progress(fraction: float, message: str,
                          _base=page_base, _span=page_span, _page=page) -> None:
            report(_base + _span * fraction, f"Page {_page.index + 1}: {message}")

        try:
            result = omr_engine.transcribe_page(page, mode=mode, debug=debug,
                                                progress=page_progress)
        except RuntimeError as exc:
            raise EngineUnavailable(str(exc))
        except ValueError as exc:
            errors.append({"page": page.index, "error": str(exc)})
            continue
        except JobCancelled:
            raise
        except Exception as exc:
            errors.append({"page": page.index, "error": f"{type(exc).__name__}: {exc}"})
            continue

        # A cancel that arrives *during* inference is only noticed here. Without
        # this, a one-page scan -- which is most scans -- could never be
        # stopped: the only other checks all run before the page starts.
        check_cancel()

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
        raise NoMusicFound(detail)

    total_notes = sum(r["stats"].get("notes", 0) for r in results)
    report(0.99, "Done")
    return {
        "ok": True,
        "engine": omr_engine.ENGINE_NAME,
        "version": omr_engine.ENGINE_VERSION,
        "device": omr_engine.DEVICE,
        "filename": filename,
        "mode": mode,
        "pages": results,
        "pageCount": len(raster_pages),
        "totalNotes": total_notes,
        "seconds": round(time.perf_counter() - started, 2),
        "errors": errors,
    }


@app.post("/api/omr")
async def omr(
    file: UploadFile = File(...),
    mode: str = Form("auto"),
    pages: Optional[str] = Form(None),
    pdf_dpi: int = Form(300),
    debug: bool = Form(False),
) -> JSONResponse:
    """Transcribe sheet music from a photo, scan or PDF, and wait for the answer.

    `mode` selects the preprocessing variant set:
        original -- size-normalise only
        auto     -- try several renderings, keep the one that reads most notes
        clean    -- deskew + contrast + denoise, for faint photocopies

    Recognition takes minutes on a large scan and holds this request open the
    whole time. POST /api/omr/jobs does the same work in the background and
    reports progress; this endpoint stays for callers that want one round trip.
    """
    data = await file.read()
    _validate_upload(data, file.filename)
    try:
        payload = _transcribe(data, file.filename or "upload", mode, pages, pdf_dpi, debug)
    except EngineUnavailable as exc:
        raise HTTPException(503, f"recognition engine unavailable: {exc}")
    except NoMusicFound as exc:
        raise HTTPException(422, str(exc))
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return JSONResponse(payload)


# --------------------------------------------------------------------- jobs
#
# Recognition on a real scan takes minutes. Holding one HTTP request open for
# that is a timeout waiting to happen, behind a proxy or not, and gives the user
# nothing to look at and no way out. So the same work can run as a job the
# client polls, reports against, and cancels.

_JOBS: "dict[str, dict]" = {}
_JOBS_LOCK = threading.Lock()
JOB_TTL_SECONDS = 3600


def _job_view(job: dict) -> dict:
    """What the client polls for. Never includes the (large) MusicXML bodies."""
    view = {
        "jobId": job["id"],
        "state": job["state"],
        "progress": round(job["progress"], 3),
        "message": job["message"],
        "seconds": round(job["seconds"], 2),
    }
    if job["state"] == "done":
        view["result"] = job["result"]
    if job["state"] == "error":
        view["error"] = job["error"]
        view["status"] = job.get("status", 400)
    return view


def _prune_jobs() -> None:
    now = time.time()
    for jid, job in list(_JOBS.items()):
        if now - job["created"] > JOB_TTL_SECONDS and job["state"] != "running":
            _JOBS.pop(jid, None)


def _run_job(job_id: str, data: bytes, filename: str, mode: str,
             pages: Optional[str], pdf_dpi: int, debug: bool) -> None:
    def progress(fraction: float, message: str) -> None:
        with _JOBS_LOCK:
            job = _JOBS.get(job_id)
            if job:
                # Progress is reported from several nested scopes -- the page
                # loop, then each variant, then each engine log line. Clamp it
                # here, at the one place it is stored, rather than trusting every
                # caller to be monotonic: a bar that slips reads as a broken job
                # even when the work is fine.
                if fraction > job["progress"]:
                    job["progress"] = fraction
                job["message"] = message

    def cancelled() -> bool:
        with _JOBS_LOCK:
            job = _JOBS.get(job_id)
            return bool(job and job["cancel"].is_set())

    started = time.perf_counter()
    try:
        result = _transcribe(data, filename, mode, pages, pdf_dpi, debug,
                             progress=progress, cancelled=cancelled)
    except JobCancelled:
        with _JOBS_LOCK:
            job = _JOBS.get(job_id)
            if job:
                job.update(state="cancelled", message="Stopped",
                           seconds=time.perf_counter() - started)
        return
    except EngineUnavailable as exc:
        with _JOBS_LOCK:
            job = _JOBS.get(job_id)
            if job:
                job.update(state="error", error=f"recognition engine unavailable: {exc}",
                           status=503, message="Engine unavailable",
                           seconds=time.perf_counter() - started)
        return
    except NoMusicFound as exc:
        with _JOBS_LOCK:
            job = _JOBS.get(job_id)
            if job:
                job.update(state="error", error=str(exc), status=422,
                           message="No readable music", seconds=time.perf_counter() - started)
        return
    except ValueError as exc:
        with _JOBS_LOCK:
            job = _JOBS.get(job_id)
            if job:
                job.update(state="error", error=str(exc), status=400,
                           message="Could not read the file",
                           seconds=time.perf_counter() - started)
        return
    except Exception as exc:  # noqa: BLE001 - a worker thread must never die silently
        with _JOBS_LOCK:
            job = _JOBS.get(job_id)
            if job:
                job.update(state="error", error=f"{type(exc).__name__}: {exc}", status=500,
                           message="Recognition failed", seconds=time.perf_counter() - started)
        return

    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
        if job:
            job.update(state="done", progress=1.0, message="Done", result=result,
                       seconds=time.perf_counter() - started)


@app.post("/api/omr/jobs")
async def create_job(
    file: UploadFile = File(...),
    mode: str = Form("auto"),
    pages: Optional[str] = Form(None),
    pdf_dpi: int = Form(300),
    debug: bool = Form(False),
) -> JSONResponse:
    """Start a transcription in the background and return its id immediately."""
    if mode not in {"auto", "original", "clean"}:
        raise HTTPException(400, f"unknown preprocessing mode {mode!r}")
    data = await file.read()
    _validate_upload(data, file.filename)

    with _JOBS_LOCK:
        _prune_jobs()
        job_id = uuid.uuid4().hex
        _JOBS[job_id] = {
            "id": job_id, "state": "running", "progress": 0.0,
            "message": "Starting", "created": time.time(), "seconds": 0.0,
            "cancel": threading.Event(), "result": None, "error": None, "status": 400,
        }

    thread = threading.Thread(
        target=_run_job,
        args=(job_id, data, file.filename or "upload", mode, pages, pdf_dpi, debug),
        daemon=True,
        name=f"omr-{job_id[:8]}",
    )
    thread.start()
    return JSONResponse({"jobId": job_id, "state": "running"})


@app.get("/api/omr/jobs/{job_id}")
def job_status(job_id: str) -> JSONResponse:
    """Poll a job. The result body is included only once it is done."""
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
        if job is None:
            raise HTTPException(404, "no such job; it may have expired")
        return JSONResponse(_job_view(job))


@app.post("/api/omr/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> JSONResponse:
    """Ask a running job to stop.

    Cancellation is checked at the boundaries between pages: inference itself is
    a single blocking call into the engine and cannot be interrupted part-way
    through a page without killing the process.
    """
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
        if job is None:
            raise HTTPException(404, "no such job; it may have expired")
        if job["state"] == "running":
            job["cancel"].set()
            job["message"] = "Stopping after the current page"
            return JSONResponse({"jobId": job_id, "state": "stopping"})
        return JSONResponse({"jobId": job_id, "state": job["state"]})


@app.get("/api/preview/{key}")
def preview(key: str) -> Response:
    png = _previews.get(key)
    if png is None:
        raise HTTPException(404, "preview expired -- upload the page again")
    return Response(content=png, media_type="image/png",
                    headers={"Cache-Control": "public, max-age=600"})


# Serve the built page and nothing else. Mounting the project directory would
# publish the source tree, .git/ and any scores dropped alongside it.
_INDEX = ROOT / "index.html"
_PACK = ROOT / "pack"


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    if not _INDEX.exists():
        raise HTTPException(404, "index.html is not built - run `npm run build`")
    return FileResponse(_INDEX, media_type="text/html",
                        headers={"Cache-Control": "no-cache"})


@app.get("/pack/{path:path}", include_in_schema=False)
def pack(path: str) -> FileResponse:
    """The recorded-instrument sample pack.

    Served from the same origin as the page so the browser can fetch it without
    CORS. The sample names are generated, but resolve and check the result
    anyway: `..` in the path must not escape the pack directory.
    """
    target = (_PACK / path).resolve()
    if not str(target).startswith(str(_PACK.resolve())) or not target.is_file():
        raise HTTPException(404, "no such sample")
    media = "application/json" if target.name == "manifest.json" else "audio/mpeg"
    # Immutable: every rebuild of the pack changes the filenames, so a cached
    # copy is never stale in a way that matters.
    return FileResponse(target, media_type=media,
                        headers={"Cache-Control": "public, max-age=604800"})


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