/**
 * io/smf.js — Standard MIDI File (SMF, ".mid") → internal score.
 *
 * Design notes
 * ------------
 * A Standard MIDI File is a chunk soup: an `MThd` header, then `MTrk` track
 * chunks, each a stream of `[delta-ticks][status][data…]` events. Everything in
 * this file is therefore written as one linear walk per track with a small
 * amount of state (running status, per-channel pedal/bend state, per-pitch note
 * stacks). There is no second pass over the bytes.
 *
 * Ticks are an *input* unit only. The internal model is the quarter note, so
 * every event is converted through a `Clock` before it reaches `makeNote`.
 * For metric divisions that is a constant scale factor. For SMPTE divisions it
 * is tempo dependent (an SMPTE tick is a fixed slice of wall-clock time, so a
 * tempo change changes how many quarters a tick is worth), so the clock keeps
 * a prefix-sum table of tempo segments.
 *
 * The parse is deliberately forgiving: a slightly damaged file should still
 * play. Anything recoverable becomes a readable string in `score.warnings`;
 * we only throw when there is no usable `MThd` header at all.
 *
 * Notes about fields outside `src/js/score/model.js`:
 *  - `bendCents`      pitch-bend deflection at note-on, ±200 cents.
 *  - `sustainQuarters` extra length the sustain pedal added after the key was
 *                     released (0 when the pedal was not down).
 *  - `soundingQuarters` key length + sustain. **The audio engine should sound a
 *                     note for `soundingQuarters`, and draw `durationQuarters`
 *                     in notation.**
 *  These are attached after `makeNote()` because that helper returns a fixed
 *  key set and would drop them. Same for `channel`.
 */

import { createScore, makePart, makeNote, midiToName } from '../score/model.js';

/* ---------------------------------------------------------------- constants */

const META = {
  SEQ_SPECIFIC_TEXT: 0x00, TEXT: 0x01, COPYRIGHT: 0x02,
  TRACK_NAME: 0x03, INSTRUMENT_NAME: 0x04,
  LYRIC: 0x05, MARKER: 0x06, CUE_POINT: 0x07,
  CHANNEL_PREFIX: 0x20, MIDI_PORT: 0x21,
  END_OF_TRACK: 0x2f, TEMPO: 0x51, SMPTE_OFFSET: 0x54,
  TIME_SIG: 0x58, KEY_SIG: 0x59,
};

const CC_SUSTAIN = 64;
const CC_ALL_SOUND_OFF = 120;
const CC_ALL_NOTES_OFF = 123;
const CC_RESET_ALL_CONTROLLERS = 121;

const PITCH_BEND_CENTRE = 8192;
const PITCH_BEND_CENT_RANGE = 200;   // cents at full deflection (±2 semitones)

/** Data-byte count for the system-common messages that may appear in a file. */
const SYSTEM_DATA_LEN = { 0xf1: 1, 0xf2: 2, 0xf3: 1 };

const TAIL_QUARTERS = 0.25;   // a note still held at end-of-track gets this much
const MIN_DUR_QUARTERS = 1 / 64;
const MAX_DELTA_TICKS = 1e9;  // clamp on a corrupt variable-length delta
const MAX_WARNINGS = 40;

/* ------------------------------------------------------------------ helpers */

function asBuffer(input) {
  if (input instanceof ArrayBuffer) return input;
  if (ArrayBuffer.isView(input)) {
    return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
  }
  throw new Error('parseMidi: expected an ArrayBuffer of MIDI bytes, got ' + typeof input + '.');
}

function tagAt(dv, pos, len = 4) {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint8(pos + i));
  return s;
}

/** Chunk ids in an error message should not spray control characters. */
function printableTag(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 0x20 && c < 0x7f ? s[i] : '?';
  }
  return out;
}

let textDecoder = null;
function decodeText(bytes) {
  try {
    if (!textDecoder) textDecoder = new TextDecoder('utf-8', { fatal: false });
    return textDecoder.decode(bytes).replace(/\0+$/, '').trim();
  } catch {
    return '';
  }
}

/**
 * Variable-length quantity (max 4 bytes in practice, we refuse to chase more).
 * @returns {{value:number, pos:number}} `value < 0` means "unreadable".
 */
