"""Check that the recognition gate really admits one job at a time.

`npm test` runs this; `tools/check-omr-jobs.py` checks the same thing over HTTP
with the real engine, which needs a running backend and minutes of CPU. This
one needs neither, because the gate is the part that can be wrong on its own.

The property that matters is concurrency, not bookkeeping: N threads asking for
the gate, and the counter of how many hold it at once never exceeding 1. A gate
that handed out slots in arrival order but let two threads through would still
report correct positions and would still pass anything that only looks at the
queue.

    python tools/check-omr-queue.py
"""

from __future__ import annotations

import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

# The gate lives in app.py, whose import drags in the backend's web stack.
# Where that stack is not installed -- a CI runner without the backend
# requirements, a checkout without the venv -- this check cannot run, and the
# honest verdict is a loud skip, not a failure: the gate is exercised wherever
# the deps exist (the dev host, and CI once it installs the light backend
# deps). Skipped is exit 0 with a reason, mirroring the pack checks that skip
# without the FreePats sources rather than failing or silently passing.
import importlib.util

_missing = [m for m in ("fastapi", "cv2", "numpy") if importlib.util.find_spec(m) is None]
if _missing:
    print(f"skip  omr queue: backend deps not installed ({', '.join(_missing)}) -- "
          "pip install fastapi python-multipart opencv-python-headless numpy to run it")
    raise SystemExit(0)

import app  # noqa: E402

fails: list[str] = []


def eq(name, actual, expected):
    check(name, actual == expected, f"expected {expected!r}, got {actual!r}")


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'ok  ' if ok else 'FAIL'} {name}{'  ' + detail if detail else ''}")
    if not ok:
        fails.append(name)


# --- 1. positions ------------------------------------------------------------
g = app._Gate()
check("an idle gate is handed to the first ticket", g.try_acquire("a") is True)
check("a second ticket does not get in while one holds it", g.try_acquire("b") is False)
# In its own thread: acquire() blocks until it is its turn, and "a" is not
# going to be released until this thread is already waiting on it.
waiter = threading.Thread(target=g.acquire, args=("b",), daemon=True)
waiter.start()
for _ in range(50):
    if g.queue_length() == 1:
        break
    time.sleep(0.02)
check("the waiting ticket is 1st in line", g.position("b") == 1,
      f"position={g.position('b')}")
check("the ticket holding the gate has no place in line", g.position("a") is None)
check("one job waiting", g.queue_length() == 1)
g.release("a")
waiter.join(timeout=5)
check("releasing hands over to the next in line", g.position("b") is None)
check("the queue is empty once it is admitted", g.queue_length() == 0)
check("the admitted ticket is the holder", g.holder() == "b", f"{g.holder()}")
g.release("b")
check("the gate is idle again", g.holder() is None and g.queue_length() == 0)

# --- 2. dropping a waiting ticket --------------------------------------------
g = app._Gate()
g.try_acquire("running")
threads = []
served: list[str] = []


def waiter(name: str) -> None:
    """Take a turn, hold it briefly, hand it on.

    Releasing from inside the thread is the point: it exercises the whole
    hand-over chain, and it leaves the gate empty without the test having to
    release tickets nobody is holding.
    """
    if g.acquire(name):
        served.append(name)
        time.sleep(0.01)
        g.release(name)


for name in ("q1", "q2", "q3"):
    t = threading.Thread(target=waiter, args=(name,), daemon=True)
    t.start()
    threads.append(t)
    time.sleep(0.05)          # arrival order must be deterministic
check("three jobs queue in arrival order",
      (g.position("q1"), g.position("q2"), g.position("q3")) == (1, 2, 3),
      f"{(g.position('q1'), g.position('q2'), g.position('q3'))}")
before = g.position("q3")
check("dropping a waiting ticket says it did", g.drop("q2") is True)
check("the dropped ticket leaves the line", g.position("q2") is None,
      f"position={g.position('q2')}")
check("the ones behind it move up",
      (g.position("q1"), g.position("q3")) == (1, 2),
      f"{(g.position('q1'), g.position('q3'))}")
check("the queue is one shorter than it was", g.queue_length() == before - 1,
      f"{g.queue_length()} vs {before}")
check("dropping a job that is not waiting says so", g.drop("q2") is False)
g.release("running")
for t in threads:
    t.join(timeout=5)
check("every waiting thread is released once the gate frees",
      g.queue_length() == 0 and g.holder() is None, f"holder={g.holder()}")
check("the cancelled job never reached the gate", "q2" not in served,
      f"served={served}")
