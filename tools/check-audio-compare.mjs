/**
 * tools/check-audio-compare.mjs - prove the WAV/MP3 page really plays the files.
 *
 * A page that renders is not a page that plays. This serves
 * docs/audio-compare/ over http, loads it in the same headless Chromium the
 * other browser checks use, and renders both files through the exact node
 * settings the buttons use -- playbackRate 1, detune 0, loop off, started at
 * sample zero, no stop() ever scheduled -- and measures what came out.
 *
 * It fails on: a file that will not decode, a render that is silent, a note that
 * does not begin at the start, or the MP3 coming out a length or a start time
 * that the WAV does not, which is the whole thing the comparison is for.
 *
 *   node tools/check-audio-compare.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';

const repo = process.cwd();
const ROOT = path.join(repo, 'docs', 'audio-compare');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
};

/**
 * A length difference the encoder cannot explain.
 *
 * An MP3 holds a whole number of 1152-sample frames plus LAME's 1105-sample
 * encoder delay, which Chrome does not strip, so the decoded MP3 legitimately
 * runs a few tens of ms longer than the WAV. Past that it has been trimmed or
 * padded by something else.
 */
const LENGTH_TOLERANCE_MS = 60;

/**
 * How late the MP3 may start.
 *
 * Not zero, and that is the point of the page. LAME writes its encoder delay
 * into the stream and the browser hands it back as leading silence, so an MP3
 * played from sample zero begins a frame or two late while the WAV begins at
 * the first sample. A budget rather than a hard zero, with the measured figure
 * printed, because the number is the thing worth seeing.
 */
const MP3_ONSET_BUDGET_MS = 100;

/**
 * How far the MP3's peak may sit from the WAV's, in dB.
 *
 * An absolute difference is the wrong unit: the recording touches digital full
 * scale on one sample, and a lossy codec is entitled to reconstruct that peak a
 * little lower. What must not happen is a level change -- normalising to a
 * family target, say, which is what the pack builder does and would move this
 * by tens of dB.
 */
const PEAK_TOLERANCE_DB = 1;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const file = path.join(ROOT, path.basename(decodeURIComponent(url.pathname)));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
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
// to fetch its own audio.
const START = "Promise.all([window.__selfTest(), window.__clickTest()]).then(function (r) {"
  + " window.__RESULT__ = { wav: r[0].wav, mp3: r[0].mp3,"
  + " wavVsMp3LengthDeltaMs: r[0].wavVsMp3LengthDeltaMs,"
  + " wavVsMp3OnsetDeltaMs: r[0].wavVsMp3OnsetDeltaMs, clicks: r[1] };"
  + " window.__DONE__ = true; }, function (e) { window.__RESULT__ = { error: String((e && e.stack) || e) };"
  + " window.__DONE__ = true; })";

const out = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    path.join(repo, 'tools', 'cdp.mjs'),
    '--url', `http://127.0.0.1:${port}/index.html`,
    '--start', START,
    '--wait', 'window.__DONE__===true',
    '--timeout', '180000',
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

let bad = 0;
const fail = (m) => { console.log('  <- ' + m); bad++; };

console.log('file                       rate  detune  loop   decoded            peak     onset');
console.log('-'.repeat(84));

for (const id of ['wav', 'mp3']) {
  const r = res[id];
  console.log(
    `${r.file.padEnd(26)} ${String(r.playbackRate).padStart(4)}  ${String(r.detune).padStart(6)}  `
    + `${String(r.loop).padEnd(5)}  ${(r.sampleRate + ' Hz ' + r.channels + 'ch ' + r.decodedSeconds.toFixed(3) + 's').padEnd(18)} `
    + `${r.renderedPeak.toFixed(5)}  ${r.onsetMs.toFixed(1)}ms`
  );

  if (r.playbackRate !== 1) fail(`${r.file}: playbackRate is ${r.playbackRate}, must be 1`);
  if (r.detune !== 0) fail(`${r.file}: detune is ${r.detune}, must be 0`);
  if (r.loop !== false) fail(`${r.file}: loop is ${r.loop}, must be false`);
  if (!(r.renderedPeak > 0.01)) fail(`${r.file}: rendered silence (peak ${r.renderedPeak})`);
  if (Math.abs(r.decodedPeak - r.renderedPeak) > 0.001) {
    fail(`${r.file}: rendering changed the level (decoded ${r.decodedPeak}, rendered ${r.renderedPeak})`);
  }

  // The WAV is the reference and has no excuse for a late start. The MP3 is
  // allowed one, because the encoder put it there; what is not allowed is for
  // that allowance to quietly grow.
  if (id === 'wav') {
    if (!(r.onsetMs >= 0 && r.onsetMs <= 5)) {
      fail(`${r.file}: sound starts ${r.onsetMs}ms in, want the first sample`);
    }
  } else if (!(r.onsetMs >= 0 && r.onsetMs <= MP3_ONSET_BUDGET_MS)) {
    fail(`${r.file}: sound starts ${r.onsetMs}ms in, `
      + `more than the ${MP3_ONSET_BUDGET_MS} ms codec delay accounts for`);
  }
}

