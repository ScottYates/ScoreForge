/**
 * audio/fx.js — the master signal chain.
 *
 * Everything here is generated at runtime. The reverb impulse response is
 * synthesised procedurally rather than loaded from a WAV, which is what keeps
 * this file (and the final HTML) self-contained with no asset downloads.
 *
 * Signal flow:
 *
 *   part gain ─ panner ─┬─────────────────────────► bus.input ─┐
 *                       └─ part send ─► reverbSend ─► IR ─┐   │
 *                                                            ▼   ▼
 *                                        wet ──────────► mix ─► EQ ─ compressor
 *                                                                   │
 *                                        dry ────────────────────►  │
 *                                                                   ▼
 *                                                limiter ─► master ─► destination
 */

/** Impulse-response cache, keyed on ctx + parameters. */
const irCache = new WeakMap();

/**
 * Build a plausible room impulse response.
 *
 * @param {BaseAudioContext} ctx
 * @param {object} opts
 * @param {number} opts.duration     seconds of tail
 * @param {number} opts.decay        higher = faster falloff
 * @param {number} opts.brightness   0..1, how bright the tail starts
 * @param {number} opts.predelay     seconds
 * @param {number} opts.size         0..1, scales early-reflection spacing
 */
export function makeImpulseResponse(ctx, opts = {}) {
  const {
    duration = 2.4,
    decay = 3.0,
    brightness = 0.55,
    predelay = 0.012,
    size = 0.5,
  } = opts;

  let bucket = irCache.get(ctx);
  if (!bucket) { bucket = new Map(); irCache.set(ctx, bucket); }
  const key = [duration, decay, brightness, predelay, size].join('|');
  if (bucket.has(key)) return bucket.get(key);

  const sr = ctx.sampleRate;
  const len = Math.max(64, Math.floor(sr * duration));
  const pre = Math.min(len - 1, Math.floor(sr * predelay));
  const buf = ctx.createBuffer(2, len, sr);

  // A handful of discrete early reflections gives the tail a sense of walls.
  // Spacing scales with room size; the delays are deliberately not multiples of
  // each other so the pattern does not sound like a metronome.
  const early = [
    [0.0071, 0.62], [0.0113, -0.48], [0.0177, 0.41], [0.0231, -0.33],
    [0.0319, 0.27], [0.0412, -0.21], [0.0533, 0.17], [0.0671, -0.13],
  ];

  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    const spread = 1 + ch * 0.063; // decorrelate the channels
    let lp = 0;

    for (let i = 0; i < len; i++) {
      if (i < pre) { d[i] = 0; continue; }
      const t = (i - pre) / Math.max(1, len - pre);
      const env = Math.pow(1 - t, decay);
      const n = Math.random() * 2 - 1;
      // One-pole lowpass whose cutoff closes over time: bright early reflections,
      // dark diffuse tail. This is what stops a long tail sounding like hiss.
      const a = Math.min(0.98, brightness * Math.pow(1 - t, 1.7) + 0.015);
      lp += a * (n - lp);
      d[i] = lp * env;
    }

    for (const [tap, g] of early) {
      const idx = pre + Math.floor(sr * tap * spread * (0.75 + size * 0.9));
      if (idx < len) d[idx] += g * (ch ? -0.94 : 1);
    }

    // Normalise so the wet level slider means the same thing for every room.
    let peak = 0;
    for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i]));
    if (peak > 0) for (let i = 0; i < len; i++) d[i] /= peak;
  }

  bucket.set(key, buf);
  return buf;
}

/** Small default set of rooms offered in the UI. */
export const ROOMS = [
  { id: 'dry', label: 'Dry (no reverb)', duration: 0.001, decay: 6, brightness: 0.4, predelay: 0, size: 0.2, mix: 0 },
  { id: 'studio', label: 'Studio', duration: 1.1, decay: 4.2, brightness: 0.42, predelay: 0.008, size: 0.32, mix: 0.16 },
  { id: 'hall', label: 'Concert Hall', duration: 2.9, decay: 2.6, brightness: 0.5, predelay: 0.018, size: 0.7, mix: 0.28 },
  { id: 'church', label: 'Church', duration: 4.2, decay: 2.0, brightness: 0.36, predelay: 0.026, size: 0.9, mix: 0.34 },
];

/**
 * The master bus. One instance per audio context (one for playback, one for
 * each export render — they must not share state).
 */
