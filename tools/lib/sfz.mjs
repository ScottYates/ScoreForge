/**
 * lib/sfz.mjs - read the sample map out of an SFZ file.
 *
 * This exists because FreePats WAV filenames say nothing. A Kalimba bank ships
 * `samples/1_01.wav`, `samples/2_03.wav` and similar; there is no pitch in the
 * name to recover, so a filename parser finds nothing and the instrument looks
 * empty. The SFZ beside them is the actual map:
 *
 *   <group>
 *   lokey=48 hikey=56
 *   pitch_keycenter=53
 *   seq_length=4
 *   <region> seq_position=1  sample=samples/F3_01.wav
 *   <region> seq_position=2  sample=samples/F3_03.wav
 *   ...
 *
 * Which is worth parsing properly for a second reason beyond filenames: the
 * author has already decided which samples map to which keys. `lokey..hikey`
 * with `seq_length` regions means "rotate these four takes across keys 48..56,
 * all of them recorded at 53". Reproducing that mapping is more faithful than
 * anything inferred from the samples themselves.
 *
 * Only the opcodes that carry a mapping are read. The pack builder has no use
 * for envelopes, filters or MIDI CC, and a partial parser that ignores them is
 * honest about that -- a full SFZ implementation would be a soundfont player.
 */

import { midiOf } from './pitch.mjs';

/** Default key range: an SFZ with no lokey/hikey covers the whole keyboard. */
const FULL_RANGE = { lokey: 0, hikey: 127 };

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * A key value, which FreePats writes two ways.
 *
 * Most regions use `lokey=60`. Some use note names -- the percussive organ bank
 * writes `lokey=G1 hikey=Db2` -- and Number('G1') is NaN, so every such region
 * matched no key at all and the whole bank came out unplayable.
 */
function keyNumber(v) {
  if (v == null) return undefined;
  const direct = num(v);
  if (direct !== undefined) return direct;
  const midi = midiOf(v);
  return midi == null ? undefined : midi;
}

/**
 * A key range, with inverted bounds swapped.
 *
 * The percussive organ bank writes `lokey=G1 hikey=Db2`, which under any octave
 * convention puts the low bound above the high one. An inverted range matches
 * nothing, and the organ silently vanishes from the instrument list. Swapping is
 * a guess, but a bounded one: it can only make the range playable, and the
 * sample itself carries `pitch_keycenter` so the pitch stays right.
 */
function keyRange(region) {
  let lo = keyNumber(region.lokey);
  let hi = keyNumber(region.hikey);
  if (lo == null && hi == null && region.key != null) {
    lo = hi = keyNumber(region.key);
  }
  lo = lo ?? FULL_RANGE.lokey;
  hi = hi ?? FULL_RANGE.hikey;
  if (lo > hi) [lo, hi] = [hi, lo];
  return { lo, hi };
}

/**
 * Parse SFZ text into a flat list of regions with group and global opcodes
 * already merged in, which is how SFZ inheritance is meant to work.
 *
 * `baseDir` is the directory holding the .sfz; sample paths are relative to it.
 *
 * @param {string} text
 * @param {string} [baseDir]
 * @returns {Array<object>} regions, each with at least `sample`
 */
export function parseSfz(text, baseDir = '') {
  const regions = [];
  let global = {};
  let group = {};
  let region = null;
  let header = null;

  const flush = () => {
    if (!region || !region.sample) { region = null; return; }
    // Inheritance: a region sees its group, which sees global.
    const merged = { ...global, ...group, ...region, dir: baseDir };
    const { lo, hi } = keyRange(merged);
    regions.push({ ...merged, lokey: lo, hikey: hi });
    region = null;
  };

  // Sample paths are special. They may be quoted, and FreePats writes some of
// them unquoted WITH SPACES -- `sample=Button Accordion HN B3.wav` -- which is
// not valid SFZ but is in the wild. A space-delimited parse truncates those to
// "Button", the file is not found, and the bank reports zero playable keys.
// So take everything up to the next opcode-looking token or end of line.
const SAMPLE = /sample=(?:"([^"]+)"|(.+?))(?=\s+[a-z_0-9]+=|$)/i;

for (const raw of String(text).split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('//')) continue;

    const head = /^<(global|group|master|region)>/i.exec(line);
    if (head) {
      flush();
      header = head[1].toLowerCase();
      if (header === 'global') { global = {}; group = {}; }
      else if (header === 'group') { group = {}; }
      else if (header === 'region') { region = {}; }
      // The opcodes may sit on the header line itself. The button accordion
      // writes `<region> sample=... pitch_keycenter=47 lokey=0 hikey=49`, all on
      // one line; skipping the remainder of that line threw the whole map away
      // and left the bank with no playable keys at all.
      line = line.slice(head[0].length).trim();
      if (!line) continue;
    }

    // Opcodes are key=value, and several may share a line. Values may be
    // quoted when they contain spaces, which sample paths sometimes do.
    const sampleAt = SAMPLE.exec(line);
    if (sampleAt) {
      const target = header === 'region' ? region : header === 'group' ? group : global;
      if (target) target.sample = (sampleAt[1] ?? sampleAt[2]).trim();
      line = line.replace(SAMPLE, ' ');
    }
    for (const m of line.matchAll(/([a-z_0-9]+)=("[^"]*"|[^\s]+)/gi)) {
      const key = m[1].toLowerCase();
      if (key === 'sample') continue; // already handled above
      const value = m[2].replace(/^"|"$/g, '');
      const target = header === 'region' ? region : header === 'group' ? group : global;
      if (target) target[key] = value;
    }
  }
  flush();
  return regions;
}

/**
 * The pitch a region was actually recorded at.
 *
 * SFZ spells this several ways and they disagree about octave numbering, so the
 * explicit ones are preferred in the order a loader would apply them. Falling
 * back to the middle of the key range is what ARIA does when nothing says, and
 * is right far more often than not: a group spanning 48..56 recorded across
 * that span really is centred near 52.
 */
export function keyCentreOf(region) {
  if (region.pitch != null) return keyNumber(region.pitch);
  if (region.key != null) return keyNumber(region.key);
  if (region.pitch_keycenter != null) return keyNumber(region.pitch_keycenter);
  if (region.note != null && region.octave != null) {
    return (Number(region.octave) + 1) * 12 + Number(region.note);
  }
  const lo = keyNumber(region.lokey) ?? 0;
  const hi = keyNumber(region.hikey) ?? 127;
  return Math.round((lo + hi) / 2);
}

/**
 * Which samples a given key plays, in round-robin order.
 *
 * When a group declares `seq_length=N`, SFZ does not mean "all N samples on
 * every key" -- it means key K takes sample number `(K - lokey) % N`. So the
 * rotation is per key, not per group, and getting it wrong makes every key in
 * the range sound like the same note.
 *
 * @returns {Array<object>} matching regions, already rotated into the order
 *   this particular key should cycle through them.
 */
export function regionsForKey(regions, midi) {
  const hit = regions.filter((r) => midi >= (keyNumber(r.lokey) ?? 0) && midi <= (keyNumber(r.hikey) ?? 127));
  if (!hit.length) return hit;

  const sorted = [...hit].sort((a, b) => (num(a.seq_position) ?? 0) - (num(b.seq_position) ?? 0));
  const seq = num(sorted[0].seq_length) || sorted.length;
  const lo = keyNumber(sorted[0].lokey) ?? 0;
  const offset = ((midi - lo) % seq + seq) % seq;

  // Keep every sample for the key, but start the rotation at the one SFZ would
  // pick first, so successive notes differ the way the author intended.
  return [...sorted.slice(offset), ...sorted.slice(0, offset)];
}

/** Does this region describe a sample that loops? */
export function loopsRegion(region) {
  const mode = String(region.loop_mode || '').toLowerCase();
  return mode === 'loop_continuous' || mode === 'loop_sustain';
}