/**
 * tools/make-pack.mjs - build the recorded-instrument sample pack.
 *
 * Every recorded instrument in ScoreForge is a FreePats bank: the WAVs downloaded
 * by tools/fetch-freepats.mjs, re-encoded to MP3 into pack/ alongside one
 * manifest the app fetches at load.
 *
 *   node tools/make-pack.mjs --freepats <dir>
 *   node tools/make-pack.mjs --dry-run       report the plan, write nothing
 *   node tools/make-pack.mjs --out <dir> --hits <n>
 *
 * Two libraries are involved and they owe different things -- see SOURCES below.
 *
 * This build does nothing to the recordings. Nothing is trimmed, nothing is
 * normalised, no loop points are invented, no silence is prepended, and the
 * whole take is kept at its own level. Every MP3 here is the source WAV
 * re-encoded and nothing else.
 *
 * That is the whole design, and the rest of the file exists to keep it true --
 * so the four things that are not obvious, all of which came from measuring the
 * real files rather than from reading the documentation:
 *
 * 1. LEADING SILENCE IS NOT A PROBLEM, IT IS THE FIX. Several banks begin with
 *    silence before the attack, and that used to be trimmed because a note that
 *    plays late is wrong. The sampler already locates the first sound in every
 *    decoded buffer and starts the source node there, so starting later is
 *    exactly what cancels it. Untrimmed takes need nothing done to them, and
 *    they keep the room tone the recording actually had.
 *
 * 2. CODEC DELAY IS NOT CONSTANT, SO IT IS MEASURED, NOT STORED. Chrome does not
 *    strip LAME's encoder delay: 1105 samples for most settings but 1524 for
 *    stereo 96 kbps (tools/check-codec-delay.mjs). A constant in the manifest
 *    would be wrong for some files. Instead findOnset() runs over each decoded
 *    buffer at load and finds the first sound, which absorbs the encoder delay
 *    and the recording's own pre-roll in one measurement. The cost is no bytes
 *    at all, and it is correct on any browser that can decode MP3.
 *
 * 3. PITCHES COME FROM THE SFZ, NOT THE FILENAME. A FreePats bank ships
 *    `1_01.wav`, so the pitch comes from the bank's own key map -- along with
 *    its keycentre, its tune and the loop points its author chose. Loop points
 *    are frame numbers in the source file, so with nothing trimmed they need no
 *    rebasing at all.
 *
 * 4. PITCHES ARE SPARSE. Some banks sample every third semitone. A missing
 *    pitch is filled by playing the nearest real sample at a shifted rate
 *    rather than by dropping the key. tools/list-recorded.mjs reports how far
 *    that shift gets on each bank, because on a few of them it gets a long way.
 *
 * 5. MIX BALANCE IS A GAIN, NOT A REWRITE. Recordings span about 30 dB -- the
 *    piano sits that far below the xylophone -- so the roster needs balancing.
 *    That used to be done by scaling every sample file to a common peak, which
 *    is the one edit this build exists not to make. It is now a number in the
 *    manifest (`hit.g`, the same figure prepare() used to apply) and is applied
 *    by the sampler at playback. Identical mix, unmodified recordings.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWav } from './lib/wav.mjs';
import { encodeMp3 } from './lib/lame.mjs';
import { parseSfz, regionsForKey, keyCentreOf, loopsRegion } from './lib/sfz.mjs';
import { FREEPATS_BANKS } from './freepats-banks.mjs';
import { noticeBlock, applyNoticeBlock, obligationOf } from './lib/credits.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ config */

/**
 * One entry per recorded instrument in the pack.
 *
 * `from` names the entries in SOURCES this family is built from, and `bank`
 * is the directory the downloader put it in. Everything else is measured
 * from the files rather than declared here -- channel count from the WAV,
 * pitch and loop points from the SFZ. The only hand-written setting left is
 * `target`, which is how loud the family sits in the mix. It used to sit
 * alongside `maxSec`, which decided how much of a take to keep and is gone:
 * the whole take is kept now, which is the point.
 *
 * `loop` marks a family that sustains while held. Its samples get loop points
 * so a two-bar note does not run out three seconds in.
 */
const FAMILIES = [];

/**
 * How far below the take's loudest window a loop may start, in dB.
 *
 * Null by default: this is a per-family guard, not a general rule, because the
 * depth is a property of the recording rather than of music. Set one only where
 * a specific recording has been measured to need it.
 */
const LOOP_FLOOR_DB = null;

/**
 * Bitrate, by channel count.
 *
 * The only knob left in this builder. Every sample is the source WAV and nothing
 * else, so the pack is as big as the recordings are long -- keeping the takes in
 * full costs about a fifth more than truncating them to 4 s did, which is the
 * honest price of not throwing away the decay. `--bitrate` moves it if you would
 * rather have the size back.
 */
