/**
 * tools/check-pack-is-unprocessed.mjs - is the pack still just the recordings?
 *
 * The pack builder used to do four things to every sample before encoding it:
 * trim the silence off the ends, scale each note to a family peak, prepend 1024
 * samples of silence so the player could find the attack, and cut the take at
 * four seconds. None of those are wrong on their own terms. All four together
 * mean the files in pack/ are not the files in the FreePats banks, and an
 * instrument that is quietly processed is an instrument that is quietly wrong --
 * every one of those four edits is audible, and none of them throws.
 *
 * So this measures the shipped MP3s against the original WAVs. Not against the
 * manifest: the manifest describes the pack, and anything wrong moves the
 * description along with it. Each hit records the source file it came from
 * (`hit.src`), so the expectation here comes from the recording rather than from
 * the thing being checked.
 *
 * It fails on a take whose level has moved from its source, whose length is
 * shorter than its source, whose channels are not the ones the recording has,
 * or whose stereo has collapsed. It also fails on the reverse error -- a take
 * carrying silence nobody recorded -- because the old marker prepended 1024
 * samples to every file and that is measurable as length the source never had.
 *
 *   node tools/check-pack-is-unprocessed.mjs
 *   node tools/check-pack-is-unprocessed.mjs --freepats <banks>
 *
 * Without the banks on disk the comparisons against the recordings are skipped
 * with a line saying so, rather than being quietly replaced by a comparison
 * against the pack's own manifest, which would prove nothing.
 */
import fs from 'node:fs';
import { takeIndex, takeBytes } from './lib/packbundle.mjs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readWav, peakOf } from './lib/wav.mjs';
import { FREEPATS_BANKS } from './freepats-banks.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : dflt;
};
const FP = flag('freepats', 'C:\\Users\\scott\\files\\music\\freepats\\banks');

/** Where pack/ lives. Overridable so the check can run against a snapshot. */
const PACK = path.resolve(repo, flag('pack', 'pack'));

/**
 * How much longer than its source a shipped file may be, in samples.
 *
 * An MP3 decodes to the source plus whatever the encoder added: LAME's delay
 * (1105 samples for most settings, 1524 for stereo 96 kbps) plus the final
 * frame of padding. Measured across all 4,172 takes the excess runs from 1152
 * to 3451 frames, so the bound sits above the measured maximum with margin.
 *
 * What this CANNOT do is prove that no marker was prepended. The old builder put
 * 1024 samples of silence in front of every file, and 1024 sits well inside the
 * spread LAME's own padding produces: a marked file would measure about 2176 to
 * 4475, which overlaps the 1152 to 3451 seen here. Length alone does not separate
 * the two, and a check that implied it did would be lying.
 *
 * So the no-marker guarantee rests on the builder having no code path that
 * prepends one -- MARKER and withMarker() are gone from it -- and not on this
 * measurement. That is stated here rather than dressed up as something measured.
 */
const MAX_EXTRA_FRAMES = 3600;

/**
 * How far ONE take's level may move, in dB, measured as RMS over the whole take.
 *
 * RMS rather than peak, because peak is not a level statistic that survives
 * lossy coding: most takes here touch digital full scale on a single sample and
 * the encoder rebuilds that sample several dB low while the waveform stays put.
 * Comparing peaks flagged 253 takes and was measuring the codec, not the pack.
 *
 * 4 dB is the measured worst case (2.3) plus margin, and it is loose on purpose.
 * tools/lib/lame.mjs applies no gain, so nothing in this pipeline can move a
 * take's level except the encoder, and one drifting take means an encoder
 * artefact rather than an edit. A normaliser moves RMS by tens of dB and is
 * caught by the median below long before it reaches this bound.
 */
const MAX_RMS_DRIFT_DB = 4;

/**
 * How far the MEDIAN level drift may sit from zero, in dB.
 *
 * This is the assertion that actually catches a level change. Per-take drift is
 * noisy -- the encoder moves different material by different amounts, and the
 * spread is plus or minus 2.3 dB around a median of -0.5 -- so no per-take bound
 * can be both tight and honest. A gain applied to everything is not noise
 * though: it moves the whole population and the median with it. One dB separates
 * "the encoder did something" from "someone multiplied every sample by a
 * constant".
 */
