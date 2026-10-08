/**
 * io/mscx.js — MuseScore's native project format (`.mscx`, or the `.mscx`
 * inside a `.mscz` zip) → internal score.
 *
 * Design notes
 * ------------
 * MuseScore's own XML is NOT MusicXML, so `io/musicxml.js` cannot read it.
 * The dialect follows how MuseScore lays a score out on screen rather than how
 * an interchange format describes one:
 *
 *   <museScore>            root; carries `version`
 *     <Score>              one score
 *       <Division>480      ticks per quarter note — MuseScore's internal unit
 *       <metaTag name="workTitle">…</metaTag>
 *       <Part>             → exactly one internal part
 *         <Staff id="1">   → one *staffline* (a piano part has two of them)
 *           <Measure>      → one bar
 *             <voice>      → voice 1, 2, 3, …
 *               <Chord>/<Rest>/<Tuplet>/<KeySig>/<TimeSig>/<Tempo>/<Spanner>
 *
 * Three consequences drive the whole implementation:
 *
 *  1. **Ticks are an input unit only.** Everything is divided by `<Division>`
 *     on the way in, so nothing downstream ever sees a MuseScore tick.
 *  2. **A part may have several staves**, and the staves must stay aligned, so
 *     bars are walked *across* the staves of a part (bar N of every staff
 *     together) rather than staff by staff.
 *  3. **Ties are two different things depending on the file's age.** Modern
 *     files hang a `<Spanner type="Tie">` inside the `<Note>` it belongs to,
 *     with `<next>`/`<prev>` `<location>` offsets saying where the other end
 *     is; older ones put a bare `<Tie>` on the note. Both become
 *     (from-quarter, to-quarter, pitch) intents that are merged afterwards, so
 *     ties across barlines, three-note chains and partial chords all take one
 *     code path.
 *
 * Grace notes, tuplets (including nested ones), pickup bars, whole-measure
 * rests, `<location>` jumps and unknown elements are all expected and must not
 * break the walk. Anything recoverable becomes a readable string in
 * `score.warnings`; we throw only when there is no score in the XML at all.
 */

import { createScore, makePart, makeNote } from '../score/model.js';

/* ---------------------------------------------------------------- constants */

const DEBUG = false;

/** `<durationType>` → length in quarter notes. */
const DURATION_QUARTERS = {
  // Per the parse contract both spellings read as 16 quarters here. (MuseScore
  // itself draws a `breve` as 8 and a `long` as 16; `long` is the spelling that
  // actually occurs, and the contract pins both to 16 — change this one line if
  // it ever has to follow MuseScore exactly.)
  breve: 16,
  long: 16,
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  '16th': 0.25,
  '32nd': 0.125,
  '64th': 1 / 16,
  '128th': 1 / 32,
  '256th': 1 / 64,
  '512th': 1 / 128,
  '1024th': 1 / 256,
};

const DEFAULT_DIVISION = 480;
const DEFAULT_BPM = 100;
const TIE_TOLERANCE = 1e-3;   // quarters: two ways of writing one tick rarely agree exactly
const MAX_WARNINGS = 40;
const MIN_DUR_QUARTERS = 1 / 1024;

/** MuseScore clef names → the model's clef ids. */
const CLEF_ID = {
  G: 'treble', F: 'bass', C: 'alto', percussion: 'percussion', TAB: 'tab',
};

/* ------------------------------------------------------------------ helpers */

/** Direct element children in document order. `localName` keeps this safe. */
function elementChildren(el) {
  const out = [];
  if (!el) return out;
  for (let n = el.firstElementChild; n; n = n.nextElementSibling) out.push(n);
  return out;
}

/** First direct child with this local name, or null. */
function childEl(el, name) {
  if (!el) return null;
  for (let n = el.firstElementChild; n; n = n.nextElementSibling) {
    if (n.localName === name) return n;
  }
  return null;
}

/** All direct children with this local name. */
function childEls(el, name) {
  return elementChildren(el).filter((n) => n.localName === name);
}

function textOf(el) {
  if (!el) return null;
  const t = el.textContent;
  return t == null ? null : String(t).trim();
}

/** Trimmed text of the first direct child with this name. */
function childText(el, name) {
  return textOf(childEl(el, name));
}

/** `Number` of the first direct child with this name, or `fallback`. */
function numOf(el, name, fallback = null) {
  const t = childText(el, name);
  if (t == null || t === '') return fallback;
  const v = parseFloat(t);
  return Number.isFinite(v) ? v : fallback;
}

/** `"1/2"` or `"-0.5"` → 0.5 / -0.5. Anything unparseable is 0. */
function fractionOf(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return 0;
  const m = /^([+-]?\d+)\s*\/\s*(\d+)$/.exec(s);
  if (m) {
    const d = parseInt(m[2], 10);
    return d ? parseInt(m[1], 10) / d : 0;
  }
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : 0;
}