const BITRATE = { stereo: 96, mono: 64 };

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : dflt;
};
const DRY = args.includes('--dry-run');
const FP = flag('freepats', path.join(os.tmpdir(), 'sf-freepats'));
const OUT = path.resolve(repo, flag('out', 'pack'));
/** How many takes of one note to keep. FreePats ships many; a browser does not need them all. */
const FP_HITS = Number(flag('hits', 2));

// Overrides for the whole build, because pack size is the one thing about an
// unprocessed pack that is a judgement rather than a fact.
if (flag('bitrate', null)) {
  const v = Number(flag('bitrate'));
  BITRATE.stereo = v;
  BITRATE.mono = Math.max(32, Math.round(v * (2 / 3)));
}

// The FreePats banks, turned into families. `bank` is the directory name the
// downloader used; almost everything else is measured from the files rather
// than declared here. The two settings left are about the mix, not the bank.
for (const b of FREEPATS_BANKS) {
  FAMILIES.push({
    pack: b.pack,
    from: [b.slug === 'fss-steel-string-acoustic-guitar' ? 'freepatsGpl' : 'freepats'],
    bank: b.slug,
    name: b.name,
    stereo: undefined,   // read from the WAV's channel count
    // undefined: take the loop points from the SFZ, which is right for anything
    // bowed, blown or driven. false: never loop, for a struck string that has to
    // decay. The bank's entry is what says which, and a piano sets it to false.
    loop: b.loop,
    maxHits: FP_HITS,
    // The peak this family plays at. It used to be applied to the sample files;
    // it is a number in the manifest now and the sampler multiplies by it. See
    // changesFor() and the note in the header.
    target: b.target ?? 0.45,
  });
}

/* ---------------------------------------------------------------- sources */

/**
 * Where each library's recordings come from, and what they are owed.
 *
 * This table is the only place in the project that records sample provenance.
 * pack/manifest.json, the credits block in NOTICE.md and the credits line in
 * the app are all generated from it, and tools/check-pack-credits.mjs fails if
 * the generated file and the manifest ever disagree. A credit maintained by
 * hand next to the code would drift from the files actually shipped, which is
 * the exact failure attribution exists to prevent.
 *
 * `dir` is a thunk rather than a string so this table can be written next to
 * the families that use it, above the argument parsing it depends on.
 */
const SOURCES = {
  /**
   * FreePats, which is where every recorded instrument comes from.
   *
   * It does not name its files by pitch -- a Kalimba bank ships
   * `samples/1_01.wav` -- so it supplies a `load` that reads the bank's own SFZ
   * map instead of scanning filenames. Everything that can be measured is
   * measured from the bank: channel count from the WAV, loop points from the
   * SFZ, pitch from `pitch_keycenter`.
   */
  freepats: {
    dir: () => FP,
    credit: {
      title: 'FreePats',
      author: 'The FreePats project and its contributors',
      licence: 'CC0 1.0 Universal (public domain)',
      url: 'https://freepats.zenvoid.org/',
    },
    load: (cfg) => collectFreepats(cfg),
  },

  /**
   * The one FreePats bank that is not CC0.
   *
   * It is GPL-3+ with the FSF-style sample exception, so music made with it is
   * not forced under the GPL -- but the sample files themselves are, which is an
   * obligation on the pack and not merely a credit to display. It gets its own
   * source so those terms attach to the pack that actually carries them,
   * instead of being averaged into a blanket "FreePats is CC0" that would be
   * false for this one bank.
   */
  freepatsGpl: {
    dir: () => FP,
    credit: {
      title: 'FreePats FSS Steel-String Acoustic Guitar',
      author: 'The FreePats project; FSS samples recorded by its contributors',
      licence: 'GPL-3.0-or-later, with the FreePats sound-sample exception',
      url: 'https://freepats.zenvoid.org/Guitar/steel-acoustic-guitar.html',
    },
    load: (cfg) => collectFreepats(cfg),
  },
};

/**
 * What the pack builder did to a family's recordings.
 *
 * CC BY asks you to state your modifications, and the statements are all
 * audible. They are built from the family config rather than written beside it,
 * because prose next to the setting it describes is prose that goes stale: the
 * grand stopped looping and the notice went on claiming loop points for a year
 * of edits without any check noticing, since the check compares the notice
 * against the manifest and both were generated from the same wrong sentence.
 *
 * Only families whose licence asks for it need one. For the CC0 banks this text
 * is never emitted at all, which is exactly why it has to be right for the one
 * bank that is not CC0: this build re-encodes to MP3 and does nothing else, and
 * the loop points a note carries are the bank's own as published rather than
 * anything invented here.
 */