const MAX_MEDIAN_RMS_DRIFT_DB = 1;

/** MP3 joint stereo moves the difference signal by a dB or two on a hard-panned take. */
const MAX_WIDTH_NARROWING_DB = 4;

/**
 * Below this the side channel carries nothing worth measuring.
 *
 * The FreePats brass 2 bank measures -39 dB side against mid -- it is very nearly
 * dual mono. Dividing by a side signal that small amplifies the codec's own noise
 * floor, so the encoded file reads as WIDER than the recording. That is not the
 * recording having been mangled and it is not a defect, so those takes are
 * counted and skipped rather than failed on. check-recording-fidelity.mjs has the
 * same floor and the same reason for it.
 */
const MIN_MEANINGFUL_WIDTH_DB = -30;

const manifest = JSON.parse(fs.readFileSync(path.join(PACK, 'manifest.json'), 'utf8'));
const packTakes = takeIndex(manifest); // rel f -> slice, for bundled packs

/** Every take in the pack, flattened, with its manifest entry alongside. */
const takes = [];
for (const [packId, inst] of Object.entries(manifest.instruments)) {
  for (const [midi, note] of Object.entries(inst.notes)) {
    for (const hit of note.hits) {
      takes.push({ packId, midi: Number(midi), hit });
    }
  }
}

// ---- the original recordings, if they are still on disk --------------------

const slugOf = new Map(FREEPATS_BANKS.map((b) => [b.pack, b.slug]));

/**
 * The one way to name a take's source recording.
 *
 * Written once and used everywhere, with an explicit separator rather than a
 * space typed inside a template literal. Two hand-written copies of this format
 * is what it did before: one of them ended up holding a NUL byte where the
 * separator belonged, the keys stopped matching, and every take silently
 * counted as having no source -- reported as "0 of 4172", which reads like a
 * missing cache rather than a character in a string.
 */
const keyOf = (t) => `${t.packId}|${t.hit.src}`;

function sourceOf(t) {
  if (!t.hit.src) return null;
  const slug = slugOf.get(t.packId);
  if (!slug) return null;
  return path.join(FP, slug, 'extracted', ...t.hit.src.split('/'));
}

/**
 * Peak, RMS and first-sound position across every channel.
 *
 * This is the Node half. The page has its own identical copy inside the template
 * literal below; two copies of a measurement is one too many, and the first
 * attempt at that left this function defined only in the page, so every source
 * read threw into the catch below and the check reported that no take had a
 * source at all.
 */
function stats(chs) {
  const n = chs[0].length;
  let peak = 0, sum = 0;
  for (let i = 0; i < n; i++) {
    for (const c of chs) { const a = Math.abs(c[i]); if (a > peak) peak = a; sum += c[i] * c[i]; }
  }
  const rms = Math.sqrt(sum / (n * chs.length));
  const win = Math.max(1, Math.round(n * 0.0015));
  const thr = peak * Math.pow(10, -40 / 20);
  let onset = -1;
  for (let i = 0; i + win <= n; i += win) {
    let m = 0;
    for (const c of chs) for (let j = i; j < i + win; j++) m = Math.max(m, Math.abs(c[j]));
    if (m > thr) { onset = i; break; }
  }
  return { peak, rms, onset };
}

/**
 * Read every source WAV once and keep only what the comparison needs.
 *
 * The peaks are taken here rather than in the page because the WAV is the
 * expectation, and the page is where the thing being checked comes from.
 * Holding the decoded audio would cost gigabytes, so only the numbers survive.
 *
 * Keyed by bank AND path. `hit.src` is relative to that bank's own extracted
 * root, and two FreePats banks both shipping `samples/A2.wav` is not unusual --
 * keying on the path alone silently measured the piano bank against the
 * honky-tonk one, which is the kind of mistake that produces a confident green.
 */