function readVarLen(dv, pos, end) {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (pos >= end) return { value: -1, pos };
    const b = dv.getUint8(pos++);
    value = value * 128 + (b & 0x7f);
    if (!(b & 0x80)) return { value, pos };
  }
  return { value: -1, pos };
}

/* -------------------------------------------------------------------- clock */

/**
 * Converts MIDI ticks to quarter notes.
 *
 * Metric: `ticksPerQuarter` is fixed, so this is a scale factor.
 * SMPTE: the header encodes a negative frames-per-second byte plus a
 * sub-resolution (ticks per frame), giving `ticksPerSecond`. A tick is then a
 * fixed slice of real time, so `quartersPerTick = bpm / (60 * ticksPerSecond)`
 * — it moves whenever the tempo moves. Tempo segments are prefix-summed so the
 * conversion is O(log n) per lookup regardless of file length.
 */
function buildClock(division, tempoEvents, warn) {
  if (!(division & 0x8000)) {
    let tpq = division;
    if (!tpq) {
      warn('The header declares 0 ticks per quarter note; assuming 480.');
      tpq = 480;
    }
    return { smpte: false, ticksPerQuarter: tpq, toQuarters: (t) => t / tpq };
  }

  let fps = (division >> 8) & 0xff;
  if (fps >= 0x80) fps -= 0x100;      // high byte is a *negative* number
  const ticksPerFrame = division & 0xff;
  const ticksPerSecond = -fps * ticksPerFrame;
  if (!(ticksPerSecond > 0)) {
    warn(`Unusable SMPTE division 0x${division.toString(16)}; assuming 480 ticks per quarter.`);
    return { smpte: false, ticksPerQuarter: 480, toQuarters: (t) => t / 480 };
  }

  const segs = [];
  let tick = 0, quarters = 0, bpm = 120;
  for (const ev of tempoEvents) {
    if (ev.tick < tick) continue;
    // Close the segment that ran up to this tempo change *before* advancing,
    // so every segment carries the scale factor that was in force on it.
    segs.push({ tick, base: quarters, qpt: bpm / (60 * ticksPerSecond) });
    quarters += (ev.tick - tick) * (bpm / (60 * ticksPerSecond));
    tick = ev.tick;
    bpm = ev.bpm;
  }
  segs.push({ tick, base: quarters, qpt: bpm / (60 * ticksPerSecond) });

  return {
    smpte: true,
    ticksPerQuarter: ticksPerSecond / 2,   // nominal, i.e. at 120 bpm
    toQuarters(t) {
      let lo = 0, hi = segs.length - 1;
      while (lo < hi) {                    // last segment with seg.tick <= t
        const mid = (lo + hi + 1) >> 1;
        if (segs[mid].tick <= t) lo = mid; else hi = mid - 1;
      }
      const s = segs[lo];
      return s.base + (t - s.tick) * s.qpt;
    },
  };
}

/* ------------------------------------------------------------- track parser */

/**
 * Walk one `MTrk` chunk and collect raw, tick-domain events.
 *
 * Everything here stays in tick units: the clock is not known until every
 * track has been read (an SMPTE file's tick→quarter scale depends on the tempo
 * map, which may live in a different track).
 */
