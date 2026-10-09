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

function run(cmd, args, opts = {}) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { cwd: root, stdio: 'pipe', ...opts });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; if (opts.echo) process.stdout.write(d); });
    p.stderr.on('data', (d) => { err += d; if (opts.echo) process.stderr.write(d); });
    p.on('close', (code) => (code === 0 ? res({ out, err }) : rej(new Error(`${cmd} exited ${code}\n${err || out}`))));
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

if (report) console.log(`self-test: ${report.result} — ${report.pass} passed, ${report.fail} failed`);

if (failures.length) {
  console.error('\nVERIFY FAILED: ' + failures.join('; '));
  process.exit(1);
}
console.log('\nVERIFY OK');