function changesFor(cfg, built) {
  const bits = [built.stereo ? 'stereo kept' : 'mixed to mono'];
  // "what changed" has to describe what this build did, not what a flag says.
  // The FreePats families take their loop points from the bank's own SFZ rather
  // than deriving them, which is a different edit to the audio and worth
  // declaring as one.
  bits.push(built.anyLoop
    ? (cfg.bank ? 'loop points taken from the bank\'s SFZ as published' : 'loop points added for held notes')
    : 'no loop points');
  // The balance is applied as playback gain, so the file on disk is the
  // recording. Declaring that matters: it is the difference between this pack
  // and the one it replaced, and an attribution that does not say it describes
  // a different set of files.
  bits.push('levels and timing untouched; mix balance applied as playback gain');
  bits.push(`encoded to MP3 at ${built.stereo ? BITRATE.stereo : BITRATE.mono} kbps`);
  return bits.join('; ') + '.';
}

/* ------------------------------------------------------------------ utils */

/**
 * Write a file, retrying a few times if the OS will not open it.
 *
 * Windows hands out UNKNOWN errno -4094 on open() when something else -- a
 * virus scanner walking the directory, an indexer, a sync client -- is holding
 * the file for a moment. A build that writes four thousand files is going to
 * meet that, and dying half an hour in on a transient lock loses the half
 * hour. Anything that is not a share violation or a resource shortage is
 * rethrown immediately rather than retried, so a real failure still fails.
 */
function writeOut(file, data) {
  const TRANSIENT = new Set(['UNKNOWN', 'EBUSY', 'EPERM', 'EAGAIN']);
  let wait = 50;
  for (let attempt = 1; ; attempt++) {
    try {
      fs.writeFileSync(file, data);
      return;
    } catch (e) {
      if (attempt >= 8 || !TRANSIENT.has(e.code)) throw e;
      // Blocking sleep, deliberately: the builder is synchronous and there is
      // nothing else to yield to.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
      wait = Math.min(wait * 2, 2000);
    }
  }
}

/**
 * Loop points inside a sustaining sample, as fractions of the take.
 *
 * Picked at local minima of the envelope rather than at fixed fractions: a hard
 * loop seam clicks in proportion to the amplitude at the splice, and a plucked
 * or struck body swells and ebbs enough that a fixed 30% often lands on a peak.
 */
// Where to look for a loop, as fractions of the take, and how long the
// resulting loop has to be.
//
// These used to be per-family settings, because every family that used this
// heuristic had a take long enough and a sustain steady enough to need its own
// window. FreePats families declare none of them, and undefined arithmetic does
// not fail loudly -- `Math.floor(undefined * dur)` is NaN, and the guard below
// is `!(NaN > NaN + 4)`, so findLoop returned null for every single take and no
// FreePats instrument ever got a fallback loop at all. Ten of the thirteen
// sustaining banks were left with most of their keys unable to hold a note.
//
// The defaults are deliberately in the middle of the take: the attack and the
// opening decay are out at one end, and the last whisper of the release is out
// at the other. A loop shorter than a fifth of a second reads as a buzz rather
// than a held note.
const DEFAULT_LOOP = { from: 0.15, to: 0.88, minSec: 0.25 };

/**
 * How big a step between the two ends of a loop may be, in dB.
 *
 * Below about 3 dB the wrap is not audible as an event. Above roughly 8 dB it is
 * a click that repeats with the note. Anything past this is refused, because
 * the alternative -- looping anyway -- is worse than letting the note decay.
 *
 * This is applied to the banks' own SFZ loop points as well as to the ones found
 * here. That sounds like distrusting the author's map, and it used to be taken
 * on trust, but trust was measurably wrong: the brass 2 bank declares the same
 * 0.89 s window on all five sampled keys, and splicing it raw steps 116 to
 * 157 dB every time the note repeats. Those points were chosen for a player that
 * crossfades the join; this one splices, so they are a suggestion and not a
 * guarantee.
 */
const SEAM_DB = 4;

/** 10 ms RMS windows over the take, and the geometry to map back to it. */
function loopEnvelope(wav, from, to) {
  const len = to - from;
  const win = Math.max(1, Math.round(wav.sampleRate * 0.01));
  const nWin = Math.floor(len / win);
  const env = new Float32Array(nWin);
  for (let w = 0; w < nWin; w++) {
    let s = 0;
    const a = from + w * win;
    const b = Math.min(to, a + win);
    for (const ch of wav.data) for (let i = a; i < b; i++) s += ch[i] * ch[i];
    env[w] = Math.sqrt(s / Math.max(1, (b - a) * wav.data.length));
  }
  return { env, nWin, win, len };
}

const dbOf = (v) => 20 * Math.log10(Math.max(v, 1e-9));

/**
 * The step, in dB, that wrapping at these points would make.
 *
 * Infinity for anything out of range, so a malformed point is refused by the
 * same comparison as a bad one rather than needing its own check.
 */
function seamOf(E, start, end) {
  const i = Math.round((start * E.len) / E.win);
  const j = Math.round((end * E.len) / E.win);
  if (!(i >= 0 && j < E.env.length && j > i)) return Infinity;
  return Math.abs(dbOf(E.env[i]) - dbOf(E.env[j]));
}

