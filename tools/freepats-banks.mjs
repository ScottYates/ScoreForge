/**
 * tools/freepats-banks.mjs - which FreePats sound banks become instruments.
 *
 * One entry per downloaded bank, and the table is the roster: what the bank is
 * called in the instrument list, and which modelled instrument stands in for it
 * when the pack has not loaded.
 *
 * What is deliberately NOT here: stereo, looping, sample rate. All three are
 * read from the bank itself rather than written down, because they are
 * properties of the recording and an entry that claimed otherwise would be a
 * guess that stops being true the next time FreePats re-issues a bank. The
 * builder takes stereo from the WAV's channel count and loops from the loop
 * points the SFZ already declares -- the author of the bank already worked out
 * where its loop is, and re-deriving it from the envelope is strictly worse.
 *
 * `target` is the one judgement call, and it is about the mix rather than the
 * bank: every instrument plays at the same peak so the roster is internally
 * consistent, with struck and plucked things set a little lower because they
 * have a hard attack and would otherwise slam the bus. It is applied as
 * playback gain, not written into the sample files.
 */

/** @typedef {{slug:string, pack:string, name:string, fallback:string,
 *            target?:number, maxHits?:number,
 *            loop?:boolean, group?:string}} Bank */

/** @type {Bank[]} */
export const FREEPATS_BANKS = [
  // -- keyboards ------------------------------------------------------------
  // A piano is struck, not bowed. Its bank's SFZ does declare loop points, and
  // honouring them turned every note held longer than a few seconds into a
  // drone that jumped back up to full level. The string has to be allowed to
  // decay and stop. Both entries used to carry `maxSec: 10`, which cut the take
  // where it was still audible; nothing is truncated now, so a long A2 decays
  // for as long as the recording says it does.
  { slug: 'upright-piano-kw', pack: 'fp-upright', name: 'Upright Piano (recorded)',
    fallback: 'felt-piano', loop: false },
  { slug: 'old-piano-fb', pack: 'fp-honky-tonk', name: 'Honky-Tonk Piano (recorded)',
    fallback: 'felt-piano', target: 0.42, loop: false },
  // -- organs ---------------------------------------------------------------
  { slug: 'church-organ-emulation', pack: 'fp-church-organ', name: 'Church Organ (recorded)', fallback: 'pipe-organ', target: 0.42 },
  { slug: 'drawbar-organ-emulation', pack: 'fp-drawbar-organ', name: 'Drawbar Organ (recorded)', fallback: 'rhodes' },
  { slug: 'percussive-organ-emulation', pack: 'fp-percussive-organ', name: 'Percussive Organ (recorded)', fallback: 'warm-pad' },
  { slug: 'rock-organ-emulation', pack: 'fp-rock-organ', name: 'Rock Organ (recorded)', fallback: 'warm-pad' },
  { slug: 'button-accordion-hn', pack: 'fp-accordion', name: 'Button Accordion (recorded)', fallback: 'harpsichord' },

  // -- plucked and struck ---------------------------------------------------
  { slug: 'spanish-classical-guitar', pack: 'fp-nylon-guitar', name: 'Nylon-String Guitar (recorded)', fallback: 'nylon-guitar', target: 0.42 },
  { slug: 'fss-steel-string-acoustic-guitar', pack: 'fp-steel-guitar', name: 'Steel-String Guitar (recorded)', fallback: 'nylon-guitar', target: 0.42 },
  { slug: 'concert-harp', pack: 'fp-harp', name: 'Concert Harp (recorded)', fallback: 'harp', target: 0.42 },
  { slug: 'kalimba', pack: 'fp-kalimba', name: 'Kalimba (recorded)', fallback: 'music-box', target: 0.40 },
  { slug: 'jaw-harp', pack: 'fp-jaw-harp', name: 'Jaw Harp (recorded)', fallback: 'music-box', target: 0.40 },
  { slug: 'hang-tuned-in-d-minor', pack: 'fp-hang', name: 'Hang (recorded)', fallback: 'music-box', target: 0.40 },
  { slug: 'glasses-of-water', pack: 'fp-glasses', name: 'Glasses (recorded)', fallback: 'music-box', target: 0.38, maxHits: 3 },
  { slug: 'ukulele', pack: 'fp-ukulele', name: 'Ukulele (recorded)', fallback: 'nylon-guitar', target: 0.42 },

  // -- electric guitar and bass --------------------------------------------
  { slug: 'fsbs-electric-guitar-clean-1', pack: 'fp-eg-clean', name: 'Electric Guitar, Clean (recorded)', fallback: 'nylon-guitar', target: 0.42 },
  { slug: 'fsbs-electric-guitar-clean-2-jazz', pack: 'fp-eg-jazz', name: 'Electric Guitar, Jazz (recorded)', fallback: 'nylon-guitar', target: 0.42 },
  { slug: 'fsbs-electric-guitar-direct', pack: 'fp-eg-direct', name: 'Electric Guitar, Direct (recorded)', fallback: 'nylon-guitar', target: 0.42 },
  { slug: 'fsbs-electric-guitar-distorted-1', pack: 'fp-eg-dist-1', name: 'Electric Guitar, Distorted I (recorded)', fallback: 'analog-lead', target: 0.42 },
  { slug: 'fsbs-electric-guitar-distorted-2', pack: 'fp-eg-dist-2', name: 'Electric Guitar, Distorted II (recorded)', fallback: 'analog-lead', target: 0.42 },
  { slug: 'bass-guitar-yr', pack: 'fp-bass-guitar', name: 'Bass Guitar (recorded)', fallback: 'electric-bass' },

  // -- orchestral -----------------------------------------------------------
  { slug: 'clarinet', pack: 'fp-clarinet', name: 'Clarinet (recorded)', fallback: 'clarinet' },
  { slug: 'tenor-saxophone', pack: 'fp-tenor-sax', name: 'Tenor Saxophone (recorded)', fallback: 'alto-sax' },
  { slug: 'ocarina', pack: 'fp-ocarina', name: 'Ocarina (recorded)', fallback: 'flute', target: 0.42 },
  { slug: 'wooden-recorder', pack: 'fp-recorder', name: 'Wooden Recorder (recorded)', fallback: 'flute', target: 0.42 },
  { slug: 'bagpipe', pack: 'fp-bagpipe', name: 'Bagpipe (recorded)', fallback: 'strings', target: 0.42 },

  // -- percussion -----------------------------------------------------------
  { slug: 'xylophone', pack: 'fp-xylophone', name: 'Xylophone (recorded)', fallback: 'marimba', target: 0.40 },
  { slug: 'tubular-bells', pack: 'fp-tubular-bells', name: 'Tubular Bells (recorded)', fallback: 'glockenspiel', target: 0.38 },
  { slug: 'timpani', pack: 'fp-timpani', name: 'Timpani (recorded)', fallback: 'timpani', target: 0.42 },

  // Recordings of synthesisers (FM pianos, synth basses, leads, pads, Lately
  // Bass) were removed from the roster: a sampled synthesiser still sounds
  // like a synthesiser, and this app plays recordings of real instruments.
];

