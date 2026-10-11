/**
 * src/js/io/musicxml.js — MusicXML (score-partwise / score-timewise) → internal Score.
 *
 * Design notes
 * ------------
 * * `<duration>` is authoritative. MusicXML writes a note's duration in
 *   `<divisions>` units *after* dots and tuplets have been applied, and the
 *   `<dot>` / `<time-modification>` / `<type>` elements are only the engraved
 *   description of it. Naively multiplying `duration/divisions` by 1.5 and 3/2
 *   again double-counts every dotted and tuplet note, so we use
 *   `duration/divisions` as the base and only fall back to the
 *   type x dots x ratio calculation when `<duration>` is missing (grace notes)
 *   or when the file is provably *not* pre-scaled — see `noteLengthQuarters`.
 * * Measures are read into (measureIndex, offsetWithinMeasure) pairs and only
 *   turned into absolute quarters in `finalizePart()`, after every part's
 *   measure lengths are known. That is what keeps multi-part and multi-staff
 *   scores aligned: one shared bar grid (the longest reading of each bar) is
 *   used for everybody.
 * * Nothing here assumes the file is well-formed beyond "parseable XML".
 *   Unknown elements are skipped, bad values become warnings, and only input
 *   we cannot possibly read (empty string, malformed XML, no `<part>` at all)
 *   throws.
 */

import { createScore, makePart, makeNote } from '../score/model.js';

/* ------------------------------------------------------------- constants */

const QUARTERS_BY_TYPE = {
  'maxima': 32, 'long': 16, 'breve': 8, 'whole': 4, 'half': 2, 'quarter': 1,
  'eighth': 0.5, '16th': 0.25, '32nd': 0.125, '64th': 0.0625,
  '128th': 0.03125, '256th': 0.015625, '512th': 0.0078125,
};

/** Same table keyed by metronome `<beat-unit>`; a beat unit is a note value. */
const QUARTERS_BY_BEAT_UNIT = QUARTERS_BY_TYPE;

const STEP_SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Dynamics -> 0..1 velocity. Only the common marks; unknown ones fall back. */
const DYNAMIC_VELOCITY = {
  ppp: 0.18, pp: 0.28, p: 0.42, mp: 0.56, mf: 0.7, f: 0.82,
  ff: 0.9, fff: 0.96, ffff: 1, n: 0.5,
  sf: 0.88, sfz: 0.95, sfp: 0.92, fp: 0.92, pf: 0.62, rf: 0.9, rfz: 0.95, sfpz: 0.95,
};

/** Slightly generous tolerance for "these two durations are the same value". */
const EPS = 1e-9;

/* --------------------------------------------------------- DOM utilities */

function tagOf(el) {
  return el && el.nodeType === 1 ? (el.localName || el.nodeName) : '';
}

/** First direct child element with this tag name, or null. */
function child(el, name) {
  const kids = el.children;
  for (let i = 0; i < kids.length; i++) {
    if (tagOf(kids[i]) === name) return kids[i];
  }
  return null;
}

/** Every direct child element with this tag name. */
function childrenNamed(el, name) {
  const kids = el.children;
  const out = [];
  for (let i = 0; i < kids.length; i++) {
    if (tagOf(kids[i]) === name) out.push(kids[i]);
  }
  return out;
}

/** Trimmed text of the first direct child with this tag name ('' if absent). */
function childText(el, name) {
  const c = child(el, name);
  return c ? (c.textContent || '').trim() : '';
}

function num(value, fallback) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

function hasTag(el, name) {
  return !!child(el, name);
}

function sliceChildren(el) {
  const kids = el.children;
  const out = new Array(kids.length);
  for (let i = 0; i < kids.length; i++) out[i] = kids[i];
  return out;
}

/* ------------------------------------------------------------ pitch/clef */

/** `<step>` + `<alter>` + `<octave>` -> MIDI number (C4 = 60), or null. */
function pitchToMidi(step, alter, octave) {
  const base = STEP_SEMITONE[step];
  if (base === undefined) return null;
  if (!Number.isFinite(octave)) return null;
  return base + (Number.isFinite(alter) ? alter : 0) + (octave + 1) * 12;
}

/** Clef sign/line -> the clef name the rest of the app uses. */
function clefType(sign, line) {
  const s = String(sign || '').toUpperCase();
  const l = line | 0;
  if (s === 'PERC') return 'percussion';
  if (s === 'G') return 'treble';              // G2 treble, G1 French violin
  if (s === 'F') return 'bass';                // F4 bass, F5 sub-bass, F3 baritone
  if (s === 'C') return l === 4 ? 'tenor' : 'alto';
  return 'treble';
}

