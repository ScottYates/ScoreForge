/**
 * tools/survey-samples.mjs - what is actually in the cached VCSL set?
 *
 * Run before writing the pack builder, so the pack is designed around the real
 * files rather than around what the library is supposed to contain.
 *
 *   node tools/survey-samples.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readWav, peakOf, envelope } from './lib/wav.mjs';
import { pitchIn } from './lib/pitch.mjs';

const argv = process.argv.slice(2);
const labelAt = argv.indexOf('--label');
const LABEL = labelAt >= 0 ? argv[labelAt + 1] : null;
const positional = argv.filter((a, i) => i !== labelAt && i !== labelAt + 1);
const dir = positional[0] || path.join(os.tmpdir(), 'sf-sample-cache');
const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.wav'));

const groups = new Map();
const odd = [];

for (const f of files) {
  const base = path.basename(f, '.wav');
  const parts = base.split('_');
  // VCSL names lead with the family (`GPiano_A3_v2`). Salamander names carry no
  // family at all (`A3vH`), so without --label every file becomes its own group
  // and the useful summary -- one line per instrument -- is 26 lines of one note.
  const inst = LABEL || (parts.length > 1 ? parts[0] : base);
  const midi = pitchIn(base);
  if (midi == null) { odd.push(f); continue; }
  let g = groups.get(inst);
  if (!g) groups.set(inst, (g = { notes: new Map(), files: [], rates: new Set(), bits: new Set(), chans: new Set() }));
  g.files.push(f);
  g.rates.add(0);
  if (!g.notes.has(midi)) g.notes.set(midi, []);
  g.notes.get(midi).push(f);
}

console.log(`${files.length} wav files in ${dir}\n`);

for (const [inst, g] of groups) {
  const midis = [...g.notes.keys()].sort((a, b) => a - b);
  // Read one representative file fully to learn the format.
  const probe = readWav(fs.readFileSync(path.join(dir, g.files[0])));
  g.rates = [probe.sampleRate];
  g.bits = [probe.bits ?? 'n/a'];
  g.chans = [probe.channels];

  const variantCounts = midis.map((m) => g.notes.get(m).length);
  const gaps = [];
  for (let m = midis[0]; m <= midis[midis.length - 1]; m++) if (!g.notes.has(m)) gaps.push(m);

  console.log(`${inst}`);
  console.log(`  pitches   ${midis.length}: ${midis[0]}..${midis[midis.length - 1]}` +
    (midis.length ? `  [${midis.slice(0, 8).join(',')}${midis.length > 8 ? '...' : ''}]` : ''));
  console.log(`  gaps      ${gaps.length ? gaps.join(',') : 'none'}`);
  console.log(`  variants  min ${Math.min(...variantCounts)} max ${Math.max(...variantCounts)}`);
  console.log(`  format    ${probe.sampleRate} Hz, ${probe.channels} ch, ${probe.frames} frames (${(probe.frames / probe.sampleRate).toFixed(2)}s)`);

  // Duration + decay shape for a low, middle and high pitch.
  const probes = [midis[0], midis[Math.floor(midis.length / 2)], midis[midis.length - 1]].filter((m) => m != null);
  const bits = [];
  for (const m of probes) {
    const wav = readWav(fs.readFileSync(path.join(dir, g.notes.get(m)[0])));
    const env = envelope(wav, 0.02);
    const peak = peakOf(wav);
    // Decay measured against the loudest 20 ms window, not the single loudest
    // sample: a mallet click is one spike, and measuring against it makes every
    // real note look like it has already died.
    let head = 0;
    for (let i = 0; i < Math.min(12, env.length); i++) head = Math.max(head, env[i]);
    const floor = head * 0.01;
    const t40 = [...env].findIndex((v) => v < floor);
    bits.push(`m${m}: ${(wav.frames / wav.sampleRate).toFixed(2)}s peak ${peak.toFixed(3)} head ${head.toFixed(3)}` +
      ` -40dB@${t40 < 0 ? '>' + (env.length * 0.02).toFixed(1) + 's' : (t40 * 0.02).toFixed(2) + 's'}`);
  }
  console.log(`  decay     ${bits.join(' | ')}`);
  const bytes = g.files.reduce((a, f) => a + fs.statSync(path.join(dir, f)).size, 0);
  console.log(`  size      ${(bytes / 1048576).toFixed(1)} MB\n`);
}

if (odd.length) {
  console.log(`could not read a pitch from ${odd.length} names:`);
  for (const o of odd.slice(0, 10)) console.log('  ' + o);
}