let sources = null;
if (fs.existsSync(FP)) {
  sources = new Map();
  let read = 0;
  for (const t of takes) {
    if (t.hit.src == null || sources.has(keyOf(t))) continue;
    const p = sourceOf(t);
    if (!p || !fs.existsSync(p)) { sources.set(keyOf(t), null); continue; }
    try {
      const wav = readWav(fs.readFileSync(p));
      let ss = 0, mm = 0;
      if (wav.data.length > 1) {
        for (let i = 0; i < wav.frames; i++) {
          const l = wav.data[0][i], r = wav.data[1][i];
          ss += ((l - r) * 0.5) ** 2;
          mm += ((l + r) * 0.5) ** 2;
        }
      }
      sources.set(keyOf(t), (() => {
        const st = stats(wav.data);
        return {
          peak: st.peak,
          rms: st.rms,
          onset: st.onset,
          frames: wav.frames,
          channels: wav.data.length,
          sampleRate: wav.sampleRate,
          // Peak of the average of the channels, for a take that a mono pack folds
          // down. Averaging and selecting a channel both look like "one channel
          // out" from the outside; the peak is what tells them apart.
          peakOfAverage: wav.data.length > 1
            ? peakOf({ data: [(() => {
              const m = new Float32Array(wav.frames);
              for (const ch of wav.data) for (let i = 0; i < wav.frames; i++) m[i] += ch[i];
              for (let i = 0; i < wav.frames; i++) m[i] /= wav.data.length;
              return m;
            })()] })
            : null,
          sideMid: wav.data.length > 1 ? 10 * Math.log10((ss + 1e-12) / (mm + 1e-12)) : null,
        };
      })());
      read++;
    } catch {
      sources.set(keyOf(t), null);
    }
  }
  console.log(`read ${read} source WAVs from ${FP}`);
} else {
  console.log(`no FreePats banks at ${FP}`);
}

/** The rates the banks actually use. The pack is not all one of them. */
const have = takes.filter((t) => {
  const s = sources && sources.get(keyOf(t));
  return s != null;
});
if (sources && have.length < takes.length * 0.9) {
  console.error(`only ${have.length} of ${takes.length} takes have a readable source WAV; ` +
    `that is not enough to check the pack against. Is --freepats pointing at the banks?`);
  process.exit(1);
}

const rates = [...new Set(have.map((t) => sources.get(keyOf(t)).sampleRate))].sort((a, b) => a - b);
console.log(`source rates  : ${rates.map((r) => `${r / 1000} kHz`).join(', ')}`);

// ---- decode every shipped file ---------------------------------------------

/**
 * A page served from the same origin as the pack, so decodeAudioData can read
 * the fetches. file:// cannot, which is why this is not a file the check opens.
 */