function parseTrack(dv, start, end, index, warn) {
  const notes = [];
  const tempoEvents = [];
  const timeSigs = [];
  const keySigs = [];

  const programs = new Array(16).fill(0);
  const bend = new Int32Array(16).fill(PITCH_BEND_CENTRE);
  const active = new Array(16);           // active[chan][pitch] = stack of notes
  const pedal = new Array(16);            // {down, pending[]}
  const chanNotes = new Int32Array(16);   // notes per channel (dominant channel)

  let name = '', instrumentName = '', text = '';
  let pos = start, tick = 0, running = 0;
  let sawEnd = false, unmatchedOff = 0, sysexCount = 0, stillHeld = 0;

  /* -- note bookkeeping ------------------------------------------------- */

  function noteOn(chan, pitch, velocity) {
    let ch = active[chan];
    if (!ch) ch = active[chan] = new Array(128);
    const n = {
      pitch, chan, tick,
      velocity: velocity / 127,
      bend: ((bend[chan] - PITCH_BEND_CENTRE) / PITCH_BEND_CENTRE) * PITCH_BEND_CENT_RANGE,
      aftertouch: 0,
      offTick: 0,
      sustained: false,
      sustainEnd: tick,
    };
    let stack = ch[pitch];
    if (!stack) stack = ch[pitch] = [];
    stack.push(n);          // a repeated note of the same pitch retriggers
  }

  function noteOff(chan, pitch) {
    const ch = active[chan];
    const stack = ch && ch[pitch];
    if (!stack || !stack.length) { unmatchedOff++; return; }
    const n = stack.pop();  // release the most recent of the overlapping notes
    n.offTick = tick;
    const pd = pedal[chan];
    if (pd && pd.down) { n.sustained = true; pd.pending.push(n); }
    else n.sustainEnd = tick;
    notes.push(n);
    chanNotes[chan]++;
  }

  function setPedal(chan, down) {
    let pd = pedal[chan];
    if (!pd) pd = pedal[chan] = { down: false, pending: [] };
    if (down) { pd.down = true; return; }
    pd.down = false;
    for (const n of pd.pending) n.sustainEnd = tick;
    pd.pending.length = 0;
  }

  function closeChannel(chan) {
    const ch = active[chan];
    if (!ch) return;
    const pd = pedal[chan];
    for (let pitch = 0; pitch < 128; pitch++) {
      const stack = ch[pitch];
      if (!stack || !stack.length) continue;
      for (const n of stack) {
        n.offTick = tick;
        if (pd && pd.down) { n.sustained = true; pd.pending.push(n); }
        else n.sustainEnd = tick;
        notes.push(n);
        chanNotes[chan]++;
      }
      stack.length = 0;
    }
  }

  /* -- byte readers ----------------------------------------------------- */

  let bad = false;
  /** Read one data byte. A byte >= 0x80 here means the stream is lost. */
  function readData() {
    if (pos >= end) { bad = true; return 0; }
    const v = dv.getUint8(pos++);
    if (v >= 0x80) { bad = true; return 0; }
    return v;
  }

  /* -- main event loop -------------------------------------------------- */

  outer:
  while (pos < end) {
    let delta = 0, b = 0, guard = 0;
    do {
      if (pos >= end) {
        warn(`Track ${index + 1}: ran out of data inside a delta-time value; stopped there.`);
        break outer;
      }
      b = dv.getUint8(pos++);
      delta = delta * 128 + (b & 0x7f);
      if (delta > MAX_DELTA_TICKS) {
        warn(`Track ${index + 1}: absurd delta time near tick ${tick}; clamped.`);
        delta = MAX_DELTA_TICKS;
      }
      if (++guard > 5) {
        warn(`Track ${index + 1}: malformed variable-length delta; stopped parsing this track.`);
        break outer;
      }
    } while (b & 0x80);
    tick += delta;

    if (pos >= end) {
      warn(`Track ${index + 1}: ended in the middle of an event.`);
      break outer;
    }
    let status = dv.getUint8(pos++);
    if (status < 0x80) {
      if (!running) {
        warn(`Track ${index + 1}: data byte ${status} with no running status at tick ${tick}; stopped parsing this track.`);
        break outer;
      }
      pos--;                 // replay it as the first data byte of `running`
      status = running;
    } else if (status < 0xf0) {
      running = status;      // channel messages may repeat
    } else {
      running = 0;           // meta / sysex / system cancel running status
    }

    /* --- meta and sysex ------------------------------------------------ */
    if (status === 0xff || status === 0xf0 || status === 0xf7) {
      // FF <type> <len> <data> | F0/F7 <len> <data> | FF F7 <len> <data> (escape)
      let type = -1;
      if (status === 0xff) {
        if (pos >= end) { warn(`Track ${index + 1}: ended after a meta-event marker.`); break outer; }
        type = dv.getUint8(pos++);
      }
      const sysex = status !== 0xff || type === 0xf7;
      if (sysex) sysexCount++;

      const { value: len, pos: after } = readVarLen(dv, pos, end);
      if (len < 0) {
        warn(`Track ${index + 1}: unreadable event length at tick ${tick}; stopped parsing this track.`);
        break outer;
      }
      const dataStart = after;
      const dataEnd = Math.min(end, dataStart + len);
      if (dataStart + len > end) {
        warn(`Track ${index + 1}: event at tick ${tick} claims ${len} bytes but the track ends early; used what was there.`);
      }
      pos = dataEnd;

      if (sysex) continue;             // payload is opaque: skipped by length
      if (type === META.END_OF_TRACK) { sawEnd = true; break outer; }

      switch (type) {
        case META.TEMPO: {
          if (dataEnd - dataStart < 3) break;
          const us = (dv.getUint8(dataStart) << 16) | (dv.getUint8(dataStart + 1) << 8) | dv.getUint8(dataStart + 2);
          if (us > 0) tempoEvents.push({ tick, bpm: 60000000 / us });
          break;
        }
        case META.TIME_SIG: {
          if (dataEnd - dataStart < 2) break;
          const beats = dv.getUint8(dataStart);
          const beatType = 1 << dv.getUint8(dataStart + 1);
          timeSigs.push({ tick, beats: beats || 4, beatType: beatType || 4 });
          break;
        }
        case META.KEY_SIG: {
          if (dataEnd - dataStart < 2) break;
          let sf = dv.getUint8(dataStart);
          if (sf >= 0x80) sf -= 0x100;               // signed fifths
          const mi = dv.getUint8(dataStart + 1);
          keySigs.push({ tick, fifths: sf, mode: mi === 1 ? 'minor' : mi === 2 ? 'major' : null });
          break;
        }
        case META.TRACK_NAME:
          if (!name) name = decodeText(new Uint8Array(dv.buffer, dataStart, dataEnd - dataStart));
          break;
        case META.SEQ_SPECIFIC_TEXT:
        case META.TEXT:
          if (!text) text = decodeText(new Uint8Array(dv.buffer, dataStart, dataEnd - dataStart));
          break;
        case META.INSTRUMENT_NAME:
          if (!instrumentName) instrumentName = decodeText(new Uint8Array(dv.buffer, dataStart, dataEnd - dataStart));
          break;
        default:
          break;                       // unknown meta: already skipped by length
      }
      continue;
    }

    /* --- system common / real time -------------------------------------- */
    if (status >= 0xf0) {
      const n = SYSTEM_DATA_LEN[status] || 0;
      for (let i = 0; i < n; i++) readData();
      if (bad) { warn(`Track ${index + 1}: malformed system message at tick ${tick}; stopped parsing this track.`); break outer; }
      continue;
    }

    /* --- channel voice messages ----------------------------------------- */
    const chan = status & 0x0f;
    switch (status & 0xf0) {
      case 0x80: { const p = readData(); readData(); if (!bad) noteOff(chan, p); break; }
      case 0x90: {
        const p = readData(), v = readData();
        if (bad) break;
        if (v === 0) noteOff(chan, p);              // note-on velocity 0 IS a note-off
        else noteOn(chan, p, v);
        break;
      }
      case 0xa0: {                                     // polyphonic aftertouch
        const p = readData(), v = readData();
        if (!bad) {
          const ch = active[chan];
          const stack = ch && ch[p];
          if (stack) for (const n of stack) n.aftertouch = v / 127;
        }
        break;
      }
      case 0xb0: {                                     // control change
        const c = readData(), v = readData();
        if (bad) break;
        if (c === CC_SUSTAIN) setPedal(chan, v >= 64);
        else if (c === CC_ALL_SOUND_OFF || c === CC_ALL_NOTES_OFF) closeChannel(chan);
        else if (c === CC_RESET_ALL_CONTROLLERS) bend[chan] = PITCH_BEND_CENTRE;
        break;
      }
      case 0xc0: { programs[chan] = readData(); break; }          // program change
      case 0xd0: { readData(); break; }                            // channel aftertouch
      case 0xe0: {                                                // pitch bend
        const lsb = readData(), msb = readData();
        if (!bad) bend[chan] = lsb | (msb << 7);
        break;
      }
      default:
        readData(); readData();
        warn(`Track ${index + 1}: unknown status byte 0x${status.toString(16)}; skipped 2 bytes.`);
    }
    if (bad) {
      warn(`Track ${index + 1}: expected a data byte but found 0x${dv.getUint8(Math.max(0, pos - 1)).toString(16)} at tick ${tick}; stopped parsing this track.`);
      break outer;
    }
  }

  // Anything still held at the end of the track gets a short tail.
  let heldSample = null;
  for (let chan = 0; chan < 16; chan++) {
    const ch = active[chan];
    if (!ch) continue;
    for (let pitch = 0; pitch < 128; pitch++) {
      const stack = ch[pitch];
      if (!stack || !stack.length) continue;
      for (const n of stack) {
        n.offTick = tick;
        n.heldAtEnd = true;     // never released: give it a release tail below
        const pd = pedal[chan];
        if (pd && pd.down) { n.sustained = true; pd.pending.push(n); }
        else n.sustainEnd = tick;
        notes.push(n);
        chanNotes[chan]++;
        stillHeld++;
        if (heldSample == null) heldSample = pitch;
      }
      stack.length = 0;
    }
    const pd = pedal[chan];
    if (pd) {                       // pedal still down at end of track
      for (const n of pd.pending) n.sustainEnd = tick;
      pd.pending.length = 0;
    }
  }

  if (!sawEnd) warn(`Track ${index + 1}: no end-of-track marker; used the end of the chunk.`);
  if (unmatchedOff) warn(`${unmatchedOff} note-off event${unmatchedOff === 1 ? '' : 's'} had no matching note-on and were ignored.`);
  if (stillHeld) warn(`${stillHeld} note${stillHeld === 1 ? '' : 's'} (e.g. ${midiToName(heldSample)}) were still sounding at the end of track ${index + 1}; given a short release tail.`);
  if (sysexCount) warn(`Track ${index + 1}: ${sysexCount} system-exclusive event${sysexCount === 1 ? '' : 's'} skipped.`);

  // The channel that carried the most notes wins the part's identity.
  let domChan = 0;
  for (let c = 1; c < 16; c++) if (chanNotes[c] > chanNotes[domChan]) domChan = c;
  const usedChannels = chanNotes.reduce((a, n) => a + (n ? 1 : 0), 0);

  return {
    index, name, instrumentName, text, notes,
    tempoEvents, timeSigs, keySigs,
    endTick: tick,
    channel: domChan,
    program: programs[domChan] || 0,
    usedChannels,
  };
}

