#!/usr/bin/env python3
"""Prove the installer's model cache actually prevents a re-download.

The bug this checks for is not a crash. install.sh deletes and rebuilds the
virtualenv on every run, because a venv whose `bin/python` points at a removed
interpreter cannot be repaired in place -- and homr keeps its ONNX weights
*inside its own installed package*, so the rebuild threw away 157 MB that
download_weights() was then asked to fetch again. Everything still worked; it
just paid the bandwidth on every single install.

So the test is a rebuild, end to end, against a fake venv: populate it, cache
the weights, delete the whole thing, rebuild it empty, restore, and require the
weights back byte for byte.

The last block asks homr itself which files it looks for, rather than trusting
this file's table -- the same names now live in three places, and a silent
mismatch between them is how a real bug hides. It is the one block that needs
homr installed, so it prints a `skip` line rather than failing without it.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "deploy"))

# The guard, not shutil: this script deletes trees, and the one rule this
# repository works under is that every delete goes through it.
from guard import (  # noqa: E402
    claim_tree,
    owned_tree,
    remove_owned_file,
    remove_owned_tree,
)

import model_cache  # noqa: E402

# The three files download_weights(False, False, False) needs, at the relative
# paths they sit at inside the homr package. Deliberately different sizes, so a
# size comparison that is not actually happening cannot pass by accident.
SEG = "segmentation/segnet_308-3296ccd40960f90ca6ab9c035cca945675d30a0f.onnx"
ENC = "transformer/encoder_pytorch_model_396-f6feedb42ff90087d898b0941a55d040fa6b2903.onnx"
DEC = "transformer/decoder_pytorch_model_396-f6feedb42ff90087d898b0941a55d040fa6b2903.onnx"
WEIGHTS = {SEG: b"segnet" * 4096, ENC: b"encoder" * 3000, DEC: b"decoder" * 2048}
TOTAL = sum(len(d) for d in WEIGHTS.values())

FAILS: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'ok  ' if ok else 'FAIL'} {name}{'  ' + detail if detail else ''}")
    if not ok:
        FAILS.append(name)


def homr_dir(venv: Path) -> Path:
    return venv / "lib" / "python3.12" / "site-packages" / "homr"


def build_venv(venv: Path, *, weights: bool) -> Path:
    """A stand-in for a pip-installed homr, with or without its model files.

    The `.py` files are the markers find_homr() looks for, so that a rebuilt
    venv looks exactly like a fresh install -- the only state in which a cache
    is worth anything.

    The decoy package is the point of this being more than one directory: a real
    site-packages holds numpy, cv2 and a hundred others, every one of them with
    an __init__.py. find_homr() has to pick homr's out of that, and it sorts, so
    naming this one so it comes first makes a wrong choice deterministic instead
    of a matter of which order the filesystem happened to return.
    """
    site = venv / "lib" / "python3.12" / "site-packages"
    decoy = site / "aaa_decoy"
    decoy.mkdir(parents=True, exist_ok=True)
    (decoy / "__init__.py").write_text("", encoding="utf-8")
    (decoy / "not_a_model-0000.onnx").write_bytes(b"decoy")

    pkg = homr_dir(venv)
    for sub in ("segmentation", "transformer"):
        (pkg / sub).mkdir(parents=True, exist_ok=True)
        (pkg / sub / "__init__.py").write_text("", encoding="utf-8")
    (pkg / "__init__.py").write_text("", encoding="utf-8")
    (pkg / "segmentation" / "config.py").write_text(
        "import os\nscript_location = os.path.dirname(os.path.realpath(__file__))\n",
        encoding="utf-8",
    )
    if weights:
        for rel, data in WEIGHTS.items():
            (pkg / rel).write_bytes(data)
    return pkg


def state(root: Path) -> dict[str, bytes]:
    """Every .onnx under `root`, keyed by path relative to it."""
    if not root.is_dir():
        return {}
    return {f.relative_to(root).as_posix(): f.read_bytes() for f in root.rglob("*.onnx")}


def parts(root: Path) -> list[Path]:
    return list(root.rglob("*.part")) if root.is_dir() else []


with owned_tree(ROOT / ".tmp" / "model-cache-check", "model cache round-trip") as scratch:
    venv = scratch / "venv"
    cache = scratch / "cache"

    # --- 1. a first install leaves weights behind, and the next one finds them.
    claim_tree(venv, "fake venv")
    pkg = build_venv(venv, weights=True)
    kept = model_cache.save(venv, cache)
    check("save lifts the weights out of the venv", state(cache) == WEIGHTS,
          f"{kept} bytes across {len(state(cache))} file(s)")
    check("save leaves the originals alone", state(pkg) == WEIGHTS)

    # --- 2. the rebuild. This is the step that used to lose them.
    remove_owned_tree(venv, "simulate install.sh rm -rf $VENV")
    claim_tree(venv, "rebuilt venv")
    build_venv(venv, weights=False)
    check("a rebuilt venv really is empty of weights", state(pkg) == {})

    got = model_cache.restore(venv, cache)
    check("restore puts every weight back", state(pkg) == WEIGHTS, f"{got[0]} file(s)")
    check("restore reports the count and the bytes", got == (len(WEIGHTS), TOTAL),
          f"returned {got}, expected {(len(WEIGHTS), TOTAL)}")

    # --- 3. a third install must not re-copy what is already correct.
    again = model_cache.restore(venv, cache)
    check("restore is idempotent", again == (0, 0), f"second call returned {again}")

    # --- 4. short files. download_weights() decides with os.path.exists and
    # nothing else, so a truncated weight that happens to sit at the right path
    # is skipped forever, and inference fails much later with an opaque ONNX
    # error a long way from the copy that was interrupted.
    (pkg / SEG).write_bytes(b"trunc")
    (pkg / ENC).write_bytes(b"x")
    got = model_cache.restore(venv, cache)
    check("restore replaces a truncated weight", state(pkg) == WEIGHTS, f"restored {got[0]}")

    # A cache entry damaged from outside -- a reboot mid-copy, a full disk. The
    # size check compares cache against venv, so it catches a short file *in the
    # venv* given a good cache; it cannot catch a bad cache, because the cache is
    # the last remaining reference to those bytes. What must hold is that
    # restore reproduces it faithfully rather than papering over it, and puts it
    # where download_weights looks, so the real download still gets a chance to
    # run and repair it.
    (cache / DEC).write_bytes(b"short")
    remove_owned_file(pkg / DEC, "remove the decoder to force a restore")
    got = model_cache.restore(venv, cache)
    check("restore reproduces a damaged cache entry faithfully",
          state(pkg)[DEC] == b"short", f"restored {got[0]} file(s)")
    check("a damaged cache entry still lands on the path homr checks",
          (pkg / DEC).exists())

    # --- 5. what must not happen.
    check("no .part debris anywhere after a full round trip",
          not parts(pkg) and not parts(cache),
          f"{[p.name for p in parts(pkg) + parts(cache)]}")

    stray = cache / (ENC + ".part")
    stray.write_bytes(b"interrupted")
    check("a .part in the cache is not mistaken for the weight",
          model_cache.restore(venv, cache) == (0, 0)
          and (pkg / ENC).exists()
          and not list(pkg.rglob("*.part")))
    remove_owned_file(stray, "remove test debris")

    # --- 6. the shapes a real first install has: nothing to keep, nothing to
    # give back. None of these may raise -- they all run before the venv exists
    # or before anything has been downloaded.
    check("no venv at all: save is a no-op",
          model_cache.save(scratch / "no-such-venv", scratch / "other-cache") == 0)
    check("no venv at all: restore is a no-op",
          model_cache.restore(scratch / "no-such-venv", cache) == (0, 0))
    check("no cache at all: restore is a no-op",
          model_cache.restore(venv, scratch / "no-such-cache") == (0, 0))

    empty = scratch / "empty-venv"
    claim_tree(empty, "venv with no homr installed")
    (empty / "lib").mkdir()
    check("a venv where homr is absent: restore is a no-op",
          model_cache.restore(empty, cache) == (0, 0))

# --- 7. Ask homr what it looks for, rather than trusting the table above.
try:
    from unittest.mock import patch

    import homr
    import homr.main as hm
except Exception as e:  # noqa: BLE001 -- any import failure means "not available"
    print(f"skip  homr cross-check: {type(e).__name__}: {e}")
else:
    real = Path(homr.__file__).resolve().parent
    asked: list[str] = []

    def spy(p) -> bool:
        # Report every path as present so download_weights() computes an empty
        # `missing_models` and returns without touching the network. What this
        # test wants is the list it consulted, not the download it would do.
        asked.append(str(p))
        return True

    with patch("os.path.exists", side_effect=spy):
        hm.download_weights(False, False, False)

    inside = [p for p in asked if real in Path(p).resolve().parents]
    check("homr looks for its weights inside its own package",
          len(inside) == len(asked) and len(asked) == 3,
          f"{len(asked)} path(s) consulted, {len(asked) - len(inside)} outside")
    check("the cache covers exactly the files homr wants",
          {Path(p).relative_to(real).as_posix() for p in asked} == set(WEIGHTS),
          "wants " + ", ".join(sorted(Path(p).name for p in asked)))

    shipped = sorted(real.rglob("*.onnx"))
    if shipped:
        mb = sum(f.stat().st_size for f in shipped) / 1e6
        print(f"ok    homr holds {len(shipped)} weight file(s), {mb:.1f} MB, "
              f"all of which this cache carries across a rebuild")
    else:
        print("ok    no weights downloaded on this machine yet; the paths above "
              "were still checked")

if FAILS:
    print("\nMODEL CACHE FAILED: " + "; ".join(FAILS))
    raise SystemExit(1)
print("model cache OK")