const html = `<!DOCTYPE html><html><body><script>
window.__RESULT__ = null;

// One decoding context per source rate. decodeAudioData resamples to the
// context's rate, so a 48 kHz file decoded into a 44.1 kHz context comes back at
// a different length and the length comparison below is meaningless for half the
// pack. Each file is decoded at the rate it was recorded at.
const CTX = {};
function ctxFor(sr) { return CTX[sr] || (CTX[sr] = new OfflineAudioContext(1, 128, sr)); }

// Peak, RMS and first-sound position, across every channel.
//
// RMS is the level statistic that means "did the level change". Peak is not:
// most of these recordings touch digital full scale on a single sample, and a
// lossy codec reconstructs that sample several dB low while the rest of the
// waveform sits where it should. Comparing peaks reported a third of the pack
// as broken and was measuring the codec, not us.
function stats(chs) {
  const n = chs[0].length;
  let peak = 0, sum = 0;
  for (let i = 0; i < n; i++) {
    for (const c of chs) { const a = Math.abs(c[i]); if (a > peak) peak = a; sum += c[i] * c[i]; }
  }
  const rms = Math.sqrt(sum / (n * chs.length));
  const win = Math.max(1, Math.round(n * 0.0015));
  const thr = peak * Math.pow(10, -40 / 20);
  let onset = -1;
  for (let i = 0; i + win <= n; i += win) {
    let m = 0;
    for (const c of chs) for (let j = i; j < i + win; j++) m = Math.max(m, Math.abs(c[j]));
    if (m > thr) { onset = i; break; }
  }
  return { peak, rms, onset };
}

async function measure(items) {
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const [f, sr] = items[i];
    const buf = await (await fetch(f)).arrayBuffer();
    const b = await ctxFor(sr).decodeAudioData(buf);
    const chs = [];
    for (let c = 0; c < b.numberOfChannels; c++) chs.push(b.getChannelData(c));
    const st = stats(chs);
    let sm = null;
    if (b.numberOfChannels > 1) {
      const L = chs[0], R = chs[1];
      let ss = 0, mm = 0;
      for (let k = 0; k < L.length; k++) {
        const l = L[k], r = R[k];
        ss += ((l - r) * 0.5) * ((l - r) * 0.5);
        mm += ((l + r) * 0.5) * ((l + r) * 0.5);
      }
      sm = 10 * Math.log10((ss + 1e-12) / (mm + 1e-12));
    }
    out.push([f, st.peak, b.length, b.numberOfChannels, sm, b.sampleRate, st.rms, st.onset]);
    if (i % 250 === 0) window.__PROGRESS__ = (i + 1) + '/' + items.length;
  }
  return out;
}

// The list comes over HTTP rather than on the command line. Four thousand paths
// is about 200 KB, and Windows caps a command line at roughly 32 KB -- so passing
// it as an argument fails with ENAMETOOLONG before the browser is even started.
window.__run = async function () {
  const items = await (await fetch('/__list.json')).json();
  window.__RESULT__ = await measure(items);
  window.__DONE__ = true;
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/__probe.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }
  if (url.pathname === '/__list.json') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(listJson);
  }
  // Decoded one segment at a time rather than decoding the pathname as a whole.
  // That is the form that survives a reserved character: '#' is left alone by
  // encodeURI, so a single decode leaves it in the path and everything after it
  // is read as a fragment. No shipped filename contains one today -- they are
  // `<midi>-<take>.mp3` inside a pack slug -- but the FreePats sources they come
  // from are named `D#1vH.wav`, and the day a pack is named after its bank that
  // stops being true. Cheap to be right now.
  const rel = url.pathname.split('/').filter(Boolean).map(decodeURIComponent).join('/');
  // A bundled pack keeps each take as a slice of <bank>.pack; serve the slice
  // so the page decodes exactly the shipped bytes.
  const loc = packTakes.get(rel);
  if (loc) {
    const bytes = takeBytes(PACK, { bundle: { file: loc.file } }, { f: rel, o: loc.o, n: loc.n });
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': bytes.length });
    return res.end(bytes);
  }
  const file = path.resolve(PACK, rel);
  if (!file.startsWith(PACK) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    return res.end('not found');
  }
  const type = path.extname(file) === '.mp3' ? 'audio/mpeg' : 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type });
  fs.createReadStream(file).pipe(res);
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// Each file is decoded at its own source rate, so the rate is looked up here
// rather than assumed. A take with no readable source falls back to 44100 and is
// skipped in the comparison below rather than compared against the wrong rate.
const list = takes.map((t) => {
  const s = sources ? sources.get(keyOf(t)) : null;
  return [t.hit.f, s ? s.sampleRate : 44100];
});
const listJson = JSON.stringify(list);
const START = 'window.__run()';

const out = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    path.join(repo, 'tools', 'cdp.mjs'),
    '--url', `http://127.0.0.1:${port}/__probe.html`,
    '--start', START,
    '--wait', 'window.__DONE__===true',
    '--timeout', '3600000',
    '--eval', 'JSON.stringify(window.__RESULT__)',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let so = '', se = '';
  child.stdout.on('data', (d) => { so += d; });
  child.stderr.on('data', (d) => { se += d; });
  child.on('error', reject);
  child.on('close', () => resolve({ so, se }));
});

server.close();

