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
deploy/install.sh installs it under $PREFIX/audiveris and sets
SCOREFORGE_AUDIVERIS for the service. By hand: download a release from
github.com/Audiveris/audiveris/releases (releases only -- audiveris.com/.net
are unaffiliated scam sites), unpack, and point SCOREFORGE_AUDIVERIS at
bin/Audiveris.

Two things the service's sandbox would otherwise break, both handled by
_child_env():

  * Audiveris writes its log and config under $HOME (or $XDG_*), and the
    service account has no home (ProtectHome=true, no home directory). When
    $HOME is not a writable directory the child gets one inside the per-call
    scratch directory, which owned_tree() removes afterwards. Tesseract's
    native libraries are a separate matter: JavaCPP takes the home from the
    user database rather than $HOME, finds it unwritable and unpacks them to
    /tmp/.javacpp-<user> instead -- the service's own PrivateTmp, so they
    load and act as a cache until the next restart.
  * Without OCR language data Audiveris reads no lyrics at all, and lyrics
    are most of the reason to run it. The installer puts that data in
    <install>/tessdata next to bin/, and the child is pointed at it through
    TESSDATA_PREFIX unless the environment already names one.
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


def bundled_tessdata(launcher: str) -> Optional[Path]:
    """The OCR language folder installed beside this launcher, if there is one.

    The installer lays Audiveris out as <root>/bin/Audiveris with the language
    data in <root>/tessdata. resolve() first, so a launcher reached through a
    symlink on PATH still finds the folder next to the real one.
    """
    root = Path(launcher).resolve().parent.parent
    folder = root / "tessdata"
    return folder if any(folder.glob("*.traineddata")) else None


def _child_env(workdir: Path, launcher: str) -> dict:
    """The environment to run Audiveris in. See the module docstring."""
    env = dict(os.environ)
    home = env.get("HOME", "")
    if not (home and os.path.isdir(home) and os.access(home, os.W_OK)):
        fake = workdir / "home"
        fake.mkdir(parents=True, exist_ok=True)
        env["HOME"] = str(fake)
        # Audiveris reads these before falling back to $HOME, so an inherited
        # value pointing somewhere unwritable would defeat the new HOME.
        env["XDG_CONFIG_HOME"] = str(fake / ".config")
        env["XDG_CACHE_HOME"] = str(fake / ".cache")
        env["XDG_DATA_HOME"] = str(fake / ".local" / "share")
    if not env.get("TESSDATA_PREFIX"):
        tessdata = bundled_tessdata(launcher)
        if tessdata is not None:
            env["TESSDATA_PREFIX"] = str(tessdata)
    return env


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
        env=_child_env(workdir, launcher),
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
