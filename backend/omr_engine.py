"""backend/omr_engine.py -- optical music recognition, CPU only.

Wraps `homr` (ONNX Runtime) so the rest of the backend never has to think
about model paths, thread safety, or its chatty stderr. Recognition is
strictly CPU: every execution provider is disabled for GPU and CoreML, so the
service runs on a machine with no graphics hardware at all.

The recogniser writes MusicXML. That is deliberate -- it is the same format the
frontend already parses for MusicXML uploads, so a scan drops straight into the
existing notation, playback and MP3 pipeline with no new code path.
"""

from __future__ import annotations

import io
import os
import re
import sys
import tempfile
import threading
import time
import xml.etree.ElementTree as ET
from contextlib import redirect_stderr
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional

import cv2
import numpy as np

from preprocess import Page, Variant, build_variants, encode_png, trim_border

ENGINE_NAME = "homr"
ENGINE_VERSION = "0.7.0"
DEVICE = "cpu"

_STEPS = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}

# homr is chatty on stderr; capture it instead of spraying the server log.
_warm_lock = threading.Lock()
_warm_state: dict = {"ready": False, "error": None, "seconds": 0.0}
_omr_lock = threading.Lock()  # onnxruntime sessions are not re-entrant here


@dataclass
class PageResult:
    index: int
    variant: str
    musicxml: str
    seconds: float
    variants_tried: List[dict] = field(default_factory=list)
    stats: dict = field(default_factory=dict)
    preview_png: Optional[bytes] = None
    log: List[str] = field(default_factory=list)


def _processing_config():
    from homr.main import ProcessingConfig

    # Every accelerator flag stays False. This is the whole CPU-only contract.
    return ProcessingConfig(
        enable_debug=False,
        enable_cache=False,
        write_staff_positions=False,
        read_staff_positions=False,
        selected_staff=-1,
        transformer_use_gpu=False,
        segnet_use_gpu=False,
        coreml_encoder=False,
    )


def warm_up() -> dict:
    """Download model weights once and build the inference session.

    Safe to call from any request: work happens under a lock and is skipped if
    it already succeeded.
    """
    if _warm_state["ready"]:
        return _warm_state
    with _warm_lock:
        if _warm_state["ready"]:
            return _warm_state
        t0 = time.perf_counter()
        try:
            from homr.main import download_weights

            log = io.StringIO()
            with redirect_stderr(log):
                download_weights(False, False, False)
            _warm_state.update(ready=True, seconds=time.perf_counter() - t0)
        except Exception as exc:  # surfaced through /api/health
            _warm_state.update(ready=False, error=f"{type(exc).__name__}: {exc}")
        return _warm_state


def summarise_musicxml(xml_text: str) -> dict:
    """Cheap structural summary of a MusicXML document for the UI report."""
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return {"valid": False}

    parts = root.findall("part")
    total_notes = 0
    total_rests = 0
    measures = 0
    staves = 0
    chords = 0
    midi_values: List[int] = []

    for part in parts:
        seen_staff: set = set()
        for measure in part.findall("measure"):
            measures += 1
            for note in measure.findall("note"):
                st = note.find("staff")
                if st is not None and st.text:
                    seen_staff.add(int(st.text))
                if note.find("chord") is not None:
                    chords += 1
                pitch = note.find("pitch")
                if pitch is None:
                    total_rests += 1
                    continue
                total_notes += 1
                step = (pitch.findtext("step") or "C").strip()
                alter = float(pitch.findtext("alter") or 0)
                octave = int(pitch.findtext("octave") or 4)
                midi_values.append(12 * (octave + 1) + _STEPS.get(step, 0) + int(round(alter)))
        staves = max(staves, len(seen_staff))

    tempo = None
    for sound in root.iter("sound"):
        if sound.get("tempo"):
            tempo = round(float(sound.get("tempo")), 2)
            break
    if tempo is None:
        per_min = root.find(".//per-minute")
        if per_min is not None:
            tempo = round(float(per_min.text), 2)

    fifths = None
    fifths_el = root.find(".//key/fifths")
    if fifths_el is not None:
        fifths = int(fifths_el.text)

    beats = root.find(".//time/beats")
    beat_type = root.find(".//time/beat-type")
    time_signature = None
    if beats is not None and beat_type is not None:
        time_signature = f"{beats.text}/{beat_type.text}"

    title_el = root.find(".//work-title")

    return {
        "valid": True,
        "parts": len(parts),
        "measures": measures,
        "staves": max(staves, len(parts)),
        "notes": total_notes,
        "rests": total_rests,
        "chords": chords,
        "tempo": tempo,
        "key_fifths": fifths,
        "time_signature": time_signature,
        "title": (title_el.text if title_el is not None else None),
        "lowest_midi": min(midi_values) if midi_values else None,
        "highest_midi": max(midi_values) if midi_values else None,
    }


