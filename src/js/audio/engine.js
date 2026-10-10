/**
 * audio/engine.js — note scheduling for live playback and offline rendering.
 *
 * The same code path drives both. Live playback uses a lookahead scheduler
 * ("a tale of two clocks"): a coarse timer wakes up often, and schedules every
 * note that falls inside the next ~220 ms using sample-accurate Web Audio
 * timestamps. Offline rendering calls `scheduleAll()` once and lets
 * `OfflineAudioContext.startRendering()` do the timing.
 *
 * Because both paths call the same `_scheduleRange()`, a rendered MP3 is
 * guaranteed to contain what you heard during preview — same instruments, same
 * envelopes, same mix. Only `humanize` (performance jitter) differs, and that
 * is forced to 0 for export.
 */

import { createInstrument, DEFAULT_INSTRUMENT, packFor } from './instruments.js';
import { prepare as prepareInstruments } from './sampler.js';

const TIMER_MS = 25;
const SCHEDULE_AHEAD = 0.22;
const RELEASE_TAIL = 0.35;

export class Engine {
  /**
   * @param {AudioContext|OfflineAudioContext} ctx
   * @param {object} o
   * @param {AudioBus} o.bus
   * @param {boolean} [o.offline] schedule everything up front instead of on a timer
   */
  constructor(ctx, o = {}) {
    this.ctx = ctx;
    this.bus = o.bus;
    this.offline = !!o.offline;
    this.notes = [];
    this.timing = null;
    this.duration = 0;
    this.score = null;
    this.partInstruments = new Map();

    this.playing = false;
    this._offset = 0;        // score-time position, seconds
    this._anchor = 0;        // ctx time corresponding to _offset
    this._cursor = 0;        // index of the next note to schedule
    this._timer = null;
    this._raf = null;
    this._pending = [];      // scheduled notes awaiting their audible moment
    this._pendingLo = 0;
    this._listeners = new Set();
    this._active = new Set(); // sounding handles, so pause/stop can release them

    this.metronome = false;
    this.metronomeGain = 0.5;
    this.countInBeats = 0;
    this.humanize = 0;
    this.sustainEnabled = true;
    this._seed = 0x9e3779b9;
    this._clicks = null;
    this._lastState = 'stopped';
  }

  /* ------------------------------------------------------------ lifecycle */

  /**
   * @param {{notes:Array, timing:Object, durationSec:number}} resolved from resolveScore()
   * @param {{score:Object, partInstruments:Map<string,string>}} o
   */
  load(resolved, o = {}) {
    this.stop();
    this.score = o.score || null;
    this.notes = resolved.notes || [];
    this.timing = resolved.timing || null;
    this.duration = resolved.durationSec || 0;
    this.partInstruments = o.partInstruments || new Map();
    this._offset = 0;
    this._cursor = 0;
    this._clicks = null;
    for (const n of this.notes) n._on = false;
    return this;
  }

  /**
   * Decode whatever this score needs before a note is scheduled.
   *
   * The whole score is known here, so the set of keys that can sound is known
   * too -- which is what makes it possible to decode exactly those and nothing
   * else. Recorded instruments used by one part of a piece are usually a handful
   * of families, and only the keys actually written get decoded.
   *
   * Called by the two places that have an async boundary before scheduling
   * starts: the play button and the offline render. Everything below this line
   * is synchronous, so this is the last chance to get PCM into memory.
   *
   * @param {(p:{done:number,total:number,label:string})=>void} [onProgress]
   */
  async prepare(onProgress) {
    const ids = [...new Set(this.partInstruments.values())];
    if (!ids.length) return;
    const midis = [...new Set(this.notes.map((n) => n.midi))];
    await prepareInstruments(ids, midis, onProgress);

    // A part's channel can exist before its samples did: touching mute, solo
    // or gain builds it, and built then it could only be the modelled
    // fallback. Nothing rebuilt it afterwards, so one press of mute before the
    // first Play meant the synthesiser for the rest of the session. Now that
    // the samples are in, swap any such channel for the recording.
    // setPartInstrument keeps its level, mute and solo.
    if (this._channels) {
      for (const [partId, id] of this.partInstruments) {
        const ch = this._channels.get(partId);
        if (ch && packFor(id) && !ch.inst.sampled) this.setPartInstrument(partId, id);
      }
    }
  }

  /**
   * Load a score and get its instruments ready to play.
   *
   * Async because that is the only honest place to decode: `load` is called
   * from constructors and from tests that then expect a synchronous result, and
   * bolting a promise onto it would push the await into every one of them for
   * the benefit of only one caller.
   *
   * @param {{notes:Array, timing:Object, durationSec:number}} resolved
   * @param {{score:Object, partInstruments:Map<string,string>}} o
   */
  async loadAndPrepare(resolved, o = {}) {
    this.load(resolved, o);
    await this.prepare();
    return this;
  }

