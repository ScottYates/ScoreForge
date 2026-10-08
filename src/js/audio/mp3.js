/**
 * audio/mp3.js — offline rendering and MP3/WAV encoding.
 *
 * Rendering is *not* real-time: an `OfflineAudioContext` synthesises the whole
 * piece as fast as the CPU allows (typically 100–1000× faster than playback),
 * and only then is the PCM handed to LAME. That is what makes a 5-minute export
 * feel instant apart from the encode itself.
 */

import { Engine } from './engine.js';
import { AudioBus } from './fx.js';

/**
 * lamejs ships as a pre-concatenated CommonJS bundle whose internal files rely
 * on sharing one module scope (`Lame` reads `MPEGMode` as a bare identifier).
 * Bundling the individual `src/js/*.js` files breaks that, so the shipped
 * `lame.min.js` is inlined as a classic script by the build and reached through
 * the global instead of imported.
 */
function lamejs() {
  const g = typeof window !== 'undefined' ? window.lamejs : null;
  if (!g || typeof g.Mp3Encoder !== 'function') {
    throw new Error('The MP3 encoder failed to load.');
  }
  return g;
}

export const RENDER_TAIL = 2.0;
export const BITRATES = [128, 160, 192, 256, 320];
export const SAMPLE_RATES = [44100, 48000];

export class RenderCancelled extends Error {
  constructor() { super('Render cancelled'); this.name = 'RenderCancelled'; }
}

/**
 * Synthesise the resolved score into an AudioBuffer, faster than real time.
 *
 * @returns {Promise<AudioBuffer>}
 */
export async function renderToBuffer(o) {
  const {
    resolved,
    partInstruments,
    sampleRate = 44100,
    channels = 2,
    busOptions = {},
    onProgress,
    signal,
  } = o;

  if (!resolved || !resolved.notes) throw new Error('Nothing to render — load a score first.');

  const seconds = Math.max(1, (resolved.durationSec || 0) + RENDER_TAIL);
  const frameCount = Math.ceil(seconds * sampleRate);

  // A very long piece at 48 kHz stereo float32 can be hundreds of megabytes.
  // Say so up front rather than letting the tab die without explanation.
  const bytesNeeded = frameCount * channels * 4;
  if (bytesNeeded > 420 * 1024 * 1024) {
    if (!o.allowHuge) {
      throw new Error(
        `This piece would need about ${(bytesNeeded / 1048576) | 0} MB of memory to render. ` +
        `Choose 44.1 kHz, or split the score, to continue.`
      );
    }
  }

  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new Ctx(channels, frameCount, sampleRate);
  const bus = new AudioBus(ctx, ctx.destination);
  if (busOptions.room) bus.setRoom(busOptions.room);
  if (busOptions.params) bus.setParams(busOptions.params);

  const engine = new Engine(ctx, { bus, offline: true });
  engine.load(resolved, { partInstruments });
  engine.metronome = !!o.metronome;
  // Exports must be bit-reproducible: no performance jitter.
  engine.humanize = 0;
  engine.scheduleAll();

  onProgress?.({ phase: 'render', ratio: 0.05, message: 'Synthesising…' });
  if (signal?.aborted) throw new RenderCancelled();

  const buffer = await ctx.startRendering();
  onProgress?.({ phase: 'render', ratio: 0.55, message: 'Synthesised' });
  if (signal?.aborted) throw new RenderCancelled();

  bus.dispose();
  engine.dispose();
  return buffer;
}

/**
 * Encode an AudioBuffer to MP3, yielding to the UI so the progress bar moves.
 *
 * @returns {Promise<{bytes: Uint8Array, blob: Blob, kbps: number, sampleRate: number, channels: number, peak: number}>}
 */