def _run_variant(variant: Variant, workdir: Path,
                 on_line=None) -> tuple[Optional[str], List[str]]:
    """Run homr over one variant. Returns (musicxml_text, captured_log).

    homr narrates its work on stderr as it goes -- "Found 142 noteheads",
    "Writing XML", "Finished parsing 3 staves". That used to be collected into a
    StringIO and thrown away, which is why a page looked frozen: from the
    caller's side inference was one blocking call a minute long. The sink keeps
    the capture *and* forwards each line as it lands.
    """
    from homr.main import process_image
    from homr.music_xml_generator import XmlGeneratorArguments

    src = workdir / "page.png"
    cv2.imwrite(str(src), variant.image)
    out_xml = workdir / "page.musicxml"
    if out_xml.exists():
        out_xml.unlink()

    log = _LineForwarder(on_line)
    t0 = time.perf_counter()
    with redirect_stderr(log):
        process_image(str(src), _processing_config(), XmlGeneratorArguments())
    elapsed = time.perf_counter() - t0

    text = out_xml.read_text(encoding="utf-8", errors="replace") if out_xml.exists() else None
    tail = [line for line in log.getvalue().splitlines() if line.strip()]
    log_lines = [f"[{elapsed:.2f}s] {line}" for line in tail[-6:]]
    return text, log_lines


def _note_count(xml_text: Optional[str]) -> int:
    if not xml_text:
        return 0
    stats = summarise_musicxml(xml_text)
    return int(stats.get("notes", 0)) if stats.get("valid") else 0


class _LineForwarder(io.StringIO):
    """A stderr sink that keeps the capture and reports lines as they arrive.

    Subclasses StringIO so it is indistinguishable from the buffer it replaces --
    homr and ONNX Runtime already cope with one under redirect_stderr, and a
    hand-rolled object would risk missing some method they happen to call.

    The callback is a progress reporter, so a failure in it must never take the
    recognition down with it; a dropped tick costs a slightly stale bar, a raised
    exception costs the whole transcription.
    """

    def __init__(self, on_line=None):
        super().__init__()
        self._on_line = on_line
        self._pending = ""

    def write(self, s: str) -> int:
        super().write(s)
        self._pending += s
        # homr writes partial lines between messages, so only report on a
        # newline -- otherwise the bar ticks on every fragment of one message.
        while "\n" in self._pending:
            line, self._pending = self._pending.split("\n", 1)
            line = line.strip()
            if not line:
                continue
            if self._on_line is not None:
                try:
                    self._on_line(line)
                except Exception:  # noqa: BLE001 - progress must never break a read
                    pass
        return len(s)


# Lines that carry no information about how far along we are. The timing ones
# matter most: they print a raw float ("Segnet Inference time: 0.24294179992284626")
# which is noise to anyone waiting on a scan.
_IGNORED = (
    "Init finished",
    "Using Log Level",
    "Segnet Inference time",
    "Inference Time Tromr",
)

# homr's wording mapped to something worth putting on a progress bar. This is a
# nicety, not a contract: anything unrecognised falls through to _milestone, so
# a wording change upstream costs prettiness and nothing else.
#
# Order matters -- the first match wins, and several of these overlap.
# "Creating bounds for noteheads" has to be tested before "noteheads", or every
# notehead message is reported as the bounds step that preceded it.
_MILESTONES = (
    # Download progress, before any of the per-page work.
    ("Downloading", "Fetching the recognition model (first run only)"),
    ("Downloaded", "Fetching the recognition model (first run only)"),

    # Geometry pass: each of these is a real detection stage over the image.
    ("Creating bounds for noteheads", "Locating the noteheads"),
    ("Creating bounds for staff_fragments", "Locating the staff lines"),
    ("Creating bounds for clefs_keys", "Reading the clefs and keys"),
    ("Creating bounds for stems_rest", "Locating stems and rests"),
    ("Creating bounds for bar_lines", "Locating the bar lines"),
    ("Dewarping staff", "Straightening the staff"),
    # Before the " staffs" entry below: both of these mention staves but say
    # nothing about how many were found.
    ("Removing first system", "Dropping a partial first system"),
    ("Removing last system", "Dropping a partial last system"),

    # Inference. These repeat once per batch and once per staff, which is the
    # point -- each one is a unit of work that actually completed.
    ("Running TrOmr inference", "Reading the notes"),
    ("Starting Inference", "Recognising the music"),

    # Counts, most specific first. These come after the "Creating bounds for"
    # group because "Creating bounds for noteheads" contains "noteheads", and
    # testing the generic one first would report every bounds line as a count.
    ("staff line fragments", "Counted the staff lines"),
    ("staff anchors", "Anchoring the staves"),
    (" staffs", "Found the staves"),
    ("notes during segmentation", "Segmented the notes"),
    ("Average note head height", "Measuring the notes"),
    ("possible other clefs", "Checked for extra clefs"),
    ("noteheads", "Counted the noteheads"),
    ("bar lines", "Counted the bar lines"),
    ("Found title:", "Found the title"),

    # Output.
    ("Writing XML", "Writing the score"),
    ("Finished parsing", "Parsed the staves"),
    ("Result was written to", "Finishing the score"),
)


