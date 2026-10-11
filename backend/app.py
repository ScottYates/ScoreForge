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

import collections
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
from starlette.concurrency import run_in_threadpool  # noqa: E402

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


@app.on_event("startup")
def _warm_engine_early() -> None:
    """Build the recognition engine while nobody is waiting on it.

    warm_up() is already lazy and lock-guarded, but lazy means the FIRST scan
    pays for the model load on top of its own inference -- the slowest scan a
    user ever sees is their first one. Warming from a daemon thread at startup
    moves that cost to the seconds after boot, when nobody is watching. A scan
    arriving mid-warm just waits on the same lock it always did, so the worst
    case is unchanged; the common case loses the whole model-load wait.

    SCOREFORGE_OMR_WARM=0 opts out, for machines where the service should not
    hold the models in memory until a scan actually arrives.
    """
    if os.environ.get("SCOREFORGE_OMR_WARM", "1") == "0":
        return
    threading.Thread(target=omr_engine.warm_up, name="omr-warm", daemon=True).start()

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
    body = omr_engine.health()
    # How busy, so a client can warn before it uploads a 40 MB scan into a queue
    # it already knows is long. Cheap to read and the alternative -- finding out
    # after the upload -- wastes the user's bandwidth and the service's memory.
    body["queue"] = {
        "running": _GATE.holder() is not None,
        "waiting": _GATE.queue_length(),
        "capacity": QUEUE_CAPACITY,
        "typicalSeconds": _DURATIONS.typical(),
    }
    return body


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

    It waits for the same admission gate the jobs use, so a synchronous caller
    cannot quietly run alongside a queued one -- one at a time means one at a
    time across both endpoints, not one each.

    The wait happens in a worker thread rather than on the event loop. It used
    to run inline, which meant a long transcription froze every other request
    the service was serving; with a queue in front of the engine that would have
    been much worse, because the polls a waiting client depends on would have
    been frozen behind the very request it was waiting for.
    """
    data = await file.read()
    _validate_upload(data, file.filename)
    payload = await run_in_threadpool(_transcribe_sync, data, file.filename or "upload",
                                      mode, pages, pdf_dpi, debug)
    return JSONResponse(payload)


def _transcribe_sync(data: bytes, filename: str, mode: str,
                     pages: Optional[str], pdf_dpi: int, debug: bool) -> dict:
    """The synchronous endpoint's work, behind the shared admission gate."""
    ticket = f"sync-{uuid.uuid4().hex}"
    _GATE.acquire(ticket)
    started = time.perf_counter()
    try:
        return _transcribe(data, filename, mode, pages, pdf_dpi, debug)
    except EngineUnavailable as exc:
        raise HTTPException(503, f"recognition engine unavailable: {exc}")
    except NoMusicFound as exc:
        raise HTTPException(422, str(exc))
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    finally:
        elapsed = time.perf_counter() - started
        _DURATIONS.add(elapsed)
        _GATE.release(ticket)


# --------------------------------------------------------------------- jobs
#
# Recognition on a real scan takes minutes. Holding one HTTP request open for
# that is a timeout waiting to happen, behind a proxy or not, and gives the user
# nothing to look at and no way out. So the same work can run as a job the
# client polls, reports against, and cancels.
#
# And only one at a time. omr_engine takes an engine lock around inference
# because onnxruntime sessions are not re-entrant here, but that lock made
# waiting invisible: every job was reported `running` from the moment it was
# created, N threads piled onto the same lock, and each client sat at 0% with no
# way to tell "the recogniser is reading my page" from "four other people's
# scans are ahead of me". The admission gate below replaces that queue of
# blocked threads with an explicit one, so a waiting client can be told its
# place in it and roughly when its turn comes.

_JOBS: "dict[str, dict]" = {}
# Reentrant, because _job_view() reads the running job's progress to work out
# how long a waiting job has left, and every caller of _job_view is already
# holding this lock. A plain Lock would deadlock the first time somebody polled
# a queued job -- which is the only state this project did not have before.
_JOBS_LOCK = threading.RLock()
JOB_TTL_SECONDS = 3600

