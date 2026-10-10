/**
 * tools/check-loop-seam.mjs - does a held recorded note gate at the loop point?
 *
 * A sustaining sample repeats somewhere, and where it repeats is the difference
 * between a held chord ringing on and a held chord that breathes in and out
 * once a cycle.
 *
 * Most FreePats banks say where: their SFZ carries `loop_start` and `loop_end`,
 * and the builder uses them as published. The rest fall back to findLoop(), which
 * measures the sustain level as the MEDIAN of the envelope across the tail and
 * picks the quietest window within FLOOR_DB of it. For a sample that decays the
 * median is itself well down the decay, so that rule tends to land on the last
 * tenth of the take.
 *
 * That is a plausible-sounding bug, so it is measured rather than argued about.
 * A loop seam that steps in level shows up in the rendered waveform as a jump
 * between consecutive amplitude windows, and that is what this looks for. Which
 * packs to measure is read from the manifest, so it cannot fall behind what
 * shipped.
 *
 *   node tools/check-loop-seam.mjs            every sustaining pack, five keys
 *   node tools/check-loop-seam.mjs 60 72      just those keys
 *
 * Serves the repo over HTTP: a page opened from file:// cannot fetch the pack.
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
 * Every pack that loops, read from the manifest rather than listed here.
 *
 * The list used to be written out by hand, which meant adding a family meant
 * remembering to add it to a check -- and forgetting left a loop nobody measured.
 * `inst.sustains` is the same flag the builder sets when it decides a take
 * repeats, so asking the manifest cannot disagree with what shipped.
 *
 * Packs that do not sustain are excluded: a piano is a decaying instrument that
 * deliberately has no loop, and "did not loop" is the intended result there, not
 * a fault to report.
 */
const LOOPING = Object.entries(
  JSON.parse(fs.readFileSync(path.join(repo, 'pack/manifest.json'), 'utf8')).instruments
).filter(([, inst]) => inst.sustains).map(([id]) => id);

if (!LOOPING.length) {
  console.error('no pack in pack/manifest.json sustains; there is nothing to measure');
  process.exit(1);
}
console.log(`measuring ${LOOPING.length} sustaining pack(s): ${LOOPING.join(', ')}\n`);
// Naming packs on the command line narrows the run; naming none measures all.
const named = process.argv.slice(2).filter((a) => !/^-/.test(a));
const PACKS = named.length ? LOOPING.filter((p) => named.includes(p)) : LOOPING;
const MIDIS = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n));
const KEYS = MIDIS.length ? MIDIS : [30, 45, 60, 72, 96];

if (!PACKS.length) {
  console.error('none of the named packs sustain, so there is nothing to measure');
  process.exit(1);
}

const HOLD_SECONDS = 9;

