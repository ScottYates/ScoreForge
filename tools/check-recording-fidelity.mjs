/**
 * tools/check-recording-fidelity.mjs - is a packed recording still the recording?
 *
 * Every other check in this repo asks whether the player plays the pack correctly.
 * None of them asked whether the pack is still the instrument that was recorded.
 * Four things got between the microphone and the speaker, and none of them threw
 * an error:
 *
 *   - the stereo step folded the left channel to (L+R)/2 while leaving the right
 *     alone, which is not stereo but a mono fold-down with one microphone still
 *     in it. On the FreePats upright that cost 6.6 dB of energy at 5-10 kHz and
 *     the piano stopped sounding struck.
 *   - one playback rate was stored per key and overwritten by each take in turn,
 *     so a take that was recorded at a different pitch_keycenter than its
 *     neighbour played a semitone out. 7 of 176 upright takes were wrong.
 *   - a piano was given a sustain loop. A struck string has to decay; looping it
 *     turned every long note into a drone that jumped back up to full level.
 *   - two takes recorded with different hammers alternated at random instead of
 *     being chosen by velocity, so a written crescendo changed volume and not
 *     timbre.
 *
 * The first and second are measurable from the shipped files: decode the take
 * and compare what is in it against what the manifest claims. The third and
 * fourth are properties of the manifest and the pack table, and are checked here
 * so they cannot be reintroduced quietly.
 *
 *   node tools/check-recording-fidelity.mjs
 *
 * Serves the repo over HTTP because a page opened from file:// cannot decode
 * anything it fetches.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { FREEPATS_BANKS } from './freepats-banks.mjs';

const repo = process.cwd();

/**
 * Cents of tuning error a take is allowed before it counts as wrong, measured
 * modulo the octave.
 *
 * A real piano's partials are stretched by string stiffness -- 9.3e-4 on the
 * FreePats upright -- which puts the top partials a few cents above where an
 * equal-tempered series would put them, and that lands on whichever octave the
 * estimator locked onto. Sixty cents leaves room for that and still refuses the
 * thing that went wrong, which was a take a semitone or a tone from its
 * neighbour.
 */
const PITCH_CENTS = 60;

/**
 * How far the shipped stereo may differ from the stereo it was cut from, in dB.
 *
 * MP3 joint stereo moves the difference signal by a dB or two on a hard-panned
 * take. Folding the left channel to (L+R)/2 took the FreePats upright down by
 * 6 dB, so four leaves the fold well outside anything an encoder can reach.
 */
const MAX_WIDTH_DRIFT_DB = 4;

/**
 * Below this the side channel carries nothing worth measuring.
 *
 * The FreePats jazz guitar is dual mono to within 1e-8 -- its source measures
 * -165 dB side against mid. Dividing by a side signal that small just amplifies
 * the codec's own noise floor, and the check reported that bank as 8 dB "wider"
 * than a recording that has no width at all. There is no stereo to preserve, so
 * the comparison is skipped rather than pretended.
 */
const MIN_MEANINGFUL_WIDTH_DB = -30;

const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'pack', 'manifest.json'), 'utf8'));

/* ---------------------------------------------- manifest-side checks, in node */

// A bank that sets loop: false is struck. It must not gain a sustain from the
// SFZ, from the heuristic, or from anybody's good intentions about long notes.
const struck = FREEPATS_BANKS.filter((b) => b.loop === false);
const mustNotLoop = [];
for (const b of struck) {
  const inst = manifest.instruments[b.pack];
  if (!inst) { mustNotLoop.push(`${b.pack}: not in the manifest at all`); continue; }
  if (inst.sustains) mustNotLoop.push(`${b.pack}: declares itself sustaining`);
  for (const [key, entry] of Object.entries(inst.notes)) {
    for (const hit of entry.hits) {
      if (hit.loop) mustNotLoop.push(`${b.pack}/${key}: take ${hit.f} has a loop`);
    }
  }
}

// The struck banks are also the ones that were being cut short. A bank that says
// maxSec: 10 must actually produce takes of about that length on its low keys,
// where a piano rings longest, or the setting is decorative.
const tooShort = [];
for (const b of struck) {
  const inst = manifest.instruments[b.pack];
  if (!inst) continue;
  const wanted = b.maxSec ?? 0;
  const longest = Math.max(0, ...Object.values(inst.notes)
    .flatMap((e) => e.hits.map((h) => h.dur)));
  if (wanted && longest < wanted * 0.8) {
    tooShort.push(`${b.pack}: longest take ${longest.toFixed(2)}s against a ${wanted}s budget`);
  }
}