  get position() {
    if (!this.playing) return this._offset;
    return Math.min(this.duration, this._offset + (this.ctx.currentTime - this._anchor));
  }

  /**
   * Score time elapsed, deliberately unclamped.
   *
   * `position` stops at the end of the piece, so asking it whether playback is
   * finished is a question it cannot answer -- it can never exceed the
   * duration. This is the value that keeps counting past the end.
   */
  get elapsed() {
    return this._offset + (this.playing ? this.ctx.currentTime - this._anchor : 0);
  }

  _setState(s) {
    if (this._lastState === s) return;
    this._lastState = s;
    this._emit({ type: 'state', state: s });
  }

  _emit(ev) {
    for (const fn of this._listeners) {
      try { fn(ev); } catch (e) { console.error(e); }
    }
  }

  on(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

  /* ------------------------------------------------------- part channels */

  /** Lazily create the instrument + mixer strip for a part. */
  _channel(partId, instrumentId) {
    let ch = this._channels && this._channels.get(partId);
    if (!ch) {
      if (!this._channels) this._channels = new Map();
      const ctx = this.ctx;
      const inst = createInstrument(instrumentId || DEFAULT_INSTRUMENT, ctx, this.bus.input);
      const gain = ctx.createGain();
      const pan = ctx.createStereoPanner
        ? ctx.createStereoPanner()
        : null;
      const send = ctx.createGain();
      gain.connect(pan || this.bus.input);
      if (pan) {
        pan.connect(this.bus.input);
        pan.connect(send);
        send.connect(this.bus.reverbSend);
      } else {
        gain.connect(send);
        send.connect(this.bus.reverbSend);
      }
      ch = { inst, gain, pan, send };
      this._channels.set(partId, ch);
    }
    return ch;
  }

  _destroyChannels() {
    if (!this._channels) return;
    for (const ch of this._channels.values()) {
      try { ch.inst.dispose(this.ctx.currentTime); } catch { /* noop */ }
      try { ch.gain.disconnect(); ch.pan && ch.pan.disconnect(); ch.send.disconnect(); } catch { /* noop */ }
    }
    this._channels.clear();
  }

  setPartMix(partId, { gain, pan, muted, solo } = {}) {
    const ch = this._channel(partId, this.partInstruments.get(partId));
    const t = this.ctx.currentTime;
    if (gain != null) ch.gain.gain.setTargetAtTime(clamp(gain, 0, 2), t, 0.01);
    if (pan != null && ch.pan) ch.pan.pan.setTargetAtTime(clamp(pan, -1, 1), t, 0.01);
    if (muted != null) ch.muted = muted;
    if (solo != null) ch.solo = solo;
    this._applySolo();
    return this;
  }

  _applySolo() {
    if (!this._channels) return;
    const anySolo = [...this._channels.values()].some((c) => c.solo);
    for (const [partId, ch] of this._channels) {
      const audible = !anySolo ? !ch.muted : ch.solo;
      ch.gain.gain.setTargetAtTime(audible ? (ch.level == null ? 1 : ch.level) : 0, this.ctx.currentTime, 0.01);
    }
  }

  setPartLevel(partId, level) {
    const ch = this._channel(partId, this.partInstruments.get(partId));
    ch.level = level;
    this._applySolo();
  }

  /**
   * Swap the instrument on a part without interrupting playback. The mixer
   * strip is rebuilt so the new voice starts clean; the caller re-applies
   * gain/mute/solo afterwards via setPartMix.
   */
  setPartInstrument(partId, instrumentId) {
    this.partInstruments.set(partId, instrumentId);
    const ch = this._channels && this._channels.get(partId);
    if (!ch) { this._channel(partId, instrumentId); return this; }
    const wasPlaying = this.playing;
    const pos = this.position;
    try { ch.inst.dispose(this.ctx.currentTime + 0.02); } catch { /* noop */ }
    try {
      ch.gain.disconnect();
      if (ch.pan) ch.pan.disconnect();
      ch.send.disconnect();
    } catch { /* noop */ }
    this._channels.delete(partId);
    const fresh = this._channel(partId, instrumentId);
    fresh.level = ch.level;
    fresh.muted = ch.muted;
    fresh.solo = ch.solo;
    this._applySolo();
    if (wasPlaying) this.seek(pos);
    return this;
  }

  /* ------------------------------------------------------------ transport */

  play(fromSec) {
    if (this.playing) return this;
    const pos = clamp(fromSec != null ? fromSec : this._offset, 0, this.duration);
    this._offset = pos;
    this._cursor = lowerBound(this.notes, pos);
    this._pending.length = 0;
    this._pendingLo = 0;
    for (const n of this.notes) n._on = false;

    const ctxNow = this.ctx.currentTime;
    const lead = this.countInBeats > 0 ? this.countInBeats * (60 / Math.max(30, this._bpmAt(pos))) : 0;
    this._anchor = ctxNow + 0.06 + lead;

    if (lead > 0) this._scheduleCountIn(pos, lead);

    this.playing = true;
    this._setState('playing');
    this._scheduleWindow();
    if (!this.offline) {
      this._timer = setInterval(() => this._tick(), TIMER_MS);
      this._raf = requestAnimationFrame(() => this._frame());
    }
    return this;
  }

  pause() {
    if (!this.playing) return this;
    const pos = this.position;
    this._releaseAll(this.ctx.currentTime);
    this.playing = false;
    this._stopTimers();
    this._offset = clamp(pos, 0, this.duration);
    this._setState('paused');
    this._emit({ type: 'state', state: 'paused', position: this._offset });
    return this;
  }

  stop() {
    if (this.playing) {
      this.playing = false;
      this._stopTimers();
      this._setState('stopped');
    }
    this._releaseAll(this.ctx.currentTime);
    this._offset = 0;
    this._cursor = 0;
    this._pending.length = 0;
    this._pendingLo = 0;
    for (const n of this.notes) n._on = false;
    return this;
  }

  seek(sec) {
    const wasPlaying = this.playing;
    if (wasPlaying) { this.pause(); }
    this._offset = clamp(sec, 0, this.duration);
    this._cursor = lowerBound(this.notes, this._offset);
    this._emit({ type: 'seek', position: this._offset });
    if (wasPlaying) this.play(this._offset);
    return this;
  }

  _stopTimers() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
  }