function findLoop(wav, from, to, cfg, E) {
  const len = to - from;
  const dur = len / wav.sampleRate;
  if (dur < 0.5) return null;

  const { env, nWin, win } = E;

  // Fractions of the sample, converted to window indices. A family may override
  // any of them; DEFAULT_LOOP covers the ones it does not.
  const toWin = (frac) => Math.floor((frac * dur) / 0.01);
  const loopFrom = cfg.loopFrom == null ? DEFAULT_LOOP.from : cfg.loopFrom;
  const loopTo = cfg.loopTo == null ? DEFAULT_LOOP.to : cfg.loopTo;
  const minLoopSec = cfg.minLoopSec == null ? DEFAULT_LOOP.minSec : cfg.minLoopSec;
  let lo = Math.max(1, toWin(loopFrom));
  let hi = Math.min(nWin - 2, toWin(loopTo));
  if (!(hi > lo + 4)) return null;

  // A loop is a seam in the waveform, so the only thing that matters about where
  // it goes is how the two ends meet. Score the pair, not the points.
  //
  // The fallback only gets a say where the bank declared nothing, or where what
  // it declared will not splice cleanly here. tools/check-loop-seam.mjs measures
  // whichever loops actually shipped.
  const minLoopWin = Math.ceil(minLoopSec / 0.01);
  if (!(hi > lo + minLoopWin)) return null;

  /**
   * Choose the loop as a PAIR, by sliding a fixed-length segment across the
   * candidate range and keeping the placement whose two ends are closest in
   * level.
   *
   * The previous version picked the quietest window for the start and the
   * quietest for the end independently, half a take apart. Nothing related them,
   * so on any tone that changes level across its length the wrap joined two
   * different volumes -- 35 of 140 held notes gated at the loop point when this
   * ran over the whole pack.
   *
   * Scoring a segment by the step its own ends make is scoring exactly what is
   * measured afterwards, so the chooser and the check cannot disagree. Among
   * acceptable placements the quietest midpoint wins, which puts the loop low in
   * the decay without ever preferring a quiet end over a matched one.
   */
  let bestStart = -1;
  let bestScore = Infinity;
  for (let s = lo; s + minLoopWin <= nWin - 1; s++) {
    const e = s + minLoopWin;
    const step = Math.abs(dbOf(env[s]) - dbOf(env[e]));
    // A step the ear can hear as a click. Beyond this the loop is a discontinuity,
    // and a note that decays into silence is a far smaller fault than one that
    // clicks every time it repeats.
    if (step > SEAM_DB) continue;
    // Among acceptable placements, prefer the quietest midpoint, then the one
    // that sits furthest into the take's steady part.
    const mid = dbOf((env[s] + env[e]) / 2);
    const score = mid + s * 1e-6;
    if (score < bestScore) { bestScore = score; bestStart = s; }
  }
  if (bestStart < 0) return null;

  const startIdx = bestStart;
  const endIdx = bestStart + minLoopWin;
  const spanSec = (endIdx - startIdx) * 0.01;
  if (spanSec < minLoopSec) return null;
  if (spanSec > dur * 0.7) return null; // looping nearly all of it is not a loop

  // A loop in the noise is not a sustain, it is a loop of hiss. Deep in a take's
  // tail the envelope stops being the note and starts being the room, and its RMS
  // swings by tens of dB between adjacent 10 ms windows. When a family sets
  // loopFloorDb, a candidate this far under the take's own loudest window is
  // refused outright. Declining to loop leaves the note decaying into silence,
  // which is what a piano with the damper down actually does.
  const floorDb = cfg.loopFloorDb === undefined ? LOOP_FLOOR_DB : cfg.loopFloorDb;
  if (floorDb != null) {
    const loudest = Math.max(...env);
    if (dbOf(env[startIdx]) - dbOf(loudest) < -floorDb) return null;
  }

  return {
    start: +((startIdx * win) / len).toFixed(4),
    end: +((endIdx * win) / len).toFixed(4),
  };
}

/**
 * The take exactly as recorded, with the channel layout the encoder needs.
 *
 * Nothing else. This used to slice the take to its useful range and scale it to
 * the family target, and both of those are gone -- see the header. What is left
 * is the one thing that is still a question about the file rather than an edit
 * to it: the pack is encoded either stereo or mono as a whole, so a mono take
 * inside a stereo bank is copied to both channels rather than left ragged.
 *
 * Returns the channels to encode plus the two things measured from them: the
 * peak, which becomes the manifest's playback gain, and the stereo width.
 */
