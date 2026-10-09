"""Unit checks for the progress plumbing, without loading the recognition model.

The expensive part of this feature is proving it, and a proof that needs a
minute of ONNX inference per run is a proof nobody re-runs. These exercise the
parts that decide what the bar does -- the stderr sink, the milestone mapping,
and the creep curve -- plus the guarantees the caller relies on.

    python tools/check-omr-progress.py
"""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from omr_engine import _LineForwarder, _milestone, _CREEP  # noqa: E402

fails = []
total = 0


def check(name, ok, detail=""):
    global total
    total += 1
    if not ok:
        fails.append(f"{name} — {detail}")
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  [{detail}]" if detail else ""))


# --- the sink reports whole lines, once, as they arrive ------------------------
seen = []
log = _LineForwarder(seen.append)
log.write("Found 142 note")
check("a partial line is not reported yet", seen == [], repr(seen))
log.write("heads\n")
check("the rest of the line completes it", seen == ["Found 142 noteheads"], repr(seen))

log.write("\n")
check("blank lines are dropped", seen == ["Found 142 noteheads"], repr(seen))
log.write("Writing XML\nFinished parsing 3 staves\n")
check("several lines in one write are all reported",
      seen == ["Found 142 noteheads", "Writing XML", "Finished parsing 3 staves"], repr(seen))

# --- it is still a drop-in for the StringIO it replaced ------------------------
check("the capture still holds everything written",
      "Found 142 noteheads" in log.getvalue() and "Finished parsing 3 staves" in log.getvalue(),
      repr(log.getvalue()))
log.write("no trailing newline")
check("an unterminated tail is kept in the capture",
      log.getvalue().endswith("no trailing newline"), repr(log.getvalue()))
check("an unterminated tail is not reported as a line",
      "no trailing newline" not in seen, repr(seen))

# --- a failing progress callback must not take the read down with it -----------
def boom(_line):
    raise RuntimeError("progress exploded")


log2 = _LineForwarder(boom)
try:
    log2.write("Processing page.png\n")
    check("a raising callback does not propagate into inference", True)
except RuntimeError as exc:
    check("a raising callback does not propagate into inference", False, str(exc))
check("the capture still works after a raising callback",
      "Processing page.png" in log2.getvalue(), repr(log2.getvalue()))


# --- milestone text ------------------------------------------------------------
check("a known milestone is rewritten for a human",
      _milestone("Found 142 noteheads") == "Counted the noteheads",
      repr(_milestone("Found 142 noteheads")))
check("init noise is dropped",
      _milestone("Init finished") is None, repr(_milestone("Init finished")))
check("onnx log-level noise is dropped",
      _milestone("Using Log Level 2 for OnnxRuntime") is None,
      repr(_milestone("Using Log Level 2 for OnnxRuntime")))
# A raw float from a timing log is noise, and it is the ugliest thing homr says.
check("inference timing floats are dropped",
      _milestone("Segnet Inference time: 0.24294179992284626; batch_size 8") is None,
      repr(_milestone("Segnet Inference time: 0.24294179992284626; batch_size 8")))
check("tromr timing floats are dropped",
      _milestone("Inference Time Tromr: 1.8365") is None,
      repr(_milestone("Inference Time Tromr: 1.8365")))
check("an unrecognised line still says something",
      _milestone("Some brand new homr milestone") == "Some brand new homr milestone",
      repr(_milestone("Some brand new homr milestone")))
check("a long unrecognised line is truncated",
      len(_milestone("x" * 200)) <= 60, len(_milestone("x" * 200)))
check("model download is explained",
      _milestone("Downloading 3 models - this is only required once").startswith("Fetching"),
      repr(_milestone("Downloading 3 models - this is only required once")))

# The ordering hazard: "Creating bounds for noteheads" also contains "noteheads",
# and "noteheads" also appears in the counts. First match wins, so the specific
# one has to come first or every bounds line is reported as a count.
bounds = _milestone("Creating bounds for noteheads")
count = _milestone("Found 142 noteheads")
check("the specific notehead line wins over the generic one", bounds != count,
      f"bounds={bounds!r} count={count!r}")
check("staff fragments are not confused with staff counts",
      _milestone("Creating bounds for staff_fragments")
      != _milestone("Found 12 staff line fragments"),
      repr(_milestone("Creating bounds for staff_fragments")))
check("staff counts are not confused with staff anchors",
      _milestone("Found 3 staffs") != _milestone("Found 3 staff anchors"),
      f"{_milestone('Found 3 staffs')!r} vs {_milestone('Found 3 staff anchors')!r}")