/** Duration of a written note type in quarters, before dots/tuplets. */
function typeQuarters(typeName) {
  const q = QUARTERS_BY_TYPE[typeName];
  return q === undefined ? null : q;
}

/**
 * Length of a note in quarters.
 *
 * `durationQuarters` is the `<duration>` reading, or null when the note has no
 * usable `<duration>` (grace notes, or a part that never declared `<divisions>`).
 * `typeQuarters` is the plain `<type>` value; `dots` and `ratio` are the
 * `<dot>` count and the `<time-modification>` actual/normal ratio.
 *
 * Two cases have to agree for us to trust `<duration>` outright. When the
 * duration lands *exactly* on the plain type value while a dot or a tuplet is
 * present, the writer clearly stored the un-scaled length, so we scale it here
 * instead. Any other combination is treated as a conformant file where
 * `<duration>` already includes the dots and the tuplet.
 */
function noteLengthQuarters(durationQuarters, tQuarters, dots, ratio) {
  const dotFactor = dots > 0 ? 2 - Math.pow(2, -dots) : 1;
  const scaled = (tQuarters === null ? null : tQuarters * dotFactor * ratio);
  if (durationQuarters === null) return scaled;
  if (scaled !== null && dotFactor !== 1 && Math.abs(durationQuarters - tQuarters) < EPS) {
    return scaled;
  }
  if (scaled !== null && ratio !== 1 && Math.abs(durationQuarters - tQuarters * dotFactor) < EPS) {
    return scaled;
  }
  return durationQuarters;
}

/* ------------------------------------------------------- part collection */

function firstParserError(doc) {
  if (tagOf(doc.documentElement) === 'parsererror') return doc.documentElement;
  const list = doc.getElementsByTagName('parsererror');
  return list.length ? list[0] : null;
}