#: How many jobs may wait for their turn before the service refuses more. Each
#: waiting job is holding its uploaded file in memory -- up to MAX_UPLOAD_BYTES
#: each -- so an unbounded queue is a slow way to run out of RAM. 0 disables the
#: limit and lets jobs wait however long they take.
QUEUE_CAPACITY = max(0, int(os.environ.get("SCOREFORGE_OMR_QUEUE", "8")))


class _Gate:
    """One-at-a-time admission to the recogniser, in arrival order.

    `_waiting[0]` is the ticket that holds the gate and `_waiting[1:]` are the
    ones behind it -- a single list, not a holder plus a queue. That is not a
    detail: with the holder tracked separately, a waiter takes itself off the
    list as soon as it wakes, which leaves the *next* one sitting at the head
    while the first is still working, so it walks straight in behind it. Two
    recognitions at once, every time the queue was busy.

    Tickets are admitted in arrival order, so "3rd in the queue" means the same
    thing to every client reading it. A counting semaphore could not do that:
    it hands slots to whoever happens to be scheduled, and the number a client
    is shown would move around for no reason.
    """

    def __init__(self) -> None:
        self._cond = threading.Condition(threading.Lock())
        self._waiting: "list[str]" = []

    # ---- reading it -------------------------------------------------------
    def position(self, ticket: str) -> Optional[int]:
        """1-based place among the waiters, or None if it holds the gate.

        Index 0 of the list is the holder, so the first person actually waiting
        sits at index 1 -- and is 1st. Adding one to the index would call them
        2nd, which is the kind of off-by-one that makes a queue look like it
        skipped someone when it only miscounted.
        """
        with self._cond:
            if not self._waiting or self._waiting[0] == ticket:
                return None
            try:
                return self._waiting.index(ticket)
            except ValueError:
                return None

    def queue_length(self) -> int:
        """How many are waiting -- not counting whoever is being served."""
        with self._cond:
            return max(0, len(self._waiting) - (1 if self._waiting else 0))

    def holder(self) -> Optional[str]:
        """The ticket currently inside, or None when the gate is idle."""
        with self._cond:
            return self._waiting[0] if self._waiting else None

    # ---- taking and giving it up -----------------------------------------
    def try_acquire(self, ticket: str) -> bool:
        """Take the gate if it is free and nobody is ahead of us.

        Separate from acquire() so the create path can answer "you are next" or
        "you are 3rd" without a thread having to block first.
        """
        with self._cond:
            if self._waiting:
                return False
            self._waiting.append(ticket)
            return True

    def acquire(self, ticket: str) -> bool:
        """Wait until it is this ticket's turn. False if it was dropped first.

        Never returns while somebody else holds the gate. The timeout is a
        backstop for a dropped signal, not a way out: returning early because
        the clock ran out is precisely how two jobs end up inside at once.
        """
        with self._cond:
            if ticket not in self._waiting:
                self._waiting.append(ticket)
            while True:
                if ticket not in self._waiting:
                    return False        # cancelled before its turn came round
                if self._waiting[0] == ticket:
                    return True
                self._cond.wait(timeout=1.0)

    def release(self, ticket: str) -> None:
        """Give the gate up, if this ticket is the one holding it."""
        with self._cond:
            if self._waiting and self._waiting[0] == ticket:
                self._waiting.pop(0)
            self._cond.notify_all()

    def drop(self, ticket: str) -> bool:
        """Remove a waiting ticket. True if it was still queued.

        A job cancelled before its turn costs nothing: it never reaches the
        engine at all. Without this it would sit in the line holding its upload
        and a place in front of everyone for a recogniser nobody is waiting for.
        """
        with self._cond:
            if ticket not in self._waiting:
                return False
            if self._waiting[0] == ticket:
                return False            # already inside; release() is its job
            self._waiting.remove(ticket)
            self._cond.notify_all()
            return True


_GATE = _Gate()