  _releaseAll(when) {
    if (!this._channels) return;
    for (const ch of this._channels.values()) {
      try { ch.inst.allNotesOff(when + 0.005); } catch { /* noop */ }
    }
    this._active.clear();
    for (const n of this.notes) {
      if (n._on) { n._on = false; this._emit({ type: 'note', note: n, on: false }); }
    }
  }

  _bpmAt(scoreTime) {
    if (!this.timing) return 100;
    return this.timing.bpmAtQuarter(this.timing.quarterAtSeconds(scoreTime));
  }

  /* ----------------------------------------------------------- scheduling */

  /**
   * Lay down the next SCHEDULE_AHEAD seconds of notes.
   *
   * Called once when playback starts and then from the interval timer. Both go
   * through here so the opening window cannot drift from the ones that follow.
   */
  _scheduleWindow() {
    const horizon = this.position + SCHEDULE_AHEAD;
    this._scheduleUntil(horizon);
    if (this.metronome) this._scheduleClicksUntil(horizon);
  }

  _tick() {
    if (!this.playing) return;
    this._scheduleWindow();
    if (this.elapsed >= this.duration + RELEASE_TAIL) {
      this.pause();
      this._offset = this.duration;
      this._emit({ type: 'ended' });
    }
  }

  /** Schedule every note whose onset falls before `horizon` (score seconds). */
  _scheduleUntil(horizon) {
    const notes = this.notes;
    while (this._cursor < notes.length) {
      const n = notes[this._cursor];
      if (n.time > horizon) break;
      this._playNote(n);
      this._cursor++;
    }
  }

  _playNote(n) {
    const ch = this._channel(n.partId, this.partInstruments.get(n.partId));
    if (!ch) return;
    if (ch.muted) return;
    const anySolo = this._anySolo();
    if (anySolo && !ch.solo) return;

    const when = Math.max(this.ctx.currentTime, this._anchor + (n.time - this._offset));
    const jitter = this.humanize > 0 ? this._jitter(n, when) : null;
    const at = jitter ? when + jitter.dt : when;
    const vel = jitter ? clamp01(n.velocity * jitter.gain) : n.velocity;

    let handle = null;
    try {
      handle = ch.inst.noteOn({
        midi: n.midi,
        velocity: vel,
        when: at,
        duration: Math.max(0.02, n.duration),
        channel: n.channel,
        legato: !!n.legato,
        tiedFromPrevious: !!n.tieTo,
      });
    } catch (e) {
      console.error('instrument noteOn failed', e);
    }

    if (handle) this._active.add(handle);

    // The pedal (written in the file, or implied by a MIDI CC64) lets the note
    // ring past its written length; the instrument holds it until then.
    const ring = n.soundingUntil != null
      ? Math.max(n.duration, n.soundingUntil - n.time)
      : n.duration;

    this._pending.push({ note: n, at, offAt: at + Math.max(0.05, ring * 0.94), handle, ch });
    if (this._pending.length > 4000) this._pending.splice(0, 1000);
  }