/* ------------------------------------------------------------- score pieces */

/** Bars from the time-signature map, walking a bar cursor (4/4 assumed at 0). */
function countMeasures(timeSigs, totalQuarters) {
  const marks = timeSigs.slice().sort((a, b) => a.quarter - b.quarter);
  let cursor = 0, i = 0, count = 0, guard = 0;
  while (cursor < totalQuarters - 1e-6) {
    while (i + 1 < marks.length && marks[i + 1].quarter <= cursor + 1e-6) i++;
    const qpm = (marks[i].beats * 4) / marks[i].beatType;
    if (!(qpm > 0)) return count;
    count++;
    cursor += qpm;
    if (++guard > 200000) return count;     // pathological meter/length guard
  }
  return count;
}

/** Collapse repeated events at the same position, keeping the last one. */
function dedupeByQuarter(list) {
  const out = [];
  for (const e of list) {
    if (out.length && Math.abs(out[out.length - 1].quarter - e.quarter) < 1e-9) out[out.length - 1] = e;
    else out.push(e);
  }
  return out;
}

/* ------------------------------------------------------------------- public */

/**
 * Parse a Standard MIDI File into the internal score.
 *
 * @param {ArrayBuffer|ArrayBufferView} arrayBuffer raw `.mid` bytes
 * @param {object} [opts]
 * @param {number} [opts.transpose=0] semitones added to every note **at parse
 *        time** (do not also pass this to `resolveScore`, or it doubles).
 * @param {boolean} [opts.splitTracks=true] one part per `MTrk`; `false` merges
 *        every track into a single part.
 * @param {string} [opts.title] fallback title when the file carries no name
 * @returns {Score}
 */