export async function encodeMp3(buffer, o = {}) {
  const {
    kbps = 192,
    normalize = true,
    targetPeakDb = -1.0,
    fadeOutSec = 0.08,
    onProgress,
    signal,
  } = o;

  const sampleRate = buffer.sampleRate;
  const channels = buffer.numberOfChannels;
  const n = buffer.length;
  const left = buffer.getChannelData(0);
  const right = channels > 1 ? buffer.getChannelData(1) : left;

  let peak = 0;
  for (let c = 0; c < channels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) { const a = d[i] < 0 ? -d[i] : d[i]; if (a > peak) peak = a; }
  }
  const targetPeak = Math.pow(10, targetPeakDb / 20);
  const gain = normalize && peak > 1e-6 ? Math.min(8, targetPeak / peak) : 1;

  const l16 = new Int16Array(n);
  const r16 = new Int16Array(n);
  const fadeN = Math.max(1, Math.min(n, Math.floor(fadeOutSec * sampleRate)));
  for (let i = 0; i < n; i++) {
    const fade = i >= n - fadeN ? (n - i) / fadeN : 1;
    const s = fade * gain;
    let l = Math.round(left[i] * s * 32767);
    let r = Math.round(right[i] * s * 32767);
    l16[i] = l > 32767 ? 32767 : l < -32768 ? -32768 : l;
    r16[i] = r > 32767 ? 32767 : r < -32768 ? -32768 : r;
  }

  const enc = new (lamejs().Mp3Encoder)(channels, sampleRate, kbps);
  const BLOCK = 1152;
  const parts = [];
  let total = 0;
  let lastTick = performance.now();

  for (let i = 0; i < n; i += BLOCK) {
    const l = l16.subarray(i, Math.min(n, i + BLOCK));
    const r = r16.subarray(i, Math.min(n, i + BLOCK));
    const out = enc.encodeBuffer(l, r);
    if (out.length) { parts.push(out); total += out.length; }

    // Yield every ~40 ms of wall clock so the page stays interactive and the
    // progress bar actually paints.
    const now = performance.now();
    if (now - lastTick > 40) {
      lastTick = now;
      onProgress?.({ phase: 'encode', ratio: i / n, message: `Encoding MP3… ${(i / n * 100) | 0}%` });
      await new Promise((r) => setTimeout(r, 0));
      if (signal?.aborted) { throw new RenderCancelled(); }
    }
  }

  const tail = enc.flush();
  if (tail.length) { parts.push(tail); total += tail.length; }

  const bytes = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { bytes.set(p, off); off += p.length; }

  onProgress?.({ phase: 'encode', ratio: 1, message: 'Encoded' });

  return {
    bytes,
    blob: new Blob([bytes], { type: 'audio/mpeg' }),
    kbps, sampleRate, channels,
    peak,
    appliedGainDb: 20 * Math.log10(gain || 1e-9),
    durationSec: n / sampleRate,
  };
}

/** 16-bit PCM WAV, for anyone who wants an uncompressed master. */
export function encodeWav(buffer) {
  const n = buffer.length;
  const ch = buffer.numberOfChannels;
  const bytes = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const wr = (o, s) => { for (let i = 0; i < s.length; i++) bytes.setUint8(o + i, s.charCodeAt(i)); };
  wr(0, 'RIFF'); bytes.setUint32(4, 36 + n * ch * 2, true); wr(8, 'WAVE');
  wr(12, 'fmt '); bytes.setUint32(16, 16, true);
  bytes.setUint16(20, 1, true);
  bytes.setUint16(22, ch, true);
  bytes.setUint32(24, buffer.sampleRate, true);
  bytes.setUint32(28, buffer.sampleRate * ch * 2, true);
  bytes.setUint16(32, ch * 2, true);
  bytes.setUint16(34, 16, true);
  wr(36, 'data'); bytes.setUint32(40, n * ch * 2, true);

  const chans = [];
  for (let c = 0; c < ch; c++) chans.push(buffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      let s = Math.round(chans[c][i] * 32767);
      s = s > 32767 ? 32767 : s < -32768 ? -32768 : s;
      bytes.setInt16(o, s, true);
      o += 2;
    }
  }
  return new Blob([bytes.buffer], { type: 'audio/wav' });
}

/**
 * Minimal MPEG audio frame walker. Used by the built-in self-test to prove an
 * exported file really is playable MPEG-1 Layer III at the rate we asked for,
 * rather than trusting the encoder's return value.
 */
export function inspectMp3(bytes) {
  const BITRATE_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const BITRATE_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const RATES = [[44100, 48000, 32000], [22050, 24000, 16000], [11025, 12000, 8000]];
  let i = 0, frames = 0, bad = 0, first = null;
  while (i + 4 <= bytes.length) {
    if (bytes[i] === 0xff && (bytes[i + 1] & 0xe0) === 0xe0) {
      const verBits = (bytes[i + 1] >> 3) & 3;
      const layer = (bytes[i + 1] >> 1) & 3;
      const brIdx = (bytes[i + 2] >> 4) & 0xf;
      const srIdx = (bytes[i + 2] >> 2) & 3;
      const pad = (bytes[i + 2] >> 1) & 1;
      const table = verBits === 3 ? BITRATE_V1_L3 : BITRATE_V2_L3;
      const br = table[brIdx];
      const srIdxMap = verBits === 3 ? 0 : verBits === 2 ? 1 : 2;
      const sr = RATES[srIdxMap][srIdx];
      if (!br || !sr || layer !== 1) { bad++; i++; continue; }
      const len = Math.floor((verBits === 3 ? 144000 : 72000) * br / sr) + pad;
      if (!first) first = { bitrateKbps: br, sampleRate: sr, mpeg: verBits === 3 ? 1 : verBits === 2 ? 2 : 2.5, layer, frameBytes: len };
      frames++;
      i += len;
    } else i++;
  }
  const spf = first && first.mpeg === 1 ? 1152 : 576;
  return { frames, badSync: bad, first, durationSec: first ? (frames * spf) / first.sampleRate : 0 };
}