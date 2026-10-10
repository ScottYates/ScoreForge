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

if (report) console.log(`self-test: ${report.result} - ${report.pass} passed, ${report.fail} failed`);

if (failures.length) {
  console.error('\nVERIFY FAILED: ' + failures.join('; '));
  process.exit(1);
}
console.log('\nVERIFY OK');
