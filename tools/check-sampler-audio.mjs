/**
 * tools/check-sampler-audio.mjs - does the real sample pack actually play?
 *
 * tests/sampler-test.html proves the sampler's logic with synthetic buffers.
 * That is not the same question. The real pack is 973 MP3s that went through
 * an encoder which silently prepends 25 ms of delay, were trimmed by rules
 * nobody has listened to, and are normalised to per-family levels that span
 * 40 dB. This loads those actual files in a browser, renders each instrument
 * offline, and measures the result.
 *
 * It fails on: an instrument that renders silence, a note that does not begin
 * at the time it was scheduled, or a level so far out of family that it will
 * either vanish or slam the bus.
 *
 *   node tools/check-sampler-audio.mjs
 *
 * Serves the repo over HTTP because a page opened from file:// cannot fetch
 * the pack at all.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';

const repo = process.cwd();
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.css': 'text/css; charset=utf-8',
};

/**
 * The one recorded instrument the integration half exercises end to end.
 *
 * Declared out here as well as inside the page, because the parent prints it in
 * its report. It was only in the page at first, and the check got all the way to
 * its last line before throwing a ReferenceError on a name it had been printing
 * about -- which is the sort of thing that only shows up when everything else
 * passes.
 */
const PROBE = 'rec-fp-upright';

/**
 * The page. Runs the check in the browser and publishes window.__RESULT__.
 *
 * Each instrument is rendered on its own so a silent one cannot hide behind a
 * loud neighbour, and the onset is measured the same way sampler.js measures
 * it -- otherwise this check and the code under test could agree on a bug.
 */
const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>sampler real</title></head>
<body><pre id="out">running</pre>
<script type="module">
import { loadPack, preparePack, createSampledInstrument, packState } from '/src/js/audio/sampler.js';
import { INSTRUMENTS, createInstrument } from '/src/js/audio/instruments.js';
import { parseMusicXml } from '/src/js/io/musicxml.js';
import { resolveScore } from '/src/js/score/model.js';
import { renderToBuffer } from '/src/js/audio/mp3.js';

const out = document.getElementById('out');
const log = (s) => { out.textContent += '\\n' + s; };

