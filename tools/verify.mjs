/**
 * tools/verify.mjs — build, then prove the built file actually works.
 *
 * Runs the app's own self-test inside headless Chrome/Edge against the *built*
 * single-file HTML (not the dev sources), so what is verified is exactly what
 * ships. Also captures a screenshot of the app with the demo score loaded.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// import.meta.dirname needs Node 20.11; from the module URL it works on 18 too.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'index.html');
const url = 'file:///' + file.replace(/\\/g, '/');

// These checks drive headless Chrome over the DevTools protocol, which needs the
// global WebSocket Node gained in 22. Stop here and say so, rather than reporting
// a self-test that "never completed" for what looks like an app problem.
if (typeof WebSocket === 'undefined') {
  console.error(
    `npm test needs Node 22 or newer: the global WebSocket it uses to reach Chrome\n` +
    `is not defined on Node ${process.versions.node}. Building with Node 18 is fine --\n` +
    `only these browser-driven checks need the newer runtime.`
  );
  process.exit(2);
}

// Resolves with { out, err, code } and rejects on a non-zero exit, so a caller
// can print the output before deciding. Returning the code matters: a result
// that resolves without one and is then compared against 0 reports failure
// having passed, which is worse than not checking at all.
//
// `allowFail` resolves on a non-zero exit instead of rejecting. A check that
// finds a bug is an expected outcome here, not an exception -- without it the
// process dies on an unhandled rejection and prints a stack trace instead of
// the failure it found.
function run(cmd, args, opts = {}) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { cwd: root, stdio: 'pipe', ...opts });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; if (opts.echo) process.stdout.write(d); });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => {
      if (code === 0 || opts.allowFail) return res({ out, err, code });
      rej(new Error(`${cmd} exited ${code}\n${err || out}`));
    });
  });
}

function cdp(args) {
  return new Promise((res) => {
    const p = spawn(process.execPath, [path.join(root, 'tools/cdp.mjs'), ...args], { cwd: root, stdio: 'pipe' });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => res({ code, out, err }));
  });
}

const size = fs.existsSync(file) ? (fs.statSync(file).size / 1048576).toFixed(2) + ' MB' : 'missing';
console.log(`build: ${size}`);

const selftest = await cdp([
  '--url', url + '?selftest',
  '--wait', 'window.__DONE__===true',
  '--timeout', '240000',
  '--eval', "JSON.stringify({result:window.__RESULT__,pass:window.__SELFTEST__.pass,fail:window.__SELFTEST__.fail,fails:(window.__SELFTEST__.log||[]).filter(l=>l.startsWith('FAIL'))})",
]);
console.log(selftest.out.trim());

let parsed = null;
try { parsed = JSON.parse(selftest.out); } catch { /* printed above */ }

// window.__RESULT__ is the harness's own verdict: 'OK' or 'FAIL(n)'.
let report = null;
try { report = JSON.parse(parsed?.value); } catch { /* handled below */ }

const shot = await cdp([
  '--url', url + '?demo',
  '--wait', 'window.__DONE__===true',
  '--timeout', '60000',
  '--eval', 'JSON.stringify(window.ScoreForge.debugState())',
  '--shot', path.join(root, 'tools/screenshot-app.png'),
  '--width', '1680', '--height', '1000',
]);
console.log(shot.out.trim());

const appState = (() => { try { return JSON.parse(JSON.parse(shot.out).value); } catch { return null; } })();
if (appState) console.log('app state:', JSON.stringify(appState));

const failures = [];

// A scan, not a test: these tools only run on the author's Windows box, so a
// platform assumption in them is invisible until CI fails. The TEMP/TMP
// environment variable is the one that bit -- undefined on Linux, so
// path.join(undefined, ...) threw before anything was measured. os.tmpdir() is
// the portable form.
{
  const toolsDir = path.join(root, 'tools');
  const offenders = [];
  // Assembled from pieces, because this file is scanned too and its own report
  // strings name the variable. Skipped outright instead: a file that reports the
  // pattern cannot usefully scan for it, and verify.mjs has no real use of it.
  const WINDOWS_ONLY = new RegExp(['process', 'env', '(T' + 'EMP|T' + 'MP)\\b'].join('\\.'));
  for (const name of fs.readdirSync(toolsDir)) {
    if (name === path.basename(fileURLToPath(import.meta.url))) continue;
    if (!name.endsWith('.mjs') && !name.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(toolsDir, name), 'utf8');
    if (WINDOWS_ONLY.test(src)) offenders.push(name);
  }
  console.log(offenders.length
    ? `platform scan: ${offenders.length} file(s) assume process.env.TEMP`
    : 'platform scan: no process.env.TEMP assumptions');
  if (offenders.length) failures.push(`tools using process.env.TEMP (use os.tmpdir()): ${offenders.join(', ')}`);
}