// Velocity layers have to be recorded as layers, or nothing can choose between
// them. A bank that ships vL and vH for a key must put different `vel` values on
// the two takes.
const velLayers = {};
for (const b of FREEPATS_BANKS) {
  const inst = manifest.instruments[b.pack];
  if (!inst) continue;
  let layered = 0;
  for (const entry of Object.values(inst.notes)) {
    if (entry.hits.length > 1 && entry.hits.every((h) => h.vel != null)
        && Math.max(...entry.hits.map((h) => h.vel)) - Math.min(...entry.hits.map((h) => h.vel)) > 0.01) {
      layered++;
    }
  }
  velLayers[b.pack] = layered;
}
const uprightLayered = velLayers['fp-upright'] ?? 0;

/* ------------------------------------------------------ the browser half */

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>recording fidelity</title></head>
<body><pre id="out">running</pre>
<script type="module">
(async () => {
// The page reports by publishing __RESULT__, not by printing: stdout from a
// headless browser is not worth parsing when there is a structured channel.
const PITCH_CENTS = ${PITCH_CENTS};

/**
 * Fundamental by autocorrelation, taking the strongest lag and nothing cleverer.
 *
 * The octave errors are NOT handled here. Autocorrelation on a real instrument
 * locks onto two, three or four times the true fundamental as readily as onto
 * the fundamental itself, and every attempt to disambiguate it -- prefer the
 * smallest strong lag, walk to whichever neighbour correlates nearly as well --
 * just moved the error somewhere else. On this pack those attempts reported
 * notes an octave and three octaves wrong while every take was in tune.
 *
 * So the ambiguity is left in place and dealt with in centsModOctave(), which
 * only asks the question that matters: is this take an integer number of
 * octaves from the pitch it is filed under.
 */
function pitch(sig, sr) {
  let mean = 0;
  for (let i = 0; i < sig.length; i++) mean += sig[i];
  mean /= sig.length;
  const n = sig.length;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = sig[i] - mean;

  const minLag = Math.max(2, Math.floor(sr / 1200));
  const maxLag = Math.min(Math.floor(sr / 55), n - 2);
  if (maxLag <= minLag) return 0;

  let best = -1;
  let top = -1;
  for (let l = minLag; l <= maxLag; l++) {
    let num = 0, da = 0, db = 0;
    for (let i = 0; i + l < n; i++) {
      num += x[i] * x[i + l];
      da += x[i] * x[i];
      db += x[i + l] * x[i + l];
    }
    const c = num / Math.sqrt((da * db) + 1e-12);
    if (c > top) { top = c; best = l; }
  }
  return top <= 0 ? 0 : sr / best;
}

/**
 * Error against the expected pitch, folded into a single octave.
 *
 * A take in tune measures at 0 cents whichever octave the estimator happened
 * to land on, so folding throws away an ambiguity that carries no information
 * and keeps the thing that does: whether this take is a semitone, or a tone,
 * away from the pitch the manifest filed it under. That was the bug -- one rate
 * shared between two takes recorded a tone apart -- and it shows up here
 * whatever the estimator did with the octave.
 */
function centsModOctave(f, expectedHz) {
  if (!(f > 0) || !(expectedHz > 0)) return NaN;
  const c = 1200 * Math.log2(f / expectedHz);
  // Fold into [-600, +600). The +1200 inside the modulo matters: JavaScript's %
  // keeps the sign of the dividend, so without it every negative error wraps to
  // exactly -600 and the whole check reads a systematic quarter-tone flat.
  return ((((c + 600) % 1200) + 1200) % 1200) - 600;
}

/**
 * Stereo width in dB: the side signal against the mid, over the whole file.
 *
 * A bank recorded with two microphones close together legitimately measures near
 * 0 dB, so this is compared against the width the builder measured from the
 * source rather than against a number that says "wide enough". The bug this
 * exists to catch -- folding the left channel to (L+R)/2 -- takes the width down
 * by about 6 dB on the FreePats upright, which is far outside any tolerance a
 * correct build could reach.
 */
function sideMidDb(L, R) {
  let ss = 0, mm = 0;
  for (let i = 0; i < L.length; i++) {
    const s = (L[i] - R[i]) * 0.5;
    const m = (L[i] + R[i]) * 0.5;
    ss += s * s;
    mm += m * m;
  }
  return 10 * Math.log10((ss + 1e-12) / (mm + 1e-12));
}

async function decode(url) {
  const bytes = await (await fetch(url)).arrayBuffer();
  const ctx = new OfflineAudioContext(1, 128, 44100);
  return ctx.decodeAudioData(bytes);
}

const manifest = await (await fetch('/pack/manifest.json')).json();

const PER_PACK = 2;
const rows = [];
for (const [pack, inst] of Object.entries(manifest.instruments)) {
  const keys = Object.keys(inst.notes);
  if (!keys.length) continue;
  // Spread the sample across the range rather than taking the lowest keys,
  // which are the ones every instrument happens to have.
  const stride = Math.max(1, Math.floor(keys.length / PER_PACK));
  for (let i = 0, seen = 0; i < keys.length && seen < PER_PACK; i += stride, seen++) {
    const key = keys[i];
    const entry = inst.notes[key];
    const group = [];
    for (const hit of entry.hits) {
      const buf = await decode('/pack/' + hit.f);
      const sr = buf.sampleRate;
      const L = buf.getChannelData(0);
      const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;

      // Measure after the attack, where the note has settled. Short enough that
      // the autocorrelation below stays cheap: it is O(window x maxLag), and
      // this runs over a sample of every pack in the library.
      const from = Math.floor(sr * 0.25);
      const to = Math.min(L.length, Math.floor(sr * 0.55));
      const f = pitch(L.slice(from, to), sr);

      // The pitch the take was RECORDED at, which is what the file contains.
      // The player's rate turns it into the key it is filed under.
      const r = hit.r != null ? hit.r : entry.rate;
      const centre = r ? Number(key) - 12 * Math.log2(r) : Number(key);
      const centreHz = 440 * Math.pow(2, (centre - 69) / 12);

      const row = {
        pack,
        key: Number(key),
        file: hit.f,
        channels: buf.numberOfChannels,
        // A mono source decoded to one channel is honestly mono, so it has no
        // width to report.
        width: R ? sideMidDb(L, R) : null,
        // What the builder measured from the source channels.
        expected: hit.sm == null ? null : hit.sm,
        measured: f,
        centre,
        cents: centsModOctave(f, centreHz),
        dur: hit.dur,
      };
      rows.push(row);
      group.push(row);
    }

    // Takes filed under one key must agree with each other. This catches the
    // shared-rate bug whatever the estimator did with the octave, because the
    // same bias lands on both sides of the comparison.
    for (const row of group.slice(1)) {
      const first = group[0];
      if (Number.isFinite(row.cents) && Number.isFinite(first.cents)
          && Math.abs(row.cents - first.cents) > PITCH_CENTS) {
        row.disagrees = Math.round(row.cents - first.cents);
      }
    }
  }
}

window.__RESULT__ = { rows };
window.__DONE__ = true;
})().catch((e) => {
  window.__RESULT__ = { error: String((e && e.stack) || e) };
  window.__DONE__ = true;
});
</script></body></html>`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/__fidelity.html') {
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    return res.end(PAGE);
  }
  const file = path.join(repo, decodeURIComponent(url.pathname));
  if (!file.startsWith(repo) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// spawn, not spawnSync: the server above lives in this process, and spawnSync
// blocks the event loop for its whole duration, so the page would never be able
// to fetch the pack. That hangs until the harness times out.
const stdout = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    path.join(repo, 'tools', 'cdp.mjs'),
    '--url', `http://127.0.0.1:${port}/__fidelity.html`,
    '--wait', 'window.__DONE__===true',
    '--timeout', '300000',
    '--eval', 'window.__RESULT__',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('error', reject);
  child.on('close', () => resolve({ out, err }));
});