export class AudioBus {
  constructor(ctx, destination) {
    this.ctx = ctx;
    const out = destination || ctx.destination;

    this.input = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.reverbSend = ctx.createGain();
    this.reverb = ctx.createConvolver();
    this.reverb.normalize = false;
    this._irKey = null;

    this.low = ctx.createBiquadFilter();
    this.low.type = 'lowshelf';
    this.low.frequency.value = 160;

    this.mid = ctx.createBiquadFilter();
    this.mid.type = 'peaking';
    this.mid.frequency.value = 1100;
    this.mid.Q.value = 0.9;

    this.high = ctx.createBiquadFilter();
    this.high.type = 'highshelf';
    this.high.frequency.value = 5200;

    this.air = ctx.createBiquadFilter();
    this.air.type = 'peaking';
    this.air.frequency.value = 11000;
    this.air.gain.value = 1.5;
    this.air.Q.value = 0.7;

    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -20;
    this.comp.knee.value = 14;
    this.comp.ratio.value = 2.6;
    this.comp.attack.value = 0.006;
    this.comp.release.value = 0.18;

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1.2;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.06;

    this.master = ctx.createGain();
    this.master.gain.value = 0.85;

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.75;

    this.input.connect(this.dry);
    this.reverbSend.connect(this.reverb);
    this.reverb.connect(this.wet);
    this.dry.connect(this.low);
    this.wet.connect(this.low);
    this.low.connect(this.mid);
    this.mid.connect(this.high);
    this.high.connect(this.air);
    this.air.connect(this.comp);
    this.comp.connect(this.limiter);
    this.limiter.connect(this.master);
    this.master.connect(this.analyser);
    this.analyser.connect(out);

    this.setRoom(ROOMS[1]);
    this.setParams({ volume: 0.85 });
  }

  setRoom(room) {
    this.room = room;
    this.reverb.buffer = makeImpulseResponse(this.ctx, room);
    this.wet.gain.value = room.mix;
    this.dry.gain.value = 1;
    this.reverbSend.gain.value = 1;
    return this;
  }

  /**
   * @param {object} p
   * @param {number} [p.volume] 0..1
   * @param {number} [p.lowDb]  -12..12
   * @param {number} [p.midDb]  -12..12
   * @param {number} [p.highDb] -12..12
   * @param {number} [p.compensation] extra output gain after the limiter, dB
   */
  setParams(p = {}) {
    const now = this.ctx.currentTime;
    const ramp = 0.02;
    if (p.volume != null) this.master.gain.setTargetAtTime(clamp01(p.volume), now, ramp / 3);
    if (p.lowDb != null) this.low.gain.setTargetAtTime(clamp(p.lowDb, -18, 18), now, ramp / 3);
    if (p.midDb != null) this.mid.gain.setTargetAtTime(clamp(p.midDb, -18, 18), now, ramp / 3);
    if (p.highDb != null) this.high.gain.setTargetAtTime(clamp(p.highDb, -18, 18), now, ramp / 3);
    if (p.makeupDb != null) this.master.gain.setTargetAtTime(clamp(p.volume * Math.pow(10, p.makeupDb / 20), 0, 1.5), now, ramp / 3);
  }

  dispose() {
    try {
      this.input.disconnect(); this.dry.disconnect(); this.wet.disconnect();
      this.reverbSend.disconnect(); this.reverb.disconnect();
      this.low.disconnect(); this.mid.disconnect(); this.high.disconnect();
      this.air.disconnect(); this.comp.disconnect(); this.limiter.disconnect();
      this.master.disconnect(); this.analyser.disconnect();
    } catch { /* already torn down */ }
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function clamp01(v) { return clamp(v, 0, 1); }

/**
 * A soft-knee peak meter. Reads the bus analyser without allocating per frame.
 */
export class Meter {
  constructor(analyser) {
    this.analyser = analyser;
    this.buf = new Float32Array(analyser.fftSize);
  }
  /** @returns {{peak:number, rms:number}} linear magnitude */
  read() {
    this.analyser.getFloatTimeDomainData(this.buf);
    let peak = 0, sum = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const v = this.buf[i];
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      sum += v * v;
    }
    return { peak, rms: Math.sqrt(sum / this.buf.length) };
  }
}

/** dB helpers shared by the meters. */
export function linToDb(v) { return v <= 1e-7 ? -Infinity : 20 * Math.log10(v); }
export function dbToLin(db) { return Math.pow(10, db / 20); }