  _anySolo() {
    if (!this._channels) return false;
    for (const c of this._channels.values()) if (c.solo) return true;
    return false;
  }

  _jitter(n, when) {
    this._seed = (this._seed + 0x6d2b79f5) | 0;
    let t = this._seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const rnd = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    const h = this.humanize;
    return {
      dt: (rnd - 0.5) * 0.03 * h * Math.min(1, n.duration * 2),
      gain: 1 + (rnd - 0.5) * 0.25 * h,
    };
  }

  /** Offline: lay every note on the timeline at once. */
  scheduleAll(tailSec = 2.5) {
    this.playing = true;
    this._offset = 0;
    this._anchor = 0;
    this._cursor = 0;
    if (this.metronome) {
      this._clicks = this._buildClicks();
      for (const c of this._clicks) this._click(c, c.time);
    }
    this._scheduleUntil(Infinity);
    this.playing = false;
    return this;
  }

  /* ------------------------------------------------------------ highlight */

  /**
   * Drives the UI cursor. Highlight events fire when the note is actually
   * audible, not when it was scheduled — with a 220 ms lookahead, driving the
   * cursor from the schedule would make the notation run visibly early.
   */
  _frame() {
    if (!this.playing) return;
    const now = this.ctx.currentTime;
    const pend = this._pending;
    let i = this._pendingLo;
    while (i < pend.length && pend[i].at <= now) {
      const p = pend[i];
      if (!p.note._on) {
        p.note._on = true;
        this._emit({ type: 'note', note: p.note, on: true, partId: p.note.partId });
      }
      i++;
    }
    let j = this._pendingLo;
    while (j < pend.length && pend[j].offAt <= now) {
      const p = pend[j];
      if (p.note._on) {
        p.note._on = false;
        this._emit({ type: 'note', note: p.note, on: false, partId: p.note.partId });
      }
      if (p.handle) this._active.delete(p.handle);
      j++;
    }
    this._pendingLo = j;
    this._emit({ type: 'time', position: this.position });
    this._raf = requestAnimationFrame(() => this._frame());
  }

  /** Emit any note highlights already in the past — used after a seek. */
  _flushPendingAt(sec) {
    const now = this.ctx.currentTime;
    for (const p of this._pending) {
      if (p.at <= now && !p.note._on) {
        p.note._on = true;
        this._emit({ type: 'note', note: p.note, on: true, partId: p.note.partId });
      }
    }
  }

  /* ------------------------------------------------------------ metronome */

  _buildClicks() {
    if (this._clicks || !this.timing) return this._clicks || [];
    const out = [];
    const total = Math.ceil(this.timing.totalQuarters);
    for (let q = 0; q <= total; q++) {
      out.push({ time: this.timing.secondsAtQuarter(q), beat: q, down: q % 4 === 0 });
    }
    this._clicks = out;
    return out;
  }

  _scheduleClicksUntil(horizon) {
    const clicks = this._buildClicks();
    if (!clicks.length) return;
    const start = this._clickCursor || 0;
    for (let i = start; i < clicks.length; i++) {
      if (clicks[i].time > horizon) { this._clickCursor = i; break; }
      if (clicks[i].time >= this._offset - 0.01) {
        this._click(clicks[i], this._anchor + (clicks[i].time - this._offset));
      }
      this._clickCursor = i + 1;
    }
  }

  _click(click, when) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'square';
    o.frequency.value = click.down ? 1760 : 1175;
    const amp = (click.down ? 0.5 : 0.32) * this.metronomeGain * 0.25;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(amp, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.055);
    o.connect(g).connect(this.bus.input);
    o.start(when);
    o.stop(when + 0.08);
  }

  _scheduleCountIn(fromSec, lead) {
    const bpm = Math.max(30, this._bpmAt(fromSec));
    const spb = 60 / bpm;
    for (let i = 0; i < this.countInBeats; i++) {
      const at = this.ctx.currentTime + 0.06 + i * spb;
      if (i === this.countInBeats - 1) continue;
      this._click({ down: i % 4 === 0 }, at);
    }
    this._click({ down: true }, this.ctx.currentTime + 0.06 + (this.countInBeats - 1) * spb);
  }

  dispose() {
    this.stop();
    this._destroyChannels();
    this._listeners.clear();
  }
}

/* ------------------------------------------------------------- utilities */

export function lowerBound(notes, t) {
  let lo = 0, hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid].time < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }