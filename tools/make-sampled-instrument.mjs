/**
 * tools/make-sampled-instrument.mjs - build a playable instrument from a
 * FreePats bank, doing nothing to the recordings.
 *
 * The pack builder and this differ on purpose, and the differences are the
 * point:
 *
 *   pack builder                        this
 *   ---------------------------------   -----------------------------------
 *   trims leading/trailing silence      keeps the whole file, leading silence
 *                                       and all
 *   peak-normalises every note          leaves every note at its own level
 *   finds and stores loop points        stores none
 *   prepends 1024 samples of silence    prepends nothing
 *   adds a family loudness target       none
 *
 * The encoder delay that the marker used to work around is not worked around at
 * all here: the player measures where each decoded file actually starts and
 * starts the source node there, so the hammer lands when the note says it
 * should. That is a measurement rather than a guess, and it is why the MP3 and
 * the WAV can be compared honestly.
 *
 * Key mapping comes from the bank's own SFZ -- pitch_keycenter, lokey/hikey,
 * and the vL / vH velocity layers in the filenames. Nothing is inferred from a
 * key name or stretched across a range to fill a gap.
 *
 *   node tools/make-sampled-instrument.mjs --freepats <banks> --bank upright-piano-kw
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWav, peakOf } from './lib/wav.mjs';
import { encodeMp3 } from './lib/lame.mjs';
import { parseSfz, regionsForKey, keyCentreOf } from './lib/sfz.mjs';
import { claimTree, removeOwnedTree } from './lib/guard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : dflt;
};
const FP = flag('freepats', 'C:\\Users\\scott\\files\\music\\freepats\\banks');
const BANK = flag('bank', 'upright-piano-kw');
const OUT = path.join(repo, 'docs', flag('out', 'sampled-instrument'));
const KBPS = Number(flag('kbps', 192));

/**
 * Which hammer a take is, from the bank's own filename.
 *
 * vL is the soft strike and vH the hard one. They are not interchangeable: the
 * hard one has more hammer noise, a brighter spectrum and a faster decay. Read
 * from the name because the bank puts it there, not guessed.
 */
function velocityOf(sample) {
  const m = /(?:^|[^A-Za-z])v(\d+|L|M|H)(?=[^A-Za-z]|$)/i.exec(path.basename(sample || ''));
  if (!m) return null;
  const t = m[1].toUpperCase();
  if (t === 'L') return 0.2;
  if (t === 'M') return 0.5;
  if (t === 'H') return 0.85;
  const n = Number(t);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n / 127)) : null;
}

/**
 * First sample that carries signal, as a fraction of the file.
 *
 * Reported, not acted on. The file keeps its leading silence; the player uses
 * this only to know where the recording's attack really is.
 */
function onsetOf(wav, thresholdDb = -60) {
  const thr = Math.pow(10, thresholdDb / 20) * Math.max(peakOf(wav), 1e-9);
  const n = wav.data[0].length;
  for (let i = 0; i < n; i++) {
    for (const c of wav.data) {
      if (Math.abs(c[i]) >= thr) return i / wav.sampleRate;
    }
  }
  return 0;
}

function findSfz(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const r = findSfz(p); if (r) return r; }
    else if (e.name.toLowerCase().endsWith('.sfz')) return p;
  }
  return null;
}

const bankRoot = path.join(FP, BANK, 'extracted');
if (!fs.existsSync(bankRoot)) {
  console.error(`no extracted bank at ${bankRoot}`);
  process.exit(1);
}
const sfzPath = findSfz(bankRoot);
if (!sfzPath) { console.error('no .sfz under', bankRoot); process.exit(1); }

const regions = parseSfz(fs.readFileSync(sfzPath, 'utf8'), path.dirname(sfzPath))
  .filter((r) => r.sample && fs.existsSync(path.join(r.dir, r.sample)));

let lo = Infinity;
let hi = -Infinity;
for (const r of regions) {
  const a = Number(r.lokey);
  const b = Number(r.hikey);
  if (Number.isFinite(a)) lo = Math.min(lo, a);
  if (Number.isFinite(b)) hi = Math.max(hi, b);
}

// Clear only the directory this script fills in. It used to delete OUT itself,
// which is the directory the hand-written page and README live in -- running
// the builder once quietly took the page with it, and the next run of the check
// then reported a decode failure that had nothing to do with audio.
//
// removeOwnedTree() refuses unless the marker claimTree() wrote is still there,
// so a mistyped --out cannot reach a directory this tool never created.
removeOwnedTree(path.join(OUT, 'samples'), 'clear generated samples');
claimTree(path.join(OUT, 'samples'), 'MP3 encodings written by make-sampled-instrument.mjs.');

