# Handoff — ScoreForge, 10 October 2026

**What this is.** State of the repository at `a8c0018`, for an agent picking the
work up cold. It records what changed in the session that ended at that commit,
what is now true, and what is still unproven.

**What this is not.** `CONTRACT.md` is the durable interface contract — score
model, instrument contract, parser rules, backend rules. That still holds and is
not repeated here. This document will go stale; the commit messages will not.
When the two disagree, trust `git log`.

---

## 0. Later the same day: samples by default

Scott's ask: *the sounds should be samples rather than synthesised.* One
commit after `2426a73`. Read this section, then the rest still stands.

**Why the app sounded synthesised.** Two reasons, the second worse than the
first:

1. Every route into the roster led to the model. New parts, all 128 GM
   programs and every MusicXML name mapped to a modelled instrument; samples
   played only if picked by hand.
2. **Picking one by hand did not work either, since `6ceee06`.**
   `instruments.js` passes the sampler a `Map`; `__registerPackOf` read it with
   `Object.entries()`, which is `[]` for a Map. The sampler's roster-to-pack
   table was always empty, so `prepare()` decoded nothing and every recorded
   instrument silently played its modelled fallback. All 1038 suite assertions
   passed throughout — the sampler checks call `preparePack` with pack ids and
   never cross that seam.

**What is true now.**

- Every route lands on a recording: `DEFAULT_INSTRUMENT` (`rec-fp-upright`) in
  `instruments.js`, the GM and name tables in `gm.js`. Families the pack has no
  recording of go to the nearest recording; `GAPS` in `gm.js` lists them.
- The picker lists recordings first; modelled groups read "Synthesised · …".
- Packs are registered when the manifest arrives, not when all 277 MB have.
  `preparePack` fetches missing keys at high priority; the background fetch
  stands aside while it does. One missing file no longer fails the whole load.
- `Engine.prepare` replaces a channel that was built as the fallback before its
  samples existed (one press of mute before the first Play used to lock a part
  to the model for the session).
- Export no longer fails when samples cannot be had; the dialog's
  *Instruments* line says recorded or modelled, and why.
- `tools/check-default-samples.mjs` (in `npm test`) drives the built page:
  over http against the real, throttled pack, and from `file://`.

**Verified here.** Suites 1145 / 0 (routing-test new, sampler-test 46 → 60).
`npm test` green except `check-omr-queue.py`, which needs FastAPI. 21 mutations,
each red for the predicted assertion: 6 sampler loading, 9 routing, 6 end to
end (including restoring the `Object.entries` bug).

**Not verified, and why.**

- **Run on Linux headless Chromium, not on Scott's Windows Chrome/Edge.** The
  egress policy here blocks PyPI and the npm registry. `check-omr-queue.py` and
  the homr checks did not run; nothing in this change touches the backend.
- **The committed `index.html` was built with esbuild 0.28.2 compiled from its
  GitHub source, and fflate 0.8.3 bundled from its TypeScript source** rather
  than npm's prebuilt ESM. Building the *previous* commit that way reproduced
  the committed file byte for byte except the app bundle's minified names
  (+502 bytes, all fflate). The `.mxl` suites pass. A normal `npm ci && npm run
  build` on the host will produce a slightly different app bundle; that is
  expected, not a regression.
- **Nobody has listened to it.** The checks prove which instrument each channel
  built and that the export renders; whether, say, synth brass is an acceptable
  stand-in for a trumpet is a judgement for a person with ears. Changing a
  substitution is a one-line edit in `gm.js` plus its row in `routing-test`.
- `check-recording-fidelity` / `check-pack-is-unprocessed` need the FreePats
  WAVs and were skipped, as before; the pack itself is untouched.

---

## 1. What happened in this session

Six commits, in order. Each was pushed directly to `main`; no PRs, no tags, no
GitHub releases (the project has no release process — `package.json` is at 2.0.0
with zero tags, and none was invented).

| Commit | Change |
|---|---|
| `8d470f3` | Deletion guardrails — never delete what we did not create, never delete outside the working folder |
| `051c337` | The pack is the recordings — builder stopped trimming, normalising and truncating them |
| `9a62938` | Rebuilt `pack/` from the sources and proved it: 4,172 takes verified against their WAVs |
| `a0f9f21` | Installer no longer re-downloads 157 MB of model weights every run |
| `962a58a` | Service could not start: `guard.py` was never installed, and the OMR scratch path was unwritable |
| `a8c0018` | One scan read at a time, with an honest queue: place in line, rough wait, free cancellation before it starts |

