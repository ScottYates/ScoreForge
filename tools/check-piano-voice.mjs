/**
 * tools/check-piano-voice.mjs — what does the Concert Grand actually sound like?
 *
 * "The piano sounds terrible" is not actionable on its own, and retuning an
 * additive voice by ear against nothing is how it stays bad. The app already
 * ships recorded pianos from FreePats -- real instruments played and
 * sampled -- so one can be used as the reference. Whatever the synth gets wrong
 * can be stated as a difference from a piano that is known to be one.
 *
 * The measurements are the ones that separate a piano from a synth pad:
 *
 *   attack        time from note-on to peak. A piano is fast but its hammer
 *                 arrives over a few ms; 0 ms is a click, 60 ms is a pad.
 *   brightness    spectral centroid early vs late. A real piano loses its top
 *                 far faster than its bottom, so the sound *darkens* as it
 *                 rings. A synth whose partials all decay together holds its
 *                 brightness -- that is the "buzzer" sound, and it is measured
 *                 here as the drop in centroid between 60 ms and 2 s.
 *   partial decay how fast partials 2..6 die relative to the fundamental.
 *   inharmonic    partials sit above exact multiples, increasingly with pitch.
 *   strike        high-frequency energy in the first 20 ms -- the hammer.
 *
 * Rendered offline at 44.1 kHz. Needs no backend: the pack is served by the
 * local http server below, because fetch() of pack/ is blocked on file://.
 *
 *   node tools/check-piano-voice.mjs [instrumentId]
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUBJECT = process.argv[2] || 'grand';
const REFERENCE = 'rec-fp-upright';
const MIDI = Number(process.argv[3] || 60);
const VEL = Number(process.argv[4] || 0.80);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.mp3': 'audio/mpeg', '.png': 'image/png',
};

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>piano voice</title></head>
<body><script type="module">
import { loadPack, preparePack } from '/src/js/audio/sampler.js';
import { createInstrument, packFor } from '/src/js/audio/instruments.js';

/* ------------------------------------------------------------- measurement */

const SR = 44100;

/** Goertzel: the magnitude of one exact frequency in a window. Cheaper and
 *  sharper than an FFT for the handful of bins we care about, and it needs no
 *  window function to compare magnitudes between two signals. */
function goertzel(x, from, n, freq) {
  const k = (2 * Math.PI * freq) / SR;
  const c = 2 * Math.cos(k);
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    const w = x[from + i] || 0;
    s0 = w + c * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2)) / n;
}

/** Power spectrum over log-spaced bins, by Goertzel at each. A real spectrum is
 *  needed: summing |sample| against bin index is not one, and it reports the
 *  centroid of the window rather than of the sound. */
function spectrum(x, from, n, loHz = 50, hiHz = 16000, bins = 160) {
  const out = [];
  const ratio = Math.log(hiHz / loHz);
  for (let b = 0; b < bins; b++) {
    const f = loHz * Math.exp((ratio * b) / (bins - 1));
    out.push([f, goertzel(x, from, n, f)]);
  }
  return out;
}

/** Spectral centroid in Hz: the brightness, weighted by power. */
function centroid(spec) {
  let num = 0, den = 0;
  for (const [f, m] of spec) { num += f * m * m; den += m * m; }
  return den > 1e-18 ? num / den : 0;
}

function rms(x, from, n) {
  let s = 0;
  for (let i = 0; i < n; i++) { const v = x[from + i] || 0; s += v * v; }
  return Math.sqrt(s / n);
}

/** Frequency of a partial near f0*n, by scanning a fine grid. Reveals
 *  inharmonicity, which exact-bin Goertzel at n*f0 would round away. */
function partialFreq(x, from, n, f0, mult) {
  let best = 0, bestMag = 0;
  const lo = f0 * mult * 0.985, hi = f0 * mult * 1.015;
  for (let f = lo; f <= hi; f += f0 * mult * 0.0004) {
    const m = goertzel(x, from, n, f);
    if (m > bestMag) { bestMag = m; best = f; }
  }
  return best;
}

/** Energy in a band around a frequency.
 *
 *  Not a single Goertzel bin: the synth spreads each partial across up to three
 *  detuned unisons, and a real string is stretched above its exact harmonic, so
 *  an exact-bin reading measures the beating and the tuning error rather than the
 *  partial. Sampling the band is what makes synth and recording comparable at
 *  all. */
