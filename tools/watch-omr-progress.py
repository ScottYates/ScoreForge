"""Print every progress tick of one real transcription, as the UI would see it.

`check-omr-jobs.py` asserts; this shows. The bug was reported as "sits at 10%
then pops to done", and that is a claim about the *shape* of the sequence, so it
needs the sequence printed rather than a boolean about it.

    python tools/watch-omr-progress.py [fixture]
"""
import json
import sys
import time
import urllib.request
import uuid

BASE = "http://127.0.0.1:8000"
FIXTURE = sys.argv[1] if len(sys.argv) > 1 else "fixtures/tiny.png"

boundary = uuid.uuid4().hex
data = open(FIXTURE, "rb").read()
name = FIXTURE.replace("\\", "/").rsplit("/", 1)[-1]
body = (
    f"--{boundary}\r\n"
    f'Content-Disposition: form-data; name="file"; filename="{name}"\r\n'
    "Content-Type: application/octet-stream\r\n\r\n"
).encode() + data + f"\r\n--{boundary}--\r\n".encode()
req = urllib.request.Request(
    BASE + "/api/omr/jobs", data=body,
    headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
)
with urllib.request.urlopen(req, timeout=120) as res:
    jid = json.load(res)["jobId"]

t0 = time.perf_counter()
last_p = last_m = None
ticks = 0
print(f"{'elapsed':>8}  {'pct':>5}  message")
while time.perf_counter() - t0 < 900:
    with urllib.request.urlopen(BASE + f"/api/omr/jobs/{jid}", timeout=60) as res:
        view = json.load(res)
    el = time.perf_counter() - t0
    # Print on a message change too, not just a progress change. The variant
    # boundaries are exactly where the message says something new at the same
    # fraction, and printing only on progress hides the whole variant structure.
    if view["progress"] != last_p or view["message"] != last_m:
        ticks += 1
        print(f"{el:7.2f}s  {view['progress'] * 100:4.0f}%  {view['message']}")
        last_p, last_m = view["progress"], view["message"]
    if view["state"] in ("done", "error", "cancelled"):
        print(f"\nstate={view['state']} after {el:.1f}s, {ticks} ticks")
        if view["state"] == "error":
            print("error:", view.get("error"))
        else:
            print("notes:", (view.get("result") or {}).get("totalNotes"))
        sys.exit(0 if view["state"] == "done" else 1)
    time.sleep(0.15)

print("timed out")
sys.exit(1)