class _Durations:
    """A short history of how long recognitions actually took here.

    Used for the wait estimate. Started empty and left empty until something
    has finished, because a made-up number on the first scan of the day is worse
    than saying so: a client shown "about 1 min" and then waiting nine has
    learned not to believe this panel.
    """

    def __init__(self, keep: int = 12) -> None:
        self._keep = keep
        self._seen: "collections.deque[float]" = collections.deque(maxlen=keep)

    def add(self, seconds: float) -> None:
        if seconds > 0:
            self._seen.append(float(seconds))

    def typical(self) -> Optional[float]:
        """Median, not mean: one eight-page scan should not skew every answer."""
        if not self._seen:
            return None
        ordered = sorted(self._seen)
        mid = len(ordered) // 2
        if len(ordered) % 2:
            return ordered[mid]
        return (ordered[mid - 1] + ordered[mid]) / 2


_DURATIONS = _Durations()


def _estimate_wait(job_id: str) -> Optional[float]:
    """Seconds until this job's turn, or None when it cannot be told yet.

    The work ahead of it is what is left of the job currently reading, plus
    everyone else queued in front. Both parts are estimates and the result is
    reported as one -- it is a "roughly when", not a schedule.
    """
    typical = _DURATIONS.typical()
    if typical is None:
        return None
    position = _GATE.position(job_id)
    if position is None:
        return 0.0          # it holds the gate; it starts now
    front = (position - 1) * typical
    running = _GATE.holder()
    if running and running != job_id:
        with _JOBS_LOCK:
            job = _JOBS.get(running)
            if job and job["state"] == "running":
                # Assume the job in progress takes a typical one. Scaling by
                # what it has reported so far is the same guess with more
                # moving parts, and a slow first variant would make the
                # estimate for everyone behind it collapse to nothing.
                front += typical * (1.0 - min(1.0, max(0.0, job["progress"])))
    return round(front, 1)


def _job_view(job: dict) -> dict:
    """What the client polls for. Never includes the (large) MusicXML bodies."""
    view = {
        "jobId": job["id"],
        "state": job["state"],
        "progress": round(job["progress"], 3),
        "message": job["message"],
        "seconds": round(job["seconds"], 2),
    }
    if job["state"] == "queued":
        # Only the waiting client needs these, so they are not on every poll of
        # every job.
        position = _GATE.position(job["id"])
        view["position"] = position
        view["queueLength"] = _GATE.queue_length()
        view["estimatedWaitSeconds"] = _estimate_wait(job["id"])
        view["typicalSeconds"] = _DURATIONS.typical()
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
            # A pruned job that was still queued still has a ticket in the gate.
            # Its thread will notice when it is admitted and give it up, but
            # until then it is a place in the line held by a scan nobody is
            # waiting for -- so take it out now rather than at its turn.
            _GATE.drop(jid)


def _run_job(job_id: str, data: bytes, filename: str, mode: str,
             pages: Optional[str], pdf_dpi: int, debug: bool) -> None:
    # Wait for a turn before touching the engine. This job's own thread does the
    # waiting rather than a separate queue of ids, so the thing that blocks is
    # the thing that will do the work -- there is no second structure to keep in
    # step, and no window where a queued job has a place but nothing holding it.
    #
    # False means it was dropped from the queue while waiting -- cancelled, and
    # the cancel handler has already written the terminal state. Nothing to do,
    # and above all no release(): it never took the gate, so releasing would
    # hand it on a second time.
    if not _GATE.acquire(job_id):
        return
    started = time.perf_counter()
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
        if job is None:
            _GATE.release(job_id)
            return
        if job["cancel"].is_set():
            # Cancelled while queued: it never reaches the engine at all.
            job.update(state="cancelled", message="Stopped before it started", seconds=0.0)
            _GATE.release(job_id)
            return
        job.update(state="running", message="Starting")

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

    # One release for every exit. Written out per-except it would be five
    # copies of the same line, and the one nobody remembers is the one that
    # wedges the gate shut for everyone behind this job.
    #
    # The success path is inside the try on purpose: the result is stored before
    # the finally hands the gate on, so the next job's clock starts when this
    # one genuinely finished rather than when it stopped computing.
    try:
        result = _transcribe(data, filename, mode, pages, pdf_dpi, debug,
                             progress=progress, cancelled=cancelled)
        elapsed = time.perf_counter() - started
        _DURATIONS.add(elapsed)
        with _JOBS_LOCK:
            job = _JOBS.get(job_id)
            if job:
                job.update(state="done", progress=1.0, message="Done", result=result,
                           seconds=elapsed)
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
    finally:
        _GATE.release(job_id)


