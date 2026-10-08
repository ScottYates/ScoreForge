/**
 * audio/gm.js — General MIDI program → our instrument id.
 *
 * MIDI files carry a program number and MusicXML carries a `<midi-program>`
 * or a `<score-instrument>` name. Neither tells us which of *our* voices to use,
 * so this maps the 128 GM programs onto the roster in `instruments.js`.
 * Anything unrecognised falls back to a sensible acoustic default rather than
 * an error — a MIDI piano track should not fail because it used program 12.
 */

import { INSTRUMENTS } from './instruments.js';

const BY_ID = new Map(INSTRUMENTS.map((i) => [i.id, i]));

/** program number (0-based, as stored in MIDI) -> our instrument id */
const GM = [
  // 0-7   Piano family
  'grand', 'bright-piano', 'felt-piano', 'felt-piano',
  'felt-piano', 'felt-piano', 'felt-piano', 'felt-piano',
  // 8-15  Chromatic percussion
  'celesta', 'glockenspiel', 'glockenspiel', 'music-box',
  'vibraphone', 'marimba', 'marimba', 'timpani',
  // 16-23 Organ
  'pipe-organ', 'pipe-organ', 'pipe-organ', 'pipe-organ',
  'pipe-organ', 'pipe-organ', 'pipe-organ', 'pipe-organ',
  // 24-31 Guitar
  'nylon-guitar', 'nylon-guitar', 'nylon-guitar', 'nylon-guitar',
  'nylon-guitar', 'nylon-guitar', 'nylon-guitar', 'nylon-guitar',
  // 32-39 Bass
  'electric-bass', 'electric-bass', 'electric-bass', 'electric-bass',
  'electric-bass', 'electric-bass', 'electric-bass', 'electric-bass',
  // 40-55 Strings
  'strings', 'strings', 'strings', 'strings',
  'strings', 'strings', 'strings', 'strings',
  'strings', 'strings', 'strings', 'strings',
  'strings', 'harp', 'strings', 'strings',
  // 56-63 Ensemble / brass
  'strings', 'strings', 'strings', 'strings',
  'strings', 'strings', 'strings', 'strings',
  // 64-79 Reed & pipe
  'alto-sax', 'alto-sax', 'clarinet', 'clarinet',
  'flute', 'flute', 'flute', 'flute',
  'choir', 'choir', 'choir', 'choir',
  'strings', 'strings', 'strings', 'strings',
  // 80-87 Lead
  'analog-lead', 'analog-lead', 'analog-lead', 'analog-lead',
  'analog-lead', 'analog-lead', 'analog-lead', 'analog-lead',
  // 88-95 Pad / synth
  'warm-pad', 'warm-pad', 'warm-pad', 'warm-pad',
  'warm-pad', 'warm-pad', 'warm-pad', 'warm-pad',
  // 96-127 Effects, ethnic, percussive
  'warm-pad', 'warm-pad', 'warm-pad', 'warm-pad',
  'warm-pad', 'warm-pad', 'warm-pad', 'warm-pad',
  'warm-pad', 'warm-pad', 'warm-pad', 'warm-pad',
  'warm-pad', 'warm-pad', 'warm-pad', 'warm-pad',
  'warm-pad', 'warm-pad', 'warm-pad', 'warm-pad',
  'marimba', 'celesta', 'grand', 'celesta',
  'music-box', 'vibraphone', 'marimba', 'choir',
  'choir', 'choir', 'strings', 'grand',
];

/** @returns {string} a valid instrument id */
export function instrumentForProgram(program) {
  const p = Number(program);
  if (Number.isFinite(p) && p >= 0 && p < 128) {
    const id = GM[Math.floor(p)];
    if (id && BY_ID.has(id)) return id;
  }
  return 'grand';
}

/** Rough name-based fallback for MusicXML `<instrument-sound>` / `<score-instrument>`. */
export function instrumentForName(name) {
  const s = String(name || '').toLowerCase();
  if (!s) return null;
  const table = [
    [/grand|acoustic grand|bösendorfer|steinway/, 'grand'],
    [/bright piano|pop piano/, 'bright-piano'],
    [/felt|soft piano/, 'felt-piano'],
    [/electric piano|rhodes|wurlitzer|epiano/, 'rhodes'],
    [/celesta|celeste/, 'celesta'],
    [/glocken|xylophone/, 'glockenspiel'],
    [/music box|musicbox/, 'music-box'],
    [/vibraphone|vibes/, 'vibraphone'],
    [/marimba|balafon/, 'marimba'],
    [/timpani|kettledrum/, 'timpani'],
    [/harpsichord|clavichord/, 'harpsichord'],
    [/harp/, 'harp'],
    [/guitar/, 'nylon-guitar'],
    [/(electric bass|upright bass|contrabass|double bass)/, 'electric-bass'],
    [/string|violin|viola|cello|orchestra/, 'strings'],
    [/choir|voice|vocal/, 'choir'],
    [/organ/, 'pipe-organ'],
    [/synth|pad|warm/, 'warm-pad'],
    [/flute|recorder/, 'flute'],
    [/clarinet|oboe|bassoon/, 'clarinet'],
    [/sax|saxophone/, 'alto-sax'],
    [/lead|synth lead/, 'analog-lead'],
  ];
  for (const [re, id] of table) if (re.test(s) && BY_ID.has(id)) return id;
  return null;
}