if (!parsed || parsed.ready !== true) failures.push('self-test never completed');
if (parsed && parsed.console && parsed.console.some((l) => l.startsWith('[exception]'))) {
  failures.push('uncaught exception in page');
}
// "finished" is not "passed" -- the self-test records its own verdict, so use it.
// Without this a build with broken assertions still reports VERIFY OK.
if (!report) failures.push('self-test reported no verdict');
else if (report.fail > 0 || report.result !== 'OK') {
  failures.push(`self-test: ${report.result} (${report.pass} passed, ${report.fail} failed)`);
  for (const line of report.fails || []) failures.push(line.trim());
}
if (appState && !appState.notes) failures.push('demo score produced no notes');

// The playback cursor was silently the wrong colour for a long time -- OSMD reads
// cursor options at construction, so assigning them after load() threw and the
// error was swallowed. Reading the app's own config would not catch that; this
// decodes the pixels OSMD actually painted. Needs Node 22 like the checks above.
const cursor = await new Promise((res) => {
  const p = spawn(process.execPath, [path.join(root, 'tools/check-cursor.mjs')], { cwd: root, stdio: 'pipe' });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  p.on('close', (code) => res({ code, out, err }));
});
console.log(cursor.out.trim());
if (cursor.code !== 0) {
  failures.push('cursor check: ' + (cursor.out.trim().split('\n').pop() || cursor.err.trim()));
}

// The transport buttons. The module suites stub the audio engine, so they cannot
// see where the notation cursor ends up when someone presses Stop, or whether a
// finished piece rewinds -- both of which were wrong and neither of which any
// existing assertion could have caught.
const transport = await run(process.execPath, [path.join(root, 'tools/check-transport.mjs')],
  { allowFail: true });
console.log(transport.out.trim());
if (transport.code !== 0) {
  failures.push('transport: ' + (transport.out.trim().split('\n').pop() || transport.err.trim()));
}

// Samples are the default sound. Every module suite passed while the app
// played the synthesiser for every part -- the sampler's roster table came
// through empty, so prepare() decoded nothing and each recorded instrument fell
// back without a word. This loads the built page against the real pack, presses
// Play while the pack is still downloading, and reads back which instrument
// each part actually built; then does the same from file://, where the honest
// answer is the model, said once, with an export that still completes.
const defaults = await run(process.execPath, [path.join(root, 'tools/check-default-samples.mjs')],
  { allowFail: true });
console.log(defaults.out.trim());
if (defaults.code !== 0) {
  failures.push('default samples: ' + (defaults.out.trim().split('\n').pop() || defaults.err.trim()));
}

// The OMR front end pays one full inference pass per page rendering, and a
// straight page used to pay four passes for two distinct images: deskew() is
// a no-op there and returned identical pixels under a different name. This
// drives backend/preprocess.py with synthetic pages (cv2, no model) and
// requires the duplicate renderings folded away -- and kept when a page is
// genuinely skewed. Skips with a reason when cv2 is not installed.
const omrVariants = await run(process.execPath, [path.join(root, 'tools/check-omr-variants.mjs')],
  { allowFail: true });
console.log(omrVariants.out.trim());
if (omrVariants.code !== 0) {
  failures.push('omr variants: ' + (omrVariants.out.trim().split('\n').pop() || omrVariants.err.trim()));
}

// The triplet repair: engravers print the "3" over a passage's first group
// and the recogniser reads the rest straight, so every such bar comes back
// half again too long. The pass converts only what explains a bar's overflow
// exactly, and refuses the rest -- stdlib python, runs everywhere.
const omrTriplets = await run(process.execPath, [path.join(root, 'tools/check-omr-triplets.mjs')],
  { allowFail: true });
