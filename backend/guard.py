"""backend/guard.py - the only place in the Python backend that may delete anything.

Mirrors tools/lib/guard.mjs, and the two are meant to stay in step. The rules:

    1. Never delete anything this repository did not create.
    2. Never delete anything outside the working folder.

The OMR engine needed the first one because it unlinked a stale MusicXML file
before each inference pass, and the second because its scratch directory was a
tempfile.TemporaryDirectory - a delete outside the working folder that happened on
every request, in a shared system directory, for a path the process did not own
by any receipt.

A directory is deletable only if it carries the marker written when the
directory is created. No marker, no delete - including for a path that looks
like ours, because "looks like our output" is how a stray request deletes
somebody's own folder.

The marker's name and format must match the JavaScript side; tools/
check-no-unguarded-deletes.mjs reads the same file to tell a claimed directory
from a claimed-about.
"""

from __future__ import annotations

import shutil
from contextlib import contextmanager
from pathlib import Path

#: The receipt written into every directory this repository creates. The name is
#: shared with tools/lib/guard.mjs -- one rule, one spelling.
MARKER = ".scoreforge-owned"

#: The working folder: the repository root, two levels above backend/.
ROOT = Path(__file__).resolve().parent.parent

_MARKER_TEXT = """Created by ScoreForge tooling.
Deleting this directory is safe; nothing here was not written by that run.
Do not put hand-written files in a claimed tree -- owned_tree() takes the
whole directory.

"""


class RefusedDelete(RuntimeError):
    """Raised when something asks to delete a directory the guard does not own."""


def _is_inside(parent: Path, child: Path) -> bool:
    """True when `child` is `parent` or lives under it.

    Compared with relative_to() rather than a string prefix, so that
    ``.../music-archive`` is not treated as living inside ``.../music``.
    """
    try:
        child.relative_to(parent)
    except ValueError:
        return False
    return True


def assert_in_workspace(target: Path | str, why: str = "delete") -> Path:
    """Resolve `target` and refuse it unless it is inside the working folder.

    Returns the resolved Path so callers act on the value that was checked; the
    gap between the string passed in and the path used is where a `..` segment
    turns a checked path into an unchecked one.
    """
    abs_path = Path(target).resolve()
    if not _is_inside(ROOT, abs_path):
        raise RefusedDelete(
            f"refusing to {why} {abs_path}\n"
            f"  it is outside the working folder ({ROOT})."
        )
    if abs_path == ROOT:
        raise RefusedDelete(f"refusing to {why} the working folder itself ({ROOT})")
    return abs_path


def is_owned(target: Path | str) -> bool:
    """True when `target` exists and carries our marker."""
    return (Path(target) / MARKER).is_file()


def claim_tree(target: Path | str, note: str = "") -> Path:
    """Create `target` and mark it as ours, ready to be replaced by a later run.

    Anything already inside is left alone until the tree is removed: this only
    guarantees the marker exists.
    """
    abs_path = assert_in_workspace(target, "create")
    abs_path.mkdir(parents=True, exist_ok=True)
    (abs_path / MARKER).write_text(_MARKER_TEXT + note + "\n", encoding="utf-8")
    return abs_path


def remove_owned_tree(target: Path | str, why: str = "remove") -> Path:
    """Delete `target` recursively, but only if it is ours and inside the working folder.

    Raises rather than returning a bool: every caller here is about to write into
    the directory, so a silently skipped delete turns into stale scratch files
    being carried forward and reported as fresh ones.
    """
    abs_path = assert_in_workspace(target, why)
    if not is_owned(abs_path):
        raise RefusedDelete(
            f"refusing to {why} {abs_path}\n"
            f"  no {MARKER} marker, so this directory was not created by this repository."
        )
    shutil.rmtree(abs_path)
    return abs_path


def remove_owned_file(target: Path | str, why: str = "remove") -> Path:
    """Delete a single file, but only from inside a tree this repository created.

    The directory rules apply to files too, and one real case needed them: the
    inference pass unlinks a MusicXML file left behind by a previous run before
    writing its own, because a crash in the middle of a pass otherwise leaves a
    stale result that the next request reads as fresh output. That is a
    legitimate deletion -- the file is ours -- so it is checked rather than
    forbidden: the file must sit inside the working folder, and some ancestor
    directory must carry the marker.

    A missing file is not an error. Callers use this to clear a path before
    writing it, and "already clear" is the state they wanted.
    """
    abs_path = Path(target).resolve()
    assert_in_workspace(abs_path.parent, why)
    if not abs_path.exists():
        return abs_path
    if not any(is_owned(parent) for parent in abs_path.parents):
        raise RefusedDelete(
            f"refusing to {why} {abs_path}\n"
            f"  it is not inside any directory carrying a {MARKER} marker, so this\n"
            f"  repository cannot show it created the tree it lives in."
        )
    abs_path.unlink()
    return abs_path


@contextmanager
def owned_tree(target: Path | str, note: str = ""):
    """A scratch directory that exists only for this block, and is ours to delete.

    The replacement for tempfile.TemporaryDirectory: same short-lived scratch
    space, but inside the working folder and carrying a receipt, so removing it
    is a claim-backed operation rather than a wildcard on a shared directory.
    """
    path = claim_tree(target, note)
    try:
        yield path
    finally:
        # A refusal raises out of the finally. That is intended: it means the
        # scratch directory could not be removed, and silently continuing would
        # leave it behind while reporting success.
        remove_owned_tree(path, "remove scratch directory")


def _selftest() -> int:
    """Prove the refusals, then be deleted by the test that ran it.

    Run as `python backend/guard.py`. A scan cannot tell whether this module
    refuses anything -- the same scan passes against a guard that permits
    everything -- so the refusals are exercised for real.

    The dangerous cases are tested through the pure predicates, never through a
    deletion: if the guard were completely broken, the worst outcome here is the
    loss of a throwaway tree this function created moments earlier.
    """
    fails: list[str] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        print(f"{'ok  ' if ok else 'FAIL'} {name}{'  ' + detail if detail else ''}")
        if not ok:
            fails.append(name)

    def refuses(fn) -> bool:
        try:
            fn()
        except RefusedDelete:
            return True
        except Exception:  # a different error is not a refusal
            return False
        return False

    import tempfile

    check("refuses a path outside the working folder",
          refuses(lambda: assert_in_workspace(Path(tempfile.gettempdir()) / "probe")))
    check("refuses the working folder itself", refuses(lambda: assert_in_workspace(ROOT)))
    check("refuses a sibling directory sharing a name prefix",
          refuses(lambda: assert_in_workspace(ROOT.parent / (ROOT.name + "-archive"))))
    assert_in_workspace(ROOT / ".tmp" / "anything")
    check("accepts a path inside the working folder", True)

    probe = ROOT / ".tmp" / "guard-py-probe"
    claimed = claim_tree(probe / "claimed", "throwaway")
    (probe / "unclaimed").mkdir(parents=True, exist_ok=True)
    keep = probe / "unclaimed" / "keep.txt"
    keep.write_text("x", encoding="utf-8")

    check("a claimed directory reports as owned", is_owned(claimed))
    check("an unclaimed directory does not report as owned", not is_owned(probe / "unclaimed"))
    check("refuses to delete a directory it did not create",
          refuses(lambda: remove_owned_tree(probe / "unclaimed", "probe")))
    check("the unclaimed directory survived the refusal", keep.is_file())

    # The file rule, tested the same way: the file has to actually be there, or
    # "did not get deleted" and "was never created" look identical.
    check("refuses to delete a file outside any claimed tree",
          refuses(lambda: remove_owned_file(keep, "probe")))
    check("the file survived that refusal too", keep.is_file())

    owned = probe / "claimed" / "f.txt"
    owned.write_text("x", encoding="utf-8")
    remove_owned_file(owned, "probe")
    check("deletes a file inside a claimed tree", not owned.exists())
    check("a missing file is not an error",
          remove_owned_file(owned, "probe") == owned)

    remove_owned_tree(claimed, "clean up claimed probe")
    check("deletes a directory it did create", not claimed.exists())
    claim_tree(probe, "throwaway parent")
    remove_owned_tree(probe, "clean up probe parent")
    check("probe parent cleaned up", not probe.exists())

    if fails:
        print("\nGUARDRAILS FAILED: " + "; ".join(fails))
        return 1
    print("backend guardrails OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(_selftest())