/** `"2"` → 2, `null`/`""`/garbage → null. */
function numberOrNull(value) {
  if (value == null || String(value).trim() === '') return null;
  const v = parseFloat(String(value).trim());
  return Number.isFinite(v) ? v : null;
}

/** 1 dot → 1.5, 2 dots → 1.75, … */
function dotScale(dots) {
  const n = Math.max(0, Math.min(12, Math.round(Number(dots) || 0)));
  return 2 - Math.pow(2, -n);
}

/** Length of one bar of a time signature, in quarters. */
function barQuarters(ts) {
  return (ts.beats * 4) / (ts.beatType || 4);
}

/** Round away float noise so assertions behave. */
function tidy(q) {
  return Math.round(q * 1e9) / 1e9;
}

function dbg() {
  if (!DEBUG) return;
  // eslint-disable-next-line no-console
  console.log.apply(console, ['[mscx]'].concat([].slice.call(arguments)));
}

/* ------------------------------------------------------------------- parse */

/**
 * Parse a MuseScore `.mscx` document.
 *
 * @param {string} xmlString text of the `.mscx` file inside a `.mscz`
 * @param {object} [opts]
 * @param {string} [opts.fileName] only used to make error messages readable
 * @param {string} [opts.title] fallback title when the file carries none
 * @returns {object} Score
 */
export function parseMuseScoreXml(xmlString, opts = {}) {
  const fileName = opts.fileName ? ` (${opts.fileName})` : '';

  if (typeof xmlString !== 'string' || !xmlString.trim()) {
    throw new Error(
      `parseMuseScoreXml${fileName}: expected the text of a MuseScore .mscx file, got ${typeof xmlString}.`
    );
  }

  const doc = new DOMParser().parseFromString(xmlString, 'text/xml');

  const parseError = doc.getElementsByTagName('parsererror')[0] || null;
  if (parseError || !doc.documentElement) {
    const detail = (parseError ? parseError.textContent : '').replace(/\s+/g, ' ').trim();
    throw new Error(`parseMuseScoreXml${fileName}: the file is not well-formed XML. ${detail}`.trim());
  }

  const root = doc.documentElement;
  if (root.localName !== 'museScore') {
    throw new Error(
      `parseMuseScoreXml${fileName}: expected a <museScore> document but found <${root.localName}> — ` +
      'that is not MuseScore\'s native format.'
    );
  }

  const scoreEl = childEl(root, 'Score') || doc.getElementsByTagName('Score')[0] || null;
  if (!scoreEl) {
    throw new Error(`parseMuseScoreXml${fileName}: the document has no <Score> element — there is no music in it.`);
  }

  /* -- warning sink (deduplicated, capped) ----------------------------- */
  const seen = new Set();
  let suppressed = 0;
  const warnings = [];
  function warn(message) {
    if (seen.has(message)) { suppressed++; return; }
    if (warnings.length >= MAX_WARNINGS) { suppressed++; return; }
    seen.add(message);
    warnings.push(message);
  }

  /* -- score-wide metadata --------------------------------------------- */
  const meta = readMeta(scoreEl);
  const score = createScore({
    title: meta.title || opts.title || 'Untitled',
    composer: meta.composer || '',
    sourceFormat: 'mscx',
    rawMusicXml: null,     // no MusicXML view of a MuseScore file; the app uses the piano roll
    tempoMap: [{ quarter: 0, bpm: DEFAULT_BPM }],
    keySigs: [],
    timeSigs: [],
    parts: [],
    warnings,
  });
  if (meta.subtitle) score.subtitle = meta.subtitle;

  /* -- division: MuseScore's ticks per quarter ------------------------- */
  const declaredDivision = numOf(scoreEl, 'Division', null);
  if (!(declaredDivision > 0)) warn('The file declares no <Division>; assumed 480 ticks per quarter note.');

  const ctx = {
    division: declaredDivision > 0 ? declaredDivision : DEFAULT_DIVISION,
    warn,
    /** Time signature in force, carried between bars (whole-bar rests need it). */
    ts: { beats: 4, beatType: 4 },
    /** Per-part output sinks, swapped by parsePart so ties cannot cross parts. */
    sink: newSink(),
    events: [],
  };

  /* -- parts ------------------------------------------------------------ */
  const partEls = childEls(scoreEl, 'Part');
  if (!partEls.length) warn('The score contains no <Part> elements.');
  let bars = 0;
  let length = 0;
  partEls.forEach((partEl, i) => {
    const parsed = parsePart(partEl, ctx, i);
    if (!parsed) return;
    score.parts.push(parsed.part);
    bars = Math.max(bars, parsed.bars);
    length = Math.max(length, parsed.length);
  });

  /* -- flatten: sort notes, then merge ties ----------------------------- */
  for (const part of score.parts) {
    resolveTies(part, ctx.warn);
    for (const n of part.notes) { delete n._tieKey; delete n._legacyTie; }
    delete part._sink;
    part.notes.sort((a, b) => (a.quarter - b.quarter) || (a.midi - b.midi) || (a.staff - b.staff));
  }

  applyEvents(ctx, score);

  score.measureCount = bars;
  let last = 0;
  for (const part of score.parts) {
    for (const n of part.notes) last = Math.max(last, n.quarter + Math.max(0, n.durationQuarters));
  }
  score.totalQuarters = tidy(Math.max(length, last));

  if (suppressed) warnings.push(`${suppressed} further warning${suppressed === 1 ? '' : 's'} suppressed.`);
  dbg('parsed', score.parts.length, 'part(s),', score.totalQuarters, 'quarters');
  return score;
}