console.log(omrTriplets.out.trim());
if (omrTriplets.code !== 0) {
  failures.push('omr triplets: ' + (omrTriplets.out.trim().split('\n').pop() || omrTriplets.err.trim()));
}

// The Concert Grand used to get *brighter* as it rang, which no struck string
// does. It passes the module suites either way -- they assert what the config
// says, not what came out of the speaker -- so it is measured from rendered
// samples here.
const piano = await run(process.execPath, [path.join(root, 'tools/check-piano-voice.mjs')],
  { allowFail: true });
console.log(piano.out.trim());
if (piano.code !== 0) {
  failures.push('piano: ' + (piano.out.trim().split('\n').pop() || piano.err.trim()));
}

// Sample provenance. Almost the whole pack is CC0, but one FreePats bank is
// GPL-3+ with the sound-sample exception, and a licence nobody is shown is a
// licence nobody is complying with. This fails on a missing credit, a stale
// notice, or a pack the roster cannot reach.
const credits = await run(process.execPath, [path.join(root, 'tools/check-pack-credits.mjs')],
  { allowFail: true });
console.log(credits.out.trim());
if (credits.code !== 0) {
  for (const line of credits.out.split('\n')) {
    if (line.startsWith('FAIL ')) failures.push(line.trim());
  }
  if (!credits.out.includes('FAIL ')) failures.push('pack credits: ' + (credits.err.trim() || 'check failed'));
}

// Can 59 recorded instruments fit in a tab? Decoding the whole 130 MB pack up
// front would need about 4.3 GB of PCM, which is not a thing a browser can be
// asked to hold, so the bytes are fetched eagerly and the PCM decoded per key
// under an eviction budget. Every other check here passes just as happily if the
// eviction silently stops working and the tab quietly grows to 4.3 GB, so the
// budget is measured directly.
const budget = await run(process.execPath, [path.join(root, 'tools/check-decode-budget.mjs')],
  { allowFail: true });
console.log(budget.out.trim());
if (budget.code !== 0) {
  for (const line of budget.out.split('\n')) {
    if (line.includes('FAIL')) failures.push(line.trim());
  }
  if (!budget.out.includes('FAIL')) failures.push('decode budget: ' + (budget.err.trim() || 'check failed'));
}

// Is the pack still the instrument that was recorded? A player-side check cannot
// answer that: folding the stereo, storing one rate per key, looping a piano or
// alternating its two hammers all leave the sampler working perfectly on samples
// that no longer sound like themselves. Decoding the shipped files settles it.
const fidelity = await run(process.execPath, [path.join(root, 'tools/check-recording-fidelity.mjs')],
  { allowFail: true });
console.log(fidelity.out.trim());
if (fidelity.code !== 0) {
  for (const line of fidelity.out.split('\n')) {
    if (line.trim().startsWith('<-')) failures.push(line.trim());
  }
  if (!fidelity.out.includes('<-')) failures.push('recording fidelity: ' + (fidelity.err.trim() || 'check failed'));
}

// Deletion guardrails. Two rules -- never delete what this repository did not
// create, never delete outside the working folder -- that have both been broken
// already, once by a builder clearing its own output directory and once by a
// browser profile in the temp directory. Checked first because it is the one that
// protects everything the checks below are about to write.
const guard = await run(process.execPath, [path.join(root, 'tools/check-no-unguarded-deletes.mjs')],
  { allowFail: true });
console.log(guard.out.trim());
if (guard.code !== 0) {
  for (const line of guard.out.split('\n')) {
    if (line.startsWith('FAIL ') || line.startsWith('GUARDRAILS FAILED')) failures.push(line.trim());
  }
  if (!guard.out.includes('FAIL ') && !guard.out.includes('GUARDRAILS FAILED')) {
    failures.push('guardrails: ' + (guard.err.trim() || 'check failed'));
  }
}

// Does the installer ship every backend module that imports another by bare
// name? omr_engine.py does `from guard import ...`, and that only resolves
// against the *installed* copy at $PREFIX/backend -- so a module present in the
// checkout but missing from the install list is invisible until the service
// starts. guard.py was exactly that, and the service crash-looped on
// `No module named 'guard'` while the install reported success.
const installedBackend = await run(process.execPath,
  [path.join(root, 'tools/check-installed-backend.mjs')], { allowFail: true });
