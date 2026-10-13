/**
 * audio/instruments.js: the recorded-instrument roster.
 *
 * Every instrument is a FreePats recording served from pack/ (see
 * audio/sampler.js). There is no synthesiser: when a pack cannot be had (a
 * page opened from file://, a download that failed), createInstrument returns
 * a silent instrument that answers the full interface and says why, and the
 * UI reports it. Engine.prepare() replaces such a channel with the real
 * sampled instrument once its pack is decoded.
 *
 * Contract: CONTRACT.md section 2.
 */

import { createSampledInstrument, hasPack, isPackDecoded, __registerPackOf } from './sampler.js';

/* ================================================================== roster */

const ROSTER = [
  /* --- FreePats: Piano (recorded) --- */
  { id: 'rec-fp-upright', name: 'Upright Piano (recorded)', group: 'Recorded · Piano', engine: 'sampled',
    pack: 'fp-upright',
    description: 'A sampled Upright Piano from the FreePats collection. Struck strings, two hammers per key, no sustain loop — the note decays and stops.' },
  { id: 'rec-fp-honky-tonk', name: 'Honky-Tonk Piano (recorded)', group: 'Recorded · Piano', engine: 'sampled',
    pack: 'fp-honky-tonk',
    description: 'A sampled Honky-Tonk Piano from the FreePats collection.' },

  /* --- FreePats: synthesised, so grouped with the synths --- */
  { id: 'rec-fp-fm-piano-1', name: 'FM Piano I (synthesised)', group: 'Recorded · Synth', engine: 'sampled',
    pack: 'fp-fm-piano-1',
    description: 'An FM-synthesised piano from the FreePats collection — generated, not a recording of an instrument.' },
  { id: 'rec-fp-fm-piano-2', name: 'FM Piano II (synthesised)', group: 'Recorded · Synth', engine: 'sampled',
    pack: 'fp-fm-piano-2',
    description: 'An FM-synthesised piano from the FreePats collection — generated, not a recording of an instrument.' },

  /* --- FreePats: Organ --- */
  { id: 'rec-fp-church-organ', name: 'Church Organ (recorded)', group: 'Recorded · Organ', engine: 'sampled',
    pack: 'fp-church-organ',
    description: 'A sampled Church Organ from the FreePats collection.' },
  { id: 'rec-fp-drawbar-organ', name: 'Drawbar Organ (recorded)', group: 'Recorded · Organ', engine: 'sampled',
    pack: 'fp-drawbar-organ',
    description: 'A sampled Drawbar Organ from the FreePats collection.' },
  { id: 'rec-fp-percussive-organ', name: 'Percussive Organ (recorded)', group: 'Recorded · Organ', engine: 'sampled',
    pack: 'fp-percussive-organ',
    description: 'A sampled Percussive Organ from the FreePats collection.' },
  { id: 'rec-fp-rock-organ', name: 'Rock Organ (recorded)', group: 'Recorded · Organ', engine: 'sampled',
    pack: 'fp-rock-organ',
    description: 'A sampled Rock Organ from the FreePats collection.' },
  { id: 'rec-fp-accordion', name: 'Button Accordion (recorded)', group: 'Recorded · Organ', engine: 'sampled',
    pack: 'fp-accordion',
    description: 'A sampled Button Accordion from the FreePats collection.' },

  /* --- FreePats: Plucked & Struck --- */
  { id: 'rec-fp-nylon-guitar', name: 'Nylon-String Guitar (recorded)', group: 'Recorded · Plucked & Struck', engine: 'sampled',
    pack: 'fp-nylon-guitar',
    description: 'A sampled Nylon-String Guitar from the FreePats collection.' },
  { id: 'rec-fp-steel-guitar', name: 'Steel-String Guitar (recorded)', group: 'Recorded · Plucked & Struck', engine: 'sampled',
    pack: 'fp-steel-guitar',
    description: 'A sampled Steel-String Guitar from the FreePats collection.' },
  { id: 'rec-fp-harp', name: 'Concert Harp (recorded)', group: 'Recorded · Plucked & Struck', engine: 'sampled',
    pack: 'fp-harp',
    description: 'A sampled Concert Harp from the FreePats collection.' },
  { id: 'rec-fp-kalimba', name: 'Kalimba (recorded)', group: 'Recorded · Plucked & Struck', engine: 'sampled',
    pack: 'fp-kalimba',
    description: 'A sampled Kalimba from the FreePats collection.' },
  { id: 'rec-fp-jaw-harp', name: 'Jaw Harp (recorded)', group: 'Recorded · Plucked & Struck', engine: 'sampled',
    pack: 'fp-jaw-harp',
    description: 'A sampled Jaw Harp from the FreePats collection.' },
  { id: 'rec-fp-hang', name: 'Hang (recorded)', group: 'Recorded · Plucked & Struck', engine: 'sampled',
    pack: 'fp-hang',
    description: 'A sampled Hang from the FreePats collection.' },
  { id: 'rec-fp-glasses', name: 'Glasses (recorded)', group: 'Recorded · Plucked & Struck', engine: 'sampled',
    pack: 'fp-glasses',
    description: 'A sampled Glasses from the FreePats collection.' },
  { id: 'rec-fp-ukulele', name: 'Ukulele (recorded)', group: 'Recorded · Plucked & Struck', engine: 'sampled',
    pack: 'fp-ukulele',
    description: 'A sampled Ukulele from the FreePats collection.' },
  { id: 'rec-fp-xylophone', name: 'Xylophone (recorded)', group: 'Recorded · Plucked & Struck', engine: 'sampled',
    pack: 'fp-xylophone',
    description: 'A sampled Xylophone from the FreePats collection.' },
  { id: 'rec-fp-tubular-bells', name: 'Tubular Bells (recorded)', group: 'Recorded · Plucked & Struck', engine: 'sampled',
    pack: 'fp-tubular-bells',
    description: 'A sampled Tubular Bells from the FreePats collection.' },
  { id: 'rec-fp-timpani', name: 'Timpani (recorded)', group: 'Recorded · Plucked & Struck', engine: 'sampled',
    pack: 'fp-timpani',
    description: 'A sampled Timpani from the FreePats collection.' },

  /* --- FreePats: Guitar & Bass --- */
  { id: 'rec-fp-eg-clean', name: 'Electric Guitar, Clean (recorded)', group: 'Recorded · Guitar & Bass', engine: 'sampled',
    pack: 'fp-eg-clean',
    description: 'A sampled Electric Guitar, Clean from the FreePats collection.' },
  { id: 'rec-fp-eg-jazz', name: 'Electric Guitar, Jazz (recorded)', group: 'Recorded · Guitar & Bass', engine: 'sampled',
    pack: 'fp-eg-jazz',
    description: 'A sampled Electric Guitar, Jazz from the FreePats collection.' },
  { id: 'rec-fp-eg-direct', name: 'Electric Guitar, Direct (recorded)', group: 'Recorded · Guitar & Bass', engine: 'sampled',
    pack: 'fp-eg-direct',
    description: 'A sampled Electric Guitar, Direct from the FreePats collection.' },
  { id: 'rec-fp-eg-dist-1', name: 'Electric Guitar, Distorted I (recorded)', group: 'Recorded · Guitar & Bass', engine: 'sampled',
    pack: 'fp-eg-dist-1',
    description: 'A sampled Electric Guitar, Distorted I from the FreePats collection.' },
  { id: 'rec-fp-eg-dist-2', name: 'Electric Guitar, Distorted II (recorded)', group: 'Recorded · Guitar & Bass', engine: 'sampled',
    pack: 'fp-eg-dist-2',
    description: 'A sampled Electric Guitar, Distorted II from the FreePats collection.' },
  { id: 'rec-fp-bass-guitar', name: 'Bass Guitar (recorded)', group: 'Recorded · Guitar & Bass', engine: 'sampled',
    pack: 'fp-bass-guitar',
    description: 'A sampled Bass Guitar from the FreePats collection.' },
  { id: 'rec-fp-lately-bass', name: 'Lately Bass (recorded)', group: 'Recorded · Guitar & Bass', engine: 'sampled',
    pack: 'fp-lately-bass',
    description: 'A sampled Lately Bass from the FreePats collection.' },

  /* --- FreePats: Winds & Reed --- */
  { id: 'rec-fp-clarinet', name: 'Clarinet (recorded)', group: 'Recorded · Winds & Reed', engine: 'sampled',
    pack: 'fp-clarinet',
    description: 'A sampled Clarinet from the FreePats collection.' },
  { id: 'rec-fp-tenor-sax', name: 'Tenor Saxophone (recorded)', group: 'Recorded · Winds & Reed', engine: 'sampled',
    pack: 'fp-tenor-sax',
    description: 'A sampled Tenor Saxophone from the FreePats collection.' },
  { id: 'rec-fp-ocarina', name: 'Ocarina (recorded)', group: 'Recorded · Winds & Reed', engine: 'sampled',
    pack: 'fp-ocarina',
    description: 'A sampled Ocarina from the FreePats collection.' },
  { id: 'rec-fp-recorder', name: 'Wooden Recorder (recorded)', group: 'Recorded · Winds & Reed', engine: 'sampled',
    pack: 'fp-recorder',
    description: 'A sampled Wooden Recorder from the FreePats collection.' },
  { id: 'rec-fp-bagpipe', name: 'Bagpipe (recorded)', group: 'Recorded · Winds & Reed', engine: 'sampled',
    pack: 'fp-bagpipe',
    description: 'A sampled Bagpipe from the FreePats collection.' },

  /* --- FreePats: Synth --- */
  { id: 'rec-fp-synth-bass-1', name: 'Synth Bass I (recorded)', group: 'Recorded · Synth', engine: 'sampled',
    pack: 'fp-synth-bass-1',
    description: 'A sampled Synth Bass I from the FreePats collection.' },
  { id: 'rec-fp-synth-bass-2', name: 'Synth Bass II (recorded)', group: 'Recorded · Synth', engine: 'sampled',
    pack: 'fp-synth-bass-2',
    description: 'A sampled Synth Bass II from the FreePats collection.' },
  { id: 'rec-fp-synth-bass-lead', name: 'Synth Bass & Lead (recorded)', group: 'Recorded · Synth', engine: 'sampled',
    pack: 'fp-synth-bass-lead',
    description: 'A sampled Synth Bass & Lead from the FreePats collection.' },
  { id: 'rec-fp-synth-square', name: 'Synth Lead, Square (recorded)', group: 'Recorded · Synth', engine: 'sampled',
    pack: 'fp-synth-square',
    description: 'A sampled Synth Lead, Square from the FreePats collection.' },
  { id: 'rec-fp-synth-calliope', name: 'Synth Lead, Calliope (recorded)', group: 'Recorded · Synth', engine: 'sampled',
    pack: 'fp-synth-calliope',
    description: 'A sampled Synth Lead, Calliope from the FreePats collection.' },
  { id: 'rec-fp-synth-fifths', name: 'Synth Fifths (recorded)', group: 'Recorded · Synth', engine: 'sampled',
    pack: 'fp-synth-fifths',
    description: 'A sampled Synth Fifths from the FreePats collection.' },
  { id: 'rec-fp-synth-goblins', name: 'Synth Goblins (recorded)', group: 'Recorded · Synth', engine: 'sampled',
    pack: 'fp-synth-goblins',
    description: 'A sampled Synth Goblins from the FreePats collection.' },
  { id: 'rec-fp-synth-sci-fi', name: 'Synth Sci-Fi (recorded)', group: 'Recorded · Synth', engine: 'sampled',
    pack: 'fp-synth-sci-fi',
    description: 'A sampled Synth Sci-Fi from the FreePats collection.' },
  { id: 'rec-fp-synth-soundtrack', name: 'Synth Soundtrack (recorded)', group: 'Recorded · Synth', engine: 'sampled',
    pack: 'fp-synth-soundtrack',
    description: 'A sampled Synth Soundtrack from the FreePats collection.' },
  { id: 'rec-fp-synth-strings-1', name: 'Synth Strings I (recorded)', group: 'Recorded · Synth', engine: 'sampled',
    pack: 'fp-synth-strings-1',
    description: 'A sampled Synth Strings I from the FreePats collection.' },
  { id: 'rec-fp-synth-strings-2', name: 'Synth Strings II (recorded)', group: 'Recorded · Synth', engine: 'sampled',
    pack: 'fp-synth-strings-2',
    description: 'A sampled Synth Strings II from the FreePats collection.' },
  { id: 'rec-fp-synth-brass-1', name: 'Synth Brass I (recorded)', group: 'Recorded · Synth', engine: 'sampled',
    pack: 'fp-synth-brass-1',
    description: 'A sampled Synth Brass I from the FreePats collection.' },
  { id: 'rec-fp-synth-brass-2', name: 'Synth Brass II (recorded)', group: 'Recorded · Synth', engine: 'sampled',
    pack: 'fp-synth-brass-2',
    description: 'A sampled Synth Brass II from the FreePats collection.' },
  { id: 'rec-fp-synth-pad-choir', name: 'Synth Pad, Choir (recorded)', group: 'Recorded · Synth', engine: 'sampled',
    pack: 'fp-synth-pad-choir',
    description: 'A sampled Synth Pad, Choir from the FreePats collection.' },
  { id: 'rec-fp-synth-pad-bowed', name: 'Synth Pad, Bowed (recorded)', group: 'Recorded · Synth', engine: 'sampled',
    pack: 'fp-synth-pad-bowed',
    description: 'A sampled Synth Pad, Bowed from the FreePats collection.' },
  { id: 'rec-fp-sweep-pad', name: 'Synth Sweep Pad (recorded)', group: 'Recorded · Synth', engine: 'sampled',
    pack: 'fp-sweep-pad',
    description: 'A sampled Synth Sweep Pad from the FreePats collection.' },
  { id: 'rec-fp-new-age', name: 'Synth Pad, New Age (recorded)', group: 'Recorded · Synth', engine: 'sampled',
    pack: 'fp-new-age',
    description: 'A sampled Synth Pad, New Age from the FreePats collection.' },
  { id: 'rec-fp-synth-crystal', name: 'Synth Crystal (recorded)', group: 'Recorded · Synth', engine: 'sampled',
    pack: 'fp-synth-crystal',
    description: 'A sampled Synth Crystal from the FreePats collection.' },


// 50 instruments in 6 groups
];

/**
 * The list the UI renders. Recorded groups in the order they first appear,
 * except the synth banks, which go last: they are recordings of synthesisers,
 * and the FM pianos would otherwise sit in second place.
 */
const LISTED = (() => {
  const rank = new Map();
  for (const r of ROSTER) if (!rank.has(r.group)) rank.set(r.group, rank.size);
  const key = (g) => (/Synth$/.test(g) ? Infinity : rank.get(g));
  return ROSTER
    .map((r, i) => [r, i])
    .sort((a, b) => (key(a[0].group) - key(b[0].group)) || (a[1] - b[1]))
    .map(([r]) => r);
})();

export const INSTRUMENTS = LISTED.map((r) => ({
  id: r.id,
  name: r.name,
  group: r.group,
  description: r.description,
  sampled: true,
  // Which pack the instrument plays, so tests can check the roster against
  // what the pack actually contains rather than against a name written into
  // the test.
  pack: r.pack,
  defaults: { ...(r.defaults || {}) },
}));

const BY_ID = new Map(ROSTER.map((r) => [r.id, r]));

/** Just the ids. */
export const INSTRUMENT_IDS = ROSTER.map((r) => r.id);

/**
 * What a part plays when nothing in the file says otherwise. Stated once,
 * here; everything else imports it.
 */