/** Per-part output: where notes, events, tie intents and loose ties land. */
function newSink() {
  return { notes: [], events: [], ties: [], loose: [] };
}

/* -------------------------------------------------------------------- meta */

function readMeta(scoreEl) {
  const out = { title: '', composer: '', subtitle: '' };
  for (const tag of childEls(scoreEl, 'metaTag')) {
    const name = (tag.getAttribute('name') || '').toLowerCase();
    const value = (tag.textContent || '').trim();
    if (!value) continue;
    if (name === 'worktitle') out.title = out.title || value;
    else if (name === 'movementtitle') out.title = out.title || value;
    else if (name === 'subtitle') out.subtitle = out.subtitle || value;
    else if (name === 'composer') out.composer = out.composer || value;
    else if (name === 'lyricist') out.composer = out.composer || value;
  }
  // Some exporters write plain elements instead of metaTags.
  if (!out.title) out.title = childText(scoreEl, 'workTitle') || childText(scoreEl, 'movementTitle') || '';
  if (!out.subtitle) out.subtitle = childText(scoreEl, 'subtitle') || '';
  if (!out.composer) out.composer = childText(scoreEl, 'composer') || '';
  return out;
}

/* -------------------------------------------------------------------- part */

/**
 * One `<Part>` → one model part, with every staff merged into it.
 *
 * @returns {{part: object, bars: number, length: number}|null}
 */