function layout(wav, stereo) {
  const out = [];
  for (let c = 0; c < (stereo ? 2 : 1); c++) out.push(wav.data[c] || wav.data[0]);

  let peak = 0;
  for (const ch of out) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));

  // How wide the recording actually is: the side signal against the mid, in dB.
  // Side is (L-R)/2 and mid is (L+R)/2 over the same samples.
  //
  // Recorded so the app's copy can be measured against the recording's own and
  // not against a number somebody guessed. Several FreePats banks are near
  // dual-mono and legitimately measure about 0 dB, which is why an absolute
  // "are these channels different enough" threshold gets the honest answer
  // wrong in both directions.
  let sideMid = null;
  if (stereo && wav.data.length > 1) {
    let ss = 0;
    let mm = 0;
    const n = wav.frames;
    for (let i = 0; i < n; i++) {
      const l = wav.data[0][i];
      const r = wav.data[1][i];
      const side = (l - r) * 0.5;
      const mid = (l + r) * 0.5;
      ss += side * side;
      mm += mid * mid;
    }
    sideMid = +(10 * Math.log10((ss + 1e-12) / (mm + 1e-12))).toFixed(2);
  }

  return { channels: out, peak, sideMid };
}

/* ------------------------------------------------------------------- build */

/**
 * Read one FreePats bank through its own SFZ map.
 *
 * The WAV filenames carry no pitch at all, so this cannot work by looking at
 * them -- `1_01.wav` is not a note. The SFZ beside them is the map, and it also
 * carries things worth having for free:
 *
 *   pitch_keycenter  the pitch the sample was actually recorded at, which is
 *                    what the playback rate is computed from
 *   tune             a detune in cents, folded into that rate
 *   loop_start/end   loop points the bank's author chose, in frames
 *
 * Loop points are the biggest win, and most FreePats banks ship their own: those
 * are used exactly as the author published them and the heuristic is never
 * consulted. Where a bank declares none, findLoop() works them out from the
 * envelope, and can leave a seam that steps in level -- tools/check-loop-seam.mjs
 * measures whichever loops actually shipped.
 *
 * Returns the same shape collect() produces: MIDI -> ordered takes.
 */
/**
 * Which hammer struck a take, read from the bank's own filename.
 *
 * FreePats names its layers vL / vM / vH, or with a MIDI velocity number, and
 * the upright piano ships two of them per key. Returns 0..1, or null when the
 * name says nothing about velocity -- which is most banks, and is fine: with one
 * layer there is nothing to choose between.
 *
 * The `v` must follow a non-letter, so "Choir" and "Envelope2" are not read as
 * velocity markers.
 */
function velocityOf(sample) {
  const m = /(?:^|[^A-Za-z])v(\d+|L|M|H)(?=[^A-Za-z]|$)/i.exec(path.basename(sample || ''));
  if (!m) return null;
  const t = m[1].toUpperCase();
  if (t === 'L') return 0.2;
  if (t === 'M') return 0.5;
  if (t === 'H') return 0.85;
  const n = Number(t);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n / 127)) : null;
}

function collectFreepats(cfg) {
  const bankDir = path.join(FP, cfg.bank, 'extracted');
  if (!fs.existsSync(bankDir)) return new Map();

  const sfzFiles = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.sfz$/i.test(e.name)) sfzFiles.push(p);
    }
  })(bankDir);
  if (!sfzFiles.length) return new Map();

  let regions = [];
  for (const s of sfzFiles) regions = regions.concat(parseSfz(fs.readFileSync(s, 'utf8'), path.dirname(s)));
  regions = regions.filter((r) => r.sample && fs.existsSync(path.join(r.dir, r.sample)));
  if (!regions.length) return new Map();

  // The key range the bank actually covers, not 0..127. A Kalimba is 48..84
  // and that is correct; extending it to the whole keyboard would mean playing
  // a 37-key instrument four octaves out of tune at the edges. Keys outside
  // the range are handled by the sampler, which shifts the nearest real one.
  let lo = Infinity, hi = -Infinity;
  for (const r of regions) {
    const a = Number(r.lokey), b = Number(r.hikey);
    if (Number.isFinite(a)) lo = Math.min(lo, a);
    if (Number.isFinite(b)) hi = Math.max(hi, b);
  }
  if (!Number.isFinite(lo)) { lo = 0; hi = 127; }
  lo = Math.max(0, lo); hi = Math.min(127, hi);

  // Whether this instrument sustains is the bank's own answer, not ours: if any
  // region declares a loop, it is a sustaining instrument and every key of it
  // should hold. If none does, it decays, and the heuristic must not go
  // inventing a sustain for it -- that is how an upright piano ends up droning
  // when the recording says it does not loop. So `loop: false` is set here,
  // where the SFZ has just been read, rather than guessed per family.
  if (!regions.some(loopsRegion)) cfg.loop = false;

  const out = new Map();
  for (let midi = lo; midi <= hi; midi++) {
    const takes = regionsForKey(regions, midi)
      .filter((r) => Number.isFinite(Number(r.lokey)) && Number.isFinite(Number(r.hikey)))
      .slice(0, cfg.maxHits || FP_HITS)
      .map((r, i) => ({
        file: r.sample,
        dir: r.dir,
        rank: i,
        centre: keyCentreOf(r),
        tune: Number(r.tune) || 0,
        // Which hammer this is, when the bank recorded more than one per key.
        vel: velocityOf(r.sample),
        // Frame numbers in the SOURCE file. With nothing trimmed these are already
        // frames of the file as shipped, so nothing has to rebase them; the
        // builder divides by the take's own length and is done.
        loop: loopsRegion(r) && r.loop_start != null && r.loop_end != null
          ? [Number(r.loop_start), Number(r.loop_end)]
          : null,
        // Which file in the bank this take came from, relative to the bank's
        // extracted root.
        //
        // Recorded so the claim that the pack is the recordings can be checked
        // against the recordings instead of against the manifest that describes
        // them. tools/check-pack-is-unprocessed.mjs reads the WAV at this path
        // and compares it with the shipped MP3. Without it the only available
        // comparison is the manifest against itself, which moves together with
        // the thing being checked.
        src: path.relative(path.join(FP, cfg.bank, 'extracted'), path.join(r.dir, r.sample)).split(path.sep).join('/'),
      }));
    if (takes.length) out.set(midi, takes);
  }
  return out;
}