// No template literals in the page script: it lives inside one.
const PAGE = [
  '<!DOCTYPE html><html><head><meta charset="utf-8"><title>loop seam</title></head>',
  '<body><pre id="out">running</pre>',
  '<script type="module">',
  "import { loadPack, preparePack, createSampledInstrument } from '/src/js/audio/sampler.js';",
  '',
  'const SR = 44100;',
  'const PACKS = ' + JSON.stringify(PACKS) + ';',
  'const KEYS = ' + JSON.stringify(KEYS) + ';',
  'const HOLD = ' + HOLD_SECONDS + ';',
  '',
  '/** RMS in dBFS for one window of the rendered buffer. */',
  'function winDb(data, from, to) {',
  '  let s = 0;',
  '  for (let i = from; i < to; i++) s += data[i] * data[i];',
  '  const rms = Math.sqrt(s / Math.max(1, to - from));',
  '  return rms > 1e-9 ? 20 * Math.log10(rms) : -180;',
  '}',
  '',
  '(async () => {',
  '  try {',
  '    await loadPack();',
  '    const manifest = await (await fetch("/pack/manifest.json")).json();',
  '    const rows = [];',
  '    for (const pack of PACKS) {',
  '      for (const midi of KEYS) {',
  '        const WHEN = 0.05;',
  '        const ctx = new OfflineAudioContext(1, Math.ceil(SR * HOLD), SR);',
  '        await preparePack(pack, [midi]);',
  '        const inst = createSampledInstrument(pack, ctx, ctx.destination);',
  '        inst.noteOn({ midi: midi, velocity: 0.8, when: WHEN, duration: HOLD - 0.6 });',
  '        const buf = await ctx.startRendering();',
  '        const data = buf.getChannelData(0);',
  '',
  '        const W = Math.round(SR * 0.010);',
  '        const env = [];',
  '        for (let i = 0; i + W <= data.length; i += W) env.push(winDb(data, i, i + W));',
  '',
  '        // Where does the source actually wrap? The onset and rate come from the',
  '        // live voice, not from re-measuring the rendered output: findOnset() on',
  '        // a rendered buffer finds the note, not the take inside it, and being',
  '        // ~25 ms out lines the seam up with the wrong part of the waveform.',
  '        const inst2 = manifest.instruments[pack];',
  '        if (!inst2 || !inst2.sustains) {',
  '          rows.push({ pack: pack, midi: midi, skipped: "does not sustain" });',
  '          continue;',
  '        }',
  '        const st = inst.debugStats();',
  '        const mine = st.timings.filter((v) => v.midi === midi)[0];',
  '        const wraps = [];',
  '        if (st.loopPoints[0] && mine) {',
  '          const ls = st.loopPoints[0][0];',
  '          const le = st.loopPoints[0][1];',
  '          const period = (le - ls) / mine.rate;',
  '          const t0 = mine.when + (ls - mine.onset) / mine.rate;',
  '          for (let t = t0; t < HOLD - 0.3; t += period) wraps.push(t);',
  '        }',
  '',
  '        // Attribute each upward step to a wrap, rather than reporting the',
  '        // largest step anywhere. A piano attack rebounds as the hammer noise',
  '        // settles, which produces genuine upward steps that have nothing to',
  '        // do with looping, and an unattributed maximum measures those.',
  '        const startWin = Math.ceil(0.4 / 0.010);',
  '        const stepAt = (i) => env[i] - env[i - 1];',
  '        // A step in dB is only meaningful where there is signal to step. In the',
  '        // last few dB of a decay a handful of samples of codec noise swings the',
  '        // RMS by tens of dB, and reporting that as a loop seam would send you',
  '        // hunting for a defect nobody can hear. So each seam carries the',
  '        // absolute level it happened at, and only seams above NOISE_FLOOR_DBFS',
  '        // are counted.',
  '        const NOISE_FLOOR_DBFS = -55;',
  '        let seam = -99, seamAt = -1, seamAbs = null;',
  '        for (const t of wraps) {',
  '          const i = Math.round(t / 0.010);',
  '          if (i <= startWin || i >= env.length - 1) continue;',
  '          if (env[i] < NOISE_FLOOR_DBFS) continue;',
  '          if (stepAt(i) > seam) { seam = stepAt(i); seamAt = t; seamAbs = env[i]; }',
  '        }',
  '        let elsewhere = -99, elsewhereAt = -1;',
  '        for (let i = startWin + 1; i < env.length; i++) {',
  '          if (wraps.some((t) => Math.abs(t - i * 0.010) < 0.03)) continue;',
  '          if (stepAt(i) > elsewhere) { elsewhere = stepAt(i); elsewhereAt = i * 0.010; }',
  '        }',
  '',
  '        const mid = env[Math.floor(env.length * 0.4)];',
  '        const last = env[env.length - 1];',
  '',
  '        rows.push({',
  '          pack: pack, midi: midi,',
  '          // The pack may not carry this key, in which case the sampler plays',
  '          // the nearest one it does have. Say which, so a row is never read',
  '          // as being about a key that was never played.',
  '          playedMidi: mine ? mine.midi : null,',
  '          looping: st.looping > 0, wraps: wraps.length,',
  '          loopPoints: st.loopPoints,',
  '          seamDb: seam === -99 ? null : +seam.toFixed(2),',
  '          seamAtSec: seamAt < 0 ? null : +seamAt.toFixed(2),',
  '          seamAbsDb: seamAbs == null ? null : +seamAbs.toFixed(1),',
  '          elsewhereDb: +elsewhere.toFixed(2),',
  '          elsewhereAtSec: +elsewhereAt.toFixed(2),',
  '          fallDb: +(mid - last).toFixed(1),',
  '          tailDb: +last.toFixed(1),',
  '          warnings: inst.warnings.length',
  '        });',
  '      }',
  '    }',
  '    window.__RESULT__ = { rows: rows };',
  '    window.__DONE__ = true;',
  '  } catch (e) {',
  '    window.__RESULT__ = { error: String(e && e.stack ? e.stack : e) };',
  '    window.__DONE__ = true;',
  '  }',
  '})();',
  '<\/script></body></html>',
].join('\n');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/__loop-seam.html') {
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

// spawn, not spawnSync: the server lives in this process, and spawnSync blocks
// the event loop for its whole run so the page could never fetch its own script.
const stdout = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    path.join(repo, 'tools', 'cdp.mjs'),
    '--url', 'http://127.0.0.1:' + port + '/__loop-seam.html',
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

/**
 * How loud a seam may be before it is heard as the note pulsing.
 *
 * 6 dB is where a steady tone starts to sound like it is being amplitude
 * modulated rather than sustained, which is the artefact this is looking for.
 */
const LIMIT_DB = 6;

console.log('held note for ' + HOLD_SECONDS + 's; a seam is a step at an actual loop wrap\n');
console.log('pack      key  wraps  loop point    seam                 biggest step elsewhere   decay');
console.log('-'.repeat(92));

let bad = 0;
for (const r of res.rows) {
  if (r.skipped) {
    console.log(r.pack.padEnd(9) + String(r.midi).padStart(4) + '  -- ' + r.skipped);
    continue;
  }
  const fallback = r.playedMidi != null && r.playedMidi !== r.midi ? ' (played ' + r.playedMidi + ')' : '';
  const problems = [];
  if (!r.looping) problems.push('did not loop at all');
  if (r.seamDb == null) problems.push(r.wraps ? 'no audible seam to measure' : 'no wrap found');
  else if (r.seamDb > LIMIT_DB) problems.push('seam ' + r.seamDb + ' dB at ' + r.seamAbsDb + 'dBFS');
  if (problems.length) bad++;

  const seamText = r.seamDb == null
    ? 'n/a'
    : r.seamDb.toFixed(2) + ' dB @' + r.seamAtSec + 's (' + r.seamAbsDb + 'dBFS)';

  console.log(
    r.pack.padEnd(9) +
    String(r.midi).padStart(4) + fallback.padEnd(11) +
    String(r.wraps).padStart(5) + '  ' +
    (r.loopPoints[0] ? JSON.stringify(r.loopPoints[0]) : '-').padEnd(14) +
    seamText.padEnd(24) +
    (r.elsewhereDb.toFixed(2) + ' dB @' + r.elsewhereAtSec + 's').padEnd(26) +
    r.fallDb.toFixed(1) + 'dB' +
    (problems.length ? '   <-- ' + problems.join(', ') : '')
  );
}

console.log('');
const measured = res.rows.filter((r) => !r.skipped).length;
if (bad) {
  console.error(bad + ' of ' + measured + ' held notes gate at the loop point');
  process.exit(1);
}
console.log('all ' + measured + ' held notes sustain without a step at the loop point');