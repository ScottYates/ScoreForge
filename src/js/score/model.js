/**
 * score/model.js — the internal score model and timing mathematics.
 *
 * Design notes
 * ------------
 * The internal time unit is the **quarter note** (a float), not MIDI ticks.
 * MusicXML parts each carry their own `<divisions>` value which may even change
 * mid-piece; MIDI files carry their own tick resolution. Quarters are the one
 * unit every notation source agrees on, and they make tempo placement trivial
 * ("quarter 42.5 is at 96 bpm") because a tempo mark is *by definition* attached
 * to a quarter.
 *
 * Everything that can be derived is derived in `resolveScore()` rather than at
 * parse time, so that changing tempo or transposition is a cheap, pure
 * recomputation instead of a re-parse.
 */

/* ------------------------------------------------------------------ pitch */

export const NOTE_NAMES = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const SEMITONE_INDEX = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/** Indexed by *pitch class* (0–11), unlike NOTE_NAMES which is the diatonic scale. */
const PITCH_CLASS_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Scientific pitch notation, e.g. `A4` -> 69, `C-1` -> 0. */
export function midiToName(midi) {
  const m = Math.round(midi);
  const pc = ((m % 12) + 12) % 12;
  return PITCH_CLASS_NAMES[pc] + (Math.floor(m / 12) - 1);
}

