"""End-to-end check of the background transcription job API.

Needs the backend running (backend/app.py on 127.0.0.1:8000) and a real fixture,
because the thing under test is a worker thread doing CPU inference -- a mocked
engine would pass while the job still never finished.

    python tools/check-omr-jobs.py [fast-fixture] [slow-fixture]

Exercises submit -> poll -> result, and submit -> cancel. Progress must actually
advance, a cancelled job must end in 'cancelled' rather than 'done' or 'error',
and the synchronous POST /api/omr that install.sh smoke-tests must still work.

Exits non-zero on the first failing assertion.
"""
import json
import sys
import time
import urllib.request
import uuid

BASE = "http://127.0.0.1:8000"
FIXTURE = sys.argv[1] if len(sys.argv) > 1 else "fixtures/tiny.png"

fails = []
total = 0


def check(name, ok, detail=""):
    global total
    total += 1
    if not ok:
        fails.append(f"{name} — {detail}")
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  [{detail}]" if detail else ""))


def post_job(path):
    boundary = uuid.uuid4().hex
    data = open(FIXTURE, "rb").read()
    name = FIXTURE.replace("\\", "/").rsplit("/", 1)[-1]
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{name}"\r\n'
        "Content-Type: application/octet-stream\r\n\r\n"
    ).encode() + data + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        BASE + path, data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    with urllib.request.urlopen(req, timeout=120) as res:
        return json.load(res)


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=60) as res:
        return json.load(res)


def post(path):
    req = urllib.request.Request(BASE + path, data=b"", method="POST")
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.load(res)


# --- 1. run to completion ---------------------------------------------------
job = post_job("/api/omr/jobs")
check("submit returns a job id", bool(job.get("jobId")), json.dumps(job))

jid = job["jobId"]
seen_progress = []
seen_messages = []
deadline = time.time() + 600
state = None
while time.time() < deadline:
    view = get(f"/api/omr/jobs/{jid}")
    state = view["state"]
    seen_progress.append(view["progress"])
    seen_messages.append(view["message"])
    if state in ("done", "error", "cancelled"):
        break
    time.sleep(0.15)

check("job finishes", state == "done", f"state={state} last={seen_messages[-1:]}")
check("progress advances", max(seen_progress) > 0.1, f"max={max(seen_progress):.2f}")
check("progress is monotonic", all(b >= a for a, b in zip(seen_progress, seen_progress[1:])),
      f"{seen_progress[:6]}...")

# --- granularity -------------------------------------------------------------
# The bug this exists to catch: a one-page scan reported 10% and then jumped to
# done, because progress was reported once per page and inference was a single
# blocking call. "max > 0.1" is satisfied by that too -- the bar reaches 0.99 at
# the end -- so it never caught it. These measure how the bar travels, not where
# it ends up.

running = seen_progress[:-1] if seen_progress else []
mid = [p for p in running if 0.15 < p < 0.9]
check("progress leaves the 10% mark before the job ends", len(mid) > 0,
      f"running values in (0.15, 0.9): {mid[:6] or 'none'}")

# A bar that only ever sits still and then finishes gives ~5 distinct values.
# Compare against the 4 variants auto mode runs, plus the engine's own
# milestones, plus the per-page steps -- a long way more than that.
distinct = len({round(p, 3) for p in running})
check("progress takes many distinct values, not a handful", distinct >= 8,
      f"{distinct} distinct while running of {len(running)} polls")

msgs = [m for m in seen_messages[:-1] if m and m.strip()]
distinct_msgs = len(set(msgs))
check("progress messages change as it works", distinct_msgs >= 5,
      f"{distinct_msgs} distinct: {list(dict.fromkeys(msgs))[:4]}")

# The worst case is a single page: one page means one page-slice, so all the
# movement has to come from inside the engine.
# Catches a bar that teleports through the middle -- one enormous step between
# two samples, e.g. one report covering a whole page. It does *not* catch the
# frozen-then-done case, because the jump to 1.0 lands in the final poll and is
# excluded from `running`; the three checks above are what catch that. Guard the
# empty case: this has to fail as a failed assertion rather than a traceback,
# and a job polled only once is exactly when it matters most.
steps = [b - a for a, b in zip(running, running[1:])]
check("no single poll accounts for most of the bar",
      bool(steps) and max(steps) <= 0.4,
      f"largest single step={max(steps):.3f}" if steps else "job finished within one poll")

check("progress messages are not empty",
      any(m and m.strip() for m in seen_messages), f"{seen_messages[:4]}")