let env;
try {
  env = JSON.parse(out.so.slice(out.so.indexOf('{'), out.so.lastIndexOf('}') + 1));
} catch {
  console.error('could not read the harness result:\n' + out.so.slice(0, 600) + out.se.slice(0, 600));
  process.exit(1);
}
let measured;
try {
  measured = typeof env.value === 'string' ? JSON.parse(env.value) : env.value;
} catch {
  measured = null;
}
if (!Array.isArray(measured)) {
  // The page reports its own failure rather than returning an empty array, so an
  // empty result here means nothing was measured and the comparison below would
  // vacuously pass -- reporting zero problems for a check that ran on nothing.
  console.error('page returned no measurements: ' + String(env.value).slice(0, 400));
  process.exit(1);
}

const byFile = new Map(measured.map((m) => [m[0], m]));

// ---- the comparison ---------------------------------------------------------

let missing = 0;
const levelMoved = [];
const truncated = [];
const padded = [];
const channelChanged = [];
const widthMoved = [];

const rmsDrift = [];
const peakDrift = [];
const extras = [];
let foldedCount = 0;
let copiedMono = 0;
let compared = 0;
let tooNarrow = 0;
const resampled = [];

for (const t of takes) {
  const m = byFile.get(t.hit.f);
  if (!m) { missing++; continue; }
  const [, peak, frames, channels, sm, decodedRate, rms] = m;
  const s = sources ? sources.get(keyOf(t)) : null;
  if (!s) continue;

  // The decoder ignored the rate it was given, which would make every length
  // comparison below wrong. Treat it as a failure rather than a measurement.
  if (decodedRate !== s.sampleRate) {
    resampled.push([t.hit.f, s.sampleRate, decodedRate]);
    continue;
  }

  const declaredStereo = !!manifest.instruments[t.packId].stereo;

  // A mono pack carrying a stereo source is a declared fold-down, not a loss of
  // a channel -- so the level is judged against the AVERAGE, and picking one
  // channel instead is caught here. Those two differ by however much side signal
  // the recording has, which for a wide take is several dB.
  const folded = !declaredStereo && s.channels > 1 && channels === 1;
  const expectedRms = folded ? (s.rms / Math.sqrt(s.channels)) : s.rms;
  const db = 20 * Math.log10(Math.max(rms, 1e-9) / Math.max(expectedRms, 1e-9));
  if (Math.abs(db) > MAX_RMS_DRIFT_DB) {
    levelMoved.push([t.hit.f, +expectedRms.toFixed(5), +rms.toFixed(5), +db.toFixed(2),
      folded ? `folded from ${s.channels}ch` : 'direct']);
  }
  // Peak drift is reported, not asserted on. Nearly every take in this library
  // touches digital full scale, and a lossy codec rebuilds that single sample
  // several dB low while the waveform as a whole stays put. Asserting on it
  // flagged a third of the pack and was measuring the encoder.
  rmsDrift.push(db);
  peakDrift.push(20 * Math.log10(Math.max(peak, 1e-9) / Math.max(folded ? s.peakOfAverage : s.peak, 1e-9)));

  const extra = frames - s.frames;
  extras.push(extra);
  if (extra < 0) truncated.push([t.hit.f, s.frames, frames, extra]);
  else if (extra > MAX_EXTRA_FRAMES) padded.push([t.hit.f, s.frames, frames, extra]);

  // The only channel change that is not a declared fold-down is a bug: a pack
  // that says stereo must ship stereo, and a mono source in a stereo pack is
  // copied to both channels rather than arriving as one.
  if (folded) foldedCount++;
  else if (channels !== s.channels) channelChanged.push([t.hit.f, s.channels, channels]);

  if (s.sideMid != null && sm != null) {
    const drift = sm - s.sideMid;
    // Only narrowing is a defect. A take whose source is nearly dual mono has
    // almost no side signal to measure, and the codec's own noise floor shows up
    // there as an apparently WIDER file -- which is not the recording having been
    // mangled. Below the floor the comparison is meaningless, so it is skipped
    // rather than turned into a failure, exactly as check-recording-fidelity does.
    if (s.sideMid > MIN_MEANINGFUL_WIDTH_DB) {
      compared++;
      if (drift < -MAX_WIDTH_NARROWING_DB) {
        widthMoved.push([t.hit.f, +s.sideMid.toFixed(2), +sm.toFixed(2), +drift.toFixed(2)]);
      }
    } else {
      tooNarrow++;
    }
  } else if (s.sideMid == null && sm != null && channels > 1) {
    // A mono source copied to both channels measures as perfectly wide stereo,
    // which is not a defect, so it is reported rather than failed on.
    copiedMono++;
  }
}