function bandEnergy(x, from, n, centre, halfWidthHz) {
  let e = 0;
  const steps = 14;
  for (let i = 0; i <= steps; i++) {
    const f = centre * (1 - halfWidthHz) + (2 * centre * halfWidthHz * i) / steps;
    const m = goertzel(x, from, n, f);
    e += m * m;
  }
  return Math.sqrt(e);
}

async function measure(id, midi, secs, vel) {
  // Decoding is a separate step from fetching now, and createInstrument falls
  // back to the modelled twin when it has not happened -- which would make this
  // check measure its own subject as the thing it is comparing against.
  const pack = packFor(id);
  if (pack) await preparePack(pack, [midi]);
  const WHEN = 0.30;
  const off = new OfflineAudioContext(1, Math.ceil(SR * secs), SR);
  const inst = createInstrument(id, off, off.destination);
  inst.noteOn({ midi, velocity: vel, when: WHEN, duration: secs - WHEN - 0.2 });
  const buf = await off.startRendering();
  const d = buf.getChannelData(0);

  let peak = 0, peakAt = 0;
  for (let i = 0; i < d.length; i++) {
    const a = Math.abs(d[i]);
    if (a > peak) { peak = a; peakAt = i / SR; }
  }
  const s0 = Math.round(WHEN * SR);
  const win = Math.round(SR * 0.05);
  const f0 = 440 * Math.pow(2, (midi - 69) / 12);

  // Early window: just after the attack, where brightness is highest.
  const early = s0 + Math.round(SR * 0.060);
  // Late window: well into the decay.
  const lateFrom = Math.min(s0 + Math.round(SR * 2.0), d.length - win - 1);

  const earlyC = centroid(spectrum(d, early, win));
  const lateC = centroid(spectrum(d, lateFrom, win));

  const partials = [];
  for (const mult of [1, 2, 3, 4, 5, 6]) {
    partials.push({
      mult,
      early: bandEnergy(d, early, win, f0 * mult, 0.02),
      late: bandEnergy(d, lateFrom, win, f0 * mult, 0.02),
      freq: mult <= 3 ? partialFreq(d, early, win, f0, mult) : 0,
    });
  }

  // How much of the partial each keeps. A real piano's upper partials fall away
  // steeply -- far faster than the fundamental -- so the note darkens as it
  // rings. If this is near 1 for every partial the voice has no warmth and no
  // reason to sound struck.
  const rel = partials.map((p) => (p.early > 1e-9 ? p.late / p.early : 0));

  // The decay itself, sampled across the note. An exponential with a long time
  // constant and one that has already collapsed look the same at two points.
  const envelope = [];
  for (let t = 0; t <= 3.5; t += 0.25) {
    const at = s0 + Math.round(SR * t);
    envelope.push([t, +rms(d, at, win).toFixed(5)]);
  }

  // Wobble: how much louder the note gets *after* it has started dying. A real
  // piano decays monotonically. A synth whose unison strings share one envelope
  // and are detuned by a constant number of cents beats against each other at a
  // rate set by the fundamental -- a few tenths of a hertz in the bass -- so the
  // note swells back up seconds later and never really goes away.
  const after1 = envelope.filter(([t]) => t >= 1);
  const rmsAt1 = envelope.find(([t]) => t === 1)[1];
  const peakAfter1 = Math.max(...after1.map(([, v]) => v));
  const wobble = rmsAt1 > 1e-9 ? peakAfter1 / rmsAt1 : 0;

  // Hammer: how much louder the strike noise is than whatever else is at the same
  // frequency a moment later, as an early/late ratio.
//
// The frequency has to sit *between* harmonics. At 12*f0 the probe landed
  // exactly on partial 12, which this voice has and which decays in ~70 ms, so
  // the "hammer" reading was that partial's decay rate: it came out at 96x and
  // did not move when the strike level was cut by three times over. Halfway
  // between the fifth and sixth partial there is no harmonic, so what is left is
  // the strike noise and its actual decay.
  const shortWin = Math.round(SR * 0.020);
  const hz = f0 * 5.5;
  const hammer = bandEnergy(d, s0 + Math.round(SR * 0.002), shortWin, hz, 0.04);
  const hammerLater = bandEnergy(d, early, win, hz, 0.04);

  return {
    id,
    peak: +peak.toFixed(4),
    attackMs: +((peakAt - WHEN) * 1000).toFixed(1),
    rms: {
      t0_02: +rms(d, s0, Math.round(SR * 0.02)).toFixed(5),
      t0_10: +rms(d, s0 + Math.round(SR * 0.08), win).toFixed(5),
      t0_50: +rms(d, s0 + Math.round(SR * 0.5), win).toFixed(5),
      t2_00: +rms(d, lateFrom, win).toFixed(5),
    },
    centroidEarly: Math.round(earlyC),
    centroidLate: Math.round(lateC),
    // Positive = the sound darkens as it rings, which is what a piano does.
    centroidDrop: earlyC - lateC,
    brightnessRetained: lateC > 0 ? lateC / earlyC : 0,
    partialRatio: rel.map((v) => +v.toFixed(3)),
    // Absolute shape of the harmonic series at the attack, normalised to the
    // fundamental. This is the comparison that holds up: both are measured in the
    // first 60 ms, before either signal reaches its loop point, so neither is
    // distorted by the recorded sample reusing its quiet sustain region.
    attackShape: (() => {
      const p1 = partials[0].early || 1e-12;
      return partials.map((p) => +(p.early / p1).toFixed(3));
    })(),
    wobble: +wobble.toFixed(3),
    envelope,
    inharmCents: [1, 2, 3].map((i) => {
      const p = partials[i];
      if (!p.freq) return 0;
      return Math.round(1200 * Math.log2(p.freq / (f0 * p.mult)));
    }),
    hammer: +(hammer / (hammerLater > 1e-12 ? hammerLater : 1e-12)).toFixed(2),
  };
}