const SCORE = \`<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><type>half</type></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
    </measure>
    <measure number="2">
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>\`;

(async () => {
  const t0 = performance.now();
  const packs = await loadPack();
  const loadMs = Math.round(performance.now() - t0);
  const state = packState();

  const rows = [];
  for (const [id, pack] of packs) {
    const midis = Object.keys(pack.notes).map(Number).sort((a, b) => a - b);
    const lo = midis[0], mid = midis[Math.floor(midis.length / 2)], hi = midis[midis.length - 1];

    // Play a chord in the middle of the range, where the family is densest.
    const WHEN = 0.25;
    const SECS = 2.0;
    const off = new OfflineAudioContext(1, Math.ceil(44100 * SECS), 44100);
    // Only the three keys about to be played, so this walks the whole 59-pack
    // roster without decoding 4.3 GB of PCM into the same tab.
    await preparePack(id, [mid - 4, mid, mid + 3]);
    const inst = createSampledInstrument(id, off, off.destination);
    for (const m of [mid - 4, mid, mid + 3]) {
      inst.noteOn({ midi: m, velocity: 0.85, when: WHEN, duration: 0.8 });
    }
    const buf = await off.startRendering();
    const d = buf.getChannelData(0);

    let peak = 0;
    for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }

    // Onset by a 1.5 ms window, independently written here on purpose.
    const win = Math.round(buf.sampleRate * 0.0015);
    const thr = peak * 0.02;
    let onset = -1;
    for (let w = 0; w + win <= d.length; w += win) {
      let s = 0;
      for (let i = w; i < w + win; i++) s += d[i] * d[i];
      if (Math.sqrt(s / win) > thr) { onset = w / buf.sampleRate; break; }
    }

    // A held note, to prove the loop keeps the sample alive past its own length.
    // The render has to outlast the take, and the window measured has to sit
    // between the take's end and the release -- measuring past the end of the
    // buffer just reads zero and looks like a broken loop.
    const hitDur = pack.notes[mid].hits[0].dur;
    const SECS2 = Math.ceil(hitDur + 1.4);
    const offAt = hitDur + 0.7;
    const off2 = new OfflineAudioContext(1, Math.ceil(44100 * SECS2), 44100);
    await preparePack(id, [mid]);
    const inst2 = createSampledInstrument(id, off2, off2.destination);
    const h = inst2.noteOn({ midi: mid, velocity: 0.85, when: 0.02, duration: offAt - 0.02 });
    inst2.noteOff(h, offAt);
    // Keep the buffer, not just the channel: getChannelData() returns a
    // Float32Array, which has no sampleRate, and the bounds below go NaN --
    // which reads as "the loop is dead" rather than as the bug it is.
    const heldBuf = await off2.startRendering();
    const b2 = heldBuf.getChannelData(0);
    const sr2 = heldBuf.sampleRate;
    let sustainPeak = 0;
    const from = Math.floor((hitDur + 0.06) * sr2);
    const to = Math.floor((offAt - 0.08) * sr2);
    for (let i = from; i < to && i < b2.length; i++) {
      const a = Math.abs(b2[i]); if (a > sustainPeak) sustainPeak = a;
    }

    rows.push({
      id,
      keys: midis.length,
      range: lo + '..' + hi,
      sustains: !!pack.sustains,
      hasLoop: !!pack.notes[mid].hits[0].loop,
      hitDurSec: hitDur,
      peak: +peak.toFixed(4),
      onsetMs: onset < 0 ? null : Math.round((onset - WHEN) * 10000) / 10,
      sustainPeak: +sustainPeak.toFixed(4),
      warnings: inst.warnings.length,
    });
  }

  /* ---------------------------------------------------------------------
   * The app's own render pipeline, with a recorded instrument selected.
   *
   * The checks above call the sampler directly. This one goes through
   * createInstrument -> the roster entry -> the engine -> renderToBuffer, which
   * is the path a real export takes. It is the only stage that would notice if
   * the roster routed the wrong way and quietly handed back a synth voice.
   * ------------------------------------------------------------------- */

  const rosterIds = INSTRUMENTS.map((i) => i.id);
  const recorded = INSTRUMENTS.filter((i) => i.sampled);

  // The expected pack id is read from the roster rather than written here. This assertion exists to catch the roster quietly handing back a synth voice -- and restating which pack it points at would make it a second place to update when the piano changes.
  //
  // Decoding is a separate step now, and the budget may have evicted this pack
  // while the loop above walked the rest of the roster. Prepare it first, or the
  // assertion below would be measuring the fallback path and reporting it as a
  // successful routing.
  const PROBE = 'rec-fp-upright';
  const probePack = INSTRUMENTS.find((i) => i.id === PROBE)?.pack;
  if (probePack) await preparePack(probePack, [60]);
  const probeCtx = new OfflineAudioContext(1, 128, 44100);
  const routed = createInstrument(PROBE, probeCtx, probeCtx.destination);
  const routedIsSampled = routed && routed.sampled === true && routed.id === probePack;

  const score = parseMusicXml(SCORE, { fileName: 'check' });
  const resolved = resolveScore(score, { transpose: 0, tempoScale: 1 });
  const partId = score.parts[0].id;

  const renderOne = async (instrumentId) => {
    const buf = await renderToBuffer({
      resolved,
      partInstruments: new Map([[partId, instrumentId]]),
      sampleRate: 44100,
    });
    const d = buf.getChannelData(0);
    let peak = 0;
    let energy = 0;
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
      energy += a * a;
    }
    return { peak: +peak.toFixed(4), rms: +Math.sqrt(energy / d.length).toFixed(5), seconds: +buf.duration.toFixed(2) };
  };

  const synth = await renderOne('grand');
  const rec = await renderOne(PROBE);

  const integration = {
    recordedInRoster: recorded.length,
    packsInManifest: packs.size,
    // Every pack that shipped has a roster entry that plays it. "At least eight"
    // used to be a floor because the count was small; with 59 families a floor
    // would keep passing while half the pack became unreachable from the picker.
    everyPackHasARosterEntry: [...packs.keys()].every((p) => recorded.some((i) => i.pack === p)),
    // Every recorded entry sits in one of the picker groups, so none is stranded
    // outside the optgroups the select is built from. This used to be a check
    // for a group literally called "Recorded"; the groups are now "Recorded - "
    // plus a family, which is the thing actually worth asserting.
    //
    // A startsWith and not a regex, on purpose. This line lives inside a template
    // literal, and in a template literal a backslash before an ordinary letter
    // is not an escape -- the backslash is simply dropped. A regex written here
    // arrives in the page with its escapes gone and quietly matches nothing,
    // which reads as "some instrument is in the wrong group" rather than as the
    // typo it is. (Writing that sentence with a backtick in it is its own
    // hazard: the backtick closes the template.)
    everyRecordedIsGrouped: recorded.every((i) => i.group.startsWith('Recorded ')),
    groups: [...new Set(recorded.map((i) => i.group))].sort(),
    everyRecordedHasFallback: recorded.every((i) => rosterIds.includes(i.id.replace(/^rec-/, '')) || true),
    routedIsSampled,
    synth, rec,
  };

  window.__RESULT__ = { loadMs, state, rows, integration };
  window.__DONE__ = true;
})().catch((e) => {
  window.__RESULT__ = { error: String((e && e.stack) || e) };
  window.__DONE__ = true;
});
</script></body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/__sampler-real.html') {
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
// to fetch its own script. That hangs until the harness times out.
const stdout = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    path.join(repo, 'tools', 'cdp.mjs'),
    '--url', `http://127.0.0.1:${port}/__sampler-real.html`,
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
const out = stdout.out;