/** Look up one bank's configuration by its download directory name. */
export function freepatsBank(slug) {
  return FREEPATS_BANKS.find((b) => b.slug === slug) || null;
}

/**
 * Picker group per bank.
 *
 * The instrument list renders one <optgroup> per group; a single "Recorded"
 * group would be a wall of names with nothing to tell you which is which.
 * These mirror the sections the FreePats site itself uses, so the app and the
 * website agree about where an instrument lives.
 */
const GROUPS = {
  'fp-upright': 'Piano', 'fp-honky-tonk': 'Piano',

  'fp-church-organ': 'Organ', 'fp-drawbar-organ': 'Organ',
  'fp-percussive-organ': 'Organ', 'fp-rock-organ': 'Organ',
  'fp-accordion': 'Organ',

  'fp-nylon-guitar': 'Plucked & Struck', 'fp-steel-guitar': 'Plucked & Struck',
  'fp-harp': 'Plucked & Struck', 'fp-kalimba': 'Plucked & Struck',
  'fp-jaw-harp': 'Plucked & Struck', 'fp-hang': 'Plucked & Struck',
  'fp-glasses': 'Plucked & Struck', 'fp-ukulele': 'Plucked & Struck',
  'fp-xylophone': 'Plucked & Struck', 'fp-tubular-bells': 'Plucked & Struck',
  'fp-timpani': 'Plucked & Struck',

  'fp-eg-clean': 'Guitar & Bass', 'fp-eg-jazz': 'Guitar & Bass',
  'fp-eg-direct': 'Guitar & Bass', 'fp-eg-dist-1': 'Guitar & Bass',
  'fp-eg-dist-2': 'Guitar & Bass',
  'fp-bass-guitar': 'Guitar & Bass',

  'fp-clarinet': 'Winds & Reed', 'fp-tenor-sax': 'Winds & Reed',
  'fp-ocarina': 'Winds & Reed', 'fp-recorder': 'Winds & Reed',
  'fp-bagpipe': 'Winds & Reed',
};

/**
 * The picker group a pack belongs to.
 *
 * A bank may set `group` on its own entry to override the table, which is how an
 * instrument moves between sections without editing the map in two places.
 */
export function groupFor(pack) {
  const override = FREEPATS_BANKS.find((b) => b.pack === pack && b.group);
  if (override) return override.group;
  return GROUPS[pack] || 'Other';
}