def _milestone(line: str) -> Optional[str]:
    """Turn one homr stderr line into progress text, or None to skip it."""
    if any(marker in line for marker in _IGNORED):
        return None
    for needle, text in _MILESTONES:
        if needle in line:
            return text
    # Anything homr says that we do not recognise still beats silence: the bar
    # moving is the point, and an unfamiliar line is at least a real event.
    # Paths are the only thing worth stripping, since they are long and mean
    # nothing to someone waiting.
    text = re.sub(r"[\w./\\:-]*page\.png", "the page", line)
    return text[:60] if text.strip() else None


# Each milestone consumes a shrinking share of what is left before the end of
# this variant's slice. It approaches CEILING and is clamped there, so the bar
# can never claim a variant is finished while homr is still running -- the
# caller snaps to the boundary only when the variant actually returns.
#
# The clamp is not decoration. An unclamped `x += (1 - x) * CREEP` reaches
# exactly 1.0 in float64 after ~25 steps and then stops moving entirely, which
# parks the bar on the variant boundary for the rest of the inference and
# recreates the frozen look this is meant to fix. Approaching a ceiling below 1
# leaves the final step to a real event.
CEILING = 0.95
_CREEP = 0.35


def transcribe_page(page: Page, mode: str = "auto", debug: bool = False,
                    progress=None) -> PageResult:
    """Recognise one page, trying each preprocessing variant and keeping the best.

    There is no confidence score to rank by, so note count is the proxy: a
    transform that erases staff lines reliably costs notes. Ties go to the
    earliest variant, i.e. the least-transformed rendering wins by default.

    `progress(fraction, message)` reports within this page, 0..1. Each variant is
    one full inference pass and they cost roughly the same, so the slice per
    variant is a real division of the work; the finer ticks *inside* a variant
    come from homr's own log lines, which say what it is doing but not how far
    through it is.
    """
    def report(fraction: float, message: str) -> None:
        if progress:
            progress(max(0.0, min(1.0, fraction)), message)

    report(0.01, "Starting the recognition engine")
    warm = warm_up()
    if not warm.get("ready"):
        raise RuntimeError(warm.get("error") or "recognition engine failed to initialise")

    report(0.04, "Preparing the page")
    variants = build_variants(page, mode=mode)
    report(0.08, f"Prepared {len(variants)} renderings to try")
    started = time.perf_counter()
    attempts: List[dict] = []
    best: Optional[tuple[int, int, str, List[str], Variant]] = None

    total = max(1, len(variants))
    span = 0.86 / total
    for index, variant in enumerate(variants):
        base = 0.08 + span * index
        report(base, f"Trying {variant.name} ({index + 1} of {total})")

        # Creep within this variant, driven by homr's log lines. `moved` is the
        # share of this slice already walked, held under CEILING.
        state = {"moved": 0.0}

        def on_line(line: str, _base=base, _span=span, _state=state,
                    _name=variant.name) -> None:
            text = _milestone(line)
            if text is None:
                return
            _state["moved"] = min(CEILING, _state["moved"] + (CEILING - _state["moved"]) * _CREEP)
            # Carry the variant on every tick, not just on the boundaries. The
            # boundary messages alone are not enough: homr's first log line
            # overwrites them within milliseconds, so a client polling a few
            # hundred milliseconds later never sees which rendering is running.
            report(_base + _span * _state["moved"], f"{_name}: {text}")

        with tempfile.TemporaryDirectory() as td:
            workdir = Path(td)
            # Serialise inference: one ONNX session per process, not per request.
            with _omr_lock:
                text, log_lines = _run_variant(variant, workdir, on_line=on_line)
        count = _note_count(text)
        report(base + span, f"{variant.name} read {count} notes")
        attempts.append({
            "variant": variant.name,
            "notes": count,
            "steps": variant.report.get("steps", {}),
            "log": log_lines if debug else [],
        })
        # (notes, -index) so earlier variants win ties.
        if text and (best is None or count > best[0]):
            best = (count, -index, text, log_lines, variant)

    if best is None:
        raise ValueError(
            "no music could be read from this page. Try a sharper, straighter, "
            "more evenly lit photo where the staves fill the frame."
        )

    report(0.96, "Building the score")
    _, neg_index, xml_text, log_lines, chosen = best
    # The preview is shown next to the transcription, so trim the blank paper
    # around the music -- a full A4 page of mostly white shrinks to an
    # unreadable strip in a panel this size. The recognition itself always ran
    # on the untrimmed image.
    preview, _ = trim_border(chosen.image)
    stats = summarise_musicxml(xml_text)
    report(0.99, "Done")
    return PageResult(
        index=page.index,
        variant=chosen.name,
        musicxml=xml_text,
        seconds=time.perf_counter() - started,
        variants_tried=attempts,
        stats=stats,
        preview_png=encode_png(preview),
        log=log_lines if debug else [],
    )


def health() -> dict:
    state = warm_up()
    return {
        "ok": bool(state.get("ready")),
        "engine": ENGINE_NAME,
        "version": ENGINE_VERSION,
        "device": DEVICE,
        "gpu": False,
        "notes": "ONNX Runtime, CPU execution provider only",
        "warmupSeconds": round(state.get("seconds", 0.0), 2),
        "error": state.get("error"),
    }