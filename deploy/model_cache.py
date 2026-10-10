#!/usr/bin/env python3
"""Keep homr's ONNX weights across a virtualenv rebuild.

`homr` puts its model files *inside its own installed package* -- see
`homr/segmentation/config.py`, where `script_location` is the directory of
`__file__`. That means they live under `site-packages/homr/...`, so they live
inside the venv.

deploy/install.sh deletes and recreates the venv on every run, because a venv
whose `bin/python` points at a removed interpreter cannot be repaired in place.
So every install threw away 157 MB of weights and downloaded them again --
`download_weights()` is correctly written to skip files that already exist, and
every time it was asked, they did not.

This script copies those weights to a cache that lives outside the venv and puts
them back afterwards, so the second install finds them where it looks.

    model-cache.py save    --venv DIR --cache DIR
    model-cache.py restore --venv DIR --cache DIR

Both are pure filesystem work and import nothing from homr, which matters: the
`save` runs before the old venv is deleted and must still work when that venv is
already broken -- which is the very case that made the installer delete it.

Filenames carry upstream content hashes (`segnet_308-3296ccd4....onnx`), so a
name match is a content match. Size is checked as well, because a copy
interrupted by a reboot is the other way a "cached" file turns out to be wrong.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path

# homr's package root, identified by the two files that are always in it. The
# .onnx files cannot be the marker: `restore` runs against a freshly built venv
# that has homr installed and no weights yet, which is exactly the case where
# there is nothing to find by looking for weights.
MARKERS = ("__init__.py", "segmentation/config.py")


def find_homr(venv: Path) -> Path | None:
    """The installed `homr` package directory inside `venv`, if there is one.

    sorted(), because rglob walks in whatever order the filesystem hands back,
    and a real site-packages holds hundreds of __init__.py files. Unsorted, the
    answer would depend on directory order and could land on some other package
    -- which then has no .onnx files, so the cache silently preserves nothing.
    """
    if not venv.is_dir():
        return None
    found: list[Path] = []
    for marker in MARKERS:
        for hit in sorted(venv.rglob(marker)):
            pkg = hit.parent
            if pkg.name != "homr":
                continue
            found.append(pkg)
            break
    return found[0] if found else None


def sizes_differ(a: Path, b: Path) -> bool:
    try:
        return a.stat().st_size != b.stat().st_size
    except OSError:
        return True


def copy_verified(src: Path, dst: Path) -> None:
    """Copy, then check the result is the size we expected.

    A plain shutil.copy2 that is interrupted leaves a short file, and the next
    run sees the file exists and skips it -- so the "cached" weight is silently
    truncated and inference fails much later with an opaque ONNX error. Copying
    to a temporary name and renaming means a partial file is never visible under
    the name the rest of the system looks for.
    """
    dst.parent.mkdir(parents=True, exist_ok=True)
    want = src.stat().st_size
    tmp = dst.with_name(dst.name + ".part")
    shutil.copy2(src, tmp)
    got = tmp.stat().st_size
    if got != want:
        tmp.unlink()
        raise RuntimeError(f"{src} -> {dst}: copied {got} bytes, expected {want}")
    os.replace(tmp, dst)


def save(venv: Path, cache: Path) -> int:
    """Copy the weights out of `venv` and into `cache`. Returns bytes preserved."""
    homr = find_homr(venv)
    if homr is None:
        return 0
    kept = 0
    for weight in sorted(homr.rglob("*.onnx")):
        dst = cache / weight.relative_to(homr)
        if dst.exists() and not sizes_differ(dst, weight):
            continue
        copy_verified(weight, dst)
        kept += weight.stat().st_size
    return kept


def restore(venv: Path, cache: Path) -> tuple[int, int]:
    """Put cached weights back into `venv`. Returns (files restored, bytes)."""
    homr = find_homr(venv)
    if homr is None or not cache.is_dir():
        return (0, 0)
    restored = 0
    total = 0
    for weight in sorted(cache.rglob("*.onnx")):
        dst = homr / weight.relative_to(cache)
        if dst.exists() and not sizes_differ(dst, weight):
            continue
        copy_verified(weight, dst)
        restored += 1
        total += weight.stat().st_size
    return (restored, total)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("action", choices=("save", "restore"))
    ap.add_argument("--venv", required=True, type=Path)
    ap.add_argument("--cache", required=True, type=Path)
    args = ap.parse_args(argv)

    try:
        if args.action == "save":
            kept = save(args.venv, args.cache)
            print(f"kept {kept} bytes of weights from the previous install")
        else:
            files, total = restore(args.venv, args.cache)
            print(f"restored {files} weight file(s), {total} bytes")
    except OSError as e:
        # Not fatal. The installer carries on to download_weights(), which is the
        # correct fallback -- failing the whole install over a cache problem would
        # be worse than spending the bandwidth again.
        print(f"warning: model cache {args.action} failed: {e}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())