export const DEFAULT_INSTRUMENT = 'rec-fp-upright';

/**
 * Roster id -> pack id. The sampler needs this to turn "the user picked tenor
 * sax" into "decode the tenor sax pack", and it must not keep its own copy of
 * the roster: a second list would drift, and the drift would show up as an
 * instrument that has been fetched but not prepared.
 */
const PACK_OF = new Map(ROSTER.map((r) => [r.id, r.pack]));
__registerPackOf(PACK_OF);

/** The pack a roster id plays from. */
export function packFor(id) {
  return PACK_OF.get(id) || null;
}

/* ============================================================== instruments */

/**
 * A full Instrument that makes no sound, returned when an instrument's pack
 * is not available. It exists so the engine and the export path keep working
 * (notes schedule, renders complete) while the UI says plainly that the part
 * is silent and why. Engine.prepare() swaps it for the real sampled
 * instrument once the pack decodes.
 */
function createSilentInstrument(entry, reason) {
  const api = {
    id: entry.id,
    name: entry.name,
    group: entry.group,
    sampled: false,
    silent: true,
    reason,
    noteOn() { return {}; },
    noteOff() {},
    sweep() {},
    setSustain() {},
    allNotesOff() {},
    setParam() {},
    dispose() {},
    get params() { return {}; },
    warnings: [reason],
    debugStats() { return { id: entry.id, silent: true, reason }; },
  };
  return api;
}

/**
 * @param {string} id        one of INSTRUMENT_IDS
 * @param {BaseAudioContext} ctx  realtime or offline
 * @param {AudioNode} [outputNode]
 * @returns {Instrument}
 */
export function createInstrument(id, ctx, outputNode) {
  const entry = BY_ID.get(id);
  if (!entry) {
    throw new Error('unknown instrument "' + id + '" -- expected one of ' + INSTRUMENT_IDS.join(', '));
  }
  if (!ctx || typeof ctx.createGain !== 'function') {
    throw new TypeError('createInstrument needs an AudioContext or OfflineAudioContext');
  }

  if (hasPack(entry.pack) && isPackDecoded(entry.pack)) {
    try {
      return createSampledInstrument(entry.pack, ctx, outputNode);
    } catch (e) {
      return createSilentInstrument(
        entry, `recorded instrument "${entry.pack}" failed: ${e && e.message ? e.message : e}`);
    }
  }
  const why = hasPack(entry.pack)
    ? `sample pack "${entry.pack}" is not decoded yet`
    : `sample pack "${entry.pack}" is not loaded`;
  return createSilentInstrument(entry, why);
}
