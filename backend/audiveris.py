"""backend/audiveris.py -- optional second engine, run as a CLI sidecar.

Audiveris (github.com/Audiveris/audiveris, AGPL-3.0 like homr) is the one
other maintained open engine that emits MusicXML, and its strengths are the
mirror of homr's: a classical segmentation pipeline tuned for flat printed
scans, with OCR-backed LYRICS -- the layer homr drops entirely. Multi-engine
combination is the best-evidenced accuracy lever in the OMR literature
(Padilla et al., ISMIR 2015, roughly halved error rates), and two engines
with decorrelated failure modes beat four renderings through one engine.

The sidecar is entirely optional. It is found through $SCOREFORGE_AUDIVERIS
(the launcher script or binary) or `audiveris` on PATH; where neither
exists, available() is False and the pipeline is exactly what it was.
Install: download a release from github.com/Audiveris/audiveris/releases
(releases only -- audiveris.com/.net are unaffiliated scam sites), unpack,
and point SCOREFORGE_AUDIVERIS at bin/Audiveris.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import zipfile
from pathlib import Path
from typing import Optional

import cv2
import numpy as np

# A page through Audiveris on a CPU is tens of seconds; the Java launcher
# adds a few more. Well under homr's own per-page minutes, but bounded.
_TIMEOUT = int(os.environ.get("SCOREFORGE_AUDIVERIS_TIMEOUT", "600"))


def find_audiveris() -> Optional[str]:
    """The Audiveris launcher to run, or None when none is installed."""
    configured = os.environ.get("SCOREFORGE_AUDIVERIS", "").strip()
    if configured:
        return configured if Path(configured).exists() else None
    return shutil.which("audiveris") or shutil.which("Audiveris")


def available() -> bool:
    return find_audiveris() is not None


def _read_export(outdir: Path) -> Optional[str]:
    """The MusicXML Audiveris wrote, wherever in the output tree it landed.

    -export writes <stem>.mxl (compressed MusicXML) by default, sometimes a
    bare .xml, and nests them in a folder named after the input. .mvn/.omr
    project files sit alongside and are not scores.
    """
    for mxl in sorted(outdir.rglob("*.mxl")):
        with zipfile.ZipFile(mxl) as z:
            names = [n for n in z.namelist()
                     if n.lower().endswith(".xml") and not n.startswith("META-INF")]
            if not names:
                continue
            return z.read(names[0]).decode("utf-8", errors="replace")
    for xml in sorted(outdir.rglob("*.xml")):
        if "META-INF" in xml.parts:
            continue
        text = xml.read_text(encoding="utf-8", errors="replace")
        if "<score-partwise" in text or "<score-timewise" in text:
            return text
    return None


def transcribe(image: np.ndarray, workdir: Path) -> str:
    """Run one page through Audiveris headless; returns MusicXML text.

    Raises on any failure -- a missing launcher, a crash, a timeout, or an
    export with no score in it -- with the process's own words where there
    are any. The caller treats this engine as best-effort.
    """
    launcher = find_audiveris()
    if not launcher:
        raise RuntimeError("Audiveris is not installed")

    workdir = Path(workdir)
    src = workdir / "page.png"
    outdir = workdir / "out"
    outdir.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(src), image):
        raise RuntimeError("could not write the page image for Audiveris")

    proc = subprocess.run(
        [launcher, "-batch", "-transcribe", "-export",
         "-output", str(outdir), "--", str(src)],
        capture_output=True, text=True, timeout=_TIMEOUT,
    )
    text = _read_export(outdir)
    if text is None:
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-4:]
        detail = "; ".join(line.strip() for line in tail if line.strip())
        raise RuntimeError(
            f"Audiveris exported no score (exit {proc.returncode}"
            + (f": {detail}" if detail else "") + ")"
        )
    return text
