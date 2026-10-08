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


def _run_variant(variant: Variant, workdir: Path) -> tuple[Optional[str], List[str]]:
    """Run homr over one variant. Returns (musicxml_text, captured_log)."""
    from homr.main import process_image
    from homr.music_xml_generator import XmlGeneratorArguments

    src = workdir / "page.png"
    cv2.imwrite(str(src), variant.image)
    out_xml = workdir / "page.musicxml"
    if out_xml.exists():
        out_xml.unlink()

    log = io.StringIO()
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


def transcribe_page(page: Page, mode: str = "auto", debug: bool = False) -> PageResult:
    """Recognise one page, trying each preprocessing variant and keeping the best.

    There is no confidence score to rank by, so note count is the proxy: a
    transform that erases staff lines reliably costs notes. Ties go to the
    earliest variant, i.e. the least-transformed rendering wins by default.
    """
    warm = warm_up()
    if not warm.get("ready"):
        raise RuntimeError(warm.get("error") or "recognition engine failed to initialise")

    variants = build_variants(page, mode=mode)
    started = time.perf_counter()
    attempts: List[dict] = []
    best: Optional[tuple[int, int, str, List[str], Variant]] = None

    for index, variant in enumerate(variants):
        with tempfile.TemporaryDirectory() as td:
            workdir = Path(td)
            # Serialise inference: one ONNX session per process, not per request.
            with _omr_lock:
                text, log_lines = _run_variant(variant, workdir)
        count = _note_count(text)
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

    _, neg_index, xml_text, log_lines, chosen = best
    # The preview is shown next to the transcription, so trim the blank paper
    # around the music -- a full A4 page of mostly white shrinks to an
    # unreadable strip in a panel this size. The recognition itself always ran
    # on the untrimmed image.
    preview, _ = trim_border(chosen.image)
    return PageResult(
        index=page.index,
        variant=chosen.name,
        musicxml=xml_text,
        seconds=time.perf_counter() - started,
        variants_tried=attempts,
        stats=summarise_musicxml(xml_text),
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