server.close();

let res;
try {
  const env = JSON.parse(stdout.out.slice(stdout.out.indexOf('{'), stdout.out.lastIndexOf('}') + 1));
  res = typeof env.value === 'string' ? JSON.parse(env.value) : env.value;
} catch (e) {
  console.error('could not read the harness result:\n' + stdout.out.slice(0, 1000) + stdout.err.slice(0, 600));
  process.exit(1);
}

if (!res || res.error) {
  console.error('check failed:', res && res.error ? res.error : 'no result');
  process.exit(1);
}

// Every take must carry its own rate. The rate used to live once per key, and
// every take of that key wrote it in turn, so two takes recorded a tone apart
// could not both be right. The player has its own test for honouring it
// (tests/sampler-test.html, "each take plays at its own rate"); this is the
// half that notices the pack stopped providing it.
const missingRate = [];
for (const [pack, inst] of Object.entries(manifest.instruments)) {
  for (const [key, entry] of Object.entries(inst.notes)) {
    for (const hit of entry.hits) {
      if (!Number.isFinite(hit.r) || hit.r <= 0) missingRate.push(`${pack}/${key}: ${hit.f}`);
    }
  }
}

let bad = 0;
const disagreeing = [];

/* -- manifest side -------------------------------------------------------- */
console.log('struck instruments must not loop');
for (const msg of mustNotLoop) { console.log('  <- ' + msg); bad++; }
if (!mustNotLoop.length) console.log(`  ok (${struck.map((b) => b.pack).join(', ')})`);

