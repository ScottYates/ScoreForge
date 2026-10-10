/**
 * lib/pitch.mjs - a note name to a MIDI number.
 *
 * The one place that answers "what note is this?". It was originally a filename
 * reader, because two of the sample libraries named their takes by pitch
 * (`GPiano_A3_v2`) and each tool that needed the number grew its own copy. Those
 * libraries are gone; FreePats names its takes `1_01.wav` and ships the real map
 * in an SFZ, so the number now comes from a key map instead of a name.
 *
 * The SFZ parser had already written its own copy of this, with its own table of
 * semitone offsets and its own regex -- which is the duplication this file
 * exists to prevent, reproduced by the very thing that replaced the first
 * duplication.
 */

/** Semitone offset of each letter within an octave. */
const BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/**
 * A note name: a letter, an optional sharp or flat, and an octave. The octave
 * is absolute: C4 is middle C, 60, which is the convention the SFZ banks use.
 *
 * Flats matter. The percussive organ bank writes `lokey=G1 hikey=Db2`, so a
 * parser that only accepts sharps returns NaN for half its regions and the whole
 * bank silently vanishes from the instrument list.
 */
const NOTE = /^([A-Ga-g])([#b]?)(-?\d+)$/;

/**
 * MIDI note number for a note name, or null if it is not one.
 *
 *   midiOf('C4')  // 60
 *   midiOf('D#2') // 39
 *   midiOf('Db2') // 37
 *   midiOf('G1')  // 31
 *   midiOf('Bb3') // 58
 */
export function midiOf(token) {
  if (typeof token !== 'string') return null;
  const m = NOTE.exec(token.trim());
  if (!m) return null;
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return (Number(m[3]) + 1) * 12 + BASE[m[1].toUpperCase()] + acc;
}