The last two were both **found by a crash on the real host**, not by a test.

---

## 2. Standing rules now in force

These are not suggestions. Each one exists because breaking it was observed.

### Deletion

`tools/lib/guard.mjs` and `backend/guard.py` are the only two files in the
repository permitted to call a delete API. Each refuses a directory that lacks a
`.scoreforge-owned` marker written at creation, or that resolves outside the
repository. `tools/check-no-unguarded-deletes.mjs` scans `tools/` and `backend/`
for eight delete shapes across JS, Python and PowerShell, and exercises both
guards' refusals for real.

**The one exception, called out rather than hidden:** `deploy/install.sh` deletes
its own `$PREFIX/.venv` with a bash `rm -rf`. That is legitimate — the installer
created it, and a venv whose interpreter has moved cannot be repaired in place —
but it is outside the eight shapes the scan matches, and `deploy/` is not
scanned. README says so.

### The pack is the recordings

`tools/make-pack.mjs` no longer trims, normalises, prepends a marker or cuts any
take short. Mix balance is a number (`hit.g`) applied at playback, not an edit to
the audio. `tools/check-pack-is-unprocessed.mjs` decodes every shipped file in a
browser at its own source rate and compares it against the WAV it was made from.

### One recognition at a time

`backend/app.py` has an explicit `_Gate` in front of the engine. Tickets in
arrival order, one inside at a time. Queued jobs report their place and a rough
wait; cancelling one before its turn costs nothing. The synchronous
`POST /api/omr` waits on the same gate and runs off the event loop.

### Verify the installed tree, not the checkout

`install.sh` imports the backend **as installed** — `sys.path` at
`$PREFIX/backend`, which is what the unit gives it — and fails the install if
that fails. `tools/check-installed-backend.mjs` reads the installer's file list
and the imports that actually exist, and requires one to cover the other.

---

## 3. Running things on this machine

```
node      v24.16.0        (npm test needs Node 22+ for global WebSocket)
python    C:\Python\Python313  (3.13.3)
venv      backend\.venv\Scripts\python.exe   — use this, not system python
freepats  C:\Users\scott\files\music\freepats\banks   50 banks, 3.44 GB WAV
```

```
npm run build            # esbuild -> single-file index.html
npm test                 # verify.mjs: the browser self-test + every guard check
npm run test:suites      # the 6 browser suites (1038 assertions)
npm run pack:check       # every shipped take against its source WAV
npm run test:omr         # the HTTP OMR check; needs the backend running
```

Checks that need a live backend, and so are **not** part of `npm test`:

```
backend\.venv\Scripts\python.exe tools\check-omr-jobs.py fixtures/tiny.png fixtures/ode.pdf
backend\.venv\Scripts\python.exe tools\watch-omr-progress.py
```

Current verified state at `a8c0018`: `npm test` → **VERIFY OK**, self-test
38/0; suites → **1038 passed / 0 failed** (omr-test 47 of them).

---

## 4. Landmines

These cost real time to find. They will cost the next agent time again.

**Ships from an installed copy, not the checkout.** `omr_engine.py` does
`from guard import ...`, which resolves by bare name against
`/opt/scoreforge/backend/`. Local runs use the checkout, so *everything worked
locally* while the service crash-looped 1,218 times. Before adding a module to
`backend/`, check `BACKEND_FILES` in `install.sh`.

**`ProtectSystem=strict` makes `/opt` read-only.** The only path the service
writes at runtime is `$PREFIX/.tmp`, because `guard.ROOT` resolves to the install
prefix on an installed tree. It is named in `ReadWritePaths=` and created by the
installer *after* the `chown -R root:root` and `chmod -R a+rX` that would
otherwise reset its owner. A `ReadWritePaths=` entry that does not exist is a
**start failure**, not a warning — so it is deliberately not `-` prefixed.

**homr keeps its ONNX weights inside its own installed package**, so they live
inside the venv and die with every rebuild. `download_weights()` decides with
`os.path.exists` and returns when nothing is missing — correctly written, and
useless against a fresh venv. `deploy/model_cache.py` lifts them to
`$PREFIX/share/homr-models` and puts them back.