// ---- encode every take once, straight from its WAV -------------------------
const takes = new Map();     // sample path -> { file, durSec, onsetSec, peak, vel, centre }
const encodeOf = new Map();

for (const r of regions) {
  const abs = path.join(r.dir, r.sample);
  if (takes.has(abs)) continue;
  const wav = readWav(fs.readFileSync(abs));
  const name = path.basename(r.sample).replace(/\.wav$/i, '');
  const outName = `${name}.mp3`;
  const mp3 = encodeMp3(wav.data, wav.sampleRate, KBPS);
  fs.writeFileSync(path.join(OUT, 'samples', outName), mp3);
  takes.set(abs, {
    file: `samples/${outName}`,
    durSec: +(wav.frames / wav.sampleRate).toFixed(6),
    onsetSec: +onsetOf(wav).toFixed(6),
    sourcePeak: +peakOf(wav).toFixed(6),
    sampleRate: wav.sampleRate,
    channels: wav.channels,
    vel: velocityOf(r.sample),
    centre: keyCentreOf(r),
    bytes: mp3.length,
  });
  encodeOf.set(abs, outName);
}

// ---- map keys, using the bank's own key map --------------------------------
const notes = {};
let exact = 0;
let stretched = 0;

for (let midi = Math.max(0, lo); midi <= Math.min(127, hi); midi++) {
  const covering = regionsForKey(regions, midi);
  const layers = [];
  for (const r of covering) {
    const abs = path.join(r.dir, r.sample);
    const t = takes.get(abs);
    if (!t) continue;
    const centre = t.centre == null ? midi : t.centre;
    // 1 when the take was recorded at exactly this key, which is what almost
    // every key of a piano bank gets. Anything else is a real transposition and
    // the fact is recorded rather than hidden.
    const rate = Math.pow(2, (midi - centre) / 12);
    if (rate === 1) exact++; else stretched++;
    layers.push({ ...t, rate: +rate.toFixed(6), cents: +((midi - centre) * 100).toFixed(2) });
  }
  // Softest first, so the player can pick by velocity with a simple scan.
  layers.sort((a, b) => (a.vel ?? 0.5) - (b.vel ?? 0.5));
  if (layers.length) notes[midi] = { layers };
}

const manifest = {
  bank: BANK,
  source: path.basename(sfzPath),
  encoder: `lame ${KBPS} kbps, straight from the source PCM`,
  marker: null,
  loopPoints: null,
  preserved: 'whole file, original level, no trim, no normalisation, no marker, no loop points',
  range: [lo, hi],
  notes,
};

fs.writeFileSync(path.join(OUT, 'instrument.json'), JSON.stringify(manifest, null, 1));

// ---- report ---------------------------------------------------------------
const sizes = [...takes.values()];
const bytes = sizes.reduce((a, t) => a + t.bytes, 0);
const keys = Object.keys(notes).length;
// flatMap, not flat: each value is { layers: [...] }, so flat() stops at the
// wrapper and every count below reads undefined off an object.
const allLayers = Object.values(notes).flatMap((n) => n.layers);
const twoLayer = Object.values(notes).filter((n) => new Set(n.layers.map((l) => l.vel)).size > 1).length;
const native = allLayers.filter((l) => l.cents === 0).length;
const shiftedLayers = allLayers.filter((l) => l.cents !== 0);
const centsSeen = [...new Set(shiftedLayers.map((l) => l.cents))].sort((a, b) => a - b);

console.log(`bank     ${BANK}`);
console.log(`  map     ${keys} keys, ${lo}..${hi}, from ${path.basename(sfzPath)}`);
console.log(`  takes   ${sizes.length} source files, encoded once each`);
console.log(`  layers  ${allLayers.length} in total across ${keys} keys`);
console.log(`  native  ${native} recorded at exactly the key they are filed under`);
console.log(`  shifted ${shiftedLayers.length} the bank genuinely records elsewhere `
  + `(${[...new Set(shiftedLayers.map((l) => l.file.split('/').pop()))].slice(0, 4).join(', ')}…)`
  + `\n          offsets present: ${centsSeen.join(', ')} cents`);
console.log(`  hammers ${twoLayer} of ${keys} keys have more than one`);
console.log(`  levels  ${Math.min(...sizes.map((t) => t.sourcePeak)).toFixed(3)}`
  + ` .. ${Math.max(...sizes.map((t) => t.sourcePeak)).toFixed(3)} peak, left as recorded`);
console.log(`  output  ${(bytes / 1048576).toFixed(1)} MB across ${sizes.length} files`);
console.log(`  nothing was done to any of it: no trim, no normalisation, no resample, no marker, no loops`);
console.log(`\ninstrument  docs/${path.basename(OUT)}/instrument.json`);