export function parseMidi(arrayBuffer, opts = {}) {
  const transpose = opts.transpose | 0;
  const splitTracks = opts.splitTracks !== false;
  const buf = asBuffer(arrayBuffer);
  const dv = new DataView(buf);
  const end = buf.byteLength;

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

  /* -- header ----------------------------------------------------------- */
  if (end < 8) {
    throw new Error(`parseMidi: file is only ${end} bytes long — too short to be a Standard MIDI File.`);
  }
  const magic = tagAt(dv, 0);
  if (magic === 'RIFF' || magic === 'FORM') {
    throw new Error(
      'parseMidi: this is a RIFF container (WAV/AVI), not a Standard MIDI File. ' +
      'If the audio came from a .wav or .mp3, it cannot be transcribed to a score.'
    );
  }
  if (magic !== 'MThd') {
    throw new Error(
      `parseMidi: not a Standard MIDI File — expected an "MThd" header chunk but found "${printableTag(magic)}".`
    );
  }
  const headerLen = dv.getUint32(4);
  if (8 + headerLen > end) {
    warn(`The MThd chunk claims ${headerLen} bytes but the file is only ${end} bytes; read what was there.`);
  }
  const headerEnd = Math.min(end, 8 + headerLen);
  if (headerEnd < 14) {
    throw new Error('parseMidi: the MThd chunk is truncated — there is no usable MIDI header.');
  }

  const format = dv.getUint16(8);
  const ntrks = dv.getUint16(10);
  const division = dv.getUint16(12);
  if (format > 2) warn(`Unusual MIDI format ${format}; parsed as format 1.`);
  else if (format === 2) warn('Sequential (format 2) MIDI: per-track time offsets are ignored and tracks are treated as simultaneous.');
  if (ntrks === 0) warn('The header declares 0 tracks.');

  /* -- chunk walk ------------------------------------------------------- */
  const tracks = [];
  let pos = headerEnd;
  while (pos + 8 <= end) {
    const id = tagAt(dv, pos);
    const declared = dv.getUint32(pos + 4);
    const dataStart = pos + 8;
    const available = end - dataStart;
    const len = declared > available ? available : declared;

    if (id === 'MTrk') {
      tracks.push(parseTrack(dv, dataStart, dataStart + len, tracks.length, warn));
    } else if (id !== 'MThd') {
      warn(`Skipped unknown chunk "${printableTag(id)}" (${declared} bytes).`);
    }
    pos = dataStart + len;   // always advances by at least the 8-byte chunk header
  }
  if (!tracks.length) warn('No MTrk track chunks were found in this file.');
  if (ntrks && tracks.length !== ntrks) {
    warn(`The header declares ${ntrks} track(s) but ${tracks.length} were present.`);
  }

  /* -- score-wide meta -------------------------------------------------- */
  const tempoEvents = tracks.flatMap((t) => t.tempoEvents);
  const clock = buildClock(division, tempoEvents, warn);

  const tempoMap = dedupeByQuarter(
    tempoEvents
      .slice()
      .sort((a, b) => a.tick - b.tick)
      .map((e) => ({ quarter: Math.max(0, clock.toQuarters(e.tick)), bpm: e.bpm }))
  );
  if (!tempoMap.length || tempoMap[0].quarter > 0) {
    tempoMap.unshift({ quarter: 0, bpm: 120 });   // the model requires an entry at 0
  }

  const timeSigs = dedupeByQuarter(
    tracks.flatMap((t) => t.timeSigs).map((e) => ({
      quarter: Math.max(0, clock.toQuarters(e.tick)), beats: e.beats, beatType: e.beatType,
    })).sort((a, b) => a.quarter - b.quarter)
  );
  if (!timeSigs.length || timeSigs[0].quarter > 0) {
    timeSigs.unshift({ quarter: 0, beats: 4, beatType: 4 });
  }

  const keySigs = dedupeByQuarter(
    tracks.flatMap((t) => t.keySigs).map((e) => ({
      quarter: Math.max(0, clock.toQuarters(e.tick)), fifths: e.fifths, mode: e.mode,
    })).sort((a, b) => a.quarter - b.quarter)
  );
  if (!keySigs.length || keySigs[0].quarter > 0) {
    keySigs.unshift({ quarter: 0, fifths: 0, mode: null });
  }

  /* -- notes ------------------------------------------------------------ */
  let endTick = 0;
  for (const t of tracks) endTick = Math.max(endTick, t.endTick);

  const noteTotal = tracks.reduce((a, t) => a + t.notes.length, 0);
  let clamped = 0;
  let lastQuarter = 0;

  /** Raw tick-domain note -> model note in quarter units. */
  function toModelNote(n) {
    const quarter = Math.max(0, clock.toQuarters(n.tick));
    const endQuarter = Math.max(quarter, clock.toQuarters(n.offTick));
    let durationQuarters = endQuarter - quarter;
    // A note the track never released is still ringing when the music stops:
    // let it decay instead of cutting it dead.
    if (n.heldAtEnd) durationQuarters += TAIL_QUARTERS;
    if (durationQuarters <= 0) durationQuarters = MIN_DUR_QUARTERS;

    const sustainQuarters = n.sustained
      ? Math.max(0, clock.toQuarters(n.sustainEnd) - endQuarter)
      : 0;

    let midi = n.pitch + transpose;
    if (midi < 0 || midi > 127) { midi = Math.max(0, Math.min(127, midi)); clamped++; }

    const note = makeNote({
      midi, velocity: n.velocity, quarter, durationQuarters,
      tieFrom: false, tieTo: false,
    });
    // makeNote() returns a fixed key set — attach everything the engine needs.
    note.channel = n.chan;
    note.bendCents = n.bend;
    note.aftertouch = n.aftertouch;
    note.sustainQuarters = sustainQuarters;
    note.soundingQuarters = durationQuarters + sustainQuarters;
    lastQuarter = Math.max(lastQuarter, quarter + note.soundingQuarters);
    return note;
  }

  let parts;
  if (splitTracks) {
    parts = tracks
      .filter((t) => t.notes.length)
      .map((t) => {
        const notes = t.notes.map(toModelNote)
          .sort((a, b) => (a.quarter - b.quarter) || (a.midi - b.midi));
        return makePart({
          id: `P${t.index + 1}`,
          // FF 03 track name, then FF 04 instrument name, then FF 01 text
          name: t.name || t.instrumentName || t.text || `Track ${t.index + 1}`,
          midiProgram: t.program,
          channel: t.channel,
          notes,
        });
      });
  } else {
    const all = tracks.flatMap((t) => t.notes);
    const notes = all.map(toModelNote).sort((a, b) => (a.quarter - b.quarter) || (a.midi - b.midi));
    const first = tracks.find((t) => t.program) || tracks[0];
    const label = opts.title || tracks.map((t) => t.name).find(Boolean) || 'All tracks';
    parts = [makePart({
      id: 'P1',
      name: label,
      midiProgram: first ? first.program : 0,
      channel: first ? first.channel : 0,
      notes,
    })];
  }

  if (noteTotal === 0) warn('This MIDI file contains no notes.');
  if (clamped) warn(`${clamped} note${clamped === 1 ? '' : 's'} fell outside MIDI range 0–127 after transposition and were clamped.`);
  for (const t of tracks) {
    if (t.usedChannels > 1) {
      warn(`Track ${t.index + 1} uses ${t.usedChannels} MIDI channels; all of its notes were kept in one part (channel ${t.channel}).`);
    }
  }

  const totalQuarters = Math.max(clock.toQuarters(endTick), lastQuarter);

  const named = tracks.map((t) => t.name).find(Boolean);
  const score = createScore({
    title: opts.title || named || 'Untitled',
    sourceFormat: 'midi',
    parts,
    tempoMap,
    keySigs,
    timeSigs,
    totalQuarters,
    measureCount: countMeasures(timeSigs, totalQuarters),
  });

  score.warnings = warnings;
  if (suppressed) score.warnings.push(`${suppressed} further warning${suppressed === 1 ? '' : 's'} suppressed.`);

  // Keep the raw tick resolution for UI/debugging; harmless if unused.
  score.midiDivision = division;
  score.midiFormat = format;
  score.midiSmpte = !!clock.smpte;
  return score;
}