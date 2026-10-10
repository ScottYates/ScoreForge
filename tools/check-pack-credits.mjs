/**
 * tools/check-pack-credits.mjs - does the attribution still describe the audio?
 *
 * One FreePats bank in this pack is GPL-3+ with the sample exception,
 * which is the first thing in the project that is not CC0. CC BY asks for a
 * visible credit where the samples are used, and for a statement of what was
 * changed. Both are easy to ship broken in ways nothing else would notice:
 *
 *   - the pack gains a non-CC0 family and nobody writes the notice
 *   - the notice is right and the app never renders it, so a user who only ever
 *     sees the page is never told
 *   - the notice claims CC0 for a library that is not CC0
 *   - a pack is deleted but the notice keeps crediting it
 *
 * None of these fail a functional test, which is why this exists.
 *
 * The block is compared by regenerating it, not by grepping. A grep for the
 * author's name passes on a notice whose licence has been edited to CC0, and
 * passes on a notice that still credits a pack which no longer exists.
 *
 *   node tools/check-pack-credits.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { noticeBlock, bySource, needsAttribution, BEGIN, END } from './lib/credits.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const args = process.argv.slice(2);

let pass = 0;
const fails = [];

function check(name, ok, detail) {
  if (ok) { pass++; return true; }
  fails.push(detail ? `${name} — ${detail}` : name);
  return false;
}

const manifest = JSON.parse(read('pack/manifest.json'));
const notice = read('NOTICE.md');
const sampler = read('src/js/audio/sampler.js');
const app = read('src/js/ui/app.js');
const instruments = read('src/js/audio/instruments.js');

/* ------------------------------------------------------- the manifest side */

const packs = Object.keys(manifest.instruments || {});
check('manifest has instruments', packs.length > 0, `found ${packs.length}`);

check('manifest carries credits', !!manifest.credits && Object.keys(manifest.credits).length > 0,
  'manifest.credits is missing or empty — run `npm run pack`');

// Every pack is credited, not just the ones someone remembered.
for (const id of packs) {
  check(`pack "${id}" is credited`, !!(manifest.credits || {})[id]?.length,
    `no entry in manifest.credits for ${id}`);
}

// Every credit has the fields a credit needs to mean anything.
for (const [id, cs] of Object.entries(manifest.credits || {})) {
  for (const c of cs) {
    check(`${id}: credit names a library`, !!c.title, JSON.stringify(c));
    check(`${id}: credit names an author`, !!c.author, `${c.title} has no author`);
    check(`${id}: credit states a licence`, !!c.licence, `${c.title} has no licence`);
    // CC BY asks you to say what you changed. Silence is not "nothing changed";
    // for this pack it is an unedited copy of the default.
    if (needsAttribution(c.licence)) {
      check(`${id}: "${c.title}" declares changes`, !!c.changes,
        `${c.licence} requires a statement of modifications and this one has none`);
      check(`${id}: "${c.title}" links its source`, /^https?:\/\//.test(c.url || ''),
        `no usable url (${c.url})`);
    }
  }
}

const sources = bySource(manifest);
const owed = sources.filter((s) => needsAttribution(s.licence));
console.log(`sources: ${sources.map((s) => `${s.title} (${s.licence})`).join(', ')}`);
console.log(`attribution owed by: ${owed.length ? owed.map((s) => s.title).join(', ') : 'nothing'}`);

/* -------------------------------------------------------- the NOTICE side */

// Regenerate and compare. This is the assertion that cannot be fooled by an
// edited licence or a stale entry, because it does not read the text at all.
const expected = noticeBlock(manifest);
const at = notice.indexOf(BEGIN);
const tail = at < 0 ? -1 : notice.indexOf(END, at);

check('NOTICE.md has a credits block', at >= 0 && tail > at,
  at < 0 ? `no ${BEGIN} marker` : tail < 0 ? `${END} marker missing` : 'markers out of order');

if (at >= 0 && tail > at) {
  const actual = notice.slice(at, tail + END.length);
  check('NOTICE.md credits match pack/manifest.json', actual === expected,
    actual === expected ? '' : diffSummary(expected, actual));
}

// The reverse direction: a notice crediting a library the pack does not
// contain is as wrong as one missing a library it does.
for (const s of sources) {
  check(`NOTICE.md credits "${s.title}"`, notice.includes(s.title),
    `the pack ships ${s.title} but the notice does not mention it`);
}

// ------------------------------------------------------------- the app side