function parsePart(partEl, ctx, index) {
  const sink = newSink();
  ctx.sink = sink;

  const instrument = childEl(partEl, 'Instrument');
  const name = childText(instrument, 'longName')
    || childText(partEl, 'trackName')
    || childText(instrument, 'shortName')
    || `Part ${index + 1}`;

  // MuseScore writes the transposition in both a diatonic and a chromatic form.
  // The model wants semitones, so `transposeChromatic` is the one to read;
  // `transposeOctave` is normally 0 and is already inside the chromatic value.
  const chromatic = numOf(instrument, 'transposeChromatic', null);
  const diatonic = numOf(instrument, 'transposeDiatonic', null);
  const transpose = Math.round(chromatic == null ? (diatonic == null ? 0 : diatonic) : chromatic);

  const program = numOf(childEl(partEl, 'Channel'), 'program', null);

  const part = makePart({
    id: 'P' + (index + 1),
    name,
    abbrev: childText(instrument, 'shortName') || '',
    transpose,
    staves: 1,
    notes: sink.notes,
  });
  if (program != null) part.midiProgram = Math.max(0, Math.min(127, Math.round(program)));

  /* -- which `<Staff>` elements actually carry music? ------------------- */
  // MuseScore writes a *properties-only* `<Staff id="1">` (holding just a
  // `<StaffType>`) before the `<Instrument>`, then a second `<Staff id="1">`
  // with the measures in it. Only the second is a staffline with notes.
  const allStaves = childEls(partEl, 'Staff');
  let stavesEls = allStaves.filter((el) => childEls(el, 'Measure').length);
  if (!stavesEls.length && allStaves.length) {
    stavesEls = allStaves;
    ctx.warn(`Part "${name}" has staves but no bars — it is empty.`);
  }

  const staves = stavesEls.map((el, i) => {
    const id = numberOrNull(el.getAttribute('id'));
    return { el, id: id && id > 0 ? Math.round(id) : i + 1, measures: childEls(el, 'Measure') };
  });
  part.staves = Math.max(1, staves.length);
  if (staves.length > 1) ctx.warn(`Part "${name}" has ${staves.length} staves; they were merged into one part.`);

  /* -- walk bar by bar so every staff of this part stays aligned -------- */
  const bars = staves.reduce((m, s) => Math.max(m, s.measures.length), 0);
  let barStart = 0;
  let missing = 0;

  for (let m = 0; m < bars; m++) {
    const tsAtStart = { beats: ctx.ts.beats, beatType: ctx.ts.beatType };
    const collected = [];
    let firstVoiceSum = 0;

    staves.forEach((s) => {
      const measureEl = s.measures[m];
      if (!measureEl) { missing++; return; }
      // A bar with no `<voice>` is malformed but not fatal: walk it as if it
      // were voice 1 so whatever is in it still sounds.
      const voiceEls = childEls(measureEl, 'voice');
      const groups = voiceEls.length ? voiceEls : [measureEl];
      groups.forEach((voiceEl, vi) => {
        const bucket = { notes: [], events: [], ties: [], loose: [], total: 0 };
        bucket.total = walkVoice(voiceEl, {
          ctx,
          staff: s.id,
          voice: vi + 1,
          tupletRatio: 1,
          grace: false,
          cursor: { q: 0 },        // bar-relative for now; shifted on commit
          bucket,
        });
        collected.push(bucket);
        if (vi === 0) firstVoiceSum = Math.max(firstVoiceSum, bucket.total);
      });
    });

    /* -- how long is this bar? ------------------------------------------ */
    let declared = null;
    for (const s of staves) {
      const measureEl = s.measures[m];
      if (!measureEl) continue;
      const attr = measureEl.getAttribute('len');
      const raw = attr != null && attr !== '' ? attr : childText(measureEl, 'len');
      if (raw == null || raw === '') continue;
      const frac = fractionOf(raw);
      if (!(frac > 0)) {
        ctx.warn(`Bar ${m + 1} declares an unusable length ("${raw}"); used the notes instead.`);
        continue;
      }
      // `len` is a fraction of the whole bar for the time signature in force,
      // so a 4/4 bar with len="1/4" is one quarter long (a pickup bar).
      const quarters = frac * barQuarters(tsAtStart);
      declared = declared == null ? quarters : Math.max(declared, quarters);
    }

    if (declared != null && Math.abs(declared - firstVoiceSum) > TIE_TOLERANCE) {
      ctx.warn(
        `Bar ${m + 1} of "${name}" declares ${tidy(declared)} quarter(s) but its notes add up to ` +
        `${tidy(firstVoiceSum)}; used the longer.`
      );
    }
    const length = Math.max(declared == null ? 0 : declared, firstVoiceSum);

    /* -- commit the bar ------------------------------------------------- */
    for (const bucket of collected) {
      for (const n of bucket.notes) n.quarter = tidy(barStart + n.quarter);
      for (const ev of bucket.events) ev.quarter = tidy(barStart + ev.quarter);
      // Tie intents were recorded at bar-relative positions; move them onto the
      // same absolute timeline as the notes they refer to.
      for (const t of bucket.ties) {
        t.fromQ = tidy(barStart + t.fromQ);
        t.toQ = tidy(barStart + t.toQ);
      }
      for (const l of bucket.loose) l.at = tidy(barStart + l.at);
      sink.notes.push(...bucket.notes);
      sink.events.push(...bucket.events);
      sink.ties.push(...bucket.ties);
      sink.loose.push(...bucket.loose);
    }

    barStart = tidy(barStart + length);
  }

  // Score-level events (tempo, key, metre) are collected per part and folded
  // into the score's maps once every part has been walked.
  ctx.events.push(...sink.events);

  if (missing) {
    ctx.warn(
      `Part "${name}" is missing ${missing} bar${missing === 1 ? '' : 's'} in one or more staves; ` +
      'the staves that do have the bar set where it starts.'
    );
  }

  part.clef = sink.clef || 'treble';
  part._sink = sink;          // tie intents are resolved after every part is walked
  return { part, bars, length: barStart };
}

/* ------------------------------------------------------------------- voice */

/** Walk one `<voice>` (or a bar with no `<voice>`). Returns quarters consumed. */
function walkVoice(voiceEl, c) {
  return walkElements(voiceEl, c);
}

function walkElements(parent, c) {
  let advanced = 0;
  for (const el of elementChildren(parent)) {
    switch (el.localName) {
      case 'Tuplet': {
        const normal = numOf(el, 'normalNotes', 0);
        const actual = numOf(el, 'actualNotes', 0);
        let ratio = 1;
        if (normal > 0 && actual > 0) {
          // `actualNotes` notes are squeezed into the time of `normalNotes`, so
          // each one is scaled by normalNotes/actualNotes: three eighths in the
          // time of two are 1/3 of a quarter each, and three of them total one
          // quarter. (The parse contract words this ratio the other way round —
          // "scale by actualNotes/normalNotes" — which would make a triplet
          // take *more* time than the notes it replaces, so the musically
          // correct direction is used here. This is the only place where the
          // implementation knowingly diverges from that wording.)
          ratio = normal / actual;
        } else {
          c.ctx.warn('A <Tuplet> without <normalNotes>/<actualNotes> was read as ordinary notes.');
        }
        // Nested tuplets multiply their ratios. The sub-walk's return value is
        // the length the group actually occupies, so it must be accumulated.
        advanced += walkElements(el, { ...c, tupletRatio: c.tupletRatio * ratio });
        break;
      }

      case 'Chord':
        advanced += walkChord(el, c);
        break;

      case 'Rest':
        advanced += walkRest(el, c);
        break;

      case 'KeySig': {
        const fifths = numberOrNull(childText(el, 'concertKey'))
          ?? numberOrNull(childText(el, 'accidental'))
          ?? 0;
        c.bucket.events.push({
          kind: 'key',
          quarter: c.cursor.q,
          fifths: Math.max(-7, Math.min(7, Math.round(fifths))),
          mode: normaliseMode(childText(el, 'mode')),
        });
        break;
      }

      case 'TimeSig': {
        const beats = numOf(el, 'sigN', 0);
        const beatType = numOf(el, 'sigD', 0);
        if (beats > 0 && beatType > 0) {
          c.ctx.ts = { beats, beatType };
          c.bucket.events.push({ kind: 'time', quarter: c.cursor.q, beats, beatType });
        } else {
          c.ctx.warn('An incomplete <TimeSig> was ignored.');
        }
        break;
      }

      case 'Tempo': {
        // `<tempo>` is QUARTERS PER SECOND: 1.9 = 114 bpm.
        const qps = numOf(el, 'tempo', null);
        if (qps != null && qps > 0) {
          c.bucket.events.push({ kind: 'tempo', quarter: c.cursor.q, bpm: qps * 60 });
        }
        break;
      }

      case 'Clef': {
        const type = childText(el, 'concertClefType') || childText(el, 'transposingClefType') || '';
        const id = clefIdOf(type);
        if (!id) break;
        if (!c.ctx.sink.clef) c.ctx.sink.clef = id;
        break;
      }

      case 'location': {
        // MuseScore's explicit position jump, relative to the start of the bar.
        c.cursor.q = (numOf(el, 'measures', 0) || 0) + fractionOf(childText(el, 'fractions'));
        break;
      }

      case 'Spanner':
      case 'Tie':
        // A tie marker with no note of its own — a voice-level "end of tie" in
        // older files. Resolved once the whole part has been walked.
        recordLooseTie(el, c);
        break;

      default:
        // Dynamic, StaffText, SystemText, BarLine, HairPin, Harmonic,
        // LayoutBreak, … and anything a future MuseScore release invents.
        break;
    }
  }
  return advanced;
}

function walkChord(el, c) {
  // Grace notes have their own container and must not move the cursor.
  const graces = childEl(el, 'graceNotes');
  if (graces) walkElements(graces, { ...c, grace: true });

  const dur = durationOf(el, c);
  const quarter = c.cursor.q;
  const noteEls = childEls(el, 'Note');

  // A note is a grace note if it says so itself (`<Note><grace/>`), if the
  // chord does (`<durationType>grace</durationType>`), or because it sits in a
  // `<graceNotes>` container. A chord whose notes are *all* grace notes takes no
  // time of its own, which is what keeps the following note in place.
  const noteGrace = noteEls.map((nEl) => c.grace || dur.grace || !!childEl(nEl, 'grace') || !!childEl(el, 'grace'));
  const graceChord = noteGrace.length > 0 && noteGrace.every(Boolean);

  const emitted = [];
  noteEls.forEach((nEl, i) => {
    const grace = noteGrace[i] || dur.grace || c.grace;
    const note = emitNote(nEl, c, {
      quarter,
      duration: grace ? Math.max(dur.quarters, MIN_DUR_QUARTERS) : dur.quarters,
      chord: emitted.length > 0,
      grace,
      articulation: articulationOf(nEl) || articulationOf(el),
    });
    if (note) { emitted.push(note); c.bucket.notes.push(note); }
  });

  // A tie written on the `<Chord>` applies to the whole chord, but never
  // overrides a note that carries a tie of its own.
  const chordTie = chordLevelTie(el);
  if (chordTie) applyChordTie(chordTie, c, emitted);

  if (graceChord) return 0;
  const advance = Math.max(dur.quarters, 0);
  c.cursor.q = tidy(c.cursor.q + advance);
  return advance;
}

function walkRest(el, c) {
  const dur = durationOf(el, c);
  if (c.grace || dur.grace) return 0;
  c.cursor.q = tidy(c.cursor.q + Math.max(dur.quarters, 0));
  return Math.max(dur.quarters, 0);
}

/* ---------------------------------------------------------------- duration */

/**
 * Length of a `<Chord>`/`<Rest>` in quarters, after dots and any enclosing
 * tuplet. An unknown duration type falls back to the raw `<duration>` ticks.
 */
