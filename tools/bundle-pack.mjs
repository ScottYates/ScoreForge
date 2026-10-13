/**
 * tools/bundle-pack.mjs: repack an existing per-file pack/ into per-bank
 * bundles, in place.
 *
 *   node tools/bundle-pack.mjs
 *
 * Runs bundlePack() over pack/ (see tools/lib/packbundle.mjs). Writes the
 * .pack files and the version-3 manifest. The per-take MP3s are left on disk;
 * remove them with `git rm` once the checks pass. make-pack.mjs runs the same
 * bundling at the end of a full rebuild, so this tool is only needed to
 * convert a pack built before version 3.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundlePack } from './lib/packbundle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = bundlePack(path.join(root, 'pack'));
const banks = Object.entries(manifest.instruments);
let bytes = 0;
for (const [, inst] of banks) bytes += inst.bundle.size;
console.log(`bundled ${banks.length} banks, ${(bytes / 1048576).toFixed(1)} MB, manifest v${manifest.version}`);
