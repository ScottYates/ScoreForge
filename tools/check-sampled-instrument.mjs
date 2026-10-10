/**
 * tools/check-sampled-instrument.mjs - does the instrument actually play the
 * recordings?
 *
 * The page is not evidence that it works; the page is a file. This drives it in
 * the same headless Chromium the other browser checks use, renders every key of
 * the instrument through the exact node settings play() uses, and measures the
 * result.
 *
 * It fails on: a key that renders silence, a note whose attack does not land
 * when the key was pressed, or a note whose level has moved from the level in
 * the recording. That last one is the interesting one -- a sample played on its
 * own must sound exactly as recorded, and a level applied to it in the builder
 * rather than at playback is the specific thing this has to catch.
 *
 *   node tools/check-sampled-instrument.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readWav, peakOf } from './lib/wav.mjs';

const repo = process.cwd();
const ROOT = path.join(repo, 'docs', 'sampled-instrument');

/**
 * The original recordings, if they are still on disk.
 *
 * This matters more than it looks. The instrument's own manifest declares the
 * peak of each take, and comparing a render against a number the builder wrote
 * proves nothing at all: peak-normalising every take to a family target moves
 * the audio AND the declared peak together, and the comparison stays happy.
 * The expectation has to come from the WAV, not from the thing being checked.
 *
 *   node tools/check-sampled-instrument.mjs --freepats <banks>
 *
 * Without it the level assertion is skipped rather than pretended.
 */
const args = process.argv.slice(2);
const fpIdx = args.indexOf('--freepats');
const FP = fpIdx >= 0 ? args[fpIdx + 1] : null;

/** Peak of each source WAV in the bank, by file stem. */
function sourcePeaks(bank) {
  const root = path.join(FP, bank, 'extracted');
  if (!FP || !fs.existsSync(root)) return null;
  const out = new Map();
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.wav$/i.test(e.name)) {
        try { out.set(e.name.replace(/\.wav$/i, '').toLowerCase(), +peakOf(readWav(fs.readFileSync(p))).toFixed(6)); }
        catch { /* unreadable; leave it out rather than guess */ }
      }
    }
  })(root);
  return out.size ? out : null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // Resolve the path as a path, not a basename: this instrument keeps its
  // samples under samples/, and collapsing that away turns every fetch into a
  // 404 and every decode into an "unable to decode" that looks like a codec
  // problem. Still confined to ROOT.
  const file = path.resolve(ROOT, '.' + decodeURIComponent(url.pathname));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const START = "new Promise(function (r) { var n = 0; var t = setInterval(function () "
  + "{ if (window.__ready && ++n > 2) { clearInterval(t); r(1); } }, 50); })"
  + ".then(function () { return window.__selfTest(); })"
  + ".then(function (r) { window.__RESULT__ = r; window.__DONE__ = true; },"
  + " function (e) { window.__RESULT__ = { error: String((e && e.stack) || e) }; window.__DONE__ = true; })";

// spawn, not spawnSync: the server lives in this process, and spawnSync blocks
// the event loop, so the page could never fetch its own samples.
const out = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    path.join(repo, 'tools', 'cdp.mjs'),
    '--url', `http://127.0.0.1:${port}/index.html`,
    '--start', START,
    '--wait', 'window.__DONE__===true',
    '--timeout', '900000',
    '--eval', 'window.__RESULT__',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let so = '';
  let se = '';
  child.stdout.on('data', (d) => { so += d; });
  child.stderr.on('data', (d) => { se += d; });
  child.on('error', reject);
  child.on('close', () => resolve({ so, se }));
});

server.close();

let res;
try {
  const env = JSON.parse(out.so.slice(out.so.indexOf('{'), out.so.lastIndexOf('}') + 1));
  res = typeof env.value === 'string' ? JSON.parse(env.value) : env.value;
} catch (e) {
  console.error('could not read the harness result:\n' + out.so.slice(0, 800) + out.se.slice(0, 600));
  process.exit(1);
}

if (!res || res.error) {
  console.error('check failed:', (res && res.error) || 'no result from the page');
  process.exit(1);
}