window.__RESULT__ = { error: null };
(async () => {
  try {
    const MIDI = ${MIDI}, VEL = ${VEL};
    // The pack has to be loaded before anything is measured. Without it
    // createInstrument(REFERENCE) silently falls back to the synth twin, and
    // the "ground truth" column becomes a second copy of the subject -- which is
    // exactly what the first run of this reported, with identical numbers to
    // six decimal places.
    await loadPack();
    const subj = await measure(${JSON.stringify(SUBJECT)}, MIDI, 4.0, VEL);
    let ref = null;
    try { ref = await measure(${JSON.stringify(REFERENCE)}, MIDI, 4.0, VEL); }
    catch (e) { ref = { id: ${JSON.stringify(REFERENCE)}, unavailable: String(e) }; }
    if (ref && !ref.unavailable && Math.abs(ref.peak - subj.peak) < 1e-9 && ref.centroidEarly === subj.centroidEarly) {
      ref = { id: REFERENCE, fallback: 'rendered identically to the synth -- the pack did not load' };
    }
    window.__RESULT__ = { subject: subj, reference: ref };
  } catch (e) {
    window.__RESULT__ = { error: String((e && e.stack) || e) };
  }
  window.__DONE__ = true;
})();
</script></body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/__piano.html') {
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

// spawn, not spawnSync: the server lives in this process, so spawnSync would
// block the event loop and the page could never fetch its own script.
const stdout = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    path.join(repo, 'tools', 'cdp.mjs'),
    '--url', `http://127.0.0.1:${port}/__piano.html`,
    '--wait', 'window.__DONE__===true',
    '--timeout', '180000',
    '--eval', 'window.__RESULT__',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
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
} catch {
  console.error('could not read the harness result:\n' + stdout.out.slice(0, 800) + stdout.err.slice(0, 600));
  process.exit(1);
}
// An envelope with no `value` means the page never published a result, which is
// a different fault from the page publishing a failure. Printing the TypeError
// that destructuring undefined would raise says nothing about either.
if (!res) {
  console.error('the page published no result. Harness said:\n' + stdout.out.slice(0, 800) + stdout.err.slice(0, 600));
  process.exit(1);
}
if (res.error) { console.error('measurement failed:', res.error); process.exit(1); }