function durationOf(el, c) {
  const typeRaw = childText(el, 'durationType');
  const type = typeRaw ? typeRaw.toLowerCase() : '';
  const dots = numOf(el, 'dots', 0) || 0;

  if (/^grace/.test(type)) return { quarters: 0.125 * dotScale(dots), grace: true };

  // A whole-bar rest lasts exactly one bar, whatever the tuplet context.
  if (type === 'measure') return { quarters: barQuarters(c.ctx.ts), grace: false };

  let base = DURATION_QUARTERS[type];
  if (base == null) {
    const ticks = numOf(el, 'duration', null);
    if (ticks != null && ticks > 0 && c.ctx.division > 0) {
      c.ctx.warn(`Unknown duration type "${typeRaw}" — used its ${ticks}-tick <duration> instead.`);
      return { quarters: (ticks / c.ctx.division) * dotScale(dots) * c.tupletRatio, grace: false };
    }
    c.ctx.warn(`Unknown duration type "${typeRaw}" — read it as a quarter note.`);
    base = 1;
  }
  return { quarters: base * dotScale(dots) * c.tupletRatio, grace: false };
}

/* -------------------------------------------------------------------- note */

function emitNote(nEl, c, { quarter, duration, chord, grace, articulation }) {
  const midi = numOf(nEl, 'pitch', null);
  if (midi == null) {
    c.ctx.warn('A <Note> with no <pitch> was skipped.');
    return null;
  }
  const pitch = Math.max(0, Math.min(127, Math.round(midi)));

  const note = makeNote({
    midi: pitch,
    quarter,
    durationQuarters: Math.max(duration, MIN_DUR_QUARTERS),
    staff: c.staff,
    voice: c.voice,
    chord,
    grace,
    velocity: velocityOf(nEl),
    lyric: childText(childEl(nEl, 'Lyrics'), 'text'),
    articulation: articulation || null,
  });
  note._tieKey = `${c.staff}|${c.voice}|${pitch}`;

  recordNoteTies(nEl, c, note);
  recordLegacyTie(nEl, c, note);
  return note;
}

/** MuseScore writes velocity either as a 0–1 float or as a 0–127 integer. */
function velocityOf(nEl) {
  const v = numOf(nEl, 'velocity', null) ?? numOf(nEl, 'velo', null);
  if (v == null) return undefined;          // makeNote's default
  return Math.max(0.05, Math.min(1, v > 1 ? v / 127 : v));
}

function articulationOf(nEl) {
  const subtype = childText(childEl(nEl, 'Articulation'), 'subtype') || '';
  if (!subtype) return null;
  if (/stacc/i.test(subtype)) return 'staccato';
  if (/accent/i.test(subtype)) return 'accent';
  if (/marcato/i.test(subtype)) return 'marcato';
  if (/tenuto/i.test(subtype)) return 'tenuto';
  return null;
}

function clefIdOf(type) {
  const t = String(type || '').trim();
  if (!t) return null;
  if (CLEF_ID[t]) return CLEF_ID[t];
  if (/^G/.test(t)) return 'treble';
  if (/^F/.test(t)) return 'bass';
  if (/^C/.test(t)) return 'alto';
  return null;
}

function normaliseMode(mode) {
  const m = String(mode || '').toLowerCase();
  if (!m) return null;
  if (/^(min|aeolian|dorian|phrygian|locrian)/.test(m)) return 'minor';
  if (/^(maj|ionian|lydian|mixolydian)/.test(m)) return 'major';
  return null;
}

/* -------------------------------------------------------------------- ties */

/** Depth-limited search for the `<next>`/`<prev>` block inside a tie spanner. */
function tieSide(spanner, side) {
  const queue = [{ el: spanner, depth: 0 }];
  while (queue.length) {
    const { el, depth } = queue.shift();
    for (const child of elementChildren(el)) {
      if (child.localName === side) {
        const loc = childEl(child, 'location') || child;
        return {
          measures: numOf(loc, 'measures', 0) || 0,
          fractions: fractionOf(childText(loc, 'fractions')),
        };
      }
      if (depth < 4 && child.localName !== 'location') queue.push({ el: child, depth: depth + 1 });
    }
  }
  return null;
}

function pushTie(c, fromQ, toQ, midi) {
  if (!Number.isFinite(fromQ) || !Number.isFinite(toQ)) return;
  // Bar-relative, like the notes: the bar is shifted to absolute position when
  // it is committed, so an intent must travel with its notes.
  c.bucket.ties.push({
    fromQ: tidy(fromQ),
    toQ: tidy(toQ),
    midi,
    staff: c.staff,
    voice: c.voice,
  });
}

/**
 * A `<location>` displacement, in quarters.
 *
 * `<measures>` counts *bars*, not beats, so it has to be scaled by the length
 * of a bar in the time signature in force; `<fractions>` is already in beats.
 * Both are signed displacements away from the note the location hangs on.
 */
function tieOffset(c, loc) {
  if (!loc) return 0;
  return loc.measures * barQuarters(c.ctx.ts) + loc.fractions;
}

