/**
 * audio/instruments.js — the synthesised instrument roster, and the way the
 * recorded ones are reached.
 *
 * Every sound the *synthesiser* makes here is built from oscillators, noise and
 * biquads — but built from *physics*, not from a bank of sine tones:
 *
 *   strings   f_n = n·f0·√(1 + B·n²)   (stiff-string inharmonicity)
 *   decay     T60_n = T60_1 / (1 + k·(n-1))   (high partials die first)
 *   unisons   2–3 strings per note, detuned a couple of cents → slow beating
 *   strike    a short band-passed noise burst whose brightness follows velocity
 *   tone      a per-voice lowpass that opens with velocity and pitch
 *   body      shared peaking filters so chords sound like one instrument
 *
 * Everything is created from the `ctx` that is handed in (realtime or offline),
 * everything is scheduled on the absolute time domain, and there is no timer,
 * promise or animation frame anywhere in the timing path — so an offline render
 * and a realtime playback of the same score are identical, and repeated renders
 * are bit-identical.
 *
 * The recorded instruments are a separate thing and live in audio/sampler.js.
 * They answer the same interface, so `createInstrument` hands back whichever
 * kind was asked for and nothing downstream can tell the difference: a roster
 * entry with `engine: 'sampled'` is served from pack/ once that has loaded,
 * and falls back to its modelled equivalent until it has — so choosing one
 * from a page opened as a file still makes music instead of silence.
 *
 * Contract: CONTRACT.md §2.
 */

import { midiToName } from '../score/model.js';
import { createSampledInstrument, hasPack, isPackDecoded, __registerPackOf } from './sampler.js';

/* ==================================================================== misc */

const DEBUG = false;
function dbg(...a) { if (DEBUG) console.log('[instruments]', ...a); }

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
/** Everything above this is inaudible and would only cost CPU. */
const TOP_FREQ = 11000;

/**
 * Deterministic [0,1) hash. Any "randomness" in the instrument (unison spread,
 * noise offset) is derived from the note itself so two renders of the same score
 * produce the same samples, sample for sample.
 */