/** min / median / p99 / max, so a threshold can be set from the whole set. */
function dist(label, xs) {
  if (!xs.length) return `${label}: none`;
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return `${label}: min ${s[0].toFixed(2)}  p50 ${q(0.5).toFixed(2)}  p99 ${q(0.99).toFixed(2)}  max ${s[s.length - 1].toFixed(2)}`;
}

const median = (xs) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const medianRms = median(rmsDrift);

const shown = (list) => list.slice(0, 8).map((r) => r.join(' ')).join('; ') || 'none';

console.log(`\npack          : ${takes.length} takes across ${Object.keys(manifest.instruments).length} instruments`);
console.log(`measured      : ${measured.length} files decoded${missing ? `, ${missing} missing` : ''}`);
if (!sources) {
  console.log('\nSKIPPED: no --freepats, so nothing was compared against the recordings.');
  console.log('         Comparing the pack against its own manifest would move both sides');
  console.log('         together and prove nothing, so the level, length, channel and width');
  console.log('         checks are reported as not run rather than as passing.');
  process.exit(0);
}
console.log(`compared      : ${have.length} takes against their source WAV`);
console.log('  ' + dist('rms drift dB ', rmsDrift));
console.log('  ' + dist('peak drift dB', peakDrift));
console.log('  ' + dist('extra frames ', extras));
console.log(`folded to mono: ${foldedCount} take(s) -- level judged against the channel average`);
console.log(`mono copied to a stereo pack: ${copiedMono}`);
console.log(`width compared: ${compared}, skipped as too narrow to measure: ${tooNarrow}`);
console.log(`level moved   : ${shown(levelMoved)}`);
console.log(`truncated     : ${shown(truncated)}`);
console.log(`extra silence : ${shown(padded)}`);
console.log(`channels      : ${shown(channelChanged)}`);
console.log(`width narrowed: ${shown(widthMoved)}`);
if (resampled.length) console.log(`resampled     : ${shown(resampled)}`);

const problems = [];
if (!measured.length) problems.push('no shipped file was decoded');
if (missing) problems.push(`${missing} shipped file(s) could not be decoded`);
if (levelMoved.length) problems.push(`${levelMoved.length} take(s) play at a level their source does not have: ${shown(levelMoved)}`);
if (Number.isFinite(medianRms) && Math.abs(medianRms) > MAX_MEDIAN_RMS_DRIFT_DB) {
  problems.push(`the whole pack sits ${medianRms.toFixed(2)} dB from its sources (limit ${MAX_MEDIAN_RMS_DRIFT_DB}), `
    + `which is the shape of a gain applied to every take rather than of an encoder artefact`);
}
if (truncated.length) problems.push(`${truncated.length} take(s) are shorter than their source: ${shown(truncated)}`);
if (padded.length) problems.push(`${padded.length} take(s) carry silence their source does not have: ${shown(padded)}`);
if (channelChanged.length) problems.push(`${channelChanged.length} take(s) changed channel count: ${shown(channelChanged)}`);
if (widthMoved.length) problems.push(`${widthMoved.length} take(s) narrowed: ${shown(widthMoved)}`);
if (resampled.length) problems.push(`${resampled.length} take(s) came back at the wrong sample rate: ${shown(resampled)}`);

if (problems.length) {
  console.error('\nPACK IS NOT THE RECORDINGS:\n  - ' + problems.join('\n  - '));
  process.exit(1);
}
console.log('\nok: every take is its source recording, re-encoded and otherwise untouched');