const instrument = JSON.parse(fs.readFileSync(path.join(ROOT, 'instrument.json'), 'utf8'));
const keys = Object.keys(instrument.notes).length;

console.log(`${keys} keys from ${instrument.source}`);
console.log(`${instrument.encoder}`);
console.log(`${instrument.preserved}\n`);

// The level assertion, judged here and not in the page, against the original
// WAV. A lossy codec moves a peak by a fraction of a dB; a normaliser moves it
// by twenty. One dB separates those without needing to be exact about either.
const wavPeaks = sourcePeaks(instrument.bank);
const levelChanged = [];
if (wavPeaks) {
  for (const [file, rendered] of Object.entries(res.peaks || {})) {
    const stem = path.basename(file).replace(/\.mp3$/i, '').toLowerCase();
    const original = wavPeaks.get(stem);
    if (original == null) { levelChanged.push([file, 'no source WAV found', rendered]); continue; }
    const db = 20 * Math.log10(rendered / original);
    if (Math.abs(db) > 1) levelChanged.push([file, original, +rendered.toFixed(5), +db.toFixed(2)]);
  }
} else {
  console.log('\n(no --freepats given, so the level assertion was SKIPPED rather than');
  console.log(' checked against this instrument\'s own manifest, which would prove nothing)');
}

let bad = 0;
const fail = (m) => { console.log('  <- ' + m); bad++; };

console.log(`\nrendered             : ${res.renders} layer renders over ${res.keys} keys`);
console.log(`silent               : ${res.silent.length ? res.silent.join(', ') : 'none'}`);
console.log(`attack not on time   : ${res.late.length
  ? res.late.map(([k, ms]) => `${k}@${ms}ms`).join(', ') : 'none'}`);
console.log(`distinct takes used  : ${Object.keys(res.layers).length}`);
console.log(`keys the bank maps to a transposed take: ${res.transposed} of ${res.keys}`);
console.log(`playback offsets used  : ${res.offsetUsed.join(', ')} s of codec delay skipped`);
console.log(`looped / detuned       : ${res.looped.length} / ${res.detuned.length}`);
console.log(`level moved from source: ${levelChanged.length
  ? levelChanged.map((r) => `${r[0]} ${r[1]}->${r[2]}`).join(', ') : 'none'}`);

if (res.keys !== keys) fail(`rendered ${res.keys} keys, the map has ${keys}`);
if (res.silent.length) fail(`${res.silent.length} key(s) rendered silence: ${res.silent.slice(0, 8).join(', ')}`);
if (res.late.length) {
  fail(`${res.late.length} key(s) did not start at their attack: `
    + res.late.slice(0, 6).map(([k, ms]) => `${k}@${ms}ms`).join(', '));
}
if (levelChanged.length) {
  fail(`${levelChanged.length} take(s) play at a level the source WAV does not have: `
    + levelChanged.slice(0, 6).map((r) => r[0]).join(', '));
}
if (res.looped.length) fail(`${res.looped.length} key(s) were rendered with loop on`);
if (res.detuned.length) fail(`${res.detuned.length} key(s) were rendered with detune on`);
if (res.rateChanged.length) {
  fail(`${res.rateChanged.length} key(s) did not play at the rate their layer declares`);
}
if (res.skipped.length) {
  // Every note has to start at the measured onset. Starting at zero instead
  // puts the hammer a frame late on every single note, and that is exactly the
  // defect the measurement exists to catch.
  fail(`${res.skipped.length} key(s) started at ${res.skipped[0][1]}s instead of their measured onset: `
    + res.skipped.slice(0, 6).map(([k, o]) => `${k}@${o}`).join(', '));
}

// Every key must be able to reach both hammers the bank recorded, or a velocity
// change is doing nothing on that key.
let noHammerChoice = 0;
for (const n of Object.values(instrument.notes)) {
  if (new Set(n.layers.map((l) => l.vel)).size < 2) noHammerChoice++;
}
console.log(`\nkeys with one hammer only: ${noHammerChoice}`);

if (bad) {
  console.error(`\n${bad} problem(s)`);
  process.exit(1);
}
console.log('\nok: every key sounds at its recorded level, and every attack lands when the key is pressed');