export function nameToMidi(name) {
  const m = /^([A-Ga-g])([#b]*)(-?\d+)$/.exec(String(name).trim());
  if (!m) return null;
  // Scientific pitch: C-1 is MIDI 0, so octave N starts at (N + 1) * 12.
  let v = (parseInt(m[3], 10) + 1) * 12 + SEMITONE_INDEX[m[1].toUpperCase()];
  for (const acc of m[2]) v += acc === '#' ? 1 : -1;
  return Math.max(0, Math.min(127, v));
}

/** Key signature (in fifths) -> display name, e.g. -3 -> "Eb major". */
export function keyNameFromFifths(fifths, mode) {
  const f = Math.max(-7, Math.min(7, Math.round(fifths || 0)));
  const isMinor = mode === 'minor';
  const pc = ((f * 7 % 12) + 12) % 12;
  const names = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  return isMinor ? names[(pc + 9) % 12] + ' minor' : names[pc] + ' major';
}

/** "Eb major" / "cmin" / "F# minor" -> key signature in fifths. */
export function keyFifthsFromName(name) {
  const s = String(name || '').trim();
  const m = /^([A-Ga-g])([#b]?)\s*(major|minor|min|maj|m)?$/i.exec(s);
  if (!m) return 0;
  const base = SEMITONE_INDEX[m[1].toUpperCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  const isMinor = /^m(in)?$/i.test(m[3] || '');
  // Index = pitch class of the tonic; value = fifths of that major key.
  const MAJOR_FIFTHS = [0, -5, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5];
  const majorFifths = MAJOR_FIFTHS[((base % 12) + 12) % 12];
  const f = isMinor ? majorFifths - 3 : majorFifths;
  return Math.max(-7, Math.min(7, f));
}

/* ----------------------------------------------------------------- timing */

/**
 * Maps quarter-note positions to seconds using a tempo map, and back again.
 * Handles tempo changes (a piece that slows down in the coda) and a global
 * tempo *scale* (the "playback speed" control).
 */
export class Timing {
  /**
   * @param {{quarter:number, bpm:number}[]} tempoMap sorted ascending by quarter
   * @param {number} totalQuarters
   */
  constructor(tempoMap, totalQuarters, scale = 1) {
    this.base = (tempoMap && tempoMap.length ? tempoMap : [{ quarter: 0, bpm: 120 }])
      .map((t, i, arr) => ({ quarter: Math.max(0, t.quarter), bpm: t.bpm > 0 ? t.bpm : 120, _i: i }))
      .sort((a, b) => a.quarter - b.quarter);
    if (!this.base.length || this.base[0].quarter > 0) this.base.unshift({ quarter: 0, bpm: 120, _i: -1 });
    this.totalQuarters = Math.max(0, totalQuarters || 0);
    this.setScale(scale);
  }

  setScale(scale) {
    this.scale = Math.max(0.25, Math.min(3, scale || 1));
    // Integrate the tempo map into a cumulative seconds table.
    const table = [{ q: 0, s: 0, bpm: this.base[0].bpm }];
    for (let i = 1; i < this.base.length; i++) {
      const prev = table[i - 1];
      const segQuarters = Math.max(0, this.base[i].quarter - prev.q);
      prev.endQ = this.base[i].quarter;
      table.push({ q: this.base[i].quarter, s: prev.s + segQuarters * (60 / prev.bpm), bpm: this.base[i].bpm });
    }
    const last = table[table.length - 1];
    last.endQ = this.totalQuarters;
    this.table = table.map((t) => ({ ...t, s: t.s / this.scale }));
    return this;
  }

  /** Seconds elapsed at a given quarter position (before tempo scale). */
  rawSecondsAtQuarter(q) {
    const t = this.table;
    let i = 0;
    while (i + 1 < t.length && t[i + 1].q <= q) i++;
    const seg = t[i];
    const endQ = seg.endQ != null ? seg.endQ : this.totalQuarters;
    const clamped = Math.min(q, endQ);
    return seg.s + Math.max(0, clamped - seg.q) * (60 / seg.bpm);
  }

  /** Played seconds (tempo scale applied) at a quarter position. */
  secondsAtQuarter(q) {
    return this.rawSecondsAtQuarter(q) / this.scale;
  }

  quarterAtSeconds(s) {
    const target = s * this.scale;
    const t = this.table;
    let i = 0;
    while (i + 1 < t.length && t[i + 1].s <= target) i++;
    const seg = t[i];
    const endQ = seg.endQ != null ? seg.endQ : this.totalQuarters;
    const q = seg.q + (target - seg.s) / (60 / seg.bpm);
    return Math.min(q, Math.max(endQ, q));
  }

  get durationSec() {
    return this.rawSecondsAtQuarter(this.totalQuarters) / this.scale;
  }

  bpmAtQuarter(q) {
    const t = this.table;
    let i = 0;
    while (i + 1 < t.length && t[i + 1].q <= q) i++;
    return t[i].bpm;
  }

  /** [{quarter, sec}] — used by the piano roll and the transport ruler. */
  beats() {
    const out = [];
    for (let q = 0; q <= this.totalQuarters + 1e-6; q += 0.25) {
      out.push({ quarter: q, sec: this.secondsAtQuarter(q), bpm: this.bpmAtQuarter(q) });
    }
    return out;
  }
}

/* ---------------------------------------------------------------- resolve */

/**
 * Turn a parsed score into a flat, time-sorted list of playable notes.
 * Applies transposition and per-part octave/wrap rules.
 *
 * @param {Score} score
 * @param {object} opts
 * @param {number} [opts.transpose=0] semitones applied to every part
 * @param {number} [opts.tempoScale=1]
 * @returns {{notes: ResolvedNote[], timing: Timing, durationSec: number}}
 */
export function resolveScore(score, opts = {}) {
  const transpose = opts.transpose | 0;
  const timing = new Timing(score.tempoMap, score.totalQuarters, opts.tempoScale || 1);
  const notes = [];
  const parts = score.parts || [];

  for (const part of parts) {
    if (part.muted) continue;
    const shift = transpose + (part.transpose || 0);
    const octaveDouble = part.octaveDouble;
    for (const n of part.notes) {
      let midi = n.midi + shift;
      if (octaveDouble) midi += 12 * (n.midi < 60 ? 1 : 0);
      midi = Math.max(0, Math.min(127, midi));
      const time = timing.secondsAtQuarter(n.quarter);
      const dur = Math.max(0.02, timing.secondsAtQuarter(n.quarter + n.durationQuarters) - time);

      // Sustain-pedal handling. Parsers may express this either as an absolute
      // end (`sustainUntilQuarters`) or as an extra tail after the key is
      // released (`sustainQuarters`); accept both and normalise to seconds.
      const holdQuarters = n.sustainUntilQuarters != null
        ? Math.max(0, n.sustainUntilQuarters - n.quarter)
        : Math.max(0, n.sustainQuarters || 0);
      const soundingQuarters = n.soundingQuarters != null
        ? Math.max(n.durationQuarters, n.soundingQuarters)
        : n.durationQuarters + holdQuarters;

      notes.push({
        ...n,
        midi,
        time,
        duration: dur,
        /** When the damper finally lifts (0 = no pedal involved). */
        sustainUntil: holdQuarters > 0
          ? timing.secondsAtQuarter(n.quarter + holdQuarters)
          : 0,
        /** How long the voice should keep ringing. */
        soundingUntil: timing.secondsAtQuarter(n.quarter + soundingQuarters),
        partId: part.id,
        partName: part.name,
        pan: part.pan || 0,
        gain: part.gain == null ? 1 : part.gain,
        sourceMidi: n.midi,
      });
    }
  }
  notes.sort((a, b) => (a.time - b.time) || (a.midi - b.midi));
  const durationSec = Math.max(
    timing.durationSec,
    notes.reduce((m, n) => Math.max(m, n.time + n.duration), 0) + 1.5
  );
  return { notes, timing, durationSec };
}

/* ------------------------------------------------------------- score shell */

let scoreSeq = 0;

export function createScore(partial = {}) {
  return {
    id: 'sc' + (++scoreSeq),
    title: 'Untitled',
    composer: '',
    sourceFormat: 'musicxml',
    parts: [],
    tempoMap: [{ quarter: 0, bpm: 120 }],
    keySigs: [{ quarter: 0, fifths: 0, mode: null }],
    timeSigs: [{ quarter: 0, beats: 4, beatType: 4 }],
    totalQuarters: 0,
    measureCount: 0,
    rawMusicXml: null,
    warnings: [],
    ...partial,
  };
}

export function makePart(partial = {}) {
  return {
    id: partial.id || 'P1',
    name: partial.name || 'Instrument',
    abbrev: partial.abbrev || '',
    midiProgram: partial.midiProgram == null ? 0 : partial.midiProgram,
    /**
     * Sounding-pitch offset baked into the file, added to every written pitch.
     * A Bb clarinet part is written a whole tone above how it sounds, so its
     * MusicXML `<chromatic>` is -2 and this is -2, not +2.
     */
    transpose: partial.transpose || 0,
    gain: partial.gain == null ? 1 : partial.gain,
    pan: partial.pan || 0,
    muted: false,
    solo: false,
    octaveDouble: false,
    staves: partial.staves || 1,
    clef: partial.clef || 'treble',
    notes: partial.notes || [],
    channel: partial.channel == null ? 0 : partial.channel,
  };
}

export function makeNote(partial = {}) {
  return {
    id: partial.id || 'n' + (++scoreSeq),
    midi: partial.midi | 0,
    velocity: partial.velocity == null ? 0.8 : partial.velocity,
    quarter: partial.quarter || 0,
    durationQuarters: partial.durationQuarters || 0.25,
    staff: partial.staff || 1,
    voice: partial.voice || 1,
    chord: !!partial.chord,
    grace: !!partial.grace,
    tieFrom: !!partial.tieFrom,
    tieTo: !!partial.tieTo,
    lyric: partial.lyric || null,
    articulation: partial.articulation || null,
  };
}

/** Key signatures present in the piece, in order — the UI offers these as targets. */
export function availableKeys(score) {
  const set = new Map();
  for (const k of score.keySigs || []) {
    set.set(k.fifths, { fifths: k.fifths, mode: k.mode, name: keyNameFromFifths(k.fifths, k.mode) });
  }
  if (!set.size) set.set(0, { fifths: 0, mode: null, name: keyNameFromFifths(0, null) });
  return [...set.values()].sort((a, b) => a.fifths - b.fifths);
}

/** Human-readable summary for the header strip. */
export function describeScore(score) {
  const n = (score.parts || []).reduce((a, p) => a + p.notes.length, 0);
  const parts = (score.parts || []).length;
  const bars = score.measureCount || 0;
  return `${parts} part${parts === 1 ? '' : 's'} · ${n.toLocaleString()} notes · ${bars} bar${bars === 1 ? '' : 's'}`;
}