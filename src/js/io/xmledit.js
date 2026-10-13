/**
 * io/xmledit.js — note edits applied to the MusicXML text itself.
 *
 * The MusicXML string is the one source every view reads: OSMD draws it, the
 * parser builds the playback model from it, and Save hands it back. So an edit
 * is a transformation of that string — change the XML, re-parse, re-render —
 * and the views cannot disagree about what the score now says.
 *
 * Addressing: a note is named by its part id and its ordinal — the index of
 * its <note> element among ALL <note> elements of that part, in document
 * order, rests and grace notes included. The parser records the same ordinals
 * on every model note it builds (note.xmlIndexes; a tie chain lists every
 * element it merged), so a model note picked in the UI names its XML elements
 * exactly.
 *
 * What each edit keeps true: the bar arithmetic. A deleted note becomes a rest
 * of the same written duration; a shortened note leaves a rest behind it; a
 * lengthened note consumes the rest that follows it and is refused when a note
 * or the barline is in the way. No edit here changes the length of a measure.
 *
 * Edits that would break that arithmetic are refused with an EditError whose
 * message is written for the user, not for a stack trace.
 */

/* ------------------------------------------------------------- utilities */

export class EditError extends Error {}

const refuse = (msg) => { throw new EditError(msg); };

function tagOf(el) {
  return el && el.localName ? el.localName.toLowerCase() : '';
}

function child(el, name) {
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
    if (tagOf(c) === name) return c;
  }
  return null;
}

function childText(el, name) {
  const c = child(el, name);
  return c ? c.textContent.trim() : '';
}

function removeChildren(el, name) {
  for (let c = el.firstElementChild; c;) {
    const next = c.nextElementSibling;
    if (tagOf(c) === name) el.removeChild(c);
    c = next;
  }
}

/**
 * MusicXML fixes the order of <note> children, and writers (OSMD among them)
 * reject or misread a note whose <duration> comes after its <voice>. Insert
 * new children by that order rather than appending.
 */
const NOTE_CHILD_ORDER = [
  'grace', 'chord', 'pitch', 'unpitched', 'rest', 'duration', 'tie', 'cue',
  'instrument', 'footnote', 'level', 'voice', 'type', 'dot', 'accidental',
  'time-modification', 'stem', 'notehead', 'notehead-text', 'staff', 'beam',
  'notations', 'lyric', 'play',
];

function insertOrdered(noteEl, newChild) {
  const rank = NOTE_CHILD_ORDER.indexOf(tagOf(newChild));
  for (let c = noteEl.firstElementChild; c; c = c.nextElementSibling) {
    const r = NOTE_CHILD_ORDER.indexOf(tagOf(c));
    if (r > rank) { noteEl.insertBefore(newChild, c); return; }
  }
  noteEl.appendChild(newChild);
}

/* ------------------------------------------------------------ document IO */

function parseDoc(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const root = doc.documentElement;
  if (!root || tagOf(root) === 'parsererror' || doc.getElementsByTagName('parsererror').length) {
    refuse('This score’s MusicXML could not be read, so it cannot be edited.');
  }
  return doc;
}

function serialize(doc) {
  let out = new XMLSerializer().serializeToString(doc);
  // OSMD's string loader requires the declaration; XMLSerializer drops it.
  if (!/^\s*<\?xml/.test(out)) out = '<?xml version="1.0" encoding="UTF-8"?>\n' + out;
  return out;
}

/**
 * Every <note> element of one part, in document order, for either root
 * flavour — the same order the parser counts, so ordinals line up.
 * Also records, per note, the <divisions> and <key><fifths> in force there.
 */
function measureContainers(doc, partId) {
  const root = doc.documentElement;
  const rootTag = tagOf(root);
  const measureLists = [];
  if (rootTag === 'score-timewise') {
    for (let m = root.firstElementChild; m; m = m.nextElementSibling) {
      if (tagOf(m) !== 'measure') continue;
      for (let p = m.firstElementChild; p; p = p.nextElementSibling) {
        if (tagOf(p) === 'part' && p.getAttribute('id') === partId) measureLists.push(p);
      }
    }
  } else {
    for (let p = root.firstElementChild; p; p = p.nextElementSibling) {
      if (tagOf(p) !== 'part' || p.getAttribute('id') !== partId) continue;
      for (let m = p.firstElementChild; m; m = m.nextElementSibling) {
        if (tagOf(m) === 'measure') measureLists.push(m);
      }
    }
  }
  if (!measureLists.length) refuse(`This score has no part "${partId}" to edit.`);
  return measureLists;
}