/**
 * A `<Note>` may carry its own `<Spanner type="Tie">`. `<next>` says where the
 * note this tie *starts* at continues to; `<prev>` says where the note it
 * *ends* at came from. Both are signed displacements from this note.
 */
function recordNoteTies(nEl, c, note) {
  for (const sp of elementChildren(nEl)) {
    if (sp.localName !== 'Spanner') continue;
    if ((sp.getAttribute('type') || '').toLowerCase() !== 'tie') continue;
    const next = tieSide(sp, 'next');
    const prev = tieSide(sp, 'prev');
    if (next) pushTie(c, note.quarter, note.quarter + tieOffset(c, next), note.midi);
    if (prev) pushTie(c, note.quarter + tieOffset(c, prev), note.quarter, note.midi);
  }
}

/** Old files write a bare `<Tie>` on the note instead of a spanner. */
function recordLegacyTie(nEl, c, note) {
  const tie = childEl(nEl, 'Tie');
  if (!tie) return;
  const value = (tie.textContent || '').trim().toLowerCase();
  note._legacyTie = {
    forward: !value || /start|begin|to/.test(value),
    backward: !value || /end|stop|from/.test(value),
  };
}

/** The `<Tie>` / `<Spanner type="Tie">` written directly on a `<Chord>`. */
function chordLevelTie(chordEl) {
  for (const el of elementChildren(chordEl)) {
    if (el.localName === 'Tie') return el;
    if (el.localName === 'Spanner' && (el.getAttribute('type') || '').toLowerCase() === 'tie') return el;
  }
  return null;
}

function applyChordTie(tieEl, c, notes) {
  if (!notes.length) return;
  const next = tieSide(tieEl, 'next');
  const prev = tieSide(tieEl, 'prev');
  for (const note of notes) {
    if (note._legacyTie) continue;             // the note said something more specific
    if (next) pushTie(c, note.quarter, note.quarter + tieOffset(c, next), note.midi);
    if (prev) pushTie(c, note.quarter + tieOffset(c, prev), note.quarter, note.midi);
  }
}

/** A tie spanner at voice level, carrying no note of its own. */
function recordLooseTie(el, c) {
  if (el.localName === 'Spanner' && (el.getAttribute('type') || '').toLowerCase() !== 'tie') return;
  const next = tieSide(el, 'next');
  const prev = tieSide(el, 'prev');
  if (next) {
    c.bucket.loose.push({ at: tidy(c.cursor.q), offset: tieOffset(c, next), dir: 'next', staff: c.staff, voice: c.voice });
  }
  if (prev) {
    c.bucket.loose.push({ at: tidy(c.cursor.q), offset: tieOffset(c, prev), dir: 'prev', staff: c.staff, voice: c.voice });
  }
}

/**
 * Merge tied notes into one and drop the continuation notes, in place.
 *
 * Handles ties across barlines, three-note chains (A–B–C collapse into one A)
 * and partial chords (only the tied members of a chord merge).
 */
