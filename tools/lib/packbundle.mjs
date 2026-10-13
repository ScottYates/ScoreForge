/**
 * tools/lib/packbundle.mjs: turn a per-file pack directory into per-bank
 * bundles.
 *
 * A pack of ~4,200 separate MP3s costs one HTTP request per take to download
 * and is slow to copy, sync, or serve. bundlePack() concatenates each bank's
 * takes into one <bank>.pack file and records each take's byte offset and
 * length in the manifest. The audio bytes do not change: a take is the same
 * MP3 stream it was as a file, so decoding a slice gives the same PCM and the
 * fidelity checks keep comparing the same bytes.
 *
 * Manifest changes (version 2 -> 3):
 *   instrument.bundle = { file: "<id>.pack", size }  one per bank
 *   hit.o, hit.n                                     slice offset and length
 * hit.f stays and remains the take's identity key everywhere (fetch dedupe,
 * decode cache, credits); it just no longer names a file on disk.
 *
 * A take referenced by more than one bank is copied into each bank's bundle,
 * so each bank is one self-contained file. The bytes are identical, so any
 * copy satisfies a reader that looks the take up by f.
 *
 * bundlePack() writes the .pack files and the updated manifest. It does not
 * delete the per-take files; the caller decides what happens to them.
 */

import fs from 'node:fs';
import path from 'node:path';

export function bundlePack(dir) {
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  for (const [id, inst] of Object.entries(manifest.instruments)) {
    // Each distinct take once, in first-seen order.
    const order = [];
    const slice = new Map(); // f -> {o, n}
    for (const note of Object.values(inst.notes)) {
      for (const hit of note.hits) {
        if (!slice.has(hit.f)) {
          slice.set(hit.f, null);
          order.push(hit.f);
        }
      }
    }

    const parts = [];
    let offset = 0;
    for (const f of order) {
      const bytes = fs.readFileSync(path.join(dir, f));
      slice.set(f, { o: offset, n: bytes.length });
      parts.push(bytes);
      offset += bytes.length;
    }

    const file = `${id}.pack`;
    fs.writeFileSync(path.join(dir, file), Buffer.concat(parts));
    inst.bundle = { file, size: offset };
    for (const note of Object.values(inst.notes)) {
      for (const hit of note.hits) {
        const s = slice.get(hit.f);
        hit.o = s.o;
        hit.n = s.n;
      }
    }
  }

  manifest.version = 3;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
  return manifest;
}

/**
 * The slice of `buf` holding one take, by its manifest hit. Shared by the
 * tools that used to read the take's own file.
 */
export function takeBytes(dir, inst, hit) {
  if (hit.o == null || !inst.bundle) {
    return fs.readFileSync(path.join(dir, hit.f)); // version 2 pack
  }
  const fd = fs.openSync(path.join(dir, inst.bundle.file), 'r');
  try {
    const out = Buffer.alloc(hit.n);
    fs.readSync(fd, out, 0, hit.n, hit.o);
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

/** rel f -> {file, o, n} for every take in a version-3 manifest. */
export function takeIndex(manifest) {
  const index = new Map();
  for (const inst of Object.values(manifest.instruments || {})) {
    if (!inst.bundle) continue;
    for (const note of Object.values(inst.notes)) {
      for (const hit of note.hits) {
        if (hit.o != null && !index.has(hit.f)) {
          index.set(hit.f, { file: inst.bundle.file, o: hit.o, n: hit.n });
        }
      }
    }
  }
  return index;
}

/**
 * Serve one file over http, honouring a single-range Range header the way the
 * backend's FileResponse does. The tool servers use this so the loader's
 * primary path (a 206 per take) is what the checks exercise; a server without
 * it still works through the loader's whole-file fallback.
 */
export function sendFileRanged(req, res, file, type) {
  const size = fs.statSync(file).size;
  const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
  if (m) {
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), size - 1);
    if (start <= end && start < size) {
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
  fs.createReadStream(file).pipe(res);
}