function collectNotes(doc, partId) {
  const measureLists = measureContainers(doc, partId);

  const notes = [];
  let divisions = 1;
  let fifths = 0;
  for (const container of measureLists) {
    for (let el = container.firstElementChild; el; el = el.nextElementSibling) {
      const tag = tagOf(el);
      if (tag === 'attributes') {
        const d = Number(childText(el, 'divisions'));
        if (Number.isFinite(d) && d > 0) divisions = d;
        const key = child(el, 'key');
        if (key) {
          const f = Number(childText(key, 'fifths'));
          if (Number.isFinite(f)) fifths = f;
        }
      } else if (tag === 'note') {
        notes.push({ el, divisions, fifths, measure: container });
      }
    }
  }
  return notes;
}

function located(notes, ordinal) {
  const n = notes[ordinal];
  if (!n) refuse('That note is no longer where the selection said it was; click it again.');
  return n;
}

/* ------------------------------------------------------------------ pitch */

const SHARP_SPELLING = [
  ['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0],
  ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0],
];
const FLAT_SPELLING = [
  ['C', 0], ['D', -1], ['D', 0], ['E', -1], ['E', 0], ['F', 0],
  ['G', -1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['B', 0],
];

/** MIDI -> {step, alter, octave}, spelled flat in flat keys, sharp otherwise. */
export function midiToPitchSpelling(midi, fifths) {
  const m = Math.max(0, Math.min(127, Math.round(midi)));
  const table = (fifths || 0) < 0 ? FLAT_SPELLING : SHARP_SPELLING;
  const [step, alter] = table[((m % 12) + 12) % 12];
  // The octave belongs to the natural step: Db4 is 61 but its step D sits in
  // octave 4 because D4 (62) does.
  const natural = m - alter;
  return { step, alter, octave: Math.floor(natural / 12) - 1 };
}

function writePitch(doc, noteEl, midi, fifths) {
  const { step, alter, octave } = midiToPitchSpelling(midi, fifths);
  removeChildren(noteEl, 'accidental'); // let the renderer infer it afresh
  let pitch = child(noteEl, 'pitch');
  if (!pitch) {
    pitch = doc.createElement('pitch');
    insertOrdered(noteEl, pitch);
  }
  while (pitch.firstChild) pitch.removeChild(pitch.firstChild);
  const put = (name, text) => {
    const e = doc.createElement(name);
    e.textContent = String(text);
    pitch.appendChild(e);
  };
  put('step', step);
  if (alter) put('alter', alter);
  put('octave', octave);
}

/* -------------------------------------------------------------- durations */

/** Written length in quarters -> <type> name and dot count, or null. */
export function quartersToTypeDots(q) {
  const PLAIN = [[4, 'whole'], [2, 'half'], [1, 'quarter'], [0.5, 'eighth'],
    [0.25, '16th'], [0.125, '32nd'], [0.0625, '64th']];
  for (const [len, type] of PLAIN) {
    if (Math.abs(q - len) < 1e-9) return { type, dots: 0 };
    if (Math.abs(q - len * 1.5) < 1e-9) return { type, dots: 1 };
  }
  return null;
}

function setWrittenDuration(doc, noteEl, dur, quarters) {
  let d = child(noteEl, 'duration');
  if (!d) { d = doc.createElement('duration'); insertOrdered(noteEl, d); }
  d.textContent = String(dur);
  removeChildren(noteEl, 'dot');
  const td = quartersToTypeDots(quarters);
  let type = child(noteEl, 'type');
  if (td) {
    if (!type) { type = doc.createElement('type'); insertOrdered(noteEl, type); }
    type.textContent = td.type;
    for (let i = 0; i < td.dots; i++) insertOrdered(noteEl, doc.createElement('dot'));
  } else if (type) {
    // No clean written form: leave only <duration>, which readers honour.
    noteEl.removeChild(type);
  }
}

/** Greedy split of a duration into cleanly-typed rest lengths, longest first. */
function restSplit(quarters) {
  const STEPS = [6, 4, 3, 2, 1.5, 1, 0.75, 0.5, 0.375, 0.25, 0.1875, 0.125, 0.0625];
  const out = [];
  let left = quarters;
  let guard = 0;
  while (left > 1e-9 && guard++ < 64) {
    const step = STEPS.find((s) => s <= left + 1e-9);
    if (!step) { out.push(left); break; }
    out.push(step);
    left -= step;
  }
  return out;
}

function makeRest(doc, { divisions, quarters, voice, staff }) {
  const rest = doc.createElement('note');
  rest.appendChild(doc.createElement('rest'));
  const d = doc.createElement('duration');
  d.textContent = String(Math.round(quarters * divisions));
  rest.appendChild(d);
  if (voice) { const v = doc.createElement('voice'); v.textContent = voice; rest.appendChild(v); }
  const td = quartersToTypeDots(quarters);
  if (td) {
    const t = doc.createElement('type');
    t.textContent = td.type;
    rest.appendChild(t);
    for (let i = 0; i < td.dots; i++) rest.appendChild(doc.createElement('dot'));
  }
  if (staff) { const s = doc.createElement('staff'); s.textContent = staff; rest.appendChild(s); }
  return rest;
}

/* ---------------------------------------------------------- chord grouping */

/**
 * The chord run a note belongs to: the lead (no <chord/>) plus the
 * immediately following <note> siblings marked <chord/>.
 */
function chordRun(el) {
  let lead = el;
  while (child(lead, 'chord')) {
    const prev = lead.previousElementSibling;
    if (!prev || tagOf(prev) !== 'note') break;
    lead = prev;
  }
  const members = [lead];
  for (let s = lead.nextElementSibling; s && tagOf(s) === 'note' && child(s, 'chord'); s = s.nextElementSibling) {
    members.push(s);
  }
  return members;
}

/* ------------------------------------------------------------------- ops */

function opPitch(doc, notes, op) {
  const ordinals = op.ordinals && op.ordinals.length ? op.ordinals : refuse('No note is selected.');
  for (const ord of ordinals) {
    const { el, fifths } = located(notes, ord);
    if (child(el, 'rest')) refuse('That position is a rest; there is no pitch to change.');
    writePitch(doc, el, op.midi, op.fifths != null ? op.fifths : fifths);
  }
}

/** Delete: a chord member disappears; a lone note becomes a rest. */
function opDelete(doc, notes, op) {
  const ordinals = op.ordinals && op.ordinals.length ? op.ordinals : refuse('No note is selected.');
  for (const ord of ordinals) {
    const { el } = located(notes, ord);
    if (child(el, 'rest')) continue;
    const isChordMember = !!child(el, 'chord');
    const next = el.nextElementSibling;
    const nextIsChord = next && tagOf(next) === 'note' && child(next, 'chord');
    if (isChordMember) {
      el.parentNode.removeChild(el);
    } else if (nextIsChord) {
      // Deleting the chord's written lead promotes the next tone to lead.
      el.parentNode.removeChild(el);
      removeChildren(next, 'chord');
    } else if (child(el, 'grace')) {
      // A grace note takes no time, so it can simply go.
      el.parentNode.removeChild(el);
    } else {
      // Keep the bar's arithmetic: the time the note took stays, as a rest.
      for (const name of ['pitch', 'tie', 'notations', 'lyric', 'accidental', 'stem', 'beam', 'notehead']) {
        removeChildren(el, name);
      }
      insertOrdered(el, doc.createElement('rest'));
    }
  }
}

function opAddChord(doc, notes, op) {
  const { el, fifths, divisions } = located(notes, op.ordinals[0]);
  if (child(el, 'rest')) refuse('A chord tone needs a note to attach to, and that position is a rest.');
  if (child(el, 'grace')) refuse('Chord tones on grace notes are not supported.');
  const members = chordRun(el);
  // Refuse a duplicate of a tone the chord already has.
  for (const m of members) {
    const p = child(m, 'pitch');
    if (!p) continue;
    const spelled = midiToPitchSpelling(op.midi, op.fifths != null ? op.fifths : fifths);
    const sameOct = Number(childText(p, 'octave')) === spelled.octave;
    const sameStep = childText(p, 'step') === spelled.step;
    const sameAlter = (Number(childText(p, 'alter')) || 0) === spelled.alter;
    if (sameOct && sameStep && sameAlter) refuse('The chord already has that note.');
  }
  const lead = members[0];
  const tone = doc.createElement('note');
  tone.appendChild(doc.createElement('chord'));
  writePitch(doc, tone, op.midi, op.fifths != null ? op.fifths : fifths);
  for (const name of ['duration', 'voice', 'type', 'staff']) {
    const src = child(lead, name);
    if (src) tone.appendChild(src.cloneNode(true));
  }
  for (let c = lead.firstElementChild; c; c = c.nextElementSibling) {
    if (tagOf(c) === 'dot' || tagOf(c) === 'time-modification') insertOrdered(tone, c.cloneNode(true));
  }
  void divisions;
  const last = members[members.length - 1];
  last.parentNode.insertBefore(tone, last.nextElementSibling);
}

function opDuration(doc, notes, op) {
  if (op.ordinals.length > 1) {
    refuse('That note is tied across the barline; change the tied halves separately is not supported yet.');
  }
  const { el, divisions } = located(notes, op.ordinals[0]);
  if (child(el, 'grace')) refuse('Grace notes take no time, so they have no length to change.');
  if (child(el, 'chord')) refuse('Change the length on the chord’s first note; the chord follows it.');
  if (child(el, 'time-modification')) refuse('That note is inside a tuplet; tuplet lengths are not editable yet.');
  const oldDur = Number(childText(el, 'duration'));
  if (!Number.isFinite(oldDur) || oldDur <= 0) refuse('That note’s written length could not be read.');

  const newDur = Math.round(op.quarters * divisions);
  if (newDur < 1 || Math.abs(newDur - op.quarters * divisions) > 1e-6) {
    refuse('This score’s rhythm grid cannot write that length.');
  }
  const delta = newDur - oldDur;
  if (delta === 0) return;

  const members = chordRun(el); // el is the lead (chord members were refused)
  const last = members[members.length - 1];
  const voice = childText(el, 'voice');
  const staff = childText(el, 'staff');

  if (delta < 0) {
    // Shorter: what is given up becomes rests straight after the note.
    let anchor = last;
    for (const q of restSplit(-delta / divisions)) {
      const rest = makeRest(doc, { divisions, quarters: q, voice, staff });
      anchor.parentNode.insertBefore(rest, anchor.nextElementSibling);
      anchor = rest;
    }
  } else {
    // Longer: only into rest, in this voice, inside this bar.
    let need = delta;
    const eaten = [];
    for (let s = last.nextElementSibling; s && need > 0; s = s.nextElementSibling) {
      const tag = tagOf(s);
      if (tag === 'direction' || tag === 'harmony' || tag === 'sound') continue;
      if (tag !== 'note') {
        refuse('There is no room: another voice begins where this note would extend.');
      }
      if (childText(s, 'voice') && voice && childText(s, 'voice') !== voice) {
        refuse('There is no room: another voice begins where this note would extend.');
      }
      if (!child(s, 'rest')) {
        refuse('There is no room: the next note is in the way. Delete or shorten it first.');
      }
      const rd = Number(childText(s, 'duration'));
      if (!Number.isFinite(rd) || rd <= 0) refuse('The rest after this note has no readable length.');
      eaten.push({ el: s, dur: rd });
      need -= rd;
    }
    if (need > 0) {
      refuse('There is no room: the bar ends where this note would extend.');
    }
    let take = delta;
    for (const r of eaten) {
      if (take >= r.dur) {
        r.el.parentNode.removeChild(r.el);
        take -= r.dur;
      } else {
        const remaining = (r.dur - take) / divisions;
        setWrittenDuration(doc, r.el, r.dur - take, remaining);
        take = 0;
      }
    }
  }

  for (const m of members) setWrittenDuration(doc, m, newDur, newDur / divisions);
}

/* --------------------------------------------------------------- insert */

/**
 * The rest sounding at `within` quarters into measure `measureIndex`, found
 * by walking that part with the same clock the parser uses: notes advance it,
 * <backup>/<forward> move it, chord and grace notes do not. Returns the rest
 * element with its onset, length, divisions and ordinal state.
 */
function locateRestAt(doc, partId, measureIndex, within) {
  const containers = measureContainers(doc, partId);
  if (!(measureIndex >= 0) || measureIndex >= containers.length) {
    refuse('That spot is outside the score.');
  }
  let divisions = 1;
  const readAttrs = (el) => {
    const d = Number(childText(el, 'divisions'));
    if (Number.isFinite(d) && d > 0) divisions = d;
  };
  // Divisions in force when the target measure starts.
  for (let i = 0; i < measureIndex; i++) {
    for (let el = containers[i].firstElementChild; el; el = el.nextElementSibling) {
      if (tagOf(el) === 'attributes') readAttrs(el);
    }
  }
  let cursor = 0;
  let lastOnset = 0;
  let sawNote = false;
  for (let el = containers[measureIndex].firstElementChild; el; el = el.nextElementSibling) {
    const tag = tagOf(el);
    if (tag === 'attributes') { readAttrs(el); continue; }
    if (tag === 'backup' || tag === 'forward') {
      const d = Number(childText(el, 'duration'));
      if (Number.isFinite(d)) cursor += (tag === 'backup' ? -d : d) / divisions;
      if (cursor < 0) cursor = 0;
      continue;
    }
    if (tag !== 'note') continue;
    sawNote = true;
    const isChord = !!child(el, 'chord');
    const isGrace = !!child(el, 'grace');
    const durUnits = Number(childText(el, 'duration'));
    const dur = Number.isFinite(durUnits) && durUnits > 0 ? durUnits / divisions : 0;
    const onset = isChord ? lastOnset : cursor;
    if (child(el, 'rest') && !isGrace
      && within >= onset - 1e-6 && within < onset + dur - 1e-6) {
      return { el, onset, durUnits, divisions };
    }
    if (!isChord && !isGrace) { lastOnset = cursor; cursor += dur; }
  }
  refuse(sawNote
    ? 'A note can only go where there is a rest. Delete or shorten what is there first.'
    : 'That bar has nothing written in it to replace.');
  return null; // refuse throws; this is for the reader
}

/**
 * Turn part of a rest into a new note. The note lands at `within` (snapped to
 * the score's rhythm grid), takes at most `quarters` (default one quarter)
 * and never more than the rest holds; what is left of the rest stays, before
 * and after. The bar's length does not change.
 */
function opInsert(doc, op) {
  const found = locateRestAt(doc, op.partId, op.measureIndex, op.within);
  const { el, divisions } = found;
  if (child(el, 'time-modification')) refuse('That rest is inside a tuplet; tuplet rhythms are not editable yet.');

  const atUnits = Math.max(0, Math.min(found.durUnits - 1,
    Math.round((op.within - found.onset) * divisions)));
  const wantUnits = Math.max(1, Math.round((op.quarters || 1) * divisions));
  const noteUnits = Math.min(wantUnits, found.durUnits - atUnits);

  const voice = childText(el, 'voice');
  const staff = childText(el, 'staff');
  const fifths = op.fifths != null ? op.fifths : collectNotes(doc, op.partId)
    .find((n) => n.el === el)?.fifths || 0;

  const tone = doc.createElement('note');
  writePitch(doc, tone, op.midi, fifths);
  if (voice) { const v = doc.createElement('voice'); v.textContent = voice; insertOrdered(tone, v); }
  if (staff) { const s = doc.createElement('staff'); s.textContent = staff; insertOrdered(tone, s); }
  setWrittenDuration(doc, tone, noteUnits, noteUnits / divisions);

  const pieces = [];
  for (const q of restSplit(atUnits / divisions)) {
    pieces.push(makeRest(doc, { divisions, quarters: q, voice, staff }));
  }
  pieces.push(tone);
  for (const q of restSplit((found.durUnits - atUnits - noteUnits) / divisions)) {
    pieces.push(makeRest(doc, { divisions, quarters: q, voice, staff }));
  }
  for (const p of pieces) el.parentNode.insertBefore(p, el);
  el.parentNode.removeChild(el);
}

/* ------------------------------------------------------------ public API */

/**
 * Apply one edit to a MusicXML string and return the edited string.
 *
 * @param {string} xml
 * @param {{type: 'pitch'|'delete'|'duration'|'addChord'|'insert',
 *          partId: string,
 *          ordinals?: number[],
 *          midi?: number,
 *          quarters?: number,
 *          measureIndex?: number,
 *          within?: number,
 *          fifths?: number}} op
 * 'insert' names a spot instead of a note: measureIndex and within (quarters
 * into the bar) must land on a rest, and ordinals is not used.
 * @returns {string}
 * @throws {EditError} with a user-facing message when the edit cannot be made
 */
export function editMusicXml(xml, op) {
  if (!op || !op.partId) refuse('No note is selected.');
  const doc = parseDoc(xml);
  if (op.type === 'insert') {
    opInsert(doc, op);
    return serialize(doc);
  }
  if (!Array.isArray(op.ordinals)) refuse('No note is selected.');
  const notes = collectNotes(doc, op.partId);
  if (op.type === 'pitch') opPitch(doc, notes, op);
  else if (op.type === 'delete') opDelete(doc, notes, op);
  else if (op.type === 'addChord') opAddChord(doc, notes, op);
  else if (op.type === 'duration') opDuration(doc, notes, op);
  else refuse(`Unknown edit "${op.type}".`);
  return serialize(doc);
}

/**
 * The duration ladder the UI steps through with “shorter” / “longer”:
 * every cleanly-written length from a 16th to a dotted whole.
 */
export const DURATION_LADDER = [0.25, 0.375, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6];

export function nextDuration(quarters, direction) {
  const L = DURATION_LADDER;
  if (direction > 0) {
    for (const v of L) if (v > quarters + 1e-9) return v;
    return null;
  }
  for (let i = L.length - 1; i >= 0; i--) if (L[i] < quarters - 1e-9) return L[i];
  return null;
}