@app.post("/api/omr/jobs")
async def create_job(
    file: UploadFile = File(...),
    mode: str = Form("auto"),
    pages: Optional[str] = Form(None),
    pdf_dpi: int = Form(300),
    debug: bool = Form(False),
) -> JSONResponse:
    """Start a transcription in the background and return its id immediately.

    Returns straight away whether or not the recogniser is free. The reply says
    which: a client that is told `running` when it is really third in a queue
    cannot show anything honest for the next few minutes.
    """
    if mode not in {"auto", "original", "clean"}:
        raise HTTPException(400, f"unknown preprocessing mode {mode!r}")
    data = await file.read()
    _validate_upload(data, file.filename)

    with _JOBS_LOCK:
        _prune_jobs()
        waiting = _GATE.queue_length()
        if QUEUE_CAPACITY and waiting >= QUEUE_CAPACITY:
            typical = _DURATIONS.typical()
            roughly = f" about {typical * waiting / 60:.0f} min" if typical else ""
            raise HTTPException(
                503,
                f"The recogniser is busy and {waiting} job(s) are already waiting"
                f"{roughly}. Try again once one finishes.",
                headers={"Retry-After": str(int(typical or 60))},
            )
        job_id = uuid.uuid4().hex
        # Take the gate here rather than letting the worker thread discover it
        # is second, so the reply can already carry the position. The thread's
        # own acquire() then finds the ticket at the head and returns at once.
        first = _GATE.try_acquire(job_id)
        _JOBS[job_id] = {
            "id": job_id,
            "state": "running" if first else "queued",
            "progress": 0.0,
            "message": "Starting" if first else "Waiting for the recogniser",
            "created": time.time(), "seconds": 0.0,
            "cancel": threading.Event(), "result": None, "error": None, "status": 400,
        }

    thread = threading.Thread(
        target=_run_job,
        args=(job_id, data, file.filename or "upload", mode, pages, pdf_dpi, debug),
        daemon=True,
        name=f"omr-{job_id[:8]}",
    )
    try:
        thread.start()
    except RuntimeError:
        # The gate was taken above, so nothing else would ever hand it on. A
        # thread that cannot start is rare -- the process is out of resources --
        # but the failure it causes is this one job lost, instead of the whole
        # service refusing every scan from then on.
        _GATE.release(job_id)
        with _JOBS_LOCK:
            job = _JOBS.get(job_id)
            if job:
                job.update(state="error", error="the service could not start a worker",
                           status=503, message="Engine unavailable")
        raise HTTPException(503, "the recognition service could not start a worker")
    # The state the service will actually be in, not an optimistic "running":
    # if this job is behind another, saying so here is the earliest the client
    # can learn it, and it can start showing a queue position immediately.
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
        state = job["state"] if job else "running"
        view = _job_view(job) if job else {}
    return JSONResponse({"jobId": job_id, "state": state, "view": view})


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
    """Ask a job to stop.

    A running job is cancelled at the boundaries between pages: inference itself
    is a single blocking call into the engine and cannot be interrupted part-way
    through a page without killing the process.

    A job still waiting its turn is removed from the queue outright. It has not
    touched the engine, so stopping it there costs nothing -- and leaving it in
    place would hold its upload in memory and a place in the line for a scan
    nobody is waiting for any more. Its thread notices when it is admitted and
    finishes without starting.
    """
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
        if job is None:
            raise HTTPException(404, "no such job; it may have expired")
        if job["state"] == "queued":
            if _GATE.drop(job_id):
                job.update(state="cancelled", message="Stopped before it started",
                           seconds=0.0)
                return JSONResponse({"jobId": job_id, "state": "cancelled"})
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
    # The audio may be cached for a week: a rebuild re-encodes the takes, and a
    # fresh manifest exposes any file that no longer matches. The manifest
    # itself may NOT: its name never changes, and a week-old cached copy fed a
    # newer page an older pack -- the load finished "ready" and every
    # instrument the roster had gained quietly played the synthesiser. It is a
    # few kilobytes; revalidate it every time.
    cache = "no-cache" if target.name == "manifest.json" else "public, max-age=604800"
    return FileResponse(target, media_type=media,
                        headers={"Cache-Control": cache})


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