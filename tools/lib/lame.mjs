/**
 * tools/lib/lame.mjs - the app's own lamejs, loaded into Node.
 *
 * The bundle exports by assigning to `lamejs` on the global, with no
 * module.exports, so it has to be evaluated in a context that has one. The
 * browser gets this file concatenated ahead of the app; here it just needs a
 * sandbox to live in.
 *
 * Reusing the bundled encoder rather than adding a dependency means the pack is
 * built with exactly the encoder the app ships, so an MP3 the pack builder
 * calls valid is valid in the browser too.
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');

let cached = null;

function loadLame() {
  if (cached) return cached;
  // Not require.resolve: this runs from tools/, and a bare specifier would be
  // resolved relative to the repo root rather than to node_modules.
  const file = path.join(repo, 'node_modules', 'lamejs', 'lame.min.js');
  const src = fs.readFileSync(file, 'utf8');

  const sandbox = { console, Math, Date, Array, Uint8Array, Int8Array, Int16Array,
    Int32Array, Float32Array, Float64Array, Uint16Array, Uint32Array, ArrayBuffer,
    DataView, Error, TypeError, RangeError, isNaN, parseInt, parseFloat, String, Number, Object };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.global = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'lame.min.js' });

  const lamejs = sandbox.lamejs || sandbox.window.lamejs;
  if (!lamejs || !lamejs.Mp3Encoder) {
    throw new Error('lamejs loaded but exposed no Mp3Encoder');
  }
  cached = lamejs;
  return cached;
}

/**
 * Encode float channels to an MP3 byte stream.
 *
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @param {number} kbps
 * @returns {Buffer}
 */
export function encodeMp3(channels, sampleRate, kbps) {
  const lamejs = loadLame();
  const stereo = channels.length > 1;
  const enc = new lamejs.Mp3Encoder(stereo ? 2 : 1, sampleRate, kbps);
  const n = channels[0].length;
  const left = toInt16(channels[0]);
  const right = stereo ? toInt16(channels[1]) : null;

  const chunks = [];
  // lamejs wants exactly one MPEG frame group at a time; a whole-file call
  // returns an empty buffer.
  const block = 1152;
  for (let i = 0; i < n; i += block) {
    const end = Math.min(n, i + block);
    const l = left.subarray(i, end);
    const r = right ? right.subarray(i, end) : undefined;
    const out = r ? enc.encodeBuffer(l, r) : enc.encodeBuffer(l);
    if (out.length) chunks.push(Buffer.from(out));
  }
  const tail = enc.flush();
  if (tail.length) chunks.push(Buffer.from(tail));
  return Buffer.concat(chunks);
}

function toInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = f32[i] < -1 ? -1 : f32[i] > 1 ? 1 : f32[i];
    out[i] = s < 0 ? s * 32768 : s * 32767;
  }
  return out;
}