**PowerShell mangles inline scripts.** Write helper scripts to files. String
replacement via PowerShell has repeatedly corrupted files in this repo — use the
`edit` tool. Heredocs are not PowerShell (`git commit -F -` silently worked once
and I still had to move the message to a file).

**`spawnSync` must never launch a browser while an HTTP server runs in the same
Node process.** Use `spawn`.

**The Windows command line is ~32 KB.** A 4,172-path argv fails with
`ENAMETOOLONG`. Pass bulk data over HTTP.

**Never put a backtick inside a JS template literal**, including in a comment
that sits inside one. It ends the string.

**FreePats filenames contain `#`.** `encodeURI` does not escape it — encode path
segments individually.

**The deletion-guardrail harness lives in `.tmp/`.** Its first version sat in
`tools/`, which tripped its own scan and made four later mutations look caught
for the wrong reason.

**Do not kill a mutation run mid-flight.** It holds a snapshot of the file under
test and restores it in a `finally`; killing the process skips that and leaves
the mutation applied. This happened once and cost a confusing debugging detour.

---

## 5. Still unproven

Honest gaps, not hedges.

- **`tools/check-omr-jobs.py` has never been executed.** It needs a live backend
  and minutes of real CPU. Its new sections — three jobs submitted together,
  never more than one `running`, no two waiters told they are 1st, cancelling a
  queued job ending `cancelled` — are written but unrun. Run it on the host.
- **The systemd unit has never been started with these changes.** `ReadWritePaths=`
  is argued from the documented semantics of `ProtectSystem=strict`, not observed.
  The installer-side import check *is* exercised by `npm test`; the unit side
  needs one real start.
- **`deploy/install.sh` has never been run end to end.** It is bash on Windows.
  `bash -n` is clean; the semantics of the change are reasoned, not executed.
- **The `.part` copy protection in `model_cache.py` is not covered by a test.**
  The check asserts no debris survives a clean round trip; it cannot fault-inject
  an interrupted copy.
- **A damaged model cache cannot be detected** — it has no independent reference
  to those bytes. It is reproduced faithfully and left where
  `download_weights()` looks, so a real download can still repair it.

---

## 6. What worked, and is worth repeating

Every claim in section 2 that could have been wrong was mutation-tested. Not
"the test passes" but "the test goes red when I break the thing, and for the
reason I predicted". Across this session: 10 + 6 + 9 + 7 + 6 = **38 mutations**,
each recorded with the assertion it was expected to trip.

That approach found bugs that reading the code did not:

- The gate **admitted two jobs at once** when the queue was busy — a waiter
  removed itself from the list on waking, exposing the next one as head. Peak
  measured concurrency was 3.
- `position()` was **off by one**, because the holder occupies index 0.
- `_job_view` **re-entered a non-reentrant lock**, deadlocking the first time
  anyone polled a queued job. It *hangs*, so it reads as a wedged test run.
- `find_homr` walked `rglob` **in filesystem order**, so against a real
  `site-packages` it could return some other package.
- A **NUL byte** in one copy of a key template literal and a space in another
  made all 4,172 lookups miss and report "0 of 4172".

The recurring lesson, and the one to carry: **bookkeeping tests cannot see a
component that fails to do its job.** The queue handed out perfectly consistent
positions whether or not it actually admitted one at a time; every
position-and-ordering assertion passed against the version running two jobs at
once. What caught it was the property itself — a counter incremented and
decremented *inside* the critical section, asserting the peak never exceeded 1.

Ask what the test measures that moves together with the bug.

Two more that generalise:

- **A check's expectation must come from the source, not the description.**
  Comparing the pack to its own manifest moves both sides together.
- **Measure in the units the user sees, and put the tight assertion on the
  median.** A gain applied to everything moves the population, not the outliers.
  Compare RMS, not peak — peak is one sample and does not survive lossy coding.

---

## 7. If you change something

1. `npm test` and `npm run test:suites` green before you push.
2. Mutation-test any new check, or say plainly that you did not.
3. If you touch a threshold, derive it from the measured distribution. Every
   threshold in this repo came from measurement; the guessed ones flagged 1,837
   and 253 takes, none of which were defects.
4. Update the relevant README section. The tools list there is the index.
5. If a fact is stated in two places, that is a bug waiting to happen — three
   times this session. State it once.