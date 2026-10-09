/**
 * tools/lib/wav.mjs - just enough RIFF/WAVE to read the VCSL samples.
 *
 * The pack builder runs in Node and the app never loads this, so it stays out
 * of the bundle. Handles the only two shapes these files come in: PCM 16-bit and
 * IEEE float 32-bit, mono or stereo. Anything else throws rather than guessing.
 */

const FMT_PCM = 1;
const FMT_FLOAT = 3;
const FMT_EXTENSIBLE = 0xfffe;

/** Parse a RIFF/WAVE file into `{sampleRate, channels, frames, data(Float32Array[])}`. */
export function readWav(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (off) => String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));

  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }

  let fmt = null;
  let dataAt = -1;
  let dataLen = 0;

  let off = 12;
  while (off + 8 <= bytes.length) {
    const id = tag(off);
    const size = dv.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      let format = dv.getUint16(body, true);
      const channels = dv.getUint16(body + 2, true);
      const sampleRate = dv.getUint32(body + 4, true);
      const bits = dv.getUint16(body + 14, true);
      if (format === FMT_EXTENSIBLE && size >= 40) {
        // The real format lives in the first two bytes of the GUID.
        format = dv.getUint16(body + 24, true);
      }
      fmt = { format, channels, sampleRate, bits, blockAlign: dv.getUint16(body + 12, true) };
    } else if (id === 'data') {
      dataAt = body;
      dataLen = Math.min(size, bytes.length - body);
    }
    off = body + size + (size & 1); // chunks are word-aligned
  }

  if (!fmt) throw new Error('WAVE file has no fmt chunk');
  if (dataAt < 0) throw new Error('WAVE file has no data chunk');
  if (fmt.format !== FMT_PCM && fmt.format !== FMT_FLOAT) {
    throw new Error(`unsupported WAVE format ${fmt.format} (only PCM and IEEE float)`);
  }
  if (fmt.bits !== 16 && fmt.bits !== 24 && fmt.bits !== 32) {
    throw new Error(`unsupported bit depth ${fmt.bits}`);
  }

  const bytesPerSample = fmt.bits >> 3;
  const frames = Math.floor(dataLen / (bytesPerSample * fmt.channels));
  const channels = [];
  for (let c = 0; c < fmt.channels; c++) channels.push(new Float32Array(frames));

  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < fmt.channels; c++) {
      const p = dataAt + (i * fmt.channels + c) * bytesPerSample;
      let v;
      if (fmt.format === FMT_FLOAT) {
        v = fmt.bits === 32 ? dv.getFloat32(p, true) : dv.getFloat64(p, true);
      } else if (fmt.bits === 16) {
        v = dv.getInt16(p, true) / 32768;
      } else if (fmt.bits === 24) {
        const u = dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getUint8(p + 2) << 16);
        v = ((u & 0x800000) ? u - 0x1000000 : u) / 8388608;
      } else {
        v = dv.getInt32(p, true) / 2147483648;
      }
      channels[c][i] = v;
    }
  }

  return { sampleRate: fmt.sampleRate, channels: fmt.channels, frames, data: channels };
}

/** Peak absolute sample value across all channels. */
export function peakOf(wav) {
  let peak = 0;
  for (const ch of wav.data) {
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > peak) peak = a;
    }
  }
  return peak;
}

/** RMS across all channels, over `from`..`to` in frames. */
export function rmsOf(wav, from = 0, to = wav.frames) {
  let sum = 0;
  let n = 0;
  for (const ch of wav.data) {
    for (let i = from; i < Math.min(to, ch.length); i++) { sum += ch[i] * ch[i]; n++; }
  }
  return n ? Math.sqrt(sum / n) : 0;
}

/** Short-window RMS envelope, for finding the decay and the loop region. */
export function envelope(wav, windowSec = 0.01) {
  const win = Math.max(1, Math.round(wav.sampleRate * windowSec));
  const out = new Float32Array(Math.ceil(wav.frames / win));
  for (let w = 0; w < out.length; w++) {
    out[w] = rmsOf(wav, w * win, (w + 1) * win);
  }
  return out;
}