// The credit has to reach someone who only ever sees the page. A notice in the
// repository does not travel with a built single-file HTML.
check('sampler exposes packCredits()', /export function packCredits\s*\(/.test(sampler),
  'src/js/audio/sampler.js does not export packCredits()');
check('sampler reads credits out of the manifest', /manifest\.credits/.test(sampler),
  'packCredits is not derived from the manifest, so it cannot describe the shipped files');
check('the settings panel renders the credits', /packCredits\(\)/.test(app),
  'src/js/ui/app.js never calls packCredits()');
check('index.html has somewhere to show them', /id="packCredits"/.test(read('src/index.html')),
  'no #packCredits element to render into');

// Every recorded instrument in the roster must point at a pack that exists.
// A typo here is silent: the instrument still plays, via its synth fallback.
for (const m of instruments.matchAll(/\bpack:\s*'([^']+)'/g)) {
  check(`roster pack "${m[1]}" exists in the manifest`, packs.includes(m[1]),
    `instruments.js refers to pack "${m[1]}", which the pack does not build`);
}

// And the converse: a pack nobody in the roster can reach is dead weight the
// user is still downloading.
for (const id of packs) {
  const used = new RegExp(`pack:\\s*'${id}'`).test(instruments);
  check(`pack "${id}" is reachable from the roster`, used,
    `${id} is in the manifest but no instrument selects it`);
}

/* ------------------------------------------------- does a user ever see it? */

/**
 * Everything above is static: files on disk agreeing with each other. The part
 * CC BY actually cares about is whether someone who only ever sees the web page
 * is told, and no amount of grepping proves that -- the renderer could be
 * unreachable, or the element could not exist, and the source would look fine.
 *
 * So load the built app for real, wait for the pack, and read what the settings
 * panel says. Served over http because a file:// page cannot fetch the pack at
 * all, which is the same reason the credits would be missing in that case.
 */
if (!args.includes('--no-browser')) {
  const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.mp3': 'audio/mpeg', '.css': 'text/css; charset=utf-8',
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const file = path.join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // spawn, not spawnSync: this process is serving the page, and spawnSync would
  // block the event loop so the page could never fetch its own script.
  const out = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(root, 'tools/cdp.mjs'),
      '--url', `http://127.0.0.1:${port}/index.html?demo`,
      // Wait for the PACK, not for the page. __DONE__ is set as soon as the demo
      // score is ready, which measured at 1 ms -- long before the 5 MB of
      // samples arrive, so an empty #packCredits here said nothing about whether
      // the credit renders. Waiting on the pack status line waits for the thing
      // that fills it.
      '--wait',
      '(()=>{const s=document.getElementById("packStatus");' +
      'const t=s?s.textContent:"";' +
      'return /instruments ready|unavailable|failed/.test(t);})()',
      '--timeout', '300000',
      '--eval', 'JSON.stringify({' +
        'credits: (document.getElementById("packCredits")||{}).innerHTML||"",' +
        'status: (document.getElementById("packStatus")||{}).textContent||""' +
        '})',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '', e = '';
    child.stdout.on('data', (d) => { o += d; });
    child.stderr.on('data', (d) => { e += d; });
    child.on('error', reject);
    child.on('close', () => resolve({ o, e }));
  });
  server.close();

  let rendered = '';
  let status = '';
  try {
    const env = JSON.parse(out.o.slice(out.o.indexOf('{'), out.o.lastIndexOf('}') + 1));
    // cdp.mjs hands the evaluated expression back as a string, so the object
    // this asked for arrives as JSON text.
    const val = typeof env.value === 'string' ? JSON.parse(env.value) : (env.value || {});
    rendered = val.credits || '';
    status = val.status || '';
  } catch { /* reported below */ }

  // The pack has to have actually loaded. Otherwise "no credits rendered" and
  // "the samples never arrived" look identical, and a run where the pack 500s
  // would pass this check for entirely the wrong reason.
  check('the sample pack loaded in the page', /instruments ready/.test(status),
    `pack status line reads "${status}"`);

  check('the settings panel rendered the credits', rendered.length > 0,
    rendered.length ? '' : `nothing in #packCredits (${out.o.slice(0, 200)}${out.e.slice(0, 200)})`);
  // The exact strings, because a credit that omits the author or the licence
  // is not a credit.
  for (const s of bySource(manifest)) {
    if (!needsAttribution(s.licence)) continue;
    check(`the page names ${s.author}`, rendered.includes(s.author));
    check(`the page states ${s.licence}`, rendered.includes(s.licence));
    check(`the page names ${s.title}`, rendered.includes(s.title));
  }
}

/* -------------------------------------------------------------------- out */

function diffSummary(want, got) {
  const w = want.split('\n');
  const g = got.split('\n');
  const first = Math.max(w.length, g.length);
  for (let i = 0; i < first; i++) {
    if (w[i] !== g[i]) {
      return `line ${i + 1}: notice has ${JSON.stringify(g[i])}, manifest says ${JSON.stringify(w[i])}`;
    }
  }
  return 'blocks differ';
}

for (const f of fails) console.log(`FAIL ${f}`);
console.log(`\npack credits: ${pass} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);