/**
 * A family's source files, grouped by MIDI pitch, best take first.
 *
 * Every source now reads the library's own key map rather than guessing a pitch
 * out of a filename -- FreePats names its takes `1_01.wav` and ships the real map
 * alongside them in an SFZ. There used to be a second path that scanned filenames
 * for a pitch token; it went when the last library using it did, and leaving it
 * would have meant two ways to answer "what note is this file", which is the kind
 * of duplication that drifts.
 */
function collect(cfg) {
  const byPitch = new Map();
  for (const id of cfg.from) {
    const src = SOURCES[id];
    if (!src) throw new Error(`family ${cfg.pack}: no such source "${id}"`);
    if (!src.load) throw new Error(`family ${cfg.pack}: source "${id}" has no load()`);

    for (const [midi, takes] of src.load(cfg)) {
      if (!byPitch.has(midi)) byPitch.set(midi, takes);
    }
  }
  // Keep the best N takes per pitch, deterministically.
  for (const [midi, list] of byPitch) {
    list.sort((a, b) => a.rank - b.rank || a.file.localeCompare(b.file));
    byPitch.set(midi, list.slice(0, cfg.maxHits || list.length));
  }
  return byPitch;
}

/** Nearest real pitch, and the playbackRate that turns it into `target`. */
function nearest(byPitch, target) {
  let best = null, bestD = Infinity;
  for (const midi of byPitch.keys()) {
    const d = Math.abs(midi - target);
    if (d < bestD) { bestD = d; best = midi; }
  }
  return { midi: best, semitones: target - best };
}

