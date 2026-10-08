/**
 * tools/verify.mjs — build, then prove the built file actually works.
 *
 * Runs the app's own self-test inside headless Edge against the *built*
 * single-file HTML (not the dev sources), so what is verified is exactly what
 * ships. Also captures a screenshot of the app with the demo score loaded.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(import.meta.dirname, '..');
const file = path.join(root, 'ScoreForge.html');
const url = 'file:///' + file.replace(/\\/g, '/');

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
  '--eval', "document.getElementById('selftest')?document.getElementById('selftest').textContent:'NO SELFTEST ELEMENT'",
]);
console.log(selftest.out.trim());

let parsed = null;
try { parsed = JSON.parse(selftest.out); } catch { /* printed above */ }

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
if (appState && !appState.notes) failures.push('demo score produced no notes');

if (failures.length) {
  console.error('\nVERIFY FAILED: ' + failures.join('; '));
  process.exit(1);
}
console.log('\nVERIFY OK');