console.log(installedBackend.out.trim());
if (installedBackend.code !== 0) {
  for (const line of installedBackend.out.split('\n')) {
    if (line.trim().startsWith('FAIL ') || line.startsWith('INSTALLED BACKEND')) {
      failures.push(line.trim());
    }
  }
  if (!installedBackend.out.includes('FAIL ') && !installedBackend.out.includes('INSTALLED BACKEND')) {
    failures.push('installed backend: ' + (installedBackend.err.trim() || 'check failed'));
  }
}

// One scan at a time. The gate is the one piece of this that can be wrong on
// its own -- it hands out positions correctly whether or not it actually admits
// one job at a time -- so it is checked without the engine, in seconds rather
// than the minutes a real transcription takes. check-omr-jobs.py covers the
// same ground over HTTP with the engine running.
{
  const win = process.platform === 'win32';
  const py = path.join(root, 'backend', '.venv', win ? 'Scripts' : 'bin',
    win ? 'python.exe' : 'python');
  const exe = fs.existsSync(py) ? py : (win ? 'python' : 'python3');
  const r = await run(exe, [path.join(root, 'tools/check-omr-queue.py')],
    { allowFail: true });
  console.log(r.out.trim() || r.err.trim() || 'omr queue: no output');
  if (r.code !== 0) {
    for (const line of r.out.split('\n')) {
      if (line.trim().startsWith('FAIL ') || line.startsWith('OMR QUEUE FAILED')) {
        failures.push(line.trim());
      }
    }
    if (!r.out.includes('FAIL ') && !r.out.includes('OMR QUEUE FAILED')) {
      failures.push('omr queue: ' + (r.err.trim() || `check exited ${r.code}`));
    }
  }
}

// Does the installer still re-download 157 MB of model weights on every run?
// It rebuilds the venv each time -- correctly, since a venv whose bin/python
// dangles cannot be repaired in place -- and homr keeps its weights inside its
// own installed package, so the rebuild used to take them with it. Nothing
// crashed; the install just paid the bandwidth forever. Checked against a
// simulated venv rather than a real install, which needs a systemd host.
{
  const win = process.platform === 'win32';
  const py = path.join(root, 'backend', '.venv', win ? 'Scripts' : 'bin',
    win ? 'python.exe' : 'python');
  const sysPy = win ? 'python' : 'python3';
  const exe = fs.existsSync(py) ? py : sysPy;
  const r = await run(exe, [path.join(root, 'tools/check-model-cache.py')],
    { allowFail: true });
  console.log(r.out.trim() || r.err.trim() || 'model cache: no output');
  if (r.code !== 0) {
    for (const line of r.out.split('\n')) {
      if (line.trim().startsWith('FAIL ') || line.startsWith('MODEL CACHE FAILED')) {
        failures.push(line.trim());
      }
    }
    if (!r.out.includes('FAIL ') && !r.out.includes('MODEL CACHE FAILED')) {
      failures.push('model cache: ' + (r.err.trim() || `check exited ${r.code}`));
    }
  }
}

// Is the pack still just the recordings? The fidelity check above asks whether
// the samples came through intact; this asks the prior question -- whether they
// were touched at all. The builder used to trim, normalise, prepend a marker
// and cut every take at four seconds, and all four of those are audible and
// none of them throws, so the claim that the pack is the recordings has to be
// measured rather than asserted. Every shipped file is decoded and compared
// against the WAV it was made from.
const unprocessed = await run(process.execPath, [path.join(root, 'tools/check-pack-is-unprocessed.mjs')],
  { allowFail: true });
console.log(unprocessed.out.trim());
if (unprocessed.code !== 0) {
  for (const line of unprocessed.out.split('\n')) {
    if (line.trim().startsWith('- ') || line.startsWith('PACK IS NOT')) failures.push(line.trim());
  }
  if (!unprocessed.out.includes('PACK IS NOT')) {
    failures.push('pack unprocessed: ' + (unprocessed.err.trim() || 'check failed'));
  }
}

if (report) console.log(`self-test: ${report.result} - ${report.pass} passed, ${report.fail} failed`);

if (failures.length) {
  console.error('\nVERIFY FAILED: ' + failures.join('; '));
  process.exit(1);
}
console.log('\nVERIFY OK');