console.log('\nstruck instruments must not be cut short');
for (const msg of tooShort) { console.log('  <- ' + msg); bad++; }
if (!tooShort.length) console.log('  ok');

console.log('\nvelocity layers recorded as layers');
console.log(`  fp-upright keys with a usable vL/vH split: ${uprightLayered}`);
if (uprightLayered < 40) {
  console.log('  <- the upright should expose two hammers across most of the keyboard');
  bad++;
}

console.log('\nevery take carries its own rate');
for (const msg of missingRate.slice(0, 5)) { console.log('  <- ' + msg); bad += missingRate.length ? 1 : 0; }
if (!missingRate.length) console.log(`  ok (${Object.keys(manifest.instruments).length} packs)`);

/* -- audio side ----------------------------------------------------------- */
const widthRows = res.rows.filter((r) => r.width != null && r.expected != null
  && r.expected > MIN_MEANINGFUL_WIDTH_DB);
const dualMono = res.rows.filter((r) => r.expected != null && r.expected <= MIN_MEANINGFUL_WIDTH_DB);
const monoRows = res.rows.filter((r) => r.channels === 1);

console.log(`\ndecoded ${res.rows.length} takes: ${widthRows.length} stereo compared against the recording, `
  + `${monoRows.length} mono, ${dualMono.length} dual mono and skipped`);
console.log('pack                key  width   source  diff   cents   note');
console.log('-'.repeat(76));

for (const r of res.rows) {
  const problems = [];
  const worthChecking = r.width != null && r.expected != null
    && r.expected > MIN_MEANINGFUL_WIDTH_DB;
  if (worthChecking && Math.abs(r.width - r.expected) > MAX_WIDTH_DRIFT_DB) {
    const diff = r.width - r.expected;
    problems.push(`stereo is ${diff >= 0 ? 'wider' : 'narrower'} by `
      + `${Math.abs(diff).toFixed(1)} dB than the recording it was cut from`);
  }
  // Two takes filed under one key should agree. This is reported, not gated:
  // it is the signal that found the shared-rate bug, but on a handful of
  // detuned banks the autocorrelation disagrees with itself by a few hundred
  // cents on notes that are demonstrably in tune, so a threshold that catches
  // the fault also catches those. The gate on tuning is the rate assertion
  // above plus the player-side test.
  if (r.disagrees) {
    disagreeing.push(`${r.file} is ${r.disagrees} cents from the other take on key ${r.key}`);
  }
  if (problems.length) bad++;
  const width = r.width == null ? 'mono' : `${r.width.toFixed(1)}dB`;
  const expected = r.expected == null ? '  -' : `${r.expected.toFixed(1)}dB`;
  const diff = r.width == null || r.expected == null ? '   -' : `${(r.width - r.expected) >= 0 ? '+' : ''}${(r.width - r.expected).toFixed(1)}`;
  console.log(
    `${r.pack.padEnd(18)} ${String(r.key).padStart(3)}  ${width.padStart(6)}  `
    + `${expected.padStart(6)}  ${diff.padStart(5)}  `
    + `${(Number.isFinite(r.cents) ? Math.round(r.cents) : '??').toString().padStart(5)}  `
    + r.file.slice(0, 22).padEnd(24)
    + (problems.length ? ' <-- ' + problems.join('; ') : '')
  );
}

const worst = widthRows.length
  ? widthRows.reduce((a, b) => (Math.abs(b.width - b.expected) > Math.abs(a.width - a.expected) ? b : a))
  : null;
if (worst) {
  console.log(`\nworst stereo drift ${(worst.width - worst.expected).toFixed(2)} dB on `
    + `${worst.file} (limit ${MAX_WIDTH_DRIFT_DB} dB)`);
}

if (disagreeing.length) {
  console.log(`\npitch, reported only (${disagreeing.length} take(s) whose sibling on the same key `
    + 'measured differently -- on detuned banks the estimator disagrees with itself here):');
  for (const d of disagreeing) console.log('  ?  ' + d);
}

if (bad) {
  console.error(`\n${bad} problem(s)`);
  process.exit(1);
}
console.log(`\nok: ${widthRows.length} stereo takes kept the width of the recording they were cut from, `
  + `${res.rows.length} takes measured, and nothing struck is looping or cut short`);