const { subject: s, reference: r } = res;
console.log(`\n  ${s.id} (synth)   vs   ${r.id || 'recorded piano'} (ground truth)`);
console.log(`  midi ${MIDI}, velocity ${VEL.toFixed(2)}, rendered at 44100 Hz\n`);
const row = (label, a, b, unit = '') => {
  console.log(`  ${label.padEnd(26)} ${String(a).padStart(10)}${unit}   ${String(b ?? '-').padStart(10)}${unit}`);
};
row('peak', s.peak, r.peak);
row('attack to peak', s.attackMs, r.attackMs, ' ms');
row('rms 0-20ms', s.rms.t0_02, r.rms && r.rms.t0_02);
row('rms 80-130ms', s.rms.t0_10, r.rms && r.rms.t0_10);
row('rms 0.5s', s.rms.t0_50, r.rms && r.rms.t0_50);
row('rms 2.0s', s.rms.t2_00, r.rms && r.rms.t2_00);
row('centroid at 60ms', s.centroidEarly, r.centroidEarly, ' Hz');
row('centroid at 2.0s', s.centroidLate, r.centroidLate, ' Hz');
row('centroid drop', s.centroidDrop, r.centroidDrop, ' Hz');
row('brightness retained', s.brightnessRetained, r.brightnessRetained && +r.brightnessRetained.toFixed(3));
row('wobble after 1s', s.wobble, r.wobble, 'x');
row('hammer (2kHz-ish)', s.hammer, r.hammer);
console.log(`\n  partials kept at 2s, as a fraction of their level at 60ms`);
console.log(`    synth      [${s.partialRatio.join(', ')}]   (partial 1..6)`);
if (r.partialRatio) console.log(`    recorded   [${r.partialRatio.join(', ')}]`);

console.log('\n  harmonic series at the attack, relative to the fundamental');
console.log('    (measured before either reaches a loop point, so it is comparable)');
console.log(`    synth      [${s.attackShape.join(', ')}]`);
// The recorded attack shape is deliberately not printed as a target. At 60 ms
// this take is still inside its own attack and reads partial 2 above 17x the
// fundamental, which no piano can produce -- the band probe is picking up the
// sample's transient noise rather than its harmonic series. It was measured
// twice and is wrong; the reference here is the physical expectation for a
// struck string instead, roughly 1, 0.5, 0.3, 0.2, 0.12, 0.07.
console.log(`\n  inharmonicity of partials 1-3, in cents above exact`);
console.log(`    synth      [${s.inharmCents.join(', ')}]`);
if (r.inharmCents) console.log(`    recorded   [${r.inharmCents.join(', ')}]`);

console.log('\n  rms envelope over the note');
const w = Math.max(s.envelope.length, (r.envelope || []).length);
const pad = (a) => String(a ?? '-').padStart(9);
console.log('     time      synth      recorded');
for (let i = 0; i < w; i++) {
  console.log(`  ${pad(s.envelope[i] && s.envelope[i][0])}${pad(s.envelope[i] && s.envelope[i][1])}  ${pad(r.envelope && r.envelope[i] && r.envelope[i][1])}`);
}
console.log();

/* ------------------------------------------------------------------ guard */

// Three properties, all of which the old voice broke and all of which are
// silent when they regress -- the note still renders, still plays, and still
// passes 250 assertions in the module suite.
const fails = [];
const t = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}  — ${detail}`);
  if (!ok) fails.push(name);
};

// A struck string loses its top before its bottom, so the note darkens as it
// rings. This one was negative: the old voice's centroid *rose* 56 Hz over two
// seconds, which is the buzzer quality, not a piano.
t('the note darkens as it rings', s.centroidDrop > 20,
  `centroid drops ${s.centroidDrop.toFixed(0)} Hz (must be positive)`);
t('brightness is lost, not gained', s.brightnessRetained < 0.92,
  `retains ${(s.brightnessRetained * 100).toFixed(0)}% of its early brightness`);

// Upper partials decay faster than the fundamental. The old voice had them
// decaying slower -- partial 3 was still at 19% after the fundamental was at
// 10%, which is backwards for anything that was struck.
t('upper partials decay faster than the fundamental',
  s.partialRatio[1] < s.partialRatio[0] && s.partialRatio[2] < s.partialRatio[0],
  `partials 1,2,3 keep ${s.partialRatio.slice(0, 3).join(', ')}`);

// A note must not get louder after it has started dying. The unison choir
// shares one envelope and is detuned by a constant number of cents, so its beat
// rate is set by the fundamental -- a few tenths of a hertz in the bass -- which
// is capable of swelling the note back up seconds later. The old voice passed
// this one too; it is here as a guard, not as a bug that was found.
t('the decay is monotonic', s.wobble <= 1.05, `peaks at ${s.wobble.toFixed(2)}x its level at 1s`);

if (fails.length) {
  console.error(`\nPIANO VOICE FAILED: ${fails.join('; ')}`);
  process.exit(1);
}
console.log('piano voice OK');