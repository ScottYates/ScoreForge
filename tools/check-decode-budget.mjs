/**
 * tools/check-decode-budget.mjs - can 59 recorded instruments fit in a tab?
 *
 * The pack builder writes about 2.2 GB of MP3 across 59 families, which decode
 * to roughly 4.3 GB of floating-point PCM. Decoding all of it before the first
 * note is not slow, it is impossible: no browser tab is asked to sit on 4.3 GB
 * of AudioBuffer. So the bytes are fetched up front and the PCM is decoded per
 * key, on demand, under a byte budget with least-recently-used eviction.
 *
 * That design is only worth anything if the eviction actually happens, so this
 * measures it rather than reasoning about it. The budget is dropped to almost
 * nothing -- one byte -- which makes every real file oversized and forces the
 * eviction path on every prepare. The assertions are then:
 *
 *   1. fetching decodes nothing at all
 *   2. preparing a pack puts real PCM in memory
 *   3. preparing a second pack evicts the first
 *   4. a pack whose notes are currently sounding is NOT evicted
 *   5. an evicted pack comes back by preparing it again
 *   6. under the real budget, preparing one small pack stays inside it
 *
 *   node tools/check-decode-budget.mjs
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

// Three small families, so the eviction path runs without a gigabyte of decode.
const A = 'fp-kalimba';
const B = 'fp-ukulele';
const C = 'fp-jaw-harp';
const KEY_A = 60;
const KEY_B = 60;
const KEY_C = 60;

const PAGE = [
  '<!DOCTYPE html><html><head><meta charset="utf-8"><title>decode budget</title></head>',
  '<body><pre id="out">running</pre>',
  '<script type="module">',
  "import {",
  "  loadPack, preparePack, createSampledInstrument, isPackDecoded, decodeState,",
  "  __setDecodeBudget,",
  "} from '/src/js/audio/sampler.js';",
  '',
  `const A = ${JSON.stringify(A)}, B = ${JSON.stringify(B)}, C = ${JSON.stringify(C)};`,
  `const KEY_A = ${KEY_A}, KEY_B = ${KEY_B}, KEY_C = ${KEY_C};`,
  '',
  '(async () => {',
  '  const steps = [];',
  '  const snap = (what) => steps.push(Object.assign({ step: what }, decodeState(), {',
  '    aDecoded: isPackDecoded(A), bDecoded: isPackDecoded(B), cDecoded: isPackDecoded(C),',
  '    aLive: (decodeState().packs.find((p) => p.id === A) || { live: 0 }).live }));',
  '  try {',
  '    // 1 - fetching must not decode. Everything up to here is compressed.',
  '    await loadPack();',
  "    snap('after fetch');",
  '',
  '    // Squeeze the budget to nothing so every file is oversized.',
  '    __setDecodeBudget(1);',
  '',
  '    await preparePack(A, [KEY_A]);',
  "    snap('after prepare A');",
  '',
  '    await preparePack(B, [KEY_B]);',
  "    snap('after prepare B');",
  '',
  '    // 4 - a pack with a note actually sounding must survive the next prepare.',
  '    //    Re-prepare A and hold a note, then prepare B again.',
  '    await preparePack(A, [KEY_A]);',
  '    const live = new OfflineAudioContext(1, 44100 * 2, 44100);',
  '    const inst = createSampledInstrument(A, live, live.destination);',
  '    inst.noteOn({ midi: KEY_A, velocity: 0.8, when: 0.01, duration: 1.5 });',
  '    await preparePack(B, [KEY_B]);',
  "    snap('A held while B prepared');",
  '',
  '    // Once the note has been told to stop, A must become evictable again. The',
  '    // live count used to be released only when a voice was reaped, and reap',
  '    // only runs on the next noteOn -- so every instrument you had ever played',
  '    // stayed pinned for the rest of the session and the cache grew without',
  '    // bound. The failure is invisible until it is catastrophic, so it is',
  '    // asserted here rather than left to be discovered.',
  '    inst.allNotesOff(0.02);',
  "    snap('A stopped');",
  '',
  '    // A third family, prepared now that nothing is sounding: A must go.',
  '    await preparePack(C, [KEY_C]);',
  "    snap('C prepared, A idle');",
  '',
  '    // And an evicted pack can be brought back.',
  '    await preparePack(A, [KEY_A]);',
  "    snap('A re-prepared');",
  '',
  '    // Back to the real budget, one small family must fit inside it.',
  '    __setDecodeBudget(1024 * 1024 * 1024);',
  '    const before = decodeState();',
  "    await preparePack(C, [KEY_C]);",
  '    const after = decodeState();',
  '',
  '    window.__RESULT__ = { steps, before, after };',
  '  } catch (e) {',
  '    window.__RESULT__ = { error: String(e && e.stack ? e.stack : e) };',
  '  }',
  '  window.__DONE__ = true;',
  '})();',
  '<\/script></body></html>',
].join('\n');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/__decode-budget.html') {
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
    '--url', 'http://127.0.0.1:' + port + '/__decode-budget.html',
    '--wait', 'window.__DONE__===true',
    '--timeout', '120000',
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

// cdp.mjs --eval answers with an envelope: {ready, url, value}, and the value
// itself comes back as a STRING because it was stringified on the way out.
let res = null;
try {
  const env = JSON.parse(stdout.out.slice(stdout.out.indexOf('{'), stdout.out.lastIndexOf('}') + 1));
  res = typeof env.value === 'string' ? JSON.parse(env.value) : env.value;
} catch (e) {
  console.error('could not read the harness result:\n' + stdout.out.slice(0, 1000) + stdout.err.slice(0, 800));
  process.exit(1);
}

if (!res || res.error) {
  console.error('check failed:', res && res.error ? res.error : 'no result');
  process.exit(1);
}

// A result without steps is the page having failed in a way it did not label.
// Printing the TypeError that iterating undefined would raise tells nobody
// anything; printing the result does.
if (!Array.isArray(res.steps)) {
  console.error('the page returned no steps. Result was:');
  console.error(JSON.stringify(res, null, 2).slice(0, 2000));
  process.exit(1);
}

const fails = [];
const check = (name, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : '  - ' + detail}`);
  if (!cond) fails.push(name);
};

const by = (s) => res.steps.find((x) => x.step === s) || {};
const mib = (b) => (b / 1024 / 1024).toFixed(2);

console.log('decoded PCM through the load/prepare/evict cycle\n');
console.log(`step                     files   decoded MiB   budget MiB   A        B        C`);
console.log('-'.repeat(76));
for (const s of res.steps) {
  console.log(
    `${s.step.padEnd(24)} ${String(s.files).padStart(5)}   ${mib(s.bytes).padStart(11)}   ` +
    `${mib(s.budget).padStart(10)}   ${String(s.aDecoded).padEnd(8)} ${String(s.bDecoded).padEnd(8)} ${String(s.cDecoded).padEnd(5)}`
  );
}
console.log('');

const fetched = by('after fetch');
check('fetching the pack decodes nothing', fetched.files === 0 && fetched.bytes === 0,
  `${fetched.files} files, ${mib(fetched.bytes)} MiB`);

const prepA = by('after prepare A');
check('preparing a pack decodes real PCM', prepA.bytes > 0 && prepA.aDecoded,
  `${prepA.files} files, ${mib(prepA.bytes)} MiB`);

const prepB = by('after prepare B');
check('preparing a second pack evicts the first', !prepB.aDecoded,
  `A still reports ${prepB.files} files decoded in total`);
check('the pack just prepared survives', prepB.bDecoded);

const held = by('A held while B prepared');
check('a pack with a sounding note is not evicted', held.aDecoded && held.bDecoded,
  `A decoded ${held.aDecoded}, B decoded ${held.bDecoded}`);

const stopped = by('A stopped');
check('a stopped note releases the pack from the live count',
  stopped.aLive === 0, `A still reports ${stopped.aLive} live voice(s)`);

const third = by('C prepared, A idle');
check('an idle pack is evicted again', !third.aDecoded && third.cDecoded,
  `A decoded ${third.aDecoded}, C decoded ${third.cDecoded}`);

const back = by('A re-prepared');
check('an evicted pack can be prepared again', back.aDecoded);

check('under the real budget a small family stays inside it',
  res.after.bytes <= res.after.budget, `${mib(res.after.bytes)} > ${mib(res.after.budget)} MiB`);
check('the real budget is 1 GiB', res.after.budget === 1024 * 1024 * 1024, String(res.after.budget));

console.log('');
if (fails.length) {
  console.error(`${fails.length} assertion(s) failed`);
  process.exit(1);
}
console.log('the decode budget holds, a sounding instrument is never evicted, and a stopped one is');