if state == "done":
    view = get(f"/api/omr/jobs/{jid}")
    res = view.get("result") or {}
    check("result carries the transcription", res.get("totalNotes", 0) > 0,
          f"notes={res.get('totalNotes')}")
    check("result carries MusicXML", bool((res.get("pages") or [{}])[0].get("musicxml")),
          "pages[0].musicxml")
    check("polled view omits the result while running is not claimed",
          "result" in view, "result present once done")

# --- 2. the synchronous endpoint still works (install.sh smoke-tests it) -----
import urllib.error
boundary = uuid.uuid4().hex
data = open(FIXTURE, "rb").read()
name = FIXTURE.replace("\\", "/").rsplit("/", 1)[-1]
body = (
    f"--{boundary}\r\n"
    f'Content-Disposition: form-data; name="file"; filename="{name}"\r\n'
    "Content-Type: application/octet-stream\r\n\r\n"
).encode() + data + f"\r\n--{boundary}--\r\n".encode()
req = urllib.request.Request(
    BASE + "/api/omr", data=body,
    headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
)
with urllib.request.urlopen(req, timeout=600) as res:
    sync = json.load(res)
check("POST /api/omr still returns a result", sync.get("ok") is True and sync.get("totalNotes", 0) > 0,
      f"notes={sync.get('totalNotes')}")

# --- 3. cancel, on a fixture slow enough to still be running -----------------
SLOW = sys.argv[2] if len(sys.argv) > 2 else "fixtures/ode.pdf"
boundary = uuid.uuid4().hex
slow = open(SLOW, "rb").read()
sname = SLOW.replace("\\", "/").rsplit("/", 1)[-1]
sbody = (
    f"--{boundary}\r\n"
    f'Content-Disposition: form-data; name="file"; filename="{sname}"\r\n'
    "Content-Type: application/octet-stream\r\n\r\n"
).encode() + slow + f"\r\n--{boundary}--\r\n".encode()
req = urllib.request.Request(
    BASE + "/api/omr/jobs", data=sbody,
    headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
)
with urllib.request.urlopen(req, timeout=300) as res:
    job2 = json.load(res)
jid2 = job2["jobId"]

time.sleep(1.2)
running = get(f"/api/omr/jobs/{jid2}")
check("slow job is still running when cancelled", running["state"] == "running",
      f"state={running['state']} msg={running['message']}")

resp = post(f"/api/omr/jobs/{jid2}/cancel")
check("cancel is accepted", resp["state"] == "stopping", json.dumps(resp))

state2 = None
deadline = time.time() + 900
while time.time() < deadline:
    view = get(f"/api/omr/jobs/{jid2}")
    state2 = view["state"]
    if state2 in ("done", "error", "cancelled"):
        break
    time.sleep(0.5)
check("cancelled job ends cancelled, not done", state2 == "cancelled", f"state={state2}")

# --- 4. bad input still fails loudly ----------------------------------------
boundary = uuid.uuid4().hex
body = (
    f"--{boundary}\r\n"
    'Content-Disposition: form-data; name="file"; filename="x.png"\r\n'
    "Content-Type: application/octet-stream\r\n\r\n"
).encode() + b"not an image at all" + f"\r\n--{boundary}--\r\n".encode()
req = urllib.request.Request(
    BASE + "/api/omr/jobs", data=body,
    headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
)
# A job API accepts the upload and reports the failure on the job, so this is
# a bad job rather than a bad request.
with urllib.request.urlopen(req, timeout=60) as res:
    bad = json.load(res)
bad_state = None
deadline = time.time() + 120
while time.time() < deadline:
    view = get(f"/api/omr/jobs/{bad['jobId']}")
    bad_state = view["state"]
    if bad_state in ("done", "error", "cancelled"):
        break
    time.sleep(0.3)
check("unreadable upload becomes a failed job", bad_state == "error",
      f"state={bad_state}")
if bad_state == "error":
    view = get(f"/api/omr/jobs/{bad['jobId']}")
    check("failed job carries a message", bool(view.get("error")), view.get("error", ""))

# --- 5. unknown job ---------------------------------------------------------
try:
    get("/api/omr/jobs/does-not-exist")
    check("unknown job is a 404", False, "no error raised")
except urllib.error.HTTPError as exc:
    check("unknown job is a 404", exc.code == 404, f"HTTP {exc.code}")

print(f"\n{total - len(fails)} passed · {len(fails)} failed")
if fails:
    print("FAILED:\n  " + "\n  ".join(fails))
sys.exit(1 if fails else 0)