function resolveTies(part, warn) {
  const sink = part._sink;
  if (!sink) return;
  const hasLegacy = part.notes.some((n) => n._legacyTie);
  if (!sink.ties.length && !sink.loose.length && !hasLegacy) return;

  const byKey = new Map();
  const byMidi = new Map();
  for (const n of part.notes) {
    if (!byKey.has(n._tieKey)) byKey.set(n._tieKey, []);
    byKey.get(n._tieKey).push(n);
    if (!byMidi.has(n.midi)) byMidi.set(n.midi, []);
    byMidi.get(n.midi).push(n);
  }

  const findAt = (list, q) => {
    if (!list || !list.length || !Number.isFinite(q)) return null;
    let best = null; let bestD = Infinity;
    for (const n of list) {
      const d = Math.abs(n.quarter - q);
      if (d < bestD) { bestD = d; best = n; }
    }
    return bestD <= TIE_TOLERANCE ? best : null;
  };

  const onsets = () => part.notes.filter((n) => !n.chord);

  /* -- ties that name no pitch have to be paired up by position -------- */
  const intents = sink.ties.slice();
  for (const l of sink.loose) {
    const sameVoice = (n) => n.staff === l.staff && n.voice === l.voice && !n.chord;
    const target = tidy(l.at + l.offset);
    const anchor = nearest(onsets(), sameVoice, l.at);
    if (!anchor) continue;
    const other = nearest(onsets(), (n) => sameVoice(n) && n.midi === anchor.midi && Math.abs(n.quarter - target) <= TIE_TOLERANCE, target);
    if (!other) continue;
    intents.push(l.dir === 'next'
      ? { fromQ: anchor.quarter, toQ: other.quarter, midi: anchor.midi, staff: l.staff, voice: l.voice }
      : { fromQ: other.quarter, toQ: anchor.quarter, midi: anchor.midi, staff: l.staff, voice: l.voice });
  }

  /* -- bare <Tie> on a note: merge with the next/previous same pitch --- */
  for (const n of part.notes) {
    const leg = n._legacyTie;
    if (!leg) continue;
    const sameVoice = (o) => o.staff === n.staff && o.voice === n.voice && !o.chord && o.midi === n.midi && o.quarter !== n.quarter;
    if (leg.forward) {
      const other = nearest(onsets(), (o) => sameVoice(o) && o.quarter > n.quarter, n.quarter);
      if (other) intents.push({ fromQ: n.quarter, toQ: other.quarter, midi: n.midi, staff: n.staff, voice: n.voice });
    }
    if (leg.backward) {
      const other = nearest(onsets(), (o) => sameVoice(o) && o.quarter < n.quarter, n.quarter);
      if (other) intents.push({ fromQ: other.quarter, toQ: n.quarter, midi: n.midi, staff: n.staff, voice: n.voice });
    }
  }

  intents.sort((a, b) => (a.fromQ - b.fromQ) || (a.toQ - b.toQ));
  dbg('intents', JSON.stringify(intents), 'notes', JSON.stringify(part.notes.map(n => [n.midi, n.quarter, n.durationQuarters])));

  const mergedInto = new Map();
  const rootOf = (n) => { let r = n; while (mergedInto.has(r)) r = mergedInto.get(r); return r; };

  let merged = 0;
  let failed = 0;
  for (const t of intents) {
    const key = `${t.staff}|${t.voice}|${t.midi}`;
    let a = findAt(byKey.get(key), t.fromQ);
    let b = findAt(byKey.get(key), t.toQ);
    // A tie that crosses voices or staves still has to sound as one note.
    if (!a || !b) {
      a = a || findAt(byMidi.get(t.midi), t.fromQ);
      b = b || findAt(byMidi.get(t.midi), t.toQ);
    }
    if (!a || !b || a === b) { failed++; continue; }
    const A = rootOf(a);
    const B = rootOf(b);
    if (A === B) continue;
    if (B.quarter <= A.quarter) { failed++; continue; }
    A.durationQuarters = tidy(A.durationQuarters + B.durationQuarters);
    A.tieFrom = true;      // it continues an earlier tie …
    A.tieTo = true;        // … and starts one
    mergedInto.set(B, A);
    merged++;
  }

  if (merged) part.notes = part.notes.filter((n) => !mergedInto.has(n));
  if (failed) {
    warn(`${failed} tie${failed === 1 ? '' : 's'} in "${part.name}" could not be matched to two notes and were played as separate notes.`);
  }
}

function nearest(notes, predicate, q) {
  let best = null; let bestD = Infinity;
  for (const n of notes) {
    if (!predicate(n)) continue;
    const d = Math.abs(n.quarter - q);
    if (d < bestD) { bestD = d; best = n; }
  }
  return best;
}

/* --------------------------------------------------------------- post-pass */

/** Collapse the per-voice event stream into the score's tempo/key/time maps. */
function applyEvents(ctx, score) {
  const events = ctx.events.slice().sort((a, b) => a.quarter - b.quarter);

  const tempo = new Map();
  const keys = new Map();
  const times = new Map();

  for (const ev of events) {
    if (ev.kind === 'tempo') {
      if (!tempo.has(ev.quarter) && ev.bpm > 0) tempo.set(ev.quarter, tidy(ev.bpm));
    } else if (ev.kind === 'key') {
      if (!keys.has(ev.quarter)) keys.set(ev.quarter, { quarter: ev.quarter, fifths: ev.fifths, mode: ev.mode });
    } else if (ev.kind === 'time') {
      if (!times.has(ev.quarter)) times.set(ev.quarter, { quarter: ev.quarter, beats: ev.beats, beatType: ev.beatType });
    }
  }

  const tempoMap = [...tempo.entries()]
    .map(([quarter, bpm]) => ({ quarter, bpm }))
    .sort((a, b) => a.quarter - b.quarter);

  if (!tempoMap.length) {
    score.tempoMap = [{ quarter: 0, bpm: DEFAULT_BPM }];
    ctx.warn('No tempo marking in the file; assumed 100 bpm.');
  } else {
    if (tempoMap[0].quarter > 0) {
      // The model needs the map to start at zero, so hold the first tempo back to
      // the top of the piece instead of inventing a 120 bpm opening.
      tempoMap.unshift({ quarter: 0, bpm: tempoMap[0].bpm });
    }
    score.tempoMap = tempoMap;
  }

  score.keySigs = [...keys.values()];
  if (!score.keySigs.length) score.keySigs = [{ quarter: 0, fifths: 0, mode: null }];

  score.timeSigs = [...times.values()];
  if (!score.timeSigs.length) score.timeSigs = [{ quarter: 0, beats: 4, beatType: 4 }];
}