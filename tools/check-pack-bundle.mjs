/**
 * tools/check-pack-bundle.mjs: a bundled pack holds the same bytes the
 * per-file pack held, where the manifest says they are.
 *
 * Builds a small synthetic per-file pack, runs bundlePack() over it, and
 * verifies: every take's slice equals its original file byte for byte; the
 * manifest is version 3 with a bundle entry per bank and an offset and length
 * on every hit; takeIndex() and takeBytes() read the same slices back; a take
 * shared by two notes is stored once; the shipped pack/ in this repository,
 * when present and bundled, passes the same slice-equality spot check against
 * its manifest sizes.
 *
 * Node only; no browser, no audio decode. The audio-level comparison against
 * the FreePats sources stays in check-pack-is-unprocessed.mjs.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claimTree, removeOwnedTree } from './lib/guard.mjs';
import { bundlePack, sendFileRanged, takeBytes, takeIndex } from './lib/packbundle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) failed++;
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${detail ? '  - ' + detail : ''}`);
};

// --- synthetic pack ---------------------------------------------------------
// Scratch inside the repository, claimed through the deletion guard: only
// guard.mjs may delete, and only trees it saw created.
const tmp = path.join(root, '.tmp', `packbundle-check-${process.pid}`);
claimTree(tmp, 'Scratch for the pack bundling round-trip check.');
const mkTake = (rel, seed, len) => {
  const buf = Buffer.alloc(len);
  for (let i = 0; i < len; i++) buf[i] = (seed * 31 + i * 7) & 0xff;
  fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
  fs.writeFileSync(path.join(tmp, rel), buf);
  return buf;
};
const originals = new Map();
originals.set('one/60.mp3', mkTake('one/60.mp3', 3, 1200));
originals.set('one/61.mp3', mkTake('one/61.mp3', 5, 777));
originals.set('two/40.mp3', mkTake('two/40.mp3', 9, 2048));
const manifest = {
  version: 2,
  credits: {},
  instruments: {
    one: {
      name: 'one', lo: 60, hi: 62, sustains: false,
      notes: {
        60: { rate: 1, hits: [{ f: 'one/60.mp3', g: 1 }] },
        61: { rate: 1, hits: [{ f: 'one/61.mp3', g: 1 }] },
        // 62 reuses 61's take: it must be stored once and found twice.
        62: { rate: 1.06, hits: [{ f: 'one/61.mp3', g: 1 }] },
      },
    },
    two: {
      name: 'two', lo: 40, hi: 40, sustains: false,
      notes: { 40: { rate: 1, hits: [{ f: 'two/40.mp3', g: 1 }] } },
    },
  },
};
fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest));

const out = bundlePack(tmp);

ok('the manifest is version 3 after bundling', out.version === 3, `version ${out.version}`);
ok('every bank gains a bundle entry',
  Object.values(out.instruments).every((i) => i.bundle && i.bundle.file && i.bundle.size > 0));
ok('every hit gains an offset and a length',
  Object.values(out.instruments).every((i) =>
    Object.values(i.notes).every((n) => n.hits.every((h) => h.o != null && h.n > 0))));

let slicesMatch = true;
let mismatch = '';
for (const [id, inst] of Object.entries(out.instruments)) {
  const bundle = fs.readFileSync(path.join(tmp, inst.bundle.file));
  for (const note of Object.values(inst.notes)) {
    for (const hit of note.hits) {
      const slice = bundle.subarray(hit.o, hit.o + hit.n);
      if (!slice.equals(originals.get(hit.f))) {
        slicesMatch = false;
        mismatch = `${id} ${hit.f}`;
      }
    }
  }
}
ok('every take slice equals the file it came from, byte for byte', slicesMatch, mismatch);

const shared = out.instruments.one;
const h61 = shared.notes[61].hits[0];
const h62 = shared.notes[62].hits[0];
ok('a take shared by two notes is stored once', h61.o === h62.o && h61.n === h62.n
  && shared.bundle.size === 1200 + 777,
  `bundle size ${shared.bundle.size}, offsets ${h61.o}/${h62.o}`);

const index = takeIndex(out);
ok('takeIndex covers every take', index.size === 3, `${index.size} of 3`);
let readBack = true;
for (const [id, inst] of Object.entries(out.instruments)) {
  for (const note of Object.values(inst.notes)) {
    for (const hit of note.hits) {
      if (!takeBytes(tmp, inst, hit).equals(originals.get(hit.f))) readBack = false;
    }
  }
}
ok('takeBytes reads the same bytes back', readBack);

// --- the tool servers' Range handling ----------------------------------------
// The loader's primary path is a 206 per take; the tool servers answer it
// through sendFileRanged, so a wrong slice here would feed every http check
// the wrong bytes while their requests all succeed.
{
  const bundleFile = path.join(tmp, out.instruments.one.bundle.file);
  const whole = fs.readFileSync(bundleFile);
  const server = http.createServer((req, res) => sendFileRanged(req, res, bundleFile, 'application/octet-stream'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const hit = out.instruments.one.notes[61].hits[0];
  const r206 = await fetch(`http://127.0.0.1:${port}/`, { headers: { Range: `bytes=${hit.o}-${hit.o + hit.n - 1}` } });
  const slice = Buffer.from(await r206.arrayBuffer());
  ok('sendFileRanged answers a range with 206 and the right bytes',
    r206.status === 206 && slice.equals(whole.subarray(hit.o, hit.o + hit.n)),
    `status ${r206.status}, ${slice.length} bytes`);
  const r200 = await fetch(`http://127.0.0.1:${port}/`);
  const all = Buffer.from(await r200.arrayBuffer());
  ok('and a plain request with 200 and the whole file',
    r200.status === 200 && all.equals(whole), `status ${r200.status}, ${all.length} bytes`);
  server.close();
}

removeOwnedTree(tmp, 'pack bundling check scratch');

// --- the shipped pack, when bundled ----------------------------------------
const shippedManifest = path.join(root, 'pack', 'manifest.json');
if (fs.existsSync(shippedManifest)) {
  const m = JSON.parse(fs.readFileSync(shippedManifest, 'utf8'));
  if (m.version >= 3) {
    let bad = '';
    let banks = 0;
    for (const [id, inst] of Object.entries(m.instruments)) {
      const file = path.join(root, 'pack', inst.bundle.file);
      if (!fs.existsSync(file)) { bad = `${id}: ${inst.bundle.file} missing`; break; }
      const size = fs.statSync(file).size;
      if (size !== inst.bundle.size) { bad = `${id}: size ${size} vs manifest ${inst.bundle.size}`; break; }
      for (const note of Object.values(inst.notes)) {
        for (const hit of note.hits) {
          if (hit.o == null || hit.o + hit.n > size) { bad = `${id}: ${hit.f} slice out of range`; break; }
        }
      }
      banks++;
    }
    ok(`the shipped pack's ${banks} bundles match their manifest sizes and slices`, !bad, bad);
  } else {
    console.log('  skip  shipped pack is version 2 (per-file); nothing bundled to check');
  }
} else {
  console.log('  skip  no pack/ in this checkout');
}

console.log(`\n${failed ? 'pack bundle FAILED' : 'pack bundle OK'}`);
process.exit(failed ? 1 : 0);