check("the others still got their turn", served == ["q1", "q3"], f"served={served}")

# --- 3. the property that actually matters -----------------------------------
# Ten threads, staggered arrival, each holding the gate briefly. The counter is
# incremented and decremented inside the gate, so an overlap shows up as a
# number above 1 -- which is exactly the bug a queue-position check cannot see.
g = app._Gate()
inside = 0
peak = 0
order: list[str] = []
lock = threading.Lock()
N = 10


def worker(i: int) -> None:
    global inside, peak
    ticket = f"job{i:02d}"
    time.sleep(i * 0.01)        # staggered, so arrival order is unambiguous
    g.acquire(ticket)
    with lock:
        inside += 1
        peak = max(peak, inside)
        order.append(ticket)
    time.sleep(0.02)            # long enough that an overlap would be seen
    with lock:
        inside -= 1
    g.release(ticket)


threads = [threading.Thread(target=worker, args=(i,)) for i in range(N)]
for t in threads:
    t.start()
for t in threads:
    t.join(timeout=30)

check("every job got a turn", len(order) == N, f"{len(order)} of {N}")
check("never more than one job inside the gate", peak == 1, f"peak concurrency={peak}")
check("turns were served in arrival order",
      order == sorted(order), f"{order}")
check("the gate ends empty", g.queue_length() == 0 and g.holder() is None)

# --- 4. the estimate ---------------------------------------------------------
d = app._Durations()
check("no estimate before anything has finished", d.typical() is None,
      f"{d.typical()}")
d.add(100.0)
d.add(10.0)
d.add(20.0)
d.add(30.0)
check("the typical time is a median, so one long scan does not skew it",
      d.typical() == 25.0, f"{d.typical()}")

# --- 5. the view a waiting client actually gets ------------------------------
# Every caller of _job_view() already holds _JOBS_LOCK, and the view reads the
# running job's progress to work out how long the wait is -- which takes the
# lock again. With a plain Lock that is a deadlock the first time anybody polls
# a queued job, and it hangs rather than raising, so it is checked on a thread
# with a timeout: a job that never comes back is reported, not waited on.
#
# The two jobs have to be real to reach that code: with nothing running, and
# with this job at the front, _estimate_wait answers "0 seconds" without ever
# touching the lock, and the check would pass against the broken version. This
# is the case that was actually broken.
def view_under_lock() -> object:
    with app._JOBS_LOCK:
        return app._job_view(app._JOBS["v1"])


app._DURATIONS.add(30.0)          # a measured "typical", or there is no estimate
real_gate = app._GATE
gate = app._Gate()
app._GATE = gate
gate.try_acquire("run1")
runner = {
    "id": "run1", "state": "running", "progress": 0.5,
    "message": "Reading page 1 of 2", "seconds": 5.0,
    "created": time.time(), "cancel": threading.Event(),
    "result": None, "error": None, "status": 400,
}
app._JOBS["run1"] = runner

# v1 genuinely queues behind run1, by the public API.
app._JOBS["v1"] = {
    "id": "v1", "state": "queued", "progress": 0.0,
    "message": "Waiting for the recogniser", "seconds": 0.0,
    "created": time.time(), "cancel": threading.Event(),
    "result": None, "error": None, "status": 400,
}
holder = threading.Thread(target=gate.acquire, args=("v1",), daemon=True)
holder.start()
for _ in range(100):
    if gate.position("v1") == 1:
        break
    time.sleep(0.02)
check("the fixture really has one job waiting behind another",
      gate.position("v1") == 1, f"position={gate.position('v1')}")

box: list = []
t = threading.Thread(target=lambda: box.append(view_under_lock()), daemon=True)
t.start()
t.join(timeout=10)
check("building a view while holding the job lock does not deadlock",
      not t.is_alive() and len(box) == 1,
      "still blocked after 10s -- _JOBS_LOCK is not reentrant" if t.is_alive()
      else f"view={box[:1]}")
if box:
    view = box[0]
    eq("a queued view reports the waiting job's place", view.get("position"), 1)
    eq("a queued view reports how many are ahead", view.get("queueLength"), 1)
    check("a queued view carries an estimate once anything has been measured",
          view.get("estimatedWaitSeconds") is not None,
          f"eta={view.get('estimatedWaitSeconds')}")
    check("a queued view never carries the result", "result" not in view)

holder.join(timeout=5)
app._GATE = real_gate
app._JOBS.clear()

if fails:
    print("\nOMR QUEUE FAILED: " + "; ".join(fails))
    raise SystemExit(1)
print("omr queue OK")