function main() {
  if (!fs.existsSync(FP)) {
    console.error(
      `no sample source found.\n` +
      `  FreePats banks: ${FP}\n` +
      `Fetch them with tools/fetch-freepats.mjs, or point --freepats at them.`
    );
    process.exit(1);
  }

  const manifest = {
    version: 2,
    sampleRate: 44100,
    /**
     * What each pack's samples came from and what they are owed. Built from
     * SOURCES, and the thing NOTICE.md and the app's credits line are
     * generated from -- see tools/check-pack-credits.mjs.
     */
    credits: {},
    instruments: {},
  };

  let totalBytes = 0;
  const rows = [];
  let done = 0;
  const t0 = Date.now();

  for (const cfg of FAMILIES) {
    const byPitch = collect(cfg);
    if (!byPitch.size) {
      const where = cfg.from.map((id) => SOURCES[id].dir()).join(', ');
      console.warn(`skip ${cfg.pack}: no files in ${where}`);
      continue;
    }

    // Per-family progress. With fifty-odd banks this runs for minutes, and a
    // build that prints nothing until the end is indistinguishable from a build
    // that has hung.
    const label = `${String(++done).padStart(2)}/${FAMILIES.length} ${cfg.pack.padEnd(22)}`;
    const tick = process.stdout.isTTY ? '\r' : '\n';

    if (!DRY) fs.mkdirSync(path.join(OUT, cfg.pack), { recursive: true });

    /** Encoded files, keyed by source pitch, one entry per round-robin hit. */
    const samples = new Map();
    /** Per-key playback rate, for keys whose sample was recorded at another pitch. */
    const rates = new Map();
    let familyBytes = 0;
    let stereo = cfg.stereo;
    for (const [midi, files] of [...byPitch].sort((a, b) => a[0] - b[0])) {
      const hits = [];
      files.forEach((entry, i) => {
        const wav = readWav(fs.readFileSync(path.join(entry.dir, entry.file)));
        // Stereo is measured, not declared. A FreePats bank is whatever its
        // author recorded, and half of them differ from the other half.
        if (stereo == null) stereo = wav.channels > 1;
        if (wav.frames < wav.sampleRate * 0.05) return;

        // The bank's own loop points, when it declared any -- and checked before
        // they are trusted.
        //
        // Its author did know roughly where the loop was; the envelope heuristic
        // does not. But "roughly" was doing a lot of work in that sentence. Those
        // points were chosen for a player that crossfades the join, and this one
        // splices, so some of them cut straight through the waveform: the brass 2
        // bank declares the same 0.89 s window on every key it samples, and it
        // steps 116 to 157 dB here. So the declared points are preferred, and
        // measured the same way a chosen one is. One that will not splice falls
        // back to the chooser rather than being used anyway.
        //
        // The SFZ counts frames in the source file, and nothing is trimmed any
        // more, so these are simply the bank's own numbers over the file's own
        // length -- no rebasing, and no chance of that rebasing being the thing
        // that was wrong.
        let loop = null;
        let E = null;
        if (cfg.loop !== false) E = loopEnvelope(wav, 0, wav.frames);
        if (entry.loop && E) {
          const a = entry.loop[0] / wav.frames;
          const b = entry.loop[1] / wav.frames;
          if (a >= 0 && b > a && b <= 1 && seamOf(E, a, b) <= SEAM_DB) {
            loop = { start: a, end: b };
          }
        }
        if (!loop && E) loop = findLoop(wav, 0, wav.frames, cfg, E);

        const take = layout(wav, stereo);
        const mp3 = encodeMp3(take.channels, wav.sampleRate,
          stereo ? BITRATE.stereo : BITRATE.mono);

        const name = `${String(midi).padStart(3, '0')}-${i}.mp3`;
        if (!DRY) writeOut(path.join(OUT, cfg.pack, name), mp3);
        familyBytes += mp3.length;

        // Rate from the pitch this take was actually recorded at, plus the bank's
        // detune. A FreePats group often spans a range with every take recorded at
        // one pitch, so without this every key but the centre plays the wrong note.
        const centre = entry.centre == null ? midi : entry.centre;
        const cents = (entry.tune || 0) / 100;
        const rate = Math.pow(2, (midi - centre + cents) / 12);

        hits.push({
          f: `${cfg.pack}/${name}`,
          // Which recording this file is. See the note in collectFreepats(): it
          // exists so the pack can be compared against the recordings rather
          // than against its own description of them.
          src: entry.src,
          // The playing level, as a number. This is exactly the gain prepare()
          // used to multiply into the sample data before encoding, and the mix it
          // produces is the mix this pack has always had. What changed is where
          // it is applied: the sampler multiplies by this, so the MP3 on disk is
          // the recording. Without it the roster falls apart -- the recordings
          // span about 30 dB, the piano that far below the xylophone -- so this
          // is a balance setting and not a correction for anything.
          g: take.peak > 0 ? +(cfg.target / take.peak).toFixed(6) : 1,
          srcPeak: +take.peak.toFixed(5),
          dur: +(wav.frames / wav.sampleRate).toFixed(3),
          // Fractions of this take, so they hold at any playbackRate.
          loop: loop ? [+loop.start.toFixed(4), +loop.end.toFixed(4)] : null,
          // This take's own rate. It used to live once per key, written by every
          // take in turn, so the last one won and the others played at whatever
          // suited their neighbour -- on the FreePats upright, 7 of 176 takes came
          // out up to 119 cents off, a semitone of wrong note in the middle of a
          // chord. Two takes covering one key can have different keycentres, so
          // the rate belongs to the take, not to the key.
          r: +rate.toFixed(6),
          // Which hammer struck it, when the bank recorded more than one. Null
          // when the bank has only one layer, which is the common case.
          vel: entry.vel ?? null,
          // How wide the recording was, measured from its own channels. Null for
          // a mono take. tools/check-recording-fidelity.mjs decodes the shipped
          // file and compares this against what is actually in it.
          sm: take.sideMid,
        });

        rates.set(midi, rate);
      });
      if (hits.length && !rates.has(midi)) rates.set(midi, 1);
      if (hits.length) samples.set(midi, hits);
    }
    totalBytes += familyBytes;

    // Fill the gaps by resampling the nearest real take rather than dropping keys.
    // FreePats banks are NOT extended: a Kalimba covers 48..84 and stretching
    // that to 128 keys would play a 37-key instrument four octaves out. Keys
    // outside the range are the sampler's problem -- it shifts the nearest real
    // key to the pitch that was asked for.
    const real = [...samples.keys()].sort((a, b) => a - b);
    const pad = cfg.bank ? 0 : 3;
    const lo = Math.max(0, real[0] - pad);
    const hi = Math.min(127, real[real.length - 1] + pad);
    const notes = {};
    let shifted = 0;
    let maxShift = 0;
    for (let midi = lo; midi <= hi; midi++) {
      let rate = rates.get(midi) || 1;
      let hits = samples.get(midi);
      if (!hits) {
        const n = nearest(samples, midi);
        hits = samples.get(n.midi);
        // The neighbour's own rate already carries its detune, so this is the
        // interval on top rather than the whole shift.
        rate = (rates.get(n.midi) || 1) * Math.pow(2, n.semitones / 12);
        shifted++;
        maxShift = Math.max(maxShift, Math.abs(n.semitones));
      }
      if (!hits) continue;
      notes[midi] = { rate: +rate.toFixed(6), hits };
    }

    // Whether this family loops at all is decided by what the bank actually
    // provided, not by a flag: a note with no loop points must not be marked as
    // sustaining, or the sampler will hold a sample that has already stopped.
    const anyLoop = Object.values(notes).some((n) => n.hits.some((h) => h.loop));

    manifest.instruments[cfg.pack] = {
      name: cfg.name,
      lo, hi,
      stereo: !!stereo,
      sustains: anyLoop,
      notes,
    };
    manifest.credits[cfg.pack] = cfg.from.map((id) => {
      const c = SOURCES[id].credit;
      // Only declare modifications where a licence actually asks for them.
      //
      // `changes` describes one family's edit -- its channel count, its
      // truncation, whether it loops -- but it is recorded once per SOURCE, and
      // the FreePats source covers fifty families that differ in all three. The
      // first one built would otherwise supply its description to the other
      // forty-nine. None of them need it, because CC0 asks for no statement at
      // all, so the honest thing is to record none rather than record one that
      // is probably wrong.
      const owed = obligationOf(c.licence) !== 'none';
      return {
        source: id, ...c,
        changes: !owed ? null
          : c.changes !== undefined ? c.changes
            : changesFor(cfg, { stereo: !!stereo, anyLoop }),
      };
    });

    rows.push({
      pack: cfg.pack,
      real: real.length,
      keys: Object.keys(notes).length,
      shifted, maxShift,
      lo, hi,
      bytes: familyBytes,
    });

    const kb = (familyBytes / 1024).toFixed(0).padStart(6);
    process.stdout.write(
      `${label} ${String(real.length).padStart(3)} real  ${String(Object.keys(notes).length).padStart(3)} keys  ` +
      `${String(lo).padStart(3)}..${String(hi).padEnd(3)} ${stereo ? 'stereo' : 'mono  '} ` +
      `${anyLoop ? 'loop' : '----'}  ${kb} KB  ${((Date.now() - t0) / 1000).toFixed(0)}s${tick}`
    );
  }

  if (!DRY) {
    fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest), 'utf8');

    // The credit travels with the audio (manifest) AND with the repository
    // (NOTICE.md), from the same SOURCES table. Writing it here rather than by
    // hand is the whole point: a notice nobody regenerates describes whatever
    // the pack used to contain.
    const noticeFile = path.join(repo, 'NOTICE.md');
    if (!fs.existsSync(noticeFile)) {
      console.warn(`NOTICE.md not found; credits were written to the manifest only`);
    } else {
      const before = fs.readFileSync(noticeFile, 'utf8');
      const after = applyNoticeBlock(before, noticeBlock(manifest));
      if (after !== before) {
        fs.writeFileSync(noticeFile, after, 'utf8');
        console.log('NOTICE.md: credits block updated');
      }
    }
  }

  console.log(DRY ? 'dry run - nothing written\n' : `pack written to ${OUT}\n`);
  console.log('pack           real   keys  shifted  max   range      size');
  for (const r of rows) {
    console.log(
      `${r.pack.padEnd(14)} ${String(r.real).padStart(4)}  ${String(r.keys).padStart(4)}  ` +
      `${String(r.shifted).padStart(7)}  ${String(r.maxShift).padStart(4)}  ${String(r.lo).padEnd(4)}..${String(r.hi).padEnd(4)}  ` +
      `${(r.bytes / 1048576).toFixed(2)} MB`
    );
  }
  console.log(`\ntotal: ${(totalBytes / 1048576).toFixed(2)} MB across ${rows.length} instruments`);
  console.log(`manifest v${manifest.version}: ` + JSON.stringify({
    processed: 'none - samples are the recordings, re-encoded only',
    balance: 'per-take gain in notes[m].hits[].g, applied at playback',
    keys: Object.fromEntries(Object.entries(manifest.instruments).map(([k, v]) => [k, Object.keys(v.notes).length])),
  }));

  const owed = Object.entries(manifest.credits).filter(([, cs]) => cs.some((c) => c.licence !== 'CC0 1.0 Universal (public domain)'));
  if (owed.length) {
    console.log(`\nATTRIBUTION OWED by ${owed.length} of ${rows.length} instruments:`);
    for (const [pack, cs] of owed) console.log(`  ${pack}: ${cs.map((c) => `${c.title} by ${c.author} (${c.licence})`).join('; ')}`);
    console.log('Run node tools/check-pack-credits.mjs to confirm NOTICE.md and the app agree.');
  }
}

main();