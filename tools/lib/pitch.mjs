/**
 * lib/pitch.mjs - read a MIDI note number out of a sample filename.
 *
 * Two libraries, two naming schemes, one function. This was duplicated
 * verbatim in survey-samples.mjs and make-pack.mjs, which is exactly the shape
 * that drifts: the pack builder gained a source the survey tool could not read,
 * and the survey then quietly reported those files as unparseable rather than
 * saying it could not follow the naming.
 */

/** Semitone offset of each letter within an octave. */
const BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** A bare pitch token: C4, D#5, F#-1, Bb3. */
const STRICT = /^([A-Ga-g])([#b]?)(-?\d+)$/;

/**
 * A pitch token with a trailing layer tag: A3vH, D#2vH.
 *
 * The tag is the recording layer, not part of the pitch, so it is stripped.
 * This is deliberately tried only after STRICT has failed over every token --
 * a VCSL filename whose underscore tokens all parse is never reinterpreted.
 */
const TAGGED = /^([A-Ga-g])([#b]?)(-?\d+)[A-Za-z]+$/;

function fromMatch(m) {
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return (Number(m[3]) + 1) * 12 + BASE[m[1].toUpperCase()] + acc;
}

/**
 * MIDI note number for a pitch token, or null if it is not a pitch.
 *
 *   midiOf('C4')  // 60
 *   midiOf('D#2') // 39
 *   midiOf('A3vH')// 57
 *   midiOf('Vibes_bowed_E3')  // null - not a single pitch
 */
export function midiOf(token) {
  if (typeof token !== 'string') return null;
  const s = STRICT.exec(token);
  if (s) return fromMatch(s);
  const t = TAGGED.exec(token);
  return t ? fromMatch(t) : null;
}

/**
 * The pitch of a sample file, or null when the name carries none.
 *
 * The pitch is not at a fixed position. `KSHarp_E3_f1` leads with it,
 * `glock_loud_C5_01` puts an articulation before it and a take number after,
 * `Vibes_bowed_E3_rr1_Main` buries it third, and `A3vH` has no separator at
 * all. Assuming a fixed position silently dropped 239 of the 284 VCSL files.
 *
 * So: first pass over the underscore-separated tokens, then the whole name as
 * a single tagged pitch. Order matters -- the strict pass must win, or a name
 * like `C5_01` could be re-read through the looser rule.
 */
export function pitchIn(name) {
  const base = String(name).replace(/\.[^.]+$/, '');
  for (const tok of base.split('_')) {
    const m = midiOf(tok);
    if (m != null && m >= 0 && m <= 127) return m;
  }
  const whole = midiOf(base);
  return whole != null && whole >= 0 && whole <= 127 ? whole : null;
}