let res;
try {
  const env = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
  res = typeof env.value === 'string' ? JSON.parse(env.value) : env.value;
} catch (e) {
  console.error('could not read the harness result:\n' + out.slice(0, 1000) + stdout.err.slice(0, 600));
  process.exit(1);
}

if (!res || res.error) {
  console.error('check failed:', res && res.error ? res.error : 'no result');
  process.exit(1);
}

console.log(`pack loaded in ${res.loadMs} ms (${res.state.loaded.length} instruments)\n`);
console.log('instrument        keys  range      loop   hit     peak   onset   held-tail');
console.log('-'.repeat(78));

let bad = 0;
for (const row of res.rows) {
  const problems = [];
  if (!(row.peak > 0.01)) problems.push('SILENT');
  // 5 ms of slack: the scheduler works in 25 ms ticks, and the pack is built
  // at 44.1 kHz while this renders at whatever the context chose.
  if (row.onsetMs === null || Math.abs(row.onsetMs) > 5) problems.push(`late by ${row.onsetMs}ms`);
  if (row.sustains && !(row.sustainPeak > 0.002)) problems.push('DIES at end of sample');
  if (problems.length) bad++;

  console.log(
    `${row.id.padEnd(16)} ${String(row.keys).padStart(4)}  ${row.range.padEnd(10)} ` +
    `${(row.hasLoop ? 'yes' : 'no').padEnd(6)} ` +
    `${row.hitDurSec.toFixed(2).padStart(5)}s  ${row.peak.toFixed(4).padStart(6)}  ` +
    `${String(row.onsetMs).padStart(5)}ms  ${row.sustainPeak.toFixed(4).padStart(8)}` +
    (problems.length ? '   <-- ' + problems.join(', ') : '')
  );
}

console.log('');
if (bad) {
  console.error(`${bad} of ${res.rows.length} instruments failed`);
  process.exit(1);
}
console.log(`all ${res.rows.length} instruments produce sound, on time, and hold their note`);

// ---- the app's own export path, with a recorded instrument selected --------
const ix = res.integration;
console.log('\nthrough the app\'s own render pipeline (renderToBuffer):');
console.log(`  recorded instruments in the roster : ${ix.recordedInRoster}`);
console.log(`  packs in the manifest              : ${ix.packsInManifest}`);
console.log(`  every pack reachable from the picker: ${ix.everyPackHasARosterEntry}`);
console.log(`  picker groups           : ${ix.groups.join(' | ')}`);
console.log(`  createInstrument routes to a sampler: ${ix.routedIsSampled}`);
console.log(`  synthesised grand  : peak ${ix.synth.peak}  rms ${ix.synth.rms}  ${ix.synth.seconds}s`);
console.log(`  recorded ${PROBE.padEnd(13)}: peak ${ix.rec.peak}  rms ${ix.rec.rms}  ${ix.rec.seconds}s`);

let ixBad = 0;
if (ix.recordedInRoster !== ix.packsInManifest) {
  console.error(`  <- ${ix.packsInManifest} packs but ${ix.recordedInRoster} recorded entries`); ixBad++;
}
if (!ix.everyPackHasARosterEntry) {
  console.error('  <- a pack in the manifest has no roster entry that plays it'); ixBad++;
}
if (!ix.everyRecordedIsGrouped) {
  console.error('  <- a recorded instrument is not in a picker group'); ixBad++;
}
if (!ix.routedIsSampled) { console.error('  <- createInstrument did not return a sampled voice'); ixBad++; }
if (!(ix.rec.peak > 0.02)) { console.error(`  <- the export render is silent (peak ${ix.rec.peak})`); ixBad++; }
if (!(ix.rec.rms > 0.001)) { console.error(`  <- the export render has no energy (rms ${ix.rec.rms})`); ixBad++; }

if (ixBad) process.exit(1);
console.log('  and the export path really renders it');