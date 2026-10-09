/**
 * tools/check-codec-delay.mjs - how far does an MP3 round trip move the audio?
 *
 * Every sampled note starts at `source.start(when, offset)`. If encoding moves
 * the waveform even a few milliseconds later, every sampled instrument plays
 * late against the synth ones -- and 25 ms is a sixteenth note at 150 bpm, so it
 * is not subtle.
 *
 * A threshold test is not good enough here: the first sample to cross a fixed
 * amplitude depends on where an attack happens to rise, so it understates the
 * shift. This measures the true lag by cross-correlating the decoded signal
 * against the original, using a chirp so the correlation peak is sharp.
 *
 *   node tools/check-codec-delay.mjs
 *
 * Run it when the pack's encoder settings change. If the shift is not the same
 * for every setting, the sampler must not assume a constant -- see the marker
 * scheme in src/js/audio/sampler.js.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { encodeMp3 } from './lib/lame.mjs';

const SR = 44100;
const N = SR; // one second

/** Linear chirp 200 Hz -> 3.2 kHz. Sharp autocorrelation peak, no periodicity. */
function chirp() {
  const a = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    a[i] = Math.sin(2 * Math.PI * (200 * t + 0.5 * 3000 * t * t)) * 0.7;
  }
  return a;
}

const ref = chirp();
const cases = [
  ['mono  64k', encodeMp3([chirp()], SR, 64), 1],
  ['mono 128k', encodeMp3([chirp()], SR, 128), 1],
  ['stereo 96k', encodeMp3([chirp(), chirp()], SR, 96), 2],
  ['stereo 128k', encodeMp3([chirp(), chirp()], SR, 128), 2],
  ['stereo 192k', encodeMp3([chirp(), chirp()], SR, 192), 2],
];

const payload = cases
  .map(([label, mp3, ch]) => `  { label: ${JSON.stringify(label)}, ch: ${ch}, b64: ${JSON.stringify(mp3.toString('base64'))} }`)
  .join(',\n');

const html = `<!DOCTYPE html><html><body><script>
const SR = ${SR};
const REF_B64 = ${JSON.stringify(Buffer.from(ref.buffer).toString('base64'))};
const cases = [
${payload}
];

/** The lag in samples that best aligns \`ref\` inside \`d\`. */
function bestLag(d, ref, maxLag) {
  let best = -Infinity, at = 0;
  const n = Math.min(ref.length, d.length - maxLag - 1);
  // Stride 3 is plenty for a chirp and keeps this to a few million products.
  for (let lag = 0; lag < maxLag; lag++) {
    let s = 0;
    for (let i = 0; i < n; i += 3) s += ref[i] * d[i + lag];
    if (s > best) { best = s; at = lag; }
  }
  return at;
}

(async () => {
  const rb = atob(REF_B64);
  const raw = new Uint8Array(rb.length);
  for (let i = 0; i < rb.length; i++) raw[i] = rb.charCodeAt(i);
  const ref = new Float32Array(raw.buffer);

  const out = [];
  for (const c of cases) {
    const bin = atob(c.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const ctx = new OfflineAudioContext(c.ch, SR, SR);
    const buf = await ctx.decodeAudioData(bytes.buffer);
    const lag = bestLag(buf.getChannelData(0), ref, 3000);
    out.push({ label: c.label, bytes: c.b64.length, frames: buf.length, lag, ms: +((lag / SR) * 1000).toFixed(2) });
  }
  window.__RESULT__ = out;
  window.__DONE__ = true;
})().catch((e) => { window.__RESULT__ = { error: String(e) }; window.__DONE__ = true; });
</script></body></html>`;

const file = path.join(os.tmpdir(), 'scoreforge-codec-delay.html');
fs.writeFileSync(file, html, 'utf8');

const r = spawnSync(process.execPath, [
  path.join(process.cwd(), 'tools', 'cdp.mjs'),
  '--url', 'file:///' + file.replace(/\\/g, '/'),
  '--wait', 'window.__DONE__===true',
  '--timeout', '180000',
  '--eval', 'window.__RESULT__',
], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const out = r.stdout || '';
let res;
try {
  const env = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
  res = typeof env.value === 'string' ? JSON.parse(env.value) : env.value;
} catch (e) {
  console.error('could not read the harness result:\n' + out.slice(0, 800));
  process.exit(1);
}

if (!Array.isArray(res)) {
  console.error('measurement failed:', JSON.stringify(res));
  process.exit(1);
}

console.log('codec delay, measured by cross-correlation against the source chirp\n');
console.log('setting      mp3 base64   decoded frames   lag    ms');
for (const c of res) {
  console.log(`${c.label.padEnd(11)} ${String(c.bytes).padStart(9)}   ${String(c.frames).padStart(14)}   ${String(c.lag).padStart(4)}  ${c.ms}`);
}

const lags = res.map((c) => c.lag);
const spread = Math.max(...lags) - Math.min(...lags);
console.log(`\nspread across settings: ${spread} samples`);
console.log(spread === 0
  ? '-> one constant would be safe for these settings'
  : '-> the shift depends on the encoder settings; the sampler must measure it per file');