console.log(`\nlength  WAV ${res.wav.decodedSeconds}s vs MP3 ${res.mp3.decodedSeconds}s`
  + `  -> ${res.wavVsMp3LengthDeltaMs} ms apart (tolerance ${LENGTH_TOLERANCE_MS} ms)`);
console.log(`onset   WAV ${res.wav.onsetMs}ms vs MP3 ${res.mp3.onsetMs}ms`
  + `  -> ${res.wavVsMp3OnsetDeltaMs} ms apart`);
console.log(`\nThe MP3 starts ${res.wavVsMp3OnsetDeltaMs * -1} ms after the WAV and runs `
  + `${-res.wavVsMp3LengthDeltaMs} ms longer.`);
console.log('That is LAME\'s encoder delay and frame padding, which Chrome does not strip.');
console.log('It means an MP3 played from sample zero starts every note late by about that much.');

if (Math.abs(res.wavVsMp3LengthDeltaMs) > LENGTH_TOLERANCE_MS) {
  fail(`the MP3 is ${res.wavVsMp3LengthDeltaMs} ms off the WAV's length -- `
    + 'something trimmed or padded it');
}
// A lossy codec is entitled to reconstruct a full-scale peak slightly lower, so
// the comparison is in dB. A level change -- normalising to a family target,
// which is what the pack builder does -- would move this by tens of dB.
const peakDb = 20 * Math.log10(res.mp3.renderedPeak / res.wav.renderedPeak);
console.log(`peak    WAV ${res.wav.renderedPeak} vs MP3 ${res.mp3.renderedPeak}`
  + `  -> ${peakDb >= 0 ? '+' : ''}${peakDb.toFixed(2)} dB (tolerance ${PEAK_TOLERANCE_DB} dB)`);
if (Math.abs(peakDb) > PEAK_TOLERANCE_DB) {
  fail(`the MP3's level sits ${peakDb.toFixed(2)} dB from the WAV's -- `
    + 'a codec round trip does not move a level that far');
}

/* -- the buttons themselves ------------------------------------------------ */
console.log('\nthe buttons:');
for (const c of res.clicks.seen) {
  console.log(`  ${c.button.padEnd(9)} -> ${c.file.padEnd(24)} rate ${c.rate}  detune ${c.detune}  `
    + `loop ${c.loop}  start ${c.offset}  stop: ${c.stop}`);
  console.log(`             ${c.decoded}   live sources: ${c.live}`);
  if (c.file === '—') fail(`${c.button}: the readout did not update, so the click did nothing`);
  if (c.rate !== '1') fail(`${c.button}: playbackRate shows ${c.rate}`);
  if (c.detune !== '0') fail(`${c.button}: detune shows ${c.detune}`);
  if (c.loop !== 'false') fail(`${c.button}: loop shows ${c.loop}`);
  if (!/^0 s \(the first sample\)$/.test(c.offset)) {
    fail(`${c.button}: started at "${c.offset}" -- the attack transient must not be skipped`);
  }
  if (!/never/.test(c.stop)) fail(`${c.button}: a stop was scheduled ("${c.stop}")`);
  // The live context runs at the device's rate, so it resamples on decode. The
  // pitch is unaffected -- playbackRate is still 1 -- but the number is worth
  // seeing rather than discovering later.
  if (!/48000|44100/.test(c.decoded)) fail(`${c.button}: unexpected decoded rate "${c.decoded}"`);
}
if (res.clicks.liveSources !== 2) {
  fail(`two clicks should leave two live source nodes, found ${res.clicks.liveSources}`);
}

if (bad) {
  console.error(`\n${bad} problem(s)`);
  process.exit(1);
}
console.log('\nok: both files decode, both play from the first sample at their recorded pitch, '
  + 'and the MP3 matches the WAV it came from');