function shorten(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * Build the per-part measure lists for either root flavour.
 *
 * `score-partwise` is `<part><measure>…`, which we walk directly.
 * `score-timewise` is `<measure><part id>…`, which we transpose into the same
 * shape (one entry per root measure, elements copied) so the measure loop below
 * has exactly one code path.
 */
function collectPartMusic(root, rootTag) {
  const records = [];
  const byId = new Map();

  const record = (id) => {
    let rec = byId.get(id);
    if (!rec) {
      rec = { id, measures: [] };
      byId.set(id, rec);
      records.push(rec);
    }
    return rec;
  };

  if (rootTag === 'score-timewise') {
    for (const m of childrenNamed(root, 'measure')) {
      const numAttr = m.getAttribute('number');
      const implicit = m.getAttribute('implicit') === 'yes';
      for (const p of childrenNamed(m, 'part')) {
        record(p.getAttribute('id') || '').measures.push({ numAttr, implicit, els: sliceChildren(p) });
      }
    }
    return { records, byId, record };
  }

  for (const p of childrenNamed(root, 'part')) {
    const rec = record(p.getAttribute('id') || '');
    const measures = p.getElementsByTagName('measure');
    for (let i = 0; i < measures.length; i++) {
      const m = measures[i];
      rec.measures.push({ numAttr: m.getAttribute('number'), implicit: m.getAttribute('implicit') === 'yes', els: m.children });
    }
  }
  return { records, byId, record };
}

/* ------------------------------------------------------- part processing */

function newPartState(rec, index, decl) {
  return {
    index,
    id: rec.id,
    declaration: decl || null,
    measures: rec.measures,
    notes: [],
    /** @type {Map<string, object>} tie start -> surviving note */
    pendingTies: new Map(),
    /** @type {{note:object, length:number, mi:number, off:number}[]} */
    merges: [],
    measureLengths: [],
    divisions: 1,
    hasDivisions: false,
    warnedNoDivisions: false,
    staves: 1,
    clef: 'treble',
    transpose: 0,
    timeSig: { beats: 4, beatType: 4 },
    senzaMisura: false,
    dynamic: 0.8,
    measureTimeSig: null,
    timeSigCaptured: false,
    measureCursor: 0,
    measureMax: 0,
    lastNote: null,
    tuplets: [],
  };
}

/** Remember the time signature in force at the first time-consuming element. */
function captureMeasureTime(state) {
  if (!state.timeSigCaptured) {
    state.timeSigCaptured = true;
    state.measureTimeSig = state.senzaMisura ? null : state.timeSig;
  }
}

function tieStateOf(noteEl) {
  let start = false;
  let stop = false;
  const marks = noteEl.getElementsByTagName('tie');
  for (let i = 0; i < marks.length; i++) {
    const type = marks[i].getAttribute('type');
    if (type === 'start' || type === 'continue') start = true;
    else if (type === 'stop') stop = true;
  }
  // `<tied>` inside <notations> carries the same information; some writers emit
  // only one of the two, so accept either.
  const notations = child(noteEl, 'notations');
  if (notations) {
    const tied = notations.getElementsByTagName('tied');
    for (let i = 0; i < tied.length; i++) {
      const type = tied[i].getAttribute('type');
      if (type === 'start' || type === 'continue') start = true;
      else if (type === 'stop') stop = true;
    }
  }
  return { start, stop };
}

/** Dot count on a note (`<dot/>` is a direct child). */
function dotCount(noteEl) {
  const kids = noteEl.children;
  let dots = 0;
  for (let i = 0; i < kids.length; i++) if (tagOf(kids[i]) === 'dot') dots++;
  return dots;
}

function articulationOf(noteEl) {
  const notations = child(noteEl, 'notations');
  if (!notations) return null;
  const arts = child(notations, 'articulations');
  if (!arts) return null;
  const first = arts.children[0];
  return first ? tagOf(first) : null;
}

function lyricOf(noteEl) {
  const lyric = child(noteEl, 'lyric');
  if (!lyric) return null;
  const text = childText(lyric, 'text');
  return text || null;
}

/**
 * Parse one `<part>`. Notes are pushed with their measure index and their
 * offset inside that measure; absolute quarters are assigned in `finalizePart`.
 */
function parsePart(state, ctx) {
  const { warn } = ctx;

  for (let mi = 0; mi < state.measures.length; mi++) {
    const m = state.measures[mi];
    const els = m.els;
    state.measureCursor = 0;
    state.measureMax = 0;
    state.lastNote = null;
    state.timeSigCaptured = false;
    state.tuplets.length = 0;

    for (let k = 0; k < els.length; k++) {
      const el = els[k];
      const tag = tagOf(el);
      if (tag === 'note') {
        readNote(el, state, mi, ctx);
      } else if (tag === 'backup') {
        captureMeasureTime(state);
        const d = readDuration(el, state, ctx);
        state.measureCursor -= d;
        if (state.measureCursor < -EPS) {
          // Malformed: a backup before the bar started. Keep the bar aligned
          // rather than letting notes drift into the previous measure.
          warn(`Part ${state.id}: <backup> before the start of measure ${m.numAttr || mi + 1}; clamped.`);
          state.measureCursor = 0;
        }
      } else if (tag === 'forward') {
        captureMeasureTime(state);
        state.measureCursor += readDuration(el, state, ctx);
      } else if (tag === 'attributes') {
        readAttributes(el, state, mi, ctx);
      } else if (tag === 'direction') {
        readDirection(el, state, mi, ctx);
      } else if (tag === 'sound') {
        readSound(el, state, mi, ctx);
      }
      if (state.measureCursor > state.measureMax) state.measureMax = state.measureCursor;
    }

    // Bar length: normally the notated time signature, but an explicit pickup
    // (`implicit="yes"`, or a first measure numbered below 1) keeps whatever
    // length the notes actually take.
    const numberValue = parseInt(m.numAttr, 10);
    const isPickup = m.implicit === true || (mi === 0 && Number.isFinite(numberValue) && numberValue < 1);
    const sig = state.measureTimeSig;
    const nominal = sig ? (sig.beats * 4) / sig.beatType : null;
    let length = state.measureMax;
    if (!isPickup && nominal !== null && nominal > length) length = nominal;
    state.measureLengths.push(length);
  }

  if (state.pendingTies.size) {
    let dangling = 0;
    for (const key of state.pendingTies.keys()) {
      if (state.pendingTies.get(key).tieTo) dangling++;
    }
    if (dangling) warn(`Part ${state.id}: ${dangling} note(s) tied past the end of the part; the tie was dropped.`);
    state.pendingTies.clear();
  }
}

/** `<duration>` in divisions → quarters, for `<backup>` / `<forward>`. */
function readDuration(el, state, ctx) {
  const raw = num(childText(el, 'duration'), NaN);
  if (!Number.isFinite(raw)) return 0;
  if (!state.hasDivisions) {
    ctx.warn(`Part ${state.id}: <divisions> was never declared; timing may be wrong.`);
    return 0;
  }
  return raw / state.divisions;
}

function readAttributes(el, state, mi, ctx) {
  const divisionsText = childText(el, 'divisions');
  if (divisionsText) {
    const d = num(divisionsText, 0);
    if (d > 0) {
      state.divisions = d;
      state.hasDivisions = true;
    } else {
      ctx.warn(`Part ${state.id}: <divisions>${shorten(divisionsText, 20)}</divisions> is not a positive number; kept ${state.divisions}.`);
    }
  }

  const key = child(el, 'key');
  if (key) {
    const fifths = num(childText(key, 'fifths'), NaN);
    if (Number.isFinite(fifths)) {
      ctx.keyEvents.push({ m: mi, off: state.measureCursor, fifths, mode: childText(key, 'mode') || null });
    } else {
      ctx.warn(`Part ${state.id}: <key> without a usable <fifths> was ignored.`);
    }
  }

  const time = child(el, 'time');
  if (time) {
    const beats = num(childText(time, 'beats'), NaN);
    const beatType = num(childText(time, 'beat-type'), NaN);
    if (Number.isFinite(beats) && Number.isFinite(beatType) && beatType > 0) {
      ctx.timeEvents.push({ m: mi, off: state.measureCursor, beats, beatType });
      state.timeSig = { beats, beatType };
      state.senzaMisura = false;
    } else if (hasTag(time, 'senza-misura')) {
      state.senzaMisura = true;
      ctx.warn(`Part ${state.id}: <senza-misura>; bar lengths follow the notes.`);
    } else {
      ctx.warn(`Part ${state.id}: <time> needs <beats> and <beat-type>; the previous time signature was kept.`);
    }
  }

  const staves = num(childText(el, 'staves'), NaN);
  if (Number.isFinite(staves) && staves > 0) state.staves = staves;

  for (const c of childrenNamed(el, 'clef')) {
    const number = c.getAttribute('number');
    const type = clefType(childText(c, 'sign'), num(childText(c, 'line'), 0));
    if (number === null || number === '1') state.clef = type;
  }

  const transpose = child(el, 'transpose');
  if (transpose) {
    // `<diatonic>` counts scale steps and `<chromatic>` counts semitones, so a
    // Bb clarinet legitimately reads -1 / -2. Only <chromatic> is used.
    const chromatic = num(childText(transpose, 'chromatic'), NaN);
    const octaveChange = num(childText(transpose, 'octave-change'), 0);
    if (Number.isFinite(chromatic)) {
      // MusicXML's <chromatic> is already the amount to ADD to a written pitch to
      // reach the sounding one (Bb clarinet: written C4 sounds Bb3, so -2).
      // `resolveScore` adds `part.transpose` to written pitches, so it stores the
      // value unchanged — negating here would transpose transposing instruments
      // the wrong way.
      state.transpose = chromatic + 12 * octaveChange;
    } else {
      // Diatonic-only transpose cannot be converted without knowing the key.
      ctx.warn(`Part ${state.id}: <transpose> has no <chromatic>; the part will play as written.`);
    }
  }
}

function readDirection(el, state, mi, ctx) {
  captureMeasureTime(state);

  for (const dt of childrenNamed(el, 'direction-type')) {
    const metronome = child(dt, 'metronome');
    if (metronome) {
      const unit = childText(metronome, 'beat-unit').toLowerCase();
      const beats = QUARTERS_BY_BEAT_UNIT[unit];
      const perMinute = num(childText(metronome, 'per-minute'), NaN);
      if (beats === undefined) {
        ctx.warn(`Part ${state.id}: metronome <beat-unit> "${unit}" is not a note value; the mark was ignored.`);
      } else if (!Number.isFinite(perMinute) || perMinute <= 0) {
        ctx.warn(`Part ${state.id}: metronome mark without a usable <per-minute>; the mark was ignored.`);
      } else {
        // "<beat-unit> = X" counts beats of that note value, so the quarter-note
        // rate is X * (length of the beat in quarters). "half = 90" is 180
        // quarter-notes per minute, not 45.
        const dots = metronome.getElementsByTagName('beat-unit-dot').length;
        const dotFactor = dots > 0 ? 2 - Math.pow(2, -dots) : 1;
        ctx.addTempo({
          m: mi,
          off: state.measureCursor,
          bpm: perMinute * beats * dotFactor,
          rank: 1,
          label: `${unit}${dots ? '.'.repeat(dots) : ''} = ${perMinute}`,
        });
      }
    }

    const dynamics = child(dt, 'dynamics');
    if (dynamics) {
      const marks = dynamics.children;
      for (let i = 0; i < marks.length; i++) {
        const name = tagOf(marks[i]);
        const velocity = DYNAMIC_VELOCITY[name.toLowerCase()];
        if (velocity !== undefined) {
          state.dynamic = velocity;
          break;
        }
      }
    }
  }

  // <sound> is allowed as a child of <direction> as well as of <measure>.
  const sound = child(el, 'sound');
  if (sound) readSound(sound, state, mi, ctx);
}

function readSound(el, state, mi, ctx) {
  captureMeasureTime(state);
  const tempo = el.getAttribute('tempo');
  if (tempo == null) return;
  const bpm = num(tempo, NaN);
  if (!Number.isFinite(bpm) || bpm <= 0) {
    ctx.warn(`Part ${state.id}: <sound tempo="${shorten(tempo, 16)}"> is not a positive number; ignored.`);
    return;
  }
  ctx.addTempo({ m: mi, off: state.measureCursor, bpm, rank: 2, label: `${bpm} BPM` });
}

/**
 * One `<note>`. Rests, cues and chords are all special: a rest advances the
 * clock without sounding, a cue is skipped entirely, and a `<chord/>` note
 * takes its onset from the note before it and does not advance the clock.
 */
function readNote(el, state, mi, ctx) {
  const isChord = hasTag(el, 'chord');
  const isRest = hasTag(el, 'rest');
  const isCue = hasTag(el, 'cue');
  const isGrace = hasTag(el, 'grace');

  captureMeasureTime(state);

  // Cues are editorial: drop them without touching the clock.
  if (isCue) return;

  const durationText = childText(el, 'duration');
  let durationQuarters = null;
  if (durationText) {
    const raw = num(durationText, NaN);
    // Without <divisions> a <duration> is meaningless, so fall through to the
    // <type> calculation instead of trusting a bare unit count.
    if (Number.isFinite(raw) && raw >= 0 && state.hasDivisions) durationQuarters = raw / state.divisions;
  }
  if (!state.hasDivisions && !state.warnedNoDivisions) {
    state.warnedNoDivisions = true;
    ctx.warn(`Part ${state.id}: <divisions> was never declared; note lengths were taken from <type>.`);
  }

  const tQuarters = typeQuarters(childText(el, 'type'));
  const dots = dotCount(el);
  const tm = child(el, 'time-modification');
  const tupletStart = childrenNamed(el, 'tuplet');

  // A <tuplet type="start"> written on this note means *this* note belongs to
  // that tuplet, so its ratio belongs to this note too.
  let ownTupletRatio = 1;
  for (let i = 0; i < tupletStart.length; i++) {
    if (tupletStart[i].getAttribute('type') !== 'start') continue;
    const actual = num(tupletStart[i].getAttribute('actual-notes'), 0);
    const normal = num(tupletStart[i].getAttribute('normal-notes'), 0);
    ownTupletRatio *= actual > 0 && normal > 0 ? actual / normal : 1;
  }

  let ratio = 1;
  if (tm) {
    const actual = num(childText(tm, 'actual-notes'), 0);
    const normal = num(childText(tm, 'normal-notes'), 0);
    if (actual > 0 && normal > 0) ratio = actual / normal;
    else ctx.warn(`Part ${state.id}: incomplete <time-modification>; the note plays undivided.`);
  } else {
    // No note-level <time-modification>: scale by every <tuplet> still open
    // *and* the one this note opens, so a triplet inside a triplet nests.
    ratio = ownTupletRatio;
    for (let i = 0; i < state.tuplets.length; i++) ratio *= state.tuplets[i];
  }

  const length = noteLengthQuarters(durationQuarters, tQuarters, dots, ratio);
  const quavers = length === null || !Number.isFinite(length) ? 0.25 : length;
  const voice = num(childText(el, 'voice'), 1) || 1;
  const staff = num(childText(el, 'staff'), 1) || 1;

  // Keep the note's tuplets open for the notes that follow it.
  for (let i = 0; i < tupletStart.length; i++) {
    const t = tupletStart[i];
    if (t.getAttribute('type') !== 'start') continue;
    const actual = num(t.getAttribute('actual-notes'), 0);
    const normal = num(t.getAttribute('normal-notes'), 0);
    state.tuplets.push(actual > 0 && normal > 0 ? actual / normal : 1);
  }

  // Rests keep the rhythm but make no sound.
  if (isRest) {
    if (!isChord && !isGrace) state.measureCursor += quavers;
    for (const t of tupletStart) {
      if (t.getAttribute('type') === 'stop') state.tuplets.pop();
    }
    return;
  }

  const pitchEl = child(el, 'pitch');
  const unpitchedEl = child(el, 'unpitched');
  let midi = null;
  let badReason = '';
  if (pitchEl) {
    const step = childText(pitchEl, 'step');
    const octave = num(childText(pitchEl, 'octave'), NaN);
    midi = pitchToMidi(step, num(childText(pitchEl, 'alter'), 0), octave);
    if (midi === null) {
      badReason = STEP_SEMITONE[step] === undefined
        ? `an unsupported note name ("${step}")`
        : 'a missing <octave>';
    }
  } else if (unpitchedEl) {
    // Percussion: fall back to the display pitch when the writer gives one.
    midi = pitchToMidi(childText(unpitchedEl, 'display-step'), 0, num(childText(unpitchedEl, 'display-octave'), NaN));
    if (midi === null) badReason = '<unpitched> without <display-step>';
  } else {
    // Neither pitched nor unpitched: nothing to play, but the time is still spent.
    if (!isChord && !isGrace) state.measureCursor += quavers;
    return;
  }
  if (midi === null) {
    ctx.warn(`Part ${state.id}: skipped a note with ${badReason}.`);
    if (!isChord && !isGrace) state.measureCursor += quavers;
    return;
  }
  if (midi < 0 || midi > 127) {
    ctx.warnOnce('range', `Part ${state.id}: ${midi} is outside MIDI range and was skipped.`);
    if (!isChord && !isGrace) state.measureCursor += quavers;
    return;
  }

  const tie = tieStateOf(el);
  const key = voice + ':' + midi;

  let onset;
  if (isChord && state.lastNote) {
    onset = state.lastNote._o;
  } else {
    if (isChord && !state.lastNote) {
      ctx.warnOnce('orphan-chord', `Part ${state.id}: a <chord/> note with nothing to attach to was treated as a normal note.`);
    }
    onset = state.measureCursor;
  }

  // A tie stop continues the earlier note: it must not create a second note,
  // but it still consumes time so the bar stays correct.
  const previous = tie.stop ? state.pendingTies.get(key) : null;
  if (tie.stop && !previous) {
    ctx.warnOnce('orphan-tie', `Part ${state.id}: a tie had no matching start note; the note was kept separate.`);
  }

  if (!previous) {
    const note = makeNote({
      midi,
      quarter: 0,                 // replaced by the shared bar grid in finalize
      durationQuarters: quavers,
      staff,
      voice,
      chord: isChord,
      grace: isGrace,
      lyric: lyricOf(el),
      articulation: articulationOf(el),
      velocity: state.dynamic,
    });
    note._m = mi;
    note._o = onset;
    state.notes.push(note);
    if (!isChord) {
      // Grace notes are printed before the beat they decorate and take no time.
      if (!isGrace) state.measureCursor += quavers;
      state.lastNote = note;
    }
    if (tie.start) note.tieTo = true;
    if (tie.stop) note.tieFrom = true;   // continuation whose start note is missing
  } else {
    state.merges.push({ note: previous, length: quavers, mi, off: onset });
    if (!isChord && !isGrace) state.measureCursor += quavers;
    // The surviving note is still the sounding onset of this position, so a
    // <chord/> tone written against the tied note must hang off it.
    if (!isChord) state.lastNote = previous;
    previous.tieFrom = true;
    if (tie.start) previous.tieTo = true;
  }

  if (tie.start) state.pendingTies.set(key, previous || state.notes[state.notes.length - 1]);
  else if (tie.stop && previous) state.pendingTies.delete(key);

  for (const t of tupletStart) {
    if (t.getAttribute('type') === 'stop') state.tuplets.pop();
  }
}

/* -------------------------------------------------------------- finalize */

/** Assign absolute quarters from the shared bar grid, then sort. */
function finalizePart(part, state, starts) {
  const startOf = (m, o) => starts[Math.min(m, starts.length - 1)] + o;

  // Tie chains first: a continuation extends the surviving note, and the gap
  // between them is real time (the bar grid may have padded the earlier bar),
  // so it has to be added to the merged length.
  for (const merge of state.merges) {
    const noteStart = startOf(merge.note._m, merge.note._o);
    const contStart = startOf(merge.mi, merge.off);
    const gap = Math.max(0, contStart - (noteStart + merge.note.durationQuarters));
    merge.note.durationQuarters += gap + merge.length;
  }

  for (const note of state.notes) {
    note.quarter = startOf(note._m, note._o);
    // Which bar the note came from, for anything that has to line this part's
    // timeline up with another view of the same bars -- the notation cursor
    // does, and a check that the cursor sits in the right bar needs the truth
    // to compare against.
    note.measure = note._m;
    delete note._m;
    delete note._o;
  }

  state.notes.sort((a, b) => (a.quarter - b.quarter) || (a.midi - b.midi));
  part.notes = state.notes;
}

/* ------------------------------------------------------------ public API */

/**
 * Parse a MusicXML document into the internal score model.
 *
 * @param {string} xmlString the original MusicXML text (kept verbatim on the score)
 * @param {{defaultTempo?:number, maxWarnings?:number, fileName?:string}} [opts]
 * @returns {import('../score/model.js').Score}
 * @throws {Error} only for input that cannot be read at all
 */
export function parseMusicXml(xmlString, opts = {}) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const defaultTempo = Number.isFinite(options.defaultTempo) && options.defaultTempo > 0 ? options.defaultTempo : 100;
  const maxWarnings = Number.isFinite(options.maxWarnings) ? options.maxWarnings : 200;

  if (typeof xmlString !== 'string' || !xmlString.trim()) {
    throw new Error('MusicXML: nothing to parse — the input is empty.');
  }

  const doc = new DOMParser().parseFromString(xmlString, 'text/xml');
  const parseError = firstParserError(doc);
  if (parseError) {
    throw new Error(`MusicXML: the file is not valid XML — ${shorten(parseError.textContent, 220)}`);
  }

  const root = doc.documentElement;
  if (!root) throw new Error('MusicXML: the document is empty.');
  const rootTag = tagOf(root);
  if (rootTag !== 'score-partwise' && rootTag !== 'score-timewise') {
    throw new Error(`MusicXML: the root element is <${rootTag}>, expected <score-partwise> or <score-timewise>.`);
  }

  const warnings = [];
  const seenWarnings = new Set();
  let suppressed = 0;
  const pushWarning = (message) => {
    if (warnings.length >= maxWarnings) { suppressed++; return; }
    warnings.push(message);
  };
  const warnOnce = (key, message) => {
    if (seenWarnings.has(key)) return;
    seenWarnings.add(key);
    pushWarning(message);
  };
  const warn = (message) => {
    if (seenWarnings.has(message)) return;
    seenWarnings.add(message);
    pushWarning(message);
  };

  /* ---- declarations from <part-list> ---- */
  const declarations = new Map();
  const partList = child(root, 'part-list');
  if (partList) {
    for (const sp of childrenNamed(partList, 'score-part')) {
      const id = sp.getAttribute('id') || '';
      const scoreInstruments = childrenNamed(sp, 'score-instrument');
      declarations.set(id, {
        id,
        name: childText(sp, 'part-name'),
        abbrev: childText(sp, 'part-abbreviation'),
        instrumentName: scoreInstruments.length ? childText(scoreInstruments[0], 'instrument-name') : '',
      });
    }
  }

  const music = collectPartMusic(root, rootTag);
  // Keep declared-but-silent parts so the part list matches the file.
  for (const [id, decl] of declarations) if (!music.byId.has(id)) music.record(id);
  if (!music.records.length) {
    throw new Error('MusicXML: the file contains no <part> elements, so there is nothing to play.');
  }

  /* ---- tempo / key / time events, collected from every part ---- */
  const tempoEvents = [];
  const ctx = {
    warn,
    warnOnce,
    keyEvents: [],
    timeEvents: [],
    addTempo(event) {
      tempoEvents.push(event);
    },
  };

  const states = music.records.map((rec, i) => {
    const state = newPartState(rec, i, declarations.get(rec.id));
    return state;
  });

  /* ---- pass 1: read every part ---- */
  for (const state of states) {
    try {
      parsePart(state, ctx);
    } catch (err) {
      // One unreadable part must not lose the rest of the score.
      warn(`Part "${state.id}" could not be read completely (${shorten(err && err.message, 120)}); it may be missing notes.`);
    }
  }

  /* ---- pass 2: one shared bar grid, the longest reading of each bar ---- */
  const barCount = states.reduce((max, s) => Math.max(max, s.measureLengths.length), 0);
  const starts = new Array(barCount + 1);
  starts[0] = 0;
  for (let i = 0; i < barCount; i++) {
    let length = 0;
    for (const state of states) {
      if (i < state.measureLengths.length && state.measureLengths[i] > length) length = state.measureLengths[i];
    }
    starts[i + 1] = starts[i] + length;
  }
  const totalQuarters = starts[barCount] || 0;

  /* ---- pass 3: absolute quarters + sorted note lists ---- */
  const parts = [];
  for (const state of states) {
    const decl = state.declaration;
    const part = makePart({
      id: decl && decl.id ? decl.id : state.id || 'P' + (state.index + 1),
      name: (decl && (decl.name || decl.instrumentName)) || state.id || 'Part ' + (state.index + 1),
      abbrev: (decl && decl.abbrev) || '',
      transpose: state.transpose,
      staves: state.staves,
      clef: state.clef,
      notes: [],
      channel: state.index,
    });
    if (decl && decl.instrumentName) part.instrumentName = decl.instrumentName;
    finalizePart(part, state, starts);
    parts.push(part);
  }

  /* ---- tempo map (quarters are only known once the bar grid exists) ---- */
  const tempoByQuarter = new Map();
  for (const ev of tempoEvents) {
    ev.at = starts[Math.min(ev.m, barCount)] + ev.off;
    // `<sound tempo>` outranks a metronome mark at the same instant.
    const existing = tempoByQuarter.get(ev.at);
    if (existing && existing.rank >= ev.rank) continue;
    tempoByQuarter.set(ev.at, ev);
  }
  const orderedTempos = [...tempoByQuarter.values()].sort((a, b) => a.at - b.at);
  const tempoMarks = orderedTempos.map((t) => ({ quarter: t.at, bpm: t.bpm, label: t.label }));
  if (!orderedTempos.length) {
    tempoMarks.push({ quarter: 0, bpm: defaultTempo, label: `${defaultTempo} BPM` });
  } else if (orderedTempos[0].at > 0) {
    // `Timing` needs an entry at 0; the piece starts at the first mark's speed.
    tempoMarks.unshift({ quarter: 0, bpm: orderedTempos[0].bpm, label: orderedTempos[0].label });
  }
  const tempoMap = tempoMarks.map((t) => ({ quarter: t.quarter, bpm: t.bpm }));

  /* ---- key + time signature maps ---- */
  const keySeen = new Set();
  const keySigs = [];
  for (const ev of ctx.keyEvents) {
    ev.at = starts[Math.min(ev.m, barCount)] + ev.off;
    const key = ev.at + ':' + ev.fifths + ':' + (ev.mode || '');
    if (keySeen.has(key)) continue;
    keySeen.add(key);
    keySigs.push({ quarter: ev.at, fifths: ev.fifths, mode: ev.mode });
  }
  keySigs.sort((a, b) => a.quarter - b.quarter);
  if (!keySigs.length) keySigs.push({ quarter: 0, fifths: 0, mode: null });

  const timeSeen = new Set();
  const timeSigs = [];
  for (const ev of ctx.timeEvents) {
    ev.at = starts[Math.min(ev.m, barCount)] + ev.off;
    const key = ev.at + ':' + ev.beats + ':' + ev.beatType;
    if (timeSeen.has(key)) continue;
    timeSeen.add(key);
    timeSigs.push({ quarter: ev.at, beats: ev.beats, beatType: ev.beatType });
  }
  timeSigs.sort((a, b) => a.quarter - b.quarter);
  if (!timeSigs.length) timeSigs.push({ quarter: 0, beats: 4, beatType: 4 });

  /* ---- metadata ---- */
  const work = child(root, 'work');
  const identification = child(root, 'identification');
  let title = work ? childText(work, 'work-title') : '';
  if (!title) title = childText(root, 'movement-title');

  let composer = '';
  if (identification) {
    for (const creator of childrenNamed(identification, 'creator')) {
      const type = (creator.getAttribute('type') || '').toLowerCase();
      if (type === 'composer' || type === 'composers') {
        composer = (creator.textContent || '').trim();
        break;
      }
    }
  }

  /* ---- measure numbering sanity ---- */
  let highestNumber = 0;
  for (const state of states) {
    for (const m of state.measures) {
      const n = parseInt(m.numAttr, 10);
      if (Number.isFinite(n) && n > highestNumber) highestNumber = n;
    }
  }
  if (barCount && highestNumber && highestNumber !== barCount) {
    warn(`Measure numbering ends at ${highestNumber} but the file contains ${barCount} bar(s); playback follows document order.`);
  }

  if (suppressed) pushWarning(`…and ${suppressed} more warning(s) suppressed.`);

  const score = createScore({
    title: title || 'Untitled',
    composer,
    sourceFormat: 'musicxml',
    parts,
    tempoMap,
    tempoMarks,
    keySigs,
    timeSigs,
    totalQuarters,
    measureCount: barCount,
    // The bar grid playback runs on: measureStarts[i] is the absolute quarter
    // where bar i begins, derived from what each bar actually CONTAINS (an
    // overfull bar gets its real length, an empty one gets none). Notation
    // engines lay the same bars out by their own arithmetic, so anything
    // mapping between the two timelines anchors on this grid per bar instead
    // of trusting absolute timestamps to agree across a whole piece.
    measureStarts: starts.slice(0, barCount + 1),
    rawMusicXml: xmlString,
    warnings,
  });
  // io/files.js passes the originating filename through; keep it for the UI.
  if (typeof options.fileName === 'string' && options.fileName) score.fileName = options.fileName;
  return score;
}