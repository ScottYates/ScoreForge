/**
 * tools/survey-freepats.mjs - what did we actually download?
 *
 * The pack builder needs per-bank answers before it can be written: how many
 * real pitches there are, how wide the key range is, the sample rate (FreePats
 * publishes everything from 44.1 kHz to 48 kHz, and the pack manifest assumes
 * one), whether the samples are stereo, and whether they sustain or decay.
 *
 * Those last two decide things that are not obvious from a name. A bank whose
 * samples ring for four seconds wants loop points; one whose samples are gone
 * in half a second must not loop or every held note will buzz. Guessing per
 * instrument is how a harpsichord ends up sustaining like a pipe organ.
 *
 *   node tools/survey-freepats.mjs <banks-dir>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSfz, regionsForKey, keyCentreOf, loopsRegion } from './lib/sfz.mjs';
import { readWav } from './lib/wav.mjs';

// os.tmpdir() rather than the TEMP environment variable, which is undefined on
// Linux and macOS, so the tool only found its default cache on the one platform
// it was written on. npm test scans for exactly that, which is also why the name
// of the variable is spelled out in words here rather than written literally.
const banksDir = process.argv[2] || path.join(os.tmpdir(), 'sf-freepats');

// Enumerate the banks by looking at what is on disk, not by trusting
// downloaded.json. Several download workers ran at once and that file is
// last-writer-wins, so it silently loses rows -- a survey built on it would
// cheerfully report a short sample set while most of the samples sat on disk
// unexamined. Metadata from it is used only where it happens to be present.
const meta = new Map();
const indexFile = path.join(banksDir, 'downloaded.json');
if (fs.existsSync(indexFile)) {
  for (const r of JSON.parse(fs.readFileSync(indexFile, 'utf8'))) meta.set(r.slug, r);
}
const banks = fs.readdirSync(banksDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(banksDir, d.name, 'extracted')))
  .map((d) => ({ slug: d.name, ...(meta.get(d.name) || {}) }))
  .sort((a, b) => a.slug.localeCompare(b.slug));

console.log(`${banks.length} bank director${banks.length === 1 ? 'y' : 'ies'} on disk` +
  ` (metadata known for ${banks.filter((b) => b.bank).length})\n`);

/** Every .sfz under a directory. */
function findSfz(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.sfz$/i.test(e.name)) out.push(p);
    }
  })(dir);
  return out;
}

const rows = [];
for (const bank of banks) {
  const dir = path.join(banksDir, bank.slug, 'extracted');
  if (!fs.existsSync(dir)) { rows.push({ ...bank, error: 'not extracted' }); continue; }
  const sfzs = findSfz(dir);
  if (!sfzs.length) { rows.push({ ...bank, error: 'no sfz' }); continue; }

  let regions = [];
  for (const s of sfzs) regions = regions.concat(parseSfz(fs.readFileSync(s, 'utf8'), path.dirname(s)));

  // Which keys are playable, and how many distinct takes does each key have?
  let lo = 999, hi = -1;
  const realPitches = new Set();
  const perKey = new Map();
  for (const r of regions) {
    const c = keyCentreOf(r);
    realPitches.add(c);
    const l = Number(r.lokey ?? 0), h = Number(r.hikey ?? 127);
    if (l < lo) lo = l;
    if (h > hi) hi = h;
    for (let k = l; k <= h && k <= 127; k++) perKey.set(k, (perKey.get(k) || 0) + 1);
  }

  // Format of the audio itself, read from a real file rather than the name.
  const first = regions.find((r) => fs.existsSync(path.join(r.dir, r.sample)));
  let rate = 0, ch = 0, seconds = 0, stereo = 0;
  if (first) {
    try {
      const w = readWav(fs.readFileSync(path.join(first.dir, first.sample)));
      rate = w.sampleRate; ch = w.channels; seconds = +(w.frames / w.sampleRate).toFixed(2);
    } catch (e) { /* reported as unknown below */ }
  }
  // And how many of the bank are stereo, which decides the pack's stereo flag.
  const probes = regions.slice(0, 12).filter((r) => fs.existsSync(path.join(r.dir, r.sample)));
  for (const r of probes) {
    try { if (readWav(fs.readFileSync(path.join(r.dir, r.sample))).channels > 1) stereo++; } catch { /* ignore */ }
  }

  rows.push({
    ...bank,
    keys: perKey.size,
    lo: perKey.size ? Math.min(...perKey.keys()) : 0,
    hi: perKey.size ? Math.max(...perKey.keys()) : 0,
    real: realPitches.size,
    takes: +(perKey.size ? [...perKey.values()].reduce((a, b) => a + b, 0) / perKey.size : 0).toFixed(1),
    sfzLoops: regions.filter(loopsRegion).length,
    rate, ch, seconds,
    stereoFrac: probes.length ? +(stereo / probes.length).toFixed(2) : 0,
    tune: regions.some((r) => r.tune != null),
  });
}

rows.sort((a, b) => String(a.slug).localeCompare(String(b.slug)));
console.log('bank                          keys   range     real  takes  rate  ch  secs  loop  stereo');
console.log('-'.repeat(96));
for (const r of rows) {
  if (r.error) { console.log(`${String(r.slug).padEnd(28)}  !! ${r.error}`); continue; }
  console.log(
    String(r.slug).padEnd(28) +
    String(r.keys).padStart(4) + '  ' +
    `${r.lo}-${r.hi}`.padEnd(9) +
    String(r.real).padStart(4) + '  ' +
    String(r.takes).padStart(5) + '  ' +
    String(r.rate || '?').padStart(4) + '  ' +
    String(r.ch || '?').padStart(2) + '  ' +
    String(r.seconds || '?').padStart(5) + '  ' +
    (r.sfzLoops ? 'yes' : 'no').padStart(4) + '   ' +
    (r.stereoFrac >= 0.5 ? 'yes' : 'no')
  );
}

const ok = rows.filter((r) => !r.error);
console.log(`\n${ok.length}/${rows.length} banks surveyed`);
const rates = {};
for (const r of ok) rates[r.rate] = (rates[r.rate] || 0) + 1;
console.log('sample rates:', JSON.stringify(rates));
const pitchless = ok.filter((r) => !r.keys);
if (pitchless.length) {
  console.log(`\n!! ${pitchless.length} bank(s) expose no playable key at all:`);
  for (const r of pitchless) console.log(`   ${r.slug}`);
}
fs.writeFileSync(path.join(banksDir, 'survey.json'), JSON.stringify(rows, null, 2));
console.log(`\nwritten to ${path.join(banksDir, 'survey.json')}`);