function hash01(a, b = 0, c = 0) {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Exponential-ish amplitude envelope: click-free attack then a decay to −80 dB. */
function envHit(param, t0, peak, attack, decay) {
  const floor = Math.max(1e-7, peak * 1e-4);
  param.cancelScheduledValues(t0);
  param.setValueAtTime(floor, t0);
  param.linearRampToValueAtTime(Math.max(1e-6, peak), t0 + attack);
  param.exponentialRampToValueAtTime(floor, t0 + attack + decay * 2);
}

/** Sustained envelope: attack to `peak`, hold until `tRel`, then release to 0. */
function envHold(param, t0, peak, attack, tRel, release) {
  const t = Math.max(tRel, t0 + attack);
  param.cancelScheduledValues(t0);
  param.setValueAtTime(0, t0);
  param.linearRampToValueAtTime(peak, t0 + attack);
  if (t > t0 + attack) param.setValueAtTime(peak, t);
  param.exponentialRampToValueAtTime(Math.max(1e-6, peak * 1e-3), t + release);
  param.linearRampToValueAtTime(0, t + release * 1.15);
}

/* =================================================================== noise */

/**
 * White + pink noise, generated **once per context** and cached on it. A
 * 3-second stereo-free buffer is 130 kB at 44.1 kHz; regenerating it per note
 * would be the single most expensive thing this file could do.
 */
const NOISE_CACHE = new WeakMap();

function noiseKit(ctx) {
  let n = NOISE_CACHE.get(ctx);
  if (n) return n;
  const len = Math.max(8192, Math.ceil(ctx.sampleRate * 1.5));
  const white = ctx.createBuffer(1, len, ctx.sampleRate);
  const wd = white.getChannelData(0);
  let s = 0x2f6e2b1;
  for (let i = 0; i < len; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    wd[i] = (s >>> 8) / 8388608 - 1;
  }
  // Paul Kellet's economy pink filter — bow noise and breath need the tilt.
  const pink = ctx.createBuffer(1, len, ctx.sampleRate);
  const pd = pink.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < len; i++) {
    const w = wd[i];
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856;
    b4 = 0.55000 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.0168980;
    pd[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  n = { white, pink, len, dur: len / ctx.sampleRate };
  NOISE_CACHE.set(ctx, n);
  return n;
}

/* ============================================================ harmonic wave */

/** Cached band-limited PeriodicWave from a harmonic amplitude table. */
const WAVE_CACHE = new WeakMap();

function wave(ctx, amps) {
  let per = WAVE_CACHE.get(ctx);
  if (!per) { per = new Map(); WAVE_CACHE.set(ctx, per); }
  const key = amps.join(',');
  let w = per.get(key);
  if (!w) {
    const n = amps.length;
    const real = new Float32Array(n + 1);
    const imag = new Float32Array(n + 1);
    for (let i = 0; i < n; i++) real[i + 1] = amps[i];
    w = ctx.createPeriodicWave(real, imag, { disableNormalization: false });
    per.set(key, w);
  }
  return w;
}

/** Harmonic amplitude table helpers (1..N, index 0 is the fundamental). */
const SPECTRA = {
  saw: (n = 24, tilt = 1) => Array.from({ length: n }, (_, i) => 1 / Math.pow(i + 1, tilt)),
  flute: (n = 16) => [1, 0.09, 0.13, 0.035, 0.045, 0.02, 0.025, 0.012, 0.014, 0.007, 0.008, 0.004, 0.005, 0.003, 0.003, 0.002],
  clarinet: (n = 16) => [1, 0.04, 0.30, 0.03, 0.18, 0.02, 0.11, 0.015, 0.075, 0.01, 0.05, 0.008, 0.034, 0.006, 0.022, 0.005],
  sax: (n = 20) => {
    const a = [];
    for (let i = 0; i < n; i++) a.push((1 / (i + 1)) * (i % 2 === 0 ? 0.55 : 1));
    return a;
  },
  bowed: (n = 24) => {
    const a = [];
    for (let i = 0; i < n; i++) a.push((1 / (i + 1)) * (i % 2 === 0 ? 1 : 0.72));
    return a;
  },
  pad: (n = 20) => {
    const a = [];
    for (let i = 0; i < n; i++) a.push(1 / Math.pow(i + 1, 1.15));
    return a;
  },
};

/* ================================================================ voice base */

/**
 * Shared voice plumbing: node accounting, the release ("damper") gain that every
 * family uses, the live-detune bus, and teardown. Families fill in `start`.
 */
function initVoice(kit) {
  const ctx = kit.ctx;
  const v = {
    kit, ctx,
    nodes: [], oscs: [],
    generation: 0,
    freeAt: 0, started: false, damped: false, sustained: false,
    midi: -1, startTime: 0, releaseAt: Infinity, vca: null, det: null,
    hold: 1, attackEnd: 0,

    track(node) {
      this.nodes.push(node);
      kit.stats.nodes++;
      if (kit.stats.nodes > kit.stats.peakNodes) kit.stats.peakNodes = kit.stats.nodes;
      return node;
    },

    osc(freq, type, wav) {
      const o = this.track(ctx.createOscillator());
      if (wav) o.setPeriodicWave(wav); else o.type = type || 'sine';
      o.frequency.value = freq;
      this.oscs.push(o);
      return o;
    },

    noise(kind) {
      const s = this.track(ctx.createBufferSource());
      const b = noiseKit(ctx)[kind || 'white'];
      s.buffer = b;
      s.loop = true;
      return s;
    },

    /** Detach everything and hand the shell back to the pool. */
    drop() {
      for (let i = 0; i < this.nodes.length; i++) {
        try { this.nodes[i].disconnect(); } catch (e) { /* already detached */ }
        kit.stats.nodes--;
      }
      this.nodes.length = 0;
      this.oscs.length = 0;
      this.vca = null;
      this.det = null;
      this.generation++;
      this.started = false;
      this.damped = false;
      this.sustained = false;
      this.midi = -1;
      this.freeAt = 0;
    },

    /** Hard cutoff used when a voice is stolen — must not click. */
    hardStop(t) {
      const stop = Math.max(t, this.startTime + 0.005);
      for (const o of this.oscs) { try { o.stop(stop); } catch (e) { /* not started */ } }
      this.freeAt = stop + 0.005;
    },

    start() {},
    release() {},
  };
  return v;
}

/**
 * Ramp a gain to silence from the value it will actually have at time `t`.
 *
 * `cancelAndHoldAtTime` is the obvious API here and it is WRONG for us: we
 * schedule the whole piece up front, before the offline render begins, and
 * Chrome resolves it against the pre-render timeline — which holds the param at
 * its initial value and applies the release retroactively from the note's
 * attack, silencing every note that has a note-off. So the hold value is
 * computed from the envelope we just scheduled instead.
 */
function fadeOut(param, t, r, held) {
  const h = Math.max(1e-4, held);
  param.cancelScheduledValues(t);
  param.setValueAtTime(h, t);
  param.exponentialRampToValueAtTime(Math.max(1e-5, h * 1e-3), t + r);
  param.linearRampToValueAtTime(0, t + r * 1.2);
}

/** Fade the release gain to zero and close the voice down. */
function closeVoice(v, t, release) {
  if (!v.vca) return;
  const r = Math.max(0.005, release);
  fadeOut(v.vca.gain, t, r, 1);
  v.damped = true;
  v.hardStop(t + r * 1.25);
}

/* ========================================================= additive voice */

/**
 * The workhorse: piano-family strings, plucked strings, struck bars and pitched
 * membranes all differ only in their partial frequencies, their decay law and
 * their strike, so they share one voice.
 *
 * mode 'string'   f_n = n·f0·√(1 + B·n²)
 * mode 'ratios'   tuned-bar / membrane modes supplied by the configuration
 */
function createAdditiveVoice(kit, cfg) {
  const v = initVoice(kit);
  const ctx = kit.ctx;
  const sr = ctx.sampleRate;

  v.start = function (spec) {
    if (v.started) { v.drop(); kit.stats.voices = Math.max(0, kit.stats.voices - 1); }
    const { midi, velocity, when } = spec;
    const params = spec.params;
    const f0 = mtof(midi);
    const vel = clamp(velocity, 0.01, 1);

    v.midi = midi;
    v.startTime = when;
    v.started = true;
    v.damped = false;
    v.sustained = false;
    v.releaseAt = Infinity;

    /* ---- how many partials this note can afford --------------------- */
    const byPitch = Math.floor(TOP_FREQ / f0);
    const byVel = Math.round(cfg.minPartials + (cfg.maxPartials - cfg.minPartials) * Math.pow(vel, 0.8));
    const count = clamp(Math.min(byPitch, byVel), 2, cfg.maxPartials);

    /* ---- spectral balance ------------------------------------------ */
    // Softer note ⇒ steeper rolloff ⇒ darker. That is the whole trick to
    // velocity realism: it is not just quieter, it is duller.
    const rolloff = clamp(cfg.rolloff - cfg.rolloffVel * Math.pow(vel, 0.9), 0.35, 5);
    const bright = clamp(
      (cfg.brightBase + cfg.brightVel * Math.pow(vel, 0.8)) *
      (1 + (midi - 60) * cfg.brightReg) *
      (0.62 + 0.76 * params.brightness), 0.3, 1.8);

    const B = cfg.mode === 'string' ? inharmonicity(midi, cfg) : 0;
    const amp = noteAmp(cfg, vel);
    const amps = [];
    const unis = [];
    let sum = 0;
    for (let n = 1; n <= count; n++) {
      const a = cfg.mode === 'string'
        ? Math.pow(n, -rolloff) * Math.pow(bright, n - 1)
        : (cfg.amps[Math.min(n - 1, cfg.amps.length - 1)] || 0) * Math.pow(bright, n - 1);
      const u = cfg.unisons === false ? 1 : unisonCount(n, midi, cfg);
      amps.push(a);
      unis.push(u);
      // Normalise across *oscillators*, not across partials: a note with three
      // strings on every partial must not be three times louder than the same
      // note with one.
      sum += a * u;
    }
    if (sum <= 0) sum = 1;

    /* ---- decay law -------------------------------------------------- */
    const t60 = fundamentalT60(f0, vel, cfg);
    const attack = Math.max(0.0012, cfg.attack * (1.4 - 0.6 * vel));

    /* ---- per-voice buses ------------------------------------------- */
    const vca = v.track(ctx.createGain());
    vca.gain.value = 1;
    v.vca = vca;

    const det = v.track(ctx.createGain());
    det.gain.value = params.detune;
    v.det = det;

    let tone = null;
    let lastFc = 12000;
    if (cfg.tone) {
      tone = v.track(ctx.createBiquadFilter());
      tone.type = 'lowpass';
      lastFc = clamp(cfg.tone * (0.40 + 0.95 * Math.pow(vel, 0.8)) * (1 + (midi - 60) * cfg.toneReg),
        350, Math.min(18000, sr * 0.46));
      tone.frequency.setValueAtTime(lastFc, when);
      if (cfg.toneClose < 1) {
        // How fast the top rolls off as the note ages. The default tracks the
        // note's own decay (t60 * 0.7), which for a grand is over ten seconds --
        // far longer than a piano takes to lose its brightness, and another way
        // the voice stayed bright for the whole note.
        const closeSec = cfg.toneCloseSec != null ? cfg.toneCloseSec : t60 * 0.7;
        tone.frequency.linearRampToValueAtTime(Math.max(350, lastFc * cfg.toneClose), when + closeSec);
      }
      tone.Q.value = cfg.toneQ;
      tone.connect(vca);
    }
    const sink = tone || vca;

    let trem = null;
    if (cfg.tremolo) {
      trem = v.track(ctx.createGain());
      trem.gain.value = 1;
      const depth = v.track(ctx.createGain());
      depth.gain.value = cfg.tremolo * clamp(0.35 + vel, 0, 1.4);
      const lfo = kit.sharedLFO(cfg.tremoloRate);
      lfo.connect(depth);
      depth.connect(trem.gain);
      sink.connect(trem);
      trem.connect(kit.bus);
    } else {
      sink.connect(trem || kit.bus);
    }

    /* ---- partials ---------------------------------------------------- */
    const spread = params.spread * cfg.spread;
    let longest = 0;
    const seed = midi * 131 + ((spec.seed || 0) & 1023);

    for (let n = 1; n <= count; n++) {
      const ratio = cfg.mode === 'string'
        ? n * Math.sqrt(1 + B * n * n)
        : cfg.ratios[Math.min(n - 1, cfg.ratios.length - 1)];
      let f = f0 * ratio;
      if (cfg.pitchDrop && n === 1) f *= 1 + cfg.pitchDrop;
      if (f > sr * 0.47) break;

      const a = (amps[n - 1] * unis[n - 1]) / sum;
      const t60n = t60 * (cfg.mode === 'string'
        ? Math.pow(1 + cfg.dPartial * (n - 1), -cfg.dPow)
        : (cfg.decayRatios[Math.min(n - 1, cfg.decayRatios.length - 1)] || 0.08));
      if (t60n > longest) longest = t60n;

      const pg = v.track(ctx.createGain());
      envHit(pg.gain, when, a * amp, attack, t60n);

      const un = unis[n - 1];
      for (let u = 0; u < un; u++) {
        // Symmetric spread about the true pitch: the sum of the choir beats
        // around the correct note instead of sounding flat.
        const jitter = (hash01(seed, n, u) - 0.5) * 0.7;
        const cents = un === 1 ? jitter : (u / (un - 1) * 2 - 1) * spread + jitter;
        const o = v.osc(f, 'sine');
        // A struck string's tension jumps as the hammer rebounds, so the pitch
        // settles a few cents flat over the first few tens of milliseconds.
        if (cfg.glideCents && cfg.glide) {
          o.detune.setValueAtTime(cents + cfg.glideCents, when);
          o.detune.linearRampToValueAtTime(cents, when + cfg.glide);
        } else {
          o.detune.value = cents;
        }
        det.connect(o.detune);
        o.connect(pg);
        o.start(when);
      }
      pg.connect(sink);
    }

    /* ---- strike transient ------------------------------------------- */
    if (cfg.strike > 0) {
      const nsrc = v.noise(cfg.strikeKind);
      const bp = v.track(ctx.createBiquadFilter());
      bp.type = 'bandpass';
      const fc = clamp(cfg.strikeLo + cfg.strikeHi * Math.pow(vel, 1.25) * (1 + (midi - 60) * 0.008),
        180, Math.min(14000, sr * 0.45));
      bp.frequency.value = fc;
      bp.Q.value = cfg.strikeQ;
      const ng = v.track(ctx.createGain());
      const nAmp = cfg.strike * Math.pow(vel, 1.4) * amp * cfg.strikeGain * (0.5 + 0.7 * params.noise);
      const dur = Math.max(0.004, cfg.strikeDur * (1.25 - 0.55 * vel));
      envHit(ng.gain, when, nAmp, 0.0012, dur);
      nsrc.connect(bp).connect(ng).connect(sink);
      const off = hash01(seed, 7, 1) * Math.max(0, noiseKit(ctx).dur - dur - 0.05);
      nsrc.start(when, Math.max(0, off));
      nsrc.stop(when + dur * 3 + 0.02);
    }

    v.freeAt = when + attack + longest * 2 + 0.05;
    for (const o of v.oscs) o.stop(v.freeAt);
  };

  v.release = function (t) {
    if (!v.started || v.damped) return;
    closeVoice(v, t, cfg.release);
  };

  return v;
}

/** Inharmonicity of a piano string. Short, stiff, thick strings beat far more. */
function inharmonicity(midi, cfg) {
  return clamp(cfg.B0 * Math.pow(2, (48 - midi) / cfg.BSlope), cfg.BMin, cfg.BMax);
}

/** T60 of the fundamental, in seconds, versus pitch and velocity. */
function fundamentalT60(f0, vel, cfg) {
  const t = cfg.t60 * Math.pow(261.626 / f0, cfg.t60Slope) * (1 + cfg.t60Vel * vel);
  return clamp(t, cfg.t60Min, cfg.t60Max);
}

/** Overall note amplitude — soft notes are quieter *and* the range is wide. */
function noteAmp(cfg, vel) {
  return cfg.level * (cfg.ampMin + (1 - cfg.ampMin) * Math.pow(vel, cfg.ampExp));
}

/**
 * How many strings in the unison choir. A real grand has one string in the
 * bottom octave, two above it, three across the middle, and one or two again at
 * the top. Only the lowest partials get the full choir — the upper ones cost
 * nodes and contribute far less to the beating you actually hear.
 */
function unisonCount(n, midi, cfg) {
  const base = midi < cfg.u1 ? 1 : midi < cfg.u2 ? 2 : midi < cfg.u3 ? 3 : midi < cfg.u4 ? 2 : 1;
  const w = n <= 3 ? 1 : n <= 6 ? 0.62 : 0.3;
  return clamp(Math.round(base * w), 1, 3);
}

/* ================================================================= FM voice */

/** Rhodes-style electric piano: a struck tine whose FM index collapses into a
 *  bell, plus the bark and the slow pickup-field tremolo. */
function createFmVoice(kit, cfg) {
  const v = initVoice(kit);
  const ctx = kit.ctx;
  const sr = ctx.sampleRate;

  v.start = function (spec) {
    if (v.started) { v.drop(); kit.stats.voices = Math.max(0, kit.stats.voices - 1); }
    const { midi, velocity, when } = spec;
    const params = spec.params;
    const f = mtof(midi);
    const vel = clamp(velocity, 0.01, 1);
    const amp = noteAmp(cfg, vel);

    v.midi = midi; v.startTime = when; v.started = true; v.damped = false; v.sustained = false;
    v.releaseAt = Infinity;

    const vca = v.track(ctx.createGain());
    vca.gain.value = 1;
    v.vca = vca;

    const det = v.track(ctx.createGain());
    det.gain.value = params.detune;
    v.det = det;

    const tone = v.track(ctx.createBiquadFilter());
    tone.type = 'lowpass';
    const fc = clamp(cfg.tone * (0.34 + 0.9 * Math.pow(vel, 0.7)) * (1 + (midi - 60) * 0.008), 400, sr * 0.46);
    tone.frequency.setValueAtTime(fc, when);
    tone.frequency.linearRampToValueAtTime(Math.max(300, fc * 0.22), when + cfg.t60 * 0.55);
    tone.Q.value = cfg.toneQ;
    tone.connect(vca);
    vca.connect(kit.bus);

    // Tine: sine carrier, sine modulator whose ratio collapses 14:1 → 1:1 as
    // the strike energy leaves the metal.
    const car = v.osc(f, 'sine');
    const carG = v.track(ctx.createGain());
    envHit(carG.gain, when, amp, 0.0015, cfg.t60);
    car.connect(carG).connect(tone);
    det.connect(car.detune);

    const mod = v.osc(f * cfg.ratio, 'sine');
    const idx = v.track(ctx.createGain());
    idx.gain.setValueAtTime(f * cfg.index * (0.12 + vel * 2.2), when);
    idx.gain.exponentialRampToValueAtTime(Math.max(1, f * 0.05), when + cfg.indexDecay * (0.6 + vel));
    mod.connect(idx).connect(car.frequency);
    mod.frequency.setValueAtTime(f * cfg.ratio, when);
    mod.frequency.exponentialRampToValueAtTime(f, when + cfg.ratioSettle);

    // The bell the tine rings against — two quiet, fast partials.
    for (let b = 0; b < cfg.bell.length; b++) {
      const ratio = cfg.bell[b][0], a = cfg.bell[b][1], d = cfg.bell[b][2];
      const o = v.osc(f * ratio, 'sine');
      o.detune.value = (hash01(midi, b, 3) - 0.5) * 2;
      const g = v.track(ctx.createGain());
      envHit(g.gain, when, amp * a * (0.4 + 0.7 * vel), 0.001, d);
      o.connect(g).connect(tone);
      det.connect(o.detune);
    }

    // Tine click.
    const nsrc = v.noise('white');
    const bp = v.track(ctx.createBiquadFilter());
    bp.type = 'bandpass';
    bp.frequency.value = clamp(2200 + 2600 * vel, 400, sr * 0.45);
    bp.Q.value = 0.8;
    const ng = v.track(ctx.createGain());
    envHit(ng.gain, when, amp * cfg.strike * Math.pow(vel, 1.5) * 3.2, 0.001, cfg.strikeDur);
    nsrc.connect(bp).connect(ng).connect(tone);
    nsrc.start(when, hash01(midi, 11, 5) * Math.max(0, noiseKit(ctx).dur - 0.3));
    nsrc.stop(when + cfg.strikeDur * 3 + 0.02);

    // Pickup-field tremolo, deeper the harder you hit it.
    if (cfg.tremolo > 0) {
      const trem = v.track(ctx.createGain());
      trem.gain.value = 1;
      const depth = v.track(ctx.createGain());
      depth.gain.value = cfg.tremolo * Math.pow(vel, 1.2);
      kit.sharedLFO(cfg.tremoloRate).connect(depth);
      depth.connect(trem.gain);
      tone.disconnect();
      tone.connect(trem);
      trem.connect(vca);
    }

    v.freeAt = when + cfg.t60 * 2 + 0.1;
    for (const o of v.oscs) o.start(when), o.stop(v.freeAt);
  };

  v.release = function (t) {
    if (!v.started || v.damped) return;
    closeVoice(v, t, cfg.release);
  };
  return v;
}

/* ============================================================== tonal voice */

/**
 * Everything with a sustained or breathy tone: bowed strings, flute, clarinet,
 * sax, choir (parallel formant filters), pipe organ, pad and lead. One voice,
 * configured, because the node budget is what makes that worthwhile.
 */
function createTonalVoice(kit, cfg) {
  const v = initVoice(kit);
  const ctx = kit.ctx;
  const sr = ctx.sampleRate;

  v.start = function (spec) {
    if (v.started) { v.drop(); kit.stats.voices = Math.max(0, kit.stats.voices - 1); }
    const { midi, velocity, when } = spec;
    const params = spec.params;
    const f = mtof(midi);
    const vel = clamp(velocity, 0.01, 1);

    v.midi = midi; v.startTime = when; v.started = true; v.damped = false; v.sustained = false;

    const amp = noteAmp(cfg, vel) * (1 + (midi - 60) * (cfg.ampReg || 0));
    const attack = Math.max(0.004, cfg.attack * (1.3 - 0.5 * vel));
    // The engine is not required to send note-offs, so a sustained voice has a
    // fail-safe: it lets go a little after the written duration anyway.
    const tRel = when + Math.max(0.02, (spec.duration || 0)) + (cfg.grace || 0.4);
    v.releaseAt = tRel;

    const vca = v.track(ctx.createGain());
    v.vca = vca;
    envHold(vca.gain, when, amp, attack, tRel, cfg.release);
    v.hold = amp;              // level held between attack and release
    v.attackEnd = when + attack;
    vca.connect(kit.bus);

    const det = v.track(ctx.createGain());
    det.gain.value = params.detune;
    v.det = det;

    const sum = v.track(ctx.createGain());
    sum.gain.value = 1;
    const wav = kit.tiltWave(cfg, vel);

    const oscs = [];
    const spread = (cfg.detuneSpread || 0) * (1 + params.detune * 0.1);
    for (let i = 0; i < cfg.voices; i++) {
      const o = v.osc(f, null, wav);
      const cents = cfg.voices === 1 ? 0 : (i / (cfg.voices - 1) * 2 - 1) * spread
        + (hash01(midi, i, 17) - 0.5) * 1.6;
      if (cfg.scoop) {
        // Reed and brass entries arrive from *below* and settle up to pitch.
        o.detune.setValueAtTime(cents - cfg.scoop, when);
        o.detune.linearRampToValueAtTime(cents, when + cfg.scoopTime);
      } else if (cfg.scoop < 0) {
        o.detune.setValueAtTime(cents - cfg.scoop, when);
        o.detune.linearRampToValueAtTime(cents, when + Math.abs(cfg.scoop) * 0.5);
      } else {
        o.detune.value = cents;
      }
      det.connect(o.detune);
      o.connect(sum);
      o.start(when);
      oscs.push(o);
    }

    // Optional shaping filter (the lead's sweep, the sax's opening, the choir's
    // anti-harshness ceiling). Its envelope is what makes those instruments
    // sound "played" rather than "generated".
    let tone = null;
    if (cfg.tone) {
      tone = v.track(ctx.createBiquadFilter());
      tone.type = cfg.toneType || 'lowpass';
      tone.Q.value = cfg.toneQ;
      const f0 = clamp(cfg.tone * (cfg.toneVel ? (0.3 + 1.1 * Math.pow(vel, 0.8)) : 1)
        * (1 + (midi - 60) * (cfg.toneReg || 0)), 60, Math.min(19000, sr * 0.46));
      tone.frequency.setValueAtTime(Math.min(f0, sr * 0.46), when);
      if (cfg.toneSweep) {
        const up = clamp(f0 * cfg.toneSweep * (0.6 + 0.8 * vel), 60, sr * 0.46);
        tone.frequency.exponentialRampToValueAtTime(Math.max(80, up), when + Math.min(cfg.sweepTime, attack * 1.6 + 0.05));
        tone.frequency.exponentialRampToValueAtTime(Math.max(80, f0), when + cfg.sweepTime + cfg.sustainHold);
      } else if (cfg.toneVel) {
        tone.frequency.linearRampToValueAtTime(clamp(f0 * 0.75, 60, sr * 0.46), when + tRel + cfg.release);
      }
      sum.connect(tone);
      tone.connect(vca);
    } else {
      sum.connect(vca);
    }

    // Parallel formant bank — the difference between "choir" and "saw".
    if (cfg.formants) {
      for (let i = 0; i < cfg.formants.length; i++) {
        const [ff, q, a] = cfg.formants[i];
        const bp = v.track(ctx.createBiquadFilter());
        bp.type = 'bandpass';
        bp.frequency.value = ff * (1 + (midi - 60) * 0.004);
        bp.Q.value = q;
        const g = v.track(ctx.createGain());
        // Louder singing opens the upper formants — the reason a choir crescendos
        // gets brighter rather than merely louder.
        g.gain.value = a * (0.55 + 0.45 * vel) * (1 + i * 0.22 * vel);
        sum.connect(bp).connect(g).connect(vca);
      }
    }

    // Breath / bow / chiff.
    if (cfg.breath > 0) {
      const nsrc = v.noise(cfg.breathKind || 'pink');
      const bp = v.track(ctx.createBiquadFilter());
      bp.type = 'bandpass';
      bp.frequency.value = clamp(cfg.breathLo + cfg.breathHi * Math.pow(vel, 1.2), 200, sr * 0.45);
      bp.Q.value = cfg.breathQ;
      const ng = v.track(ctx.createGain());
      const bAmp = amp * cfg.breath * (0.25 + 0.95 * Math.pow(vel, 1.3)) * (0.4 + 0.7 * params.noise);
      const g = ng.gain;
      g.setValueAtTime(0, when);
      g.linearRampToValueAtTime(bAmp, when + Math.min(attack, cfg.breathAttack || attack));
      g.setValueAtTime(bAmp, Math.max(when + attack, when + (cfg.breathHold || 0)));
      g.exponentialRampToValueAtTime(Math.max(1e-6, bAmp * 1e-3), tRel + cfg.release);
      g.linearRampToValueAtTime(0, tRel + cfg.release * 1.15);
      nsrc.connect(bp).connect(ng);
      ng.connect(cfg.breathToTone && tone ? tone : vca);
      nsrc.start(when, hash01(midi, 23, 9) * Math.max(0, noiseKit(ctx).dur - 1.0));
      nsrc.stop(tRel + cfg.release * 1.3);
    }

    // Vibrato with a realistic onset delay — nothing sounds more synthetic
    // than vibrato that is already at full depth on the first sample.
    if (cfg.vibDepth) {
      const lfo = v.osc(cfg.vibRate, 'sine');
      const depth = v.track(ctx.createGain());
      const d = cfg.vibDepth * clamp(0.3 + vel, 0, 1.5) * clamp(params.vibrato, 0, 2);
      depth.gain.setValueAtTime(0, when);
      depth.gain.setValueAtTime(0, when + cfg.vibDelay);
      depth.gain.linearRampToValueAtTime(d, when + cfg.vibDelay + cfg.vibRamp);
      depth.gain.setValueAtTime(d, tRel);
      depth.gain.linearRampToValueAtTime(0, tRel + cfg.release);
      lfo.connect(depth);
      for (const o of oscs) depth.connect(o.detune);
      lfo.start(when);
      lfo.stop(tRel + cfg.release * 1.4);
    }

    v.freeAt = tRel + cfg.release * 1.5 + 0.05;
    for (const o of v.oscs) o.stop(v.freeAt);
      };

  v.release = function (t) {
    if (!v.started || v.damped) return;
    // Ramp from the level the envelope will actually have at t — including
    // part-way through the attack, so a staccato note never clicks up.
    const held = t < v.attackEnd
      ? v.hold * Math.max(0.02, (t - v.startTime) / Math.max(1e-4, v.attackEnd - v.startTime))
      : v.hold;
    fadeOut(v.vca.gain, t, cfg.release, held);
    v.damped = true;
    v.hardStop(t + cfg.release * 1.3);
  };

  return v;
}

/* ============================================================== voice factory */

function makeVoice(kit, cfg) {
  switch (cfg.engine) {
    case 'fm': return createFmVoice(kit, cfg);
    case 'tonal': return createTonalVoice(kit, cfg);
    default: return createAdditiveVoice(kit, cfg);
  }
}

/* ============================================================ string family */

const PIANO_BASE = {
  engine: 'additive',
  mode: 'string',
  ampExp: 1.25, ampMin: 0.05,
  attack: 0.0022, release: 0.075,
  strikeGain: 2.6,
  unisons: true,
  u1: 34, u2: 45, u3: 92, u4: 104,
  glide: 0.045, glideCents: 6,
};

const PIANO = {
  grand: {
    ...PIANO_BASE,
    // Raised from 0.15: a slower, less clicky attack costs peak level, and this
    // must not end up quieter than the voice it replaces or it reads as a volume
    // bug rather than a new sound. 0.235 puts the rendered peak back where the
    // old configuration's was (0.20 against 0.26 measured -- the old peak was
    // flattered by the transient this removed).
    level: 0.235, minPartials: 4, maxPartials: 13,
    // The original series measured 1, 0.45, 0.28, 0.10, 0.09, 0.08 and was
    // already plausible, so this is a nudge to 1, 0.54, 0.36 -- filling in the
    // lower partials a little, not rescuing a cliff.
    rolloff: 0.95, rolloffVel: 0.45,
    brightBase: 0.62, brightVel: 0.62, brightReg: 0.010,
    B0: 3.0e-4, BSlope: 7, BMin: 2.5e-5, BMax: 3.5e-3,
    t60: 12, t60Slope: 0.85, t60Vel: 0.25, t60Min: 0.45, t60Max: 20,
    // T60 of partial n is t60 / n^dPow, because (1 + dPartial*(n-1)) with
    // dPartial=1 is exactly n. At dPartial 0.62 the second partial only decayed
    // 1.6x faster than the fundamental, so the note held its brightness and then
    // gained it -- measured centroid *rose* 56 Hz over two seconds where a
    // struck string falls away. A piano loses its top first, and that darkening
    // is most of what makes it sound like a piano.
    //
    // The exponent is 2.2, not the physical 2.0, because one exponential per
    // partial starts dying the instant it peaks: pushed to 2.8, the upper
    // partials were already 40% down before the note had finished sounding and
    // the attack came out thinner than the problem it was fixing.
    dPartial: 1.0, dPow: 2.2,
    // And the tone filter closes over a second and a half rather than the ten
    // seconds the shared default gave it, so the brightness actually falls while
    // the note is still sounding.
    tone: 9500, toneQ: 0.62, toneReg: 0.012, toneClose: 0.30, toneCloseSec: 1.6,
    spread: 1.0,
    // Felt-hammer range rather than a bright 5.2 kHz scrape.
    strike: 0.5, strikeGain: 1.0, strikeLo: 650, strikeHi: 4200, strikeDur: 0.030, strikeQ: 0.85,
    // A felt hammer takes a few milliseconds to come off the string, not two.
    // At 2.2 ms the note reached full level fast enough to click.
    attack: 0.0045,
  },
  'bright-piano': {
    ...PIANO_BASE,
    level: 0.17, minPartials: 5, maxPartials: 12,
    rolloff: 1.12, rolloffVel: 0.44,
    brightBase: 0.58, brightVel: 0.52, brightReg: 0.012,
    B0: 1.6e-4, BSlope: 7, BMin: 2.0e-5, BMax: 2.0e-3,
    t60: 8.5, t60Slope: 0.85, t60Vel: 0.25, t60Min: 0.4, t60Max: 14,
    dPartial: 0.70, dPow: 1.05,
    tone: 13000, toneQ: 0.7, toneReg: 0.014, toneClose: 0.7,
    spread: 1.1,
    strike: 1.25, strikeGain: 3.4, strikeLo: 900, strikeHi: 6800, strikeDur: 0.024, strikeQ: 0.8,
    glide: 0.035, glideCents: 8,
  },
  'felt-piano': {
    ...PIANO_BASE,
    level: 0.10, minPartials: 3, maxPartials: 9,
    rolloff: 1.75, rolloffVel: 0.80,
    brightBase: 0.40, brightVel: 0.62, brightReg: 0.010,
    B0: 2.6e-4, BSlope: 7, BMin: 3.0e-5, BMax: 3.0e-3,
    t60: 6.5, t60Slope: 0.85, t60Vel: 0.2, t60Min: 0.35, t60Max: 11,
    dPartial: 0.85, dPow: 1.1,
    tone: 5200, toneQ: 0.55, toneReg: 0.010, toneClose: 0.7,
    spread: 0.8,
    strike: 0.55, strikeGain: 1.5, strikeLo: 380, strikeHi: 2100, strikeDur: 0.045, strikeQ: 0.7,
    release: 0.05,
    glide: 0.055, glideCents: 4,
  },
  rhodes: {
    engine: 'fm',
    level: 0.16, ampExp: 1.2, ampMin: 0.05, attack: 0.002, release: 0.10,
    ratio: 14, ratioSettle: 0.30, index: 2.2, indexDecay: 0.90,
    bell: [[3.01, 0.13, 0.55], [4.98, 0.05, 0.30]],
    t60: 2.6, tone: 7000, toneQ: 0.8,
    strike: 1.0, strikeDur: 0.010,
    tremolo: 0.10, tremoloRate: 4.6,
  },

  /* plucked strings — same engine, different physics */
  harpsichord: {
    ...PIANO_BASE,
    level: 0.18, minPartials: 5, maxPartials: 16,
    rolloff: 1.00, rolloffVel: 0.42,
    brightBase: 0.72, brightVel: 0.45, brightReg: 0.012,
    B0: 5.0e-4, BSlope: 8, BMin: 5e-5, BMax: 3.0e-3,
    t60: 2.6, t60Slope: 0.75, t60Vel: 0.3, t60Min: 0.3, t60Max: 6,
    dPartial: 1.30, dPow: 1.15,
    tone: 13000, toneQ: 0.7, toneReg: 0.010, toneClose: 0.62,
    spread: 0.5, unisons: false,
    strike: 0.95, strikeGain: 2.8, strikeLo: 1400, strikeHi: 6400, strikeDur: 0.016, strikeQ: 1.1,
    attack: 0.0016, release: 0.06,
    glide: 0.02, glideCents: 10,
  },
  harp: {
    ...PIANO_BASE,
    level: 0.36, minPartials: 4, maxPartials: 12,
    rolloff: 1.30, rolloffVel: 0.45,
    brightBase: 0.58, brightVel: 0.5, brightReg: 0.011,
    B0: 6.0e-4, BSlope: 8, BMin: 8e-5, BMax: 3.0e-3,
    t60: 5.2, t60Slope: 0.72, t60Vel: 0.3, t60Min: 0.5, t60Max: 9,
    dPartial: 0.95, dPow: 1.1,
    tone: 9500, toneQ: 0.7, toneReg: 0.010, toneClose: 0.66,
    spread: 0.7, unisons: false,
    strike: 0.8, strikeGain: 2.0, strikeLo: 500, strikeHi: 3400, strikeDur: 0.030, strikeQ: 0.8,
    attack: 0.004, release: 0.10,
    glide: 0.03, glideCents: 7,
  },
  'nylon-guitar': {
    ...PIANO_BASE,
    level: 0.32, minPartials: 3, maxPartials: 11,
    rolloff: 1.62, rolloffVel: 0.60,
    brightBase: 0.50, brightVel: 0.62, brightReg: 0.010,
    B0: 1.2e-3, BSlope: 8, BMin: 1.2e-4, BMax: 4.0e-3,
    t60: 3.4, t60Slope: 0.70, t60Vel: 0.3, t60Min: 0.35, t60Max: 7,
    dPartial: 1.15, dPow: 1.1,
    tone: 8000, toneQ: 0.75, toneReg: 0.010, toneClose: 0.6,
    spread: 0.5, unisons: false,
    strike: 0.75, strikeGain: 2.2, strikeLo: 320, strikeHi: 2400, strikeDur: 0.024, strikeQ: 0.7,
    attack: 0.0025, release: 0.08,
    glide: 0.03, glideCents: 6,
  },
  'electric-bass': {
    ...PIANO_BASE,
    level: 0.34, minPartials: 2, maxPartials: 8,
    rolloff: 2.35, rolloffVel: 1.10,
    brightBase: 0.42, brightVel: 0.72, brightReg: 0.008,
    B0: 1.8e-3, BSlope: 8, BMin: 2.5e-4, BMax: 6.0e-3,
    t60: 2.4, t60Slope: 0.55, t60Vel: 0.35, t60Min: 0.3, t60Max: 5,
    dPartial: 1.6, dPow: 1.2,
    tone: 6800, toneQ: 0.8, toneReg: 0.008, toneClose: 0.55,
    spread: 0.4, unisons: false,
    strike: 0.9, strikeGain: 2.6, strikeLo: 420, strikeHi: 2000, strikeDur: 0.018, strikeQ: 0.8,
    attack: 0.0018, release: 0.07,
    glide: 0.025, glideCents: 8,
  },

  /* struck bars and membranes */
  celesta: {
    ...PIANO_BASE,
    mode: 'ratios', ratios: [1, 2.02, 3.04, 4.19, 5.42, 6.83], amps: [1, 0.42, 0.20, 0.10, 0.05, 0.025],
    decayRatios: [1, 0.45, 0.28, 0.16, 0.09, 0.05],
    level: 0.30, minPartials: 4, maxPartials: 6, unisons: false,
    rolloff: 1, rolloffVel: 0, brightBase: 0.60, brightVel: 0.80, brightReg: 0.012,
    t60: 1.5, t60Slope: 0.55, t60Vel: 0.3, t60Min: 0.4, t60Max: 3,
    tone: 12000, toneQ: 0.6, toneReg: 0.010, toneClose: 0.7, spread: 0.4,
    strike: 0.9, strikeGain: 2.4, strikeLo: 900, strikeHi: 4200, strikeDur: 0.022, strikeQ: 0.9,
    attack: 0.0025, release: 0.10,
  },
  glockenspiel: {
    ...PIANO_BASE,
    mode: 'ratios', ratios: [1, 2.76, 5.40, 8.93, 13.3], amps: [1, 0.44, 0.20, 0.09, 0.035],
    decayRatios: [1, 0.52, 0.28, 0.14, 0.07],
    level: 0.15, minPartials: 4, maxPartials: 5, unisons: false,
    rolloff: 1, rolloffVel: 0, brightBase: 0.72, brightVel: 0.80, brightReg: 0.012,
    t60: 1.7, t60Slope: 0.5, t60Vel: 0.25, t60Min: 0.4, t60Max: 3.2,
    tone: 16000, toneQ: 0.6, toneReg: 0.010, toneClose: 0.72, spread: 0.4,
    strike: 1.3, strikeGain: 3.2, strikeLo: 1600, strikeHi: 8000, strikeDur: 0.012, strikeQ: 1.2,
    attack: 0.0015, release: 0.09,
  },
  'music-box': {
    ...PIANO_BASE,
    mode: 'ratios', ratios: [1, 3.92, 9.21, 15.1], amps: [1, 0.32, 0.12, 0.04],
    decayRatios: [1, 0.36, 0.16, 0.06],
    level: 0.26, minPartials: 3, maxPartials: 4, unisons: false,
    rolloff: 1, rolloffVel: 0, brightBase: 1.10, brightVel: 0.90, brightReg: 0.014,
    t60: 0.85, t60Slope: 0.45, t60Vel: 0.25, t60Min: 0.25, t60Max: 2,
    tone: 18000, toneQ: 0.6, toneReg: 0.012, toneClose: 0.75, spread: 0.3,
    strike: 1.1, strikeGain: 2.6, strikeLo: 2200, strikeHi: 9000, strikeDur: 0.008, strikeQ: 1.4,
    attack: 0.0012, release: 0.08,
  },
  marimba: {
    ...PIANO_BASE,
    mode: 'ratios', ratios: [1, 3.99, 9.20, 16.0], amps: [1, 0.30, 0.10, 0.028],
    decayRatios: [1, 0.30, 0.11, 0.045],
    level: 0.32, minPartials: 3, maxPartials: 4, unisons: false,
    rolloff: 1, rolloffVel: 0, brightBase: 0.52, brightVel: 0.75, brightReg: 0.010,
    t60: 2.0, t60Slope: 0.5, t60Vel: 0.3, t60Min: 0.4, t60Max: 3.4,
    tone: 9000, toneQ: 0.6, toneReg: 0.010, toneClose: 0.68, spread: 0.4,
    strike: 0.85, strikeGain: 2.0, strikeLo: 400, strikeHi: 2600, strikeDur: 0.014, strikeQ: 0.9,
    attack: 0.002, release: 0.09,
  },
  vibraphone: {
    ...PIANO_BASE,
    mode: 'ratios', ratios: [1, 4.02, 10.0, 16.2], amps: [1, 0.26, 0.065, 0.018],
    decayRatios: [1, 0.42, 0.14, 0.05],
    level: 0.32, minPartials: 3, maxPartials: 4, unisons: false,
    rolloff: 1, rolloffVel: 0, brightBase: 0.60, brightVel: 0.70, brightReg: 0.010,
    t60: 3.8, t60Slope: 0.5, t60Vel: 0.3, t60Min: 0.6, t60Max: 6,
    tone: 11000, toneQ: 0.6, toneReg: 0.010, toneClose: 0.7, spread: 0.4,
    strike: 0.7, strikeGain: 1.7, strikeLo: 350, strikeHi: 2200, strikeDur: 0.014, strikeQ: 0.9,
    attack: 0.0022, release: 0.10,
    tremolo: 0.11, tremoloRate: 5.0,
  },
  timpani: {
    ...PIANO_BASE,
    mode: 'ratios',
    ratios: [1, 1.593, 2.135, 2.295, 2.653, 2.917, 3.598, 4.51],
    amps: [1, 0.62, 0.42, 0.22, 0.14, 0.09, 0.05, 0.03],
    decayRatios: [1, 0.55, 0.38, 0.22, 0.16, 0.11, 0.07, 0.04],
    level: 0.34, minPartials: 4, maxPartials: 8, unisons: false,
    rolloff: 1, rolloffVel: 0, brightBase: 0.55, brightVel: 0.75, brightReg: 0.008,
    t60: 1.9, t60Slope: 0.45, t60Vel: 0.35, t60Min: 0.5, t60Max: 3.2,
    tone: 6000, toneQ: 0.7, toneReg: 0.006, toneClose: 0.6, spread: 0.5,
    strike: 1.2, strikeGain: 3.0, strikeLo: 180, strikeHi: 1800, strikeDur: 0.030, strikeQ: 0.7,
    attack: 0.0018, release: 0.10,
    pitchDrop: 0.016,
  },
};

/* ============================================================ tonal family */

const TONAL = {
  strings: {
    engine: 'tonal', spectrum: SPECTRA.bowed(24), voices: 2, detuneSpread: 7,
    level: 0.26, ampExp: 1.1, ampMin: 0.08, ampReg: -0.001,
    attack: 0.085, release: 0.22, grace: 0.6,
    tone: 5200, toneType: 'lowpass', toneQ: 0.6, toneVel: true, toneReg: 0.008, brightTilt: 0.30,
    breath: 0.14, breathKind: 'pink', breathLo: 1400, breathHi: 4200, breathQ: 0.8,
    breathHold: 0.12, breathAttack: 0.06,
    vibDepth: 7, vibRate: 5.1, vibDelay: 0.26, vibRamp: 0.34,
  },
  choir: {
    engine: 'tonal', spectrum: SPECTRA.bowed(20), voices: 2, detuneSpread: 9,
    level: 0.24, ampExp: 1.1, ampMin: 0.10,
    attack: 0.16, release: 0.40, grace: 0.8,
    tone: 5200, toneType: 'lowpass', toneQ: 0.5, toneVel: false, brightTilt: 0.28,
    formants: [[730, 7, 1.0], [1090, 9, 0.55], [2440, 11, 0.22]],
    breath: 0.10, breathKind: 'pink', breathLo: 900, breathHi: 3200, breathQ: 0.7,
    breathHold: 0.2, breathAttack: 0.12,
    vibDepth: 10, vibRate: 4.8, vibDelay: 0.34, vibRamp: 0.45,
  },
  'warm-pad': {
    engine: 'tonal', spectrum: SPECTRA.pad(20), voices: 3, detuneSpread: 11,
    level: 0.22, ampExp: 1.0, ampMin: 0.12,
    attack: 0.42, release: 0.55, grace: 1.2,
    tone: 3400, toneType: 'lowpass', toneQ: 0.9, toneVel: true, toneReg: 0.006, brightTilt: 0.22,
    vibDepth: 3, vibRate: 0.32, vibDelay: 0.5, vibRamp: 1.2,
  },
  'pipe-organ': {
    engine: 'tonal', spectrum: [1, 0.5, 0.3, 0.22, 0.12, 0.06], voices: 1, detuneSpread: 0,
    level: 0.22, ampExp: 0.8, ampMin: 0.15,
    attack: 0.035, release: 0.012, grace: 0.3,
    tone: 12000, toneType: 'lowpass', toneQ: 0.4, toneVel: false,
    breath: 0.70, breathKind: 'white', breathLo: 1500, breathHi: 5200, breathQ: 0.6,
    breathHold: 0.20, breathAttack: 0.025,
  },
  flute: {
    engine: 'tonal', spectrum: SPECTRA.flute(16), voices: 1, detuneSpread: 0,
    level: 0.26, ampExp: 1.2, ampMin: 0.07,
    attack: 0.045, release: 0.11, grace: 0.4,
    tone: 9000, toneType: 'lowpass', toneQ: 0.5, toneVel: true, toneReg: 0.010, brightTilt: 0.50,
    breath: 0.16, breathKind: 'pink', breathLo: 1800, breathHi: 4200, breathQ: 0.7,
    breathHold: 0.05, breathAttack: 0.03,
    vibDepth: 9, vibRate: 5.4, vibDelay: 0.32, vibRamp: 0.4,
  },
  clarinet: {
    engine: 'tonal', spectrum: SPECTRA.clarinet(16), voices: 1, detuneSpread: 0,
    level: 0.26, ampExp: 1.2, ampMin: 0.07,
    attack: 0.028, release: 0.10, grace: 0.4,
    tone: 7000, toneType: 'lowpass', toneQ: 0.6, toneVel: true, toneReg: 0.010, brightTilt: 0.45,
    scoop: 42, scoopTime: 0.030,
    breath: 0.10, breathKind: 'white', breathLo: 900, breathHi: 2600, breathQ: 0.7,
    breathHold: 0.03, breathAttack: 0.015,
  },
  'alto-sax': {
    engine: 'tonal', spectrum: SPECTRA.sax(20), voices: 1, detuneSpread: 0,
    level: 0.25, ampExp: 1.15, ampMin: 0.08,
    attack: 0.042, release: 0.14, grace: 0.5,
    tone: 4200, toneType: 'lowpass', toneQ: 0.8, toneVel: true, toneSweep: 3.4, brightTilt: 0.45,
    toneReg: 0.010, sweepTime: 0.16, sustainHold: 0.5,
    scoop: -55, scoopTime: 0.05,
    breath: 0.20, breathKind: 'pink', breathLo: 1100, breathHi: 3800, breathQ: 0.6,
    breathHold: 0.06, breathAttack: 0.03,
    vibDepth: 13, vibRate: 5.6, vibDelay: 0.22, vibRamp: 0.3,
  },
  'analog-lead': {
    engine: 'tonal', spectrum: SPECTRA.saw(24), voices: 1, detuneSpread: 0,
    level: 0.22, ampExp: 1.0, ampMin: 0.08,
    attack: 0.010, release: 0.10, grace: 0.4,
    tone: 2400, toneType: 'lowpass', toneQ: 7, toneVel: false, brightTilt: 0.30,
    toneSweep: 5.5, sweepTime: 0.10, sustainHold: 0.35,
    vibDepth: 6, vibRate: 5.8, vibDelay: 0.25, vibRamp: 0.3,
  },
};

const TUNING = Object.assign({}, PIANO, TONAL);

/* ================================================================== roster */

const ROSTER = [
  { id: 'grand', name: 'Concert Grand', group: 'Pianos', engine: 'additive', cap: 36,
    description: 'A 9-foot concert grand: three-string unisons, real stiff-string inharmonicity, hammer transients and a soundboard body.',
    defaults: { level: 0.9, brightness: 0.78, detune: 0, vibrato: 0, spread: 1, noise: 0.8 } },
  { id: 'bright-piano', name: 'Bright Piano', group: 'Pianos', engine: 'additive', cap: 32,
    description: 'A smaller, harder-strung piano — harder hammer, brighter partials and a tighter decay.',
    defaults: { level: 0.9, brightness: 0.86, detune: 0, vibrato: 0, spread: 1.1, noise: 0.9 } },
  { id: 'felt-piano', name: 'Felt Piano', group: 'Pianos', engine: 'additive', cap: 32,
    description: 'Practice upright under the felt: muffled hammer, dark partials, quick dampers, no brilliance.',
    defaults: { level: 0.9, brightness: 0.42, detune: 0, vibrato: 0, spread: 0.8, noise: 0.4 } },
  { id: 'rhodes', name: 'Rhodes Electric Piano', group: 'Pianos', engine: 'fm', cap: 28,
    description: 'FM tine electric piano — the 14:1 bell collapsing into a sine, with bark and pickup-field tremolo.',
    defaults: { level: 0.9, brightness: 0.75, detune: 0, vibrato: 0, spread: 0.4, noise: 0.8 } },

  { id: 'celesta', name: 'Celesta', group: 'Bells & Mallet', engine: 'additive', cap: 16,
    description: 'A steel plate struck over a wooden box: soft, sweet and bell-like.',
    defaults: { level: 0.9, brightness: 0.8, detune: 0, vibrato: 0, spread: 0.4, noise: 0.6 } },
  { id: 'glockenspiel', name: 'Glockenspiel', group: 'Bells & Mallet', engine: 'additive', cap: 16,
    description: 'High steel bars, hard bright strike, short singing decay.',
    defaults: { level: 0.9, brightness: 0.92, detune: 0, vibrato: 0, spread: 0.4, noise: 1.0 } },
  { id: 'music-box', name: 'Music Box', group: 'Bells & Mallet', engine: 'additive', cap: 16,
    description: 'A tiny pinned steel comb: extremely bright partials and a fast glittering decay.',
    defaults: { level: 0.85, brightness: 1.0, detune: 0, vibrato: 0, spread: 0.3, noise: 1.0 } },
  { id: 'marimba', name: 'Marimba', group: 'Bells & Mallet', engine: 'additive', cap: 16,
    description: 'Rosewood bars tuned 1 : 4 : 9.2, warm and woody under a soft yarn mallet.',
    defaults: { level: 0.95, brightness: 0.62, detune: 0, vibrato: 0, spread: 0.4, noise: 0.5 } },
  { id: 'vibraphone', name: 'Vibraphone', group: 'Bells & Mallet', engine: 'additive', cap: 16,
    description: 'Aluminium bars at 1 : 4 : 10 with a motor tremolo and a long shimmering tail.',
    defaults: { level: 0.95, brightness: 0.7, detune: 0, vibrato: 0, spread: 0.4, noise: 0.45 } },
  { id: 'timpani', name: 'Timpani', group: 'Bells & Mallet', engine: 'additive', cap: 12,
    description: 'Pitched membrane with inharmonic modes, a fast pitch settle and a copper-shell body.',
    defaults: { level: 0.95, brightness: 0.6, detune: 0, vibrato: 0, spread: 0.5, noise: 0.9 } },

  { id: 'harpsichord', name: 'Harpsichord', group: 'Plucked', engine: 'additive', cap: 20,
    description: 'Quill-plucked wire strings: bright quill rasp and a fast dry release.',
    defaults: { level: 0.9, brightness: 0.9, detune: 0, vibrato: 0, spread: 0.5, noise: 1.0 } },
  { id: 'harp', name: 'Concert Harp', group: 'Plucked', engine: 'additive', cap: 20,
    description: 'Splayed strings over a curved soundboard — round attack, long warm ring.',
    defaults: { level: 0.95, brightness: 0.7, detune: 0, vibrato: 0, spread: 0.7, noise: 0.5 } },
  { id: 'nylon-guitar', name: 'Nylon-String Guitar', group: 'Plucked', engine: 'additive', cap: 20,
    description: 'Fingerpicked nylon with a soft attack and a woody body resonance.',
    defaults: { level: 0.95, brightness: 0.66, detune: 0, vibrato: 0, spread: 0.5, noise: 0.5 } },
  { id: 'electric-bass', name: 'Electric Bass', group: 'Plucked', engine: 'additive', cap: 12,
    description: 'Thick round-wound string into a pickup: near-sinusoidal, fast pick, solid low end.',
    defaults: { level: 0.95, brightness: 0.6, detune: 0, vibrato: 0, spread: 0.4, noise: 0.7 } },

  { id: 'strings', name: 'String Ensemble', group: 'Bowed & Sustained', engine: 'tonal', cap: 24,
    description: 'A section of bowed strings: slow attacks, bow noise, delayed vibrato.',
    defaults: { level: 0.9, brightness: 0.72, detune: 0, vibrato: 0.85, spread: 1, noise: 0.7 } },
  { id: 'choir', name: 'Choir (aah)', group: 'Bowed & Sustained', engine: 'tonal', cap: 20,
    description: 'Formant-filtered voices singing an open aah, with breath and slow vibrato.',
    defaults: { level: 0.9, brightness: 0.75, detune: 0, vibrato: 0.9, spread: 1, noise: 0.6 } },
  { id: 'warm-pad', name: 'Warm Analog Pad', group: 'Bowed & Sustained', engine: 'tonal', cap: 16,
    description: 'Three detuned saws through a slowly breathing, ladder-filter-style lowpass.',
    defaults: { level: 0.85, brightness: 0.6, detune: 0, vibrato: 0.5, spread: 1, noise: 0.5 } },
  { id: 'pipe-organ', name: 'Pipe Organ', group: 'Bowed & Sustained', engine: 'tonal', cap: 16,
    description: 'A harmonic drawbar mixture with a soft chiff and no release tail.',
    defaults: { level: 0.9, brightness: 0.8, detune: 0, vibrato: 0, spread: 0.3, noise: 0.5 } },

  { id: 'flute', name: 'Flute', group: 'Brass & Wind', engine: 'tonal', cap: 12,
    description: 'Mostly-fundamental tone with breath noise and a late, gentle vibrato.',
    defaults: { level: 0.9, brightness: 0.8, detune: 0, vibrato: 0.8, spread: 0.5, noise: 0.8 } },
  { id: 'clarinet', name: 'Clarinet', group: 'Brass & Wind', engine: 'tonal', cap: 12,
    description: 'Odd-harmonic stopped pipe with a reedy attack and a scooped entry.',
    defaults: { level: 0.9, brightness: 0.75, detune: 0, vibrato: 0.7, spread: 0.5, noise: 0.7 } },
  { id: 'alto-sax', name: 'Alto Sax', group: 'Brass & Wind', engine: 'tonal', cap: 12,
    description: 'Breathy conical reed with a lowpass that blooms open as you push.',
    defaults: { level: 0.9, brightness: 0.72, detune: 0, vibrato: 0.85, spread: 0.5, noise: 0.9 } },

  { id: 'analog-lead', name: 'Analog Lead', group: 'Synth', engine: 'tonal', cap: 10,
    description: 'Sawtooth through a resonant ladder filter with a fast, musical sweep.',
    defaults: { level: 0.85, brightness: 0.65, detune: 0, vibrato: 0.6, spread: 0.4, noise: 0.4 } },

  /* ------------------------------------------------------------- recorded --- */
  //
  // Real recordings built into pack/ by tools/make-pack.mjs. They sit beside the
  // modelled instruments rather than replacing them: the synthesiser is always
  // available offline, and these need the pack fetched once.
  //
  // Most families are CC0. The FSS steel-string guitar is not: it is GPL-3+ with
  // the sample exception, so it is the one pack here carrying an obligation
  // rather than a courtesy. What each pack owes is recorded once, in the SOURCES
  // table in tools/make-pack.mjs, and flows from there into pack/manifest.json,
  // NOTICE.md and the app's credits line. Do not restate it here.
  //
  // `fallback` is the modelled instrument to use if the pack is not loaded --
  // picking one of these from a file:// page still makes music instead of
  // silence. `pack` is the id in pack/manifest.json.

  /* ---------------------------------------------------------------------- */
  /* FreePats banks, added as recorded instruments.                        */
  /*                                                                       */
  /* These are split across their own picker groups because fifty of them   */
  /* in one list is a wall of names. The banks themselves are described in  */
  /* tools/freepats-banks.mjs, which is also where the licence terms come  */
  /* from -- do not repeat a credit here.                                   */
  /* ---------------------------------------------------------------------- */
  /* --- FreePats: Piano (recorded) --- */
  { id: 'rec-fp-upright', name: 'Upright Piano (recorded)', group: 'Recorded · Piano', engine: 'sampled',
    pack: 'fp-upright', fallback: 'felt-piano', cap: 48,
    description: 'A sampled Upright Piano from the FreePats collection. Struck strings, two hammers per key, no sustain loop — the note decays and stops.' },
  { id: 'rec-fp-honky-tonk', name: 'Honky-Tonk Piano (recorded)', group: 'Recorded · Piano', engine: 'sampled',
    pack: 'fp-honky-tonk', fallback: 'felt-piano', cap: 48,
    description: 'A sampled Honky-Tonk Piano from the FreePats collection.' },

  /* --- FreePats: synthesised, so grouped with the synths --- */
  { id: 'rec-fp-fm-piano-1', name: 'FM Piano I (synthesised)', group: 'Recorded · Synth', engine: 'sampled',
    pack: 'fp-fm-piano-1', fallback: 'rhodes', cap: 48,
    description: 'An FM-synthesised piano from the FreePats collection — generated, not a recording of an instrument.' },
  { id: 'rec-fp-fm-piano-2', name: 'FM Piano II (synthesised)', group: 'Recorded · Synth', engine: 'sampled',
    pack: 'fp-fm-piano-2', fallback: 'rhodes', cap: 48,
    description: 'An FM-synthesised piano from the FreePats collection — generated, not a recording of an instrument.' },

  /* --- FreePats: Organ --- */
  { id: 'rec-fp-church-organ', name: 'Church Organ (recorded)', group: 'Recorded · Organ', engine: 'sampled',
    pack: 'fp-church-organ', fallback: 'pipe-organ', cap: 48,
    description: 'A sampled Church Organ from the FreePats collection.' },
  { id: 'rec-fp-drawbar-organ', name: 'Drawbar Organ (recorded)', group: 'Recorded · Organ', engine: 'sampled',
    pack: 'fp-drawbar-organ', fallback: 'rhodes', cap: 48,
    description: 'A sampled Drawbar Organ from the FreePats collection.' },
  { id: 'rec-fp-percussive-organ', name: 'Percussive Organ (recorded)', group: 'Recorded · Organ', engine: 'sampled',
    pack: 'fp-percussive-organ', fallback: 'warm-pad', cap: 48,
    description: 'A sampled Percussive Organ from the FreePats collection.' },
  { id: 'rec-fp-rock-organ', name: 'Rock Organ (recorded)', group: 'Recorded · Organ', engine: 'sampled',
    pack: 'fp-rock-organ', fallback: 'warm-pad', cap: 48,
    description: 'A sampled Rock Organ from the FreePats collection.' },
  { id: 'rec-fp-accordion', name: 'Button Accordion (recorded)', group: 'Recorded · Organ', engine: 'sampled',
    pack: 'fp-accordion', fallback: 'harpsichord', cap: 48,
    description: 'A sampled Button Accordion from the FreePats collection.' },

  /* --- FreePats: Plucked & Struck --- */
  { id: 'rec-fp-nylon-guitar', name: 'Nylon-String Guitar (recorded)', group: 'Recorded · Plucked & Struck', engine: 'sampled',
    pack: 'fp-nylon-guitar', fallback: 'nylon-guitar', cap: 48,
    description: 'A sampled Nylon-String Guitar from the FreePats collection.' },
  { id: 'rec-fp-steel-guitar', name: 'Steel-String Guitar (recorded)', group: 'Recorded · Plucked & Struck', engine: 'sampled',
    pack: 'fp-steel-guitar', fallback: 'nylon-guitar', cap: 48,
    description: 'A sampled Steel-String Guitar from the FreePats collection.' },
  { id: 'rec-fp-harp', name: 'Concert Harp (recorded)', group: 'Recorded · Plucked & Struck', engine: 'sampled',
    pack: 'fp-harp', fallback: 'harp', cap: 48,
    description: 'A sampled Concert Harp from the FreePats collection.' },
  { id: 'rec-fp-kalimba', name: 'Kalimba (recorded)', group: 'Recorded · Plucked & Struck', engine: 'sampled',
    pack: 'fp-kalimba', fallback: 'music-box', cap: 48,
    description: 'A sampled Kalimba from the FreePats collection.' },
  { id: 'rec-fp-jaw-harp', name: 'Jaw Harp (recorded)', group: 'Recorded · Plucked & Struck', engine: 'sampled',
    pack: 'fp-jaw-harp', fallback: 'music-box', cap: 48,
    description: 'A sampled Jaw Harp from the FreePats collection.' },
  { id: 'rec-fp-hang', name: 'Hang (recorded)', group: 'Recorded · Plucked & Struck', engine: 'sampled',
    pack: 'fp-hang', fallback: 'music-box', cap: 48,
    description: 'A sampled Hang from the FreePats collection.' },
  { id: 'rec-fp-glasses', name: 'Glasses (recorded)', group: 'Recorded · Plucked & Struck', engine: 'sampled',
    pack: 'fp-glasses', fallback: 'music-box', cap: 48,
    description: 'A sampled Glasses from the FreePats collection.' },
  { id: 'rec-fp-ukulele', name: 'Ukulele (recorded)', group: 'Recorded · Plucked & Struck', engine: 'sampled',
    pack: 'fp-ukulele', fallback: 'nylon-guitar', cap: 48,
    description: 'A sampled Ukulele from the FreePats collection.' },
  { id: 'rec-fp-xylophone', name: 'Xylophone (recorded)', group: 'Recorded · Plucked & Struck', engine: 'sampled',
    pack: 'fp-xylophone', fallback: 'marimba', cap: 48,
    description: 'A sampled Xylophone from the FreePats collection.' },
  { id: 'rec-fp-tubular-bells', name: 'Tubular Bells (recorded)', group: 'Recorded · Plucked & Struck', engine: 'sampled',
    pack: 'fp-tubular-bells', fallback: 'glockenspiel', cap: 48,
    description: 'A sampled Tubular Bells from the FreePats collection.' },
  { id: 'rec-fp-timpani', name: 'Timpani (recorded)', group: 'Recorded · Plucked & Struck', engine: 'sampled',
    pack: 'fp-timpani', fallback: 'timpani', cap: 48,
    description: 'A sampled Timpani from the FreePats collection.' },

  /* --- FreePats: Guitar & Bass --- */
  { id: 'rec-fp-eg-clean', name: 'Electric Guitar, Clean (recorded)', group: 'Recorded · Guitar & Bass', engine: 'sampled',
    pack: 'fp-eg-clean', fallback: 'nylon-guitar', cap: 48,
    description: 'A sampled Electric Guitar, Clean from the FreePats collection.' },
  { id: 'rec-fp-eg-jazz', name: 'Electric Guitar, Jazz (recorded)', group: 'Recorded · Guitar & Bass', engine: 'sampled',
    pack: 'fp-eg-jazz', fallback: 'nylon-guitar', cap: 48,
    description: 'A sampled Electric Guitar, Jazz from the FreePats collection.' },
  { id: 'rec-fp-eg-direct', name: 'Electric Guitar, Direct (recorded)', group: 'Recorded · Guitar & Bass', engine: 'sampled',
    pack: 'fp-eg-direct', fallback: 'nylon-guitar', cap: 48,
    description: 'A sampled Electric Guitar, Direct from the FreePats collection.' },
  { id: 'rec-fp-eg-dist-1', name: 'Electric Guitar, Distorted I (recorded)', group: 'Recorded · Guitar & Bass', engine: 'sampled',
    pack: 'fp-eg-dist-1', fallback: 'analog-lead', cap: 48,
    description: 'A sampled Electric Guitar, Distorted I from the FreePats collection.' },
  { id: 'rec-fp-eg-dist-2', name: 'Electric Guitar, Distorted II (recorded)', group: 'Recorded · Guitar & Bass', engine: 'sampled',
    pack: 'fp-eg-dist-2', fallback: 'analog-lead', cap: 48,
    description: 'A sampled Electric Guitar, Distorted II from the FreePats collection.' },
  { id: 'rec-fp-bass-guitar', name: 'Bass Guitar (recorded)', group: 'Recorded · Guitar & Bass', engine: 'sampled',
    pack: 'fp-bass-guitar', fallback: 'electric-bass', cap: 48,
    description: 'A sampled Bass Guitar from the FreePats collection.' },
  { id: 'rec-fp-lately-bass', name: 'Lately Bass (recorded)', group: 'Recorded · Guitar & Bass', engine: 'sampled',
    pack: 'fp-lately-bass', fallback: 'electric-bass', cap: 48,
    description: 'A sampled Lately Bass from the FreePats collection.' },

  /* --- FreePats: Winds & Reed --- */
  { id: 'rec-fp-clarinet', name: 'Clarinet (recorded)', group: 'Recorded · Winds & Reed', engine: 'sampled',
    pack: 'fp-clarinet', fallback: 'clarinet', cap: 48,
    description: 'A sampled Clarinet from the FreePats collection.' },
  { id: 'rec-fp-tenor-sax', name: 'Tenor Saxophone (recorded)', group: 'Recorded · Winds & Reed', engine: 'sampled',
    pack: 'fp-tenor-sax', fallback: 'alto-sax', cap: 48,
    description: 'A sampled Tenor Saxophone from the FreePats collection.' },
  { id: 'rec-fp-ocarina', name: 'Ocarina (recorded)', group: 'Recorded · Winds & Reed', engine: 'sampled',
    pack: 'fp-ocarina', fallback: 'flute', cap: 48,
    description: 'A sampled Ocarina from the FreePats collection.' },
  { id: 'rec-fp-recorder', name: 'Wooden Recorder (recorded)', group: 'Recorded · Winds & Reed', engine: 'sampled',
    pack: 'fp-recorder', fallback: 'flute', cap: 48,
    description: 'A sampled Wooden Recorder from the FreePats collection.' },
  { id: 'rec-fp-bagpipe', name: 'Bagpipe (recorded)', group: 'Recorded · Winds & Reed', engine: 'sampled',
    pack: 'fp-bagpipe', fallback: 'strings', cap: 48,
    description: 'A sampled Bagpipe from the FreePats collection.' },

  /* --- FreePats: Synth --- */
  { id: 'rec-fp-synth-bass-1', name: 'Synth Bass I (recorded)', group: 'Recorded · Synth', engine: 'sampled',
    pack: 'fp-synth-bass-1', fallback: 'electric-bass', cap: 48,
    description: 'A sampled Synth Bass I from the FreePats collection.' },
  { id: 'rec-fp-synth-bass-2', name: 'Synth Bass II (recorded)', group: 'Recorded · Synth', engine: 'sampled',
    pack: 'fp-synth-bass-2', fallback: 'electric-bass', cap: 48,
    description: 'A sampled Synth Bass II from the FreePats collection.' },
  { id: 'rec-fp-synth-bass-lead', name: 'Synth Bass & Lead (recorded)', group: 'Recorded · Synth', engine: 'sampled',
    pack: 'fp-synth-bass-lead', fallback: 'electric-bass', cap: 48,
    description: 'A sampled Synth Bass & Lead from the FreePats collection.' },
  { id: 'rec-fp-synth-square', name: 'Synth Lead, Square (recorded)', group: 'Recorded · Synth', engine: 'sampled',
    pack: 'fp-synth-square', fallback: 'analog-lead', cap: 48,
    description: 'A sampled Synth Lead, Square from the FreePats collection.' },
  { id: 'rec-fp-synth-calliope', name: 'Synth Lead, Calliope (recorded)', group: 'Recorded · Synth', engine: 'sampled',
    pack: 'fp-synth-calliope', fallback: 'analog-lead', cap: 48,
    description: 'A sampled Synth Lead, Calliope from the FreePats collection.' },
  { id: 'rec-fp-synth-fifths', name: 'Synth Fifths (recorded)', group: 'Recorded · Synth', engine: 'sampled',
    pack: 'fp-synth-fifths', fallback: 'analog-lead', cap: 48,
    description: 'A sampled Synth Fifths from the FreePats collection.' },
  { id: 'rec-fp-synth-goblins', name: 'Synth Goblins (recorded)', group: 'Recorded · Synth', engine: 'sampled',
    pack: 'fp-synth-goblins', fallback: 'analog-lead', cap: 48,
    description: 'A sampled Synth Goblins from the FreePats collection.' },
  { id: 'rec-fp-synth-sci-fi', name: 'Synth Sci-Fi (recorded)', group: 'Recorded · Synth', engine: 'sampled',
    pack: 'fp-synth-sci-fi', fallback: 'analog-lead', cap: 48,
    description: 'A sampled Synth Sci-Fi from the FreePats collection.' },
  { id: 'rec-fp-synth-soundtrack', name: 'Synth Soundtrack (recorded)', group: 'Recorded · Synth', engine: 'sampled',
    pack: 'fp-synth-soundtrack', fallback: 'warm-pad', cap: 48,
    description: 'A sampled Synth Soundtrack from the FreePats collection.' },
  { id: 'rec-fp-synth-strings-1', name: 'Synth Strings I (recorded)', group: 'Recorded · Synth', engine: 'sampled',
    pack: 'fp-synth-strings-1', fallback: 'strings', cap: 48,
    description: 'A sampled Synth Strings I from the FreePats collection.' },
  { id: 'rec-fp-synth-strings-2', name: 'Synth Strings II (recorded)', group: 'Recorded · Synth', engine: 'sampled',
    pack: 'fp-synth-strings-2', fallback: 'strings', cap: 48,
    description: 'A sampled Synth Strings II from the FreePats collection.' },
  { id: 'rec-fp-synth-brass-1', name: 'Synth Brass I (recorded)', group: 'Recorded · Synth', engine: 'sampled',
    pack: 'fp-synth-brass-1', fallback: 'strings', cap: 48,
    description: 'A sampled Synth Brass I from the FreePats collection.' },
  { id: 'rec-fp-synth-brass-2', name: 'Synth Brass II (recorded)', group: 'Recorded · Synth', engine: 'sampled',
    pack: 'fp-synth-brass-2', fallback: 'strings', cap: 48,
    description: 'A sampled Synth Brass II from the FreePats collection.' },
  { id: 'rec-fp-synth-pad-choir', name: 'Synth Pad, Choir (recorded)', group: 'Recorded · Synth', engine: 'sampled',
    pack: 'fp-synth-pad-choir', fallback: 'choir', cap: 48,
    description: 'A sampled Synth Pad, Choir from the FreePats collection.' },
  { id: 'rec-fp-synth-pad-bowed', name: 'Synth Pad, Bowed (recorded)', group: 'Recorded · Synth', engine: 'sampled',
    pack: 'fp-synth-pad-bowed', fallback: 'warm-pad', cap: 48,
    description: 'A sampled Synth Pad, Bowed from the FreePats collection.' },
  { id: 'rec-fp-sweep-pad', name: 'Synth Sweep Pad (recorded)', group: 'Recorded · Synth', engine: 'sampled',
    pack: 'fp-sweep-pad', fallback: 'warm-pad', cap: 48,
    description: 'A sampled Synth Sweep Pad from the FreePats collection.' },
  { id: 'rec-fp-new-age', name: 'Synth Pad, New Age (recorded)', group: 'Recorded · Synth', engine: 'sampled',
    pack: 'fp-new-age', fallback: 'warm-pad', cap: 48,
    description: 'A sampled Synth Pad, New Age from the FreePats collection.' },
  { id: 'rec-fp-synth-crystal', name: 'Synth Crystal (recorded)', group: 'Recorded · Synth', engine: 'sampled',
    pack: 'fp-synth-crystal', fallback: 'music-box', cap: 48,
    description: 'A sampled Synth Crystal from the FreePats collection.' },


// 50 instruments in 6 groups
];

/** The list the UI renders. `defaults` are the live parameter set. */
export const INSTRUMENTS = ROSTER.map((r) => ({
  id: r.id,
  name: r.name,
  group: r.group,
  description: r.description,
  sampled: r.engine === 'sampled',
  // Which pack a recorded instrument plays, so this can be checked against what
  // the pack actually contains rather than against a name written into the
  // test. Two recorded grands now exist and sit one entry apart, so "did the
  // roster route somewhere real" and "did it route to the RIGHT somewhere" are
  // different questions.
  pack: r.pack || null,
  defaults: { ...(r.defaults || {}) },
}));

const BY_ID = new Map(ROSTER.map((r) => [r.id, r]));

/** Just the ids — cheap enough for a module-level constant. */
export const INSTRUMENT_IDS = ROSTER.map((r) => r.id);

/**
 * Roster id -> pack id, for the ones that are recorded.
 *
 * The sampler needs this to turn "the user picked tenor sax" into "decode the
 * tenor sax pack", and it must not keep its own copy of the roster: a second
 * list would drift, and the drift would show up as an instrument that has been
 * fetched but not prepared.
 */
const PACK_OF = new Map(
  ROSTER.filter((r) => r.engine === 'sampled' && r.pack).map((r) => [r.id, r.pack])
);
__registerPackOf(PACK_OF);

/** The pack a roster id plays from, or null when it is modelled. */
export function packFor(id) {
  return PACK_OF.get(id) || null;
}

/* ============================================================== instruments */

/**
 * @param {string} id        one of INSTRUMENT_IDS
 * @param {BaseAudioContext} ctx  realtime **or** offline
 * @param {AudioNode} [outputNode]
 * @returns {Instrument}
 */
export function createInstrument(id, ctx, outputNode) {
  const entry = BY_ID.get(id);
  if (!entry) {
    throw new Error('unknown instrument "' + id + '" — expected one of ' + INSTRUMENT_IDS.join(', '));
  }
  if (!ctx || typeof ctx.createGain !== 'function') {
    throw new TypeError('createInstrument needs an AudioContext or OfflineAudioContext');
  }

  // A recorded instrument is a thin wrapper over the same interface, so nothing
  // downstream has to know which kind it got. If the pack has not been fetched,
  // or has been fetched but not decoded for these keys yet -- offline, on a page
  // opened from file://, or because nobody awaited prepare() -- fall back to the
  // modelled equivalent rather than to nothing.
  if (entry.engine === 'sampled') {
    if (hasPack(entry.pack) && isPackDecoded(entry.pack)) {
      try {
        return createSampledInstrument(entry.pack, ctx, outputNode);
      } catch (e) {
        console.warn(`recorded instrument "${entry.pack}" failed, using ${entry.fallback}:`, e);
      }
    }
    return createInstrument(entry.fallback, ctx, outputNode);
  }

  const out = outputNode || ctx.destination;
  const cfg = TUNING[id];
  const cap = entry.cap;

  /* ------------------------------------------------------------ bus chain */
  const stats = { nodes: 0, peakNodes: 0, voices: 0, peakVoices: 0 };
  const chain = [];
  const mk = (fn) => { const n = fn(); chain.push(n); return n; };

  const bus = mk(() => ctx.createGain());
  bus.gain.value = 1;

  // Keeps sub-audio and DC out of the render; every instrument gets one.
  const hp = mk(() => ctx.createBiquadFilter());
  hp.type = 'highpass';
  hp.frequency.value = 20;
  hp.Q.value = 0.6;

  let body = mk(() => ctx.createGain());
  body.gain.value = 1;
  bus.connect(hp).connect(body);

  // Instrument-specific body resonances: this is what stops four notes from
  // sounding like four detached oscillators and starts them sounding like one
  // instrument in a room.
  const BODY = {
    grand: [[99, 5.5, 1.6], [196, 3.5, 1.5], [305, 2.5, 1.4], [440, 1.5, 1.1]],
    'bright-piano': [[104, 4.0, 1.5], [208, 2.5, 1.4]],
    'felt-piano': [[92, 3.0, 1.3], [186, 1.8, 1.2]],
    rhodes: [[128, 3.0, 1.2], [640, 2.0, 1.6], [2100, 1.5, 1.8]],
    celesta: [[420, 3.0, 1.4], [1180, 2.0, 1.6]],
    'nylon-guitar': [[104, 6.0, 1.7], [212, 3.0, 1.5], [430, 1.5, 1.1]],
    harp: [[150, 3.0, 1.3], [360, 2.0, 1.3], [760, 1.5, 1.2]],
    harpsichord: [[180, 3.5, 1.4], [420, 2.0, 1.3]],
    timpani: [[58, 4.0, 1.2], [92, 3.0, 1.3], [146, 2.0, 1.3]],
    strings: [[210, 2.0, 1.2], [330, 1.5, 1.2]],
    choir: [[240, 2.0, 1.2]],
  };
  const bodySpec = BODY[id];
  if (bodySpec) {
    for (const [f, g, q] of bodySpec) {
      const f1 = mk(() => ctx.createBiquadFilter());
      f1.type = 'peaking';
      f1.frequency.value = f;
      f1.Q.value = q;
      f1.gain.value = g;
      body.connect(f1);
      body = f1;
    }
  }

  // Master tone control — the `brightness` parameter lives here.
  const tone = mk(() => ctx.createBiquadFilter());
  tone.type = 'lowpass';
  tone.Q.value = 0.4;

  const level = mk(() => ctx.createGain());
  level.gain.value = 1;

  body.connect(tone).connect(level).connect(out);

  const lfos = new Map();
  const kit = {
    ctx, bus, out: bus, stats,
    /**
     * A band-limited wave whose upper harmonics grow with dynamics. Blowing
     * harder into a pipe or bowing harder across a string genuinely produces
     * more upper partials, and it is the single biggest reason a synth note
     * stops sounding like a sine the moment you lean on it.
     */
    tiltWave(cfg, vel) {
      if (!cfg.brightTilt) return wave(ctx, cfg.spectrum);
      const k = Math.round(6 + clamp(vel, 0, 1) * 8);
      const tilt = Math.pow(1.10, (k - 6) / 4);
      const amps = cfg.spectrum.map((a, i) => a * Math.pow(tilt, Math.min(i, 8)));
      return wave(ctx, amps);
    },
    sharedLFO(rate) {
      const key = rate.toFixed(3);
      let l = lfos.get(key);
      if (!l) {
        l = ctx.createOscillator();
        l.type = 'sine';
        l.frequency.value = rate;
        l.start(0);
        lfos.set(key, l);
      }
      return l;
    },
  };

  /* -------------------------------------------------------------- params */
  const params = {
    level: 1, brightness: 0.75, detune: 0, vibrato: 1, spread: 1, noise: 1,
    ...entry.defaults,
  };
  applyTone();

  function applyTone() {
    const b = clamp(params.brightness, 0, 1.2);
    const f = clamp(2400 * Math.pow(18000 / 2400, b), 800, Math.min(20000, ctx.sampleRate * 0.47));
    tone.frequency.setValueAtTime(f, ctx.currentTime);
  }

  /* ---------------------------------------------------------- voice pool */
  const pool = [];
  const active = [];
  let sustain = false;
  let seed = 0;
  const warnings = [];

  function newVoice() {
    const v = makeVoice(kit, cfg);
    return v;
  }

  function free(v) {
    v.drop();
    if (pool.length < cap) pool.push(v);
  }

  /** Deterministic reclaim: anything whose tail ended before `when` is reusable. */
  function reap(when) {
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i].freeAt <= when) {
        const v = active[i];
        active.splice(i, 1);
        free(v);
      }
    }
  }

  function steal(when) {
    if (!active.length) return;
    let oldest = 0;
    for (let i = 1; i < active.length; i++) {
      if (active[i].startTime < active[oldest].startTime) oldest = i;
    }
    const v = active[oldest];
    active.splice(oldest, 1);
    v.hardStop(when + 0.005);
    free(v);
  }

  /* ------------------------------------------------------------ noteOn/off */

  function noteOn(ev) {
    const e = ev || {};
    const rawMidi = Number(e.midi);
    const midi = clamp(Math.round(Number.isFinite(rawMidi) ? rawMidi : 60), 0, 127);
    if (!Number.isFinite(rawMidi)) warnings.push('noteOn: missing midi, using ' + midiToName(midi));
    if (rawMidi < 0 || rawMidi > 127 || Math.round(rawMidi) !== rawMidi) {
      // Out-of-range or fractional pitches should not happen upstream; clamp
      // rather than throw, but make it visible.
      warnings.push('noteOn: midi ' + rawMidi + ' clamped to ' + midiToName(midi));
      dbg('noteOn clamped midi', rawMidi, '->', midi);
    }
    const velocity = clamp(Number.isFinite(Number(e.velocity)) ? Number(e.velocity) : 0.7, 0.001, 1);
    const when = Math.max(Number.isFinite(Number(e.when)) ? Number(e.when) : ctx.currentTime, ctx.currentTime);
    const duration = Number.isFinite(Number(e.duration)) ? Math.max(0, Number(e.duration)) : 0;
    const legato = !!e.legato;
    const tiedFromPrevious = !!e.tiedFromPrevious;

    reap(when);

    // Re-striking a ringing string excites the *same* string — that is both
    // physically right and much cheaper than layering a second voice on top.
    if (cfg.engine === 'additive' && cfg.reuse !== false) {
      for (const v of active) {
        if (v.midi === midi && v.freeAt > when && !v.damped) {
          v.sustained = false;
          v.start({ midi, velocity, when, duration, legato, tiedFromPrevious, params, seed: seed++ });
          return handle(v, midi, when);
        }
      }
    }

    if (active.length >= cap) steal(when);
    const v = pool.pop() || newVoice();
    v.start({ midi, velocity, when, duration, legato, tiedFromPrevious, params, seed: seed++ });
    active.push(v);
    stats.voices = active.length;
    if (stats.voices > stats.peakVoices) stats.peakVoices = stats.voices;
    return handle(v, midi, when);
  }

  function handle(v, midi, when) {
    return { instrument: api, voice: v, generation: v.generation, midi, when };
  }

  function noteOff(h, when) {
    if (!h || !h.voice) return;
    const v = h.voice;
    if (h.generation != null && h.generation !== v.generation) return; // recycled
    if (!v.started) return;
    const t = Math.max(Number.isFinite(Number(when)) ? Number(when) : ctx.currentTime, ctx.currentTime);
    // A release earlier than the note's own start would wipe that note's
    // scheduled envelope; ignore it rather than corrupting a later voice.
    if (t <= v.startTime) return;
    if (sustain && cfg.dampers) { v.sustained = true; return; }
    v.sustained = false;
    v.release(t);
  }

  function setSustain(down, when) {
    sustain = !!down;
    const t = Math.max(Number.isFinite(Number(when)) ? Number(when) : ctx.currentTime, ctx.currentTime);
    if (!sustain) {
      // Dampers drop: everything that was only held by the pedal stops now.
      for (const v of active) if (v.sustained) { v.sustained = false; v.release(t); }
    }
  }

  function allNotesOff(when) {
    const t = Math.max(Number.isFinite(Number(when)) ? Number(when) : ctx.currentTime, ctx.currentTime);
    for (const v of active) { v.sustained = false; v.release(t); }
  }

  function setParam(name, value, when) {
    const t = Math.max(Number.isFinite(Number(when)) ? Number(when) : ctx.currentTime, ctx.currentTime);
    const key = String(name).toLowerCase();
    const val = Number(value);
    if (!Number.isFinite(val)) return;
    switch (key) {
      case 'level':
      case 'gain':
      case 'volume':
        params.level = clamp(val, 0, 4);
        level.gain.setTargetAtTime(params.level, t, 0.02);
        break;
      case 'brightness':
      case 'tone':
        params.brightness = clamp(val, 0, 1.2);
        applyTone();
        break;
      case 'detune':
        params.detune = clamp(val, -1200, 1200);
        break;
      case 'vibrato':
        params.vibrato = clamp(val, 0, 2);
        break;
      case 'spread':
        params.spread = clamp(val, 0, 4);
        break;
      case 'noise':
        params.noise = clamp(val, 0, 2);
        break;
      default:
        warnings.push('setParam: unknown parameter "' + name + '"');
    }
  }

  function dispose(when) {
    const t = Math.max(Number.isFinite(Number(when)) ? Number(when) : ctx.currentTime, ctx.currentTime);
    for (const v of active) { v.hardStop(t); v.drop(); }
    active.length = 0;
    for (const v of pool) v.drop();
    pool.length = 0;
    for (const l of lfos.values()) { try { l.stop(t); } catch (e) { /* already stopped */ } }
    lfos.clear();
    for (const n of chain) { try { n.disconnect(); } catch (e) { /* already detached */ } }
    stats.voices = 0;
    disposed = true;
  }

  let disposed = false;

  const api = {
    id,
    name: entry.name,
    group: entry.group,
    noteOn,
    noteOff,
    setSustain,
    allNotesOff,
    setParam,
    dispose,
    /** Live parameter values (a copy — mutate through setParam). */
    get params() { return { ...params }; },
    /** Non-contract extras used by the UI and by the test harness. */
    warnings,
    debugStats() {
      return {
        id, voices: active.length, idle: pool.length, cap,
        nodes: stats.nodes, peakNodes: stats.peakNodes,
        peakVoices: stats.peakVoices, sustain, disposed,
      };
    },
  };
  return api;
}