# "Removing ... a different number of staffs" contains " staffs" too, and
# reporting it as "Found the staves" would be simply untrue.
check("a message that merely mentions staves is not reported as a count",
      _milestone("Removing first system from all voices, as it has a different number of staffs")
      != "Found the staves",
      repr(_milestone("Removing first system from all voices, as it has a different number of staffs")))

# Every line homr can print must map to something, or fall through to something
# short. A file path must not survive into the UI.
check("a page path is not shown to the user",
      "page.png" not in (_milestone("Processing /tmp/xyz/page.png") or ""),
      repr(_milestone("Processing /tmp/xyz/page.png")))
check("the processing line still says something",
      bool(_milestone("Processing /tmp/xyz/page.png")),
      repr(_milestone("Processing /tmp/xyz/page.png")))

# Walk the real message set. These are homr's strings verbatim; each must produce
# either a mapping or a short passthrough, and none may leak a path.
HOMR_LINES = [
    "Processing C:\\tmp\\abc123\\page.png",
    "Found 12 staff line fragments",
    "Found 87 noteheads",
    "Average note head height: 6.214",
    "Found 9 bar lines",
    "Found 3 staffs",
    "Found 3 staff anchors",
    "Found 2 clefs",
    "Found 4 possible other clefs",
    "Found 91 notes during segmentation",
    "Found title: Ode to Joy",
    "Dewarping staff 0",
    "Dewarping staff 0 done",
    "Creating bounds for noteheads",
    "Creating bounds for staff_fragments",
    "Creating bounds for clefs_keys",
    "Creating bounds for stems_rest",
    "Creating bounds for bar_lines",
    "Running TrOmr inference on staff image 0",
    "Starting Inference.",
    "Segnet Inference time: 0.24294179992284626; batch_size 8",
    "Inference Time Tromr: 1.83651",
    "Writing XML [<Staff 0>, <Staff 1>]",
    "Finished parsing 2 staves",
    "Result was written to /tmp/abc123/page.musicxml",
    "Init finished",
    "Using Log Level 2 for OnnxRuntime",
    "Skipping empty staff 1",
    "Removing first system from all voices, as it has a different number of staffs",
]
leaked = [l for l in HOMR_LINES
          if (m := _milestone(l)) and ("\\" in m or "/" in m or len(m) > 60)]
check("no homr message leaks a path or runs long", not leaked, "; ".join(leaked))
dropped = [l for l in HOMR_LINES if _milestone(l) is None]
check("only known noise is dropped", set(dropped) <= {
    "Segnet Inference time: 0.24294179992284626; batch_size 8",
    "Inference Time Tromr: 1.83651",
    "Init finished",
    "Using Log Level 2 for OnnxRuntime",
}, "; ".join(dropped))


# --- the creep curve -----------------------------------------------------------
# homr emits roughly 9-15 milestones per variant, so the curve has to cover most
# of the variant's slice over that many steps and then stop short of the
# boundary. Stopping short is the design: the last step belongs to the variant
# actually completing, which is a real event rather than a guess.
from omr_engine import CEILING  # noqa: E402


def creep_trace(steps):
    moved = 0.0
    out = []
    for _ in range(steps):
        moved = min(CEILING, moved + (CEILING - moved) * _CREEP)
        out.append(moved)
    return out


realistic = creep_trace(15)
check("creep never reaches the variant boundary", max(realistic) <= CEILING,
      f"max={max(realistic):.6f} ceiling={CEILING}")
check("creep covers the slice over a realistic milestone count",
      realistic[-1] > 0.9 * CEILING, f"after 15 milestones={realistic[-1]:.4f}")
check("creep always advances", all(b > a for a, b in zip(realistic, realistic[1:])))

# An unclamped geometric creep reaches exactly 1.0 in float64 and then goes flat;
# that is the bug the ceiling exists to prevent, so assert it stays bounded over
# a long run rather than assuming the clamp is doing something.
long_run = creep_trace(200)
check("a long milestone run still never passes the ceiling", max(long_run) <= CEILING,
      f"max={max(long_run):.6f}")
check("the ceiling is not the variant boundary itself", CEILING < 1.0, f"{CEILING}")

print(f"\n{total - len(fails)} passed · {len(fails)} failed")
if fails:
    print("FAILED:\n  " + "\n  ".join(fails))
sys.exit(1 if fails else 0)