/**
 * tools/make-pack.mjs - build the recorded-instrument sample pack.
 *
 * Source is the Versilian Community Edition (CC0, public domain, no attribution
 * owed) cached in %TEMP%/sf-sample-cache. Output is pack/: a folder of MP3s and
 * one manifest the app fetches at load.
 *
 *   node tools/make-pack.mjs                 build pack/ from the cache
 *   node tools/make-pack.mjs --dry-run       report the plan, write nothing
 *   node tools/make-pack.mjs --src <dir> --out <dir>
 *
 * Three things in here are not obvious, and all three came from measuring the
 * real files rather than from the documentation:
 *
 * 1. LEADING SILENCE. Several families (Rode, KSHarp high notes) start with
 *    silence before the attack. Left in, every note plays late. Trimmed.
 *
 * 2. CODEC DELAY IS NOT CONSTANT. Chrome does not strip LAME's encoder delay.
 *    It is 1105 samples for most settings but 1524 for stereo 96 kbps -- see
 *    tools/check-codec-delay.mjs. So every file gets MARKER samples of digital
 *    silence prepended, and the sampler finds where the sound actually starts
 *    in each decoded buffer. Measuring per file costs ~190 bytes and is correct
 *    on any browser that can decode MP3 at all.
 *
 * 3. PITCHES ARE SPARSE. The families sample every third semitone, and Marimba
 *    and Xylo have gaps of seven. A missing pitch is filled by playing the
 *    nearest real sample at a shifted rate rather than by dropping the key.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWav, peakOf, envelope } from './lib/wav.mjs';
import { encodeMp3 } from './lib/lame.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ config */

/**
 * One entry per source family.
 *
 * `take` is a preference over the tokens VCSL puts in filenames: `ff` is a hard
 * mallet strike, `mf` a medium one, `pp` a soft one. The middle layer is picked
 * so a single velocity layer covers the useful range once the sampler applies
 * its own gain envelope.
 *
 * `loop` marks a family that sustains while held. Its samples get loop points
 * so a two-bar note does not run out three seconds in.
 */
const FAMILIES = [
  {
    pack: 'gpiano', prefix: 'GPiano', name: 'Concert Grand (recorded)',
    stereo: false, loop: true, prefer: ['v2', 'v3', 'v1'], maxHits: 2,
    maxSec: 4.0, loopFrom: 0.18, loopTo: 0.94, minLoopSec: 0.30, target: 0.50,
  },
  {
    pack: 'harpsichord', prefix: 'HarpsiRH', name: 'Harpsichord (recorded)',
    stereo: false, loop: true, prefer: [], maxHits: 1,
    maxSec: 2.2, loopFrom: 0.25, loopTo: 0.90, minLoopSec: 0.22, target: 0.45,
  },
  {
    pack: 'koto', prefix: 'KSHarp', name: 'Koto (recorded)',
    stereo: false, loop: true, prefer: ['mf1', 'f1'], maxHits: 2,
    maxSec: 3.2, loopFrom: 0.12, loopTo: 0.60, minLoopSec: 0.30, target: 0.50,
  },
  {
    pack: 'viola', prefix: 'Rode', name: 'Viola da gamba (recorded)',
    stereo: false, loop: true, prefer: [], maxHits: 1,
    maxSec: 3.0, loopFrom: 0.30, loopTo: 0.92, minLoopSec: 0.35, target: 0.45,
  },
  {
    pack: 'marimba', prefix: 'Marimba', name: 'Marimba (recorded)',
    stereo: true, loop: false, prefer: ['_1', '2', '3'], maxHits: 3,
    maxSec: 2.4, target: 0.42,
  },
  {
    pack: 'vibraphone', prefix: 'Vibes', name: 'Vibraphone (recorded)',
    stereo: true, loop: false, prefer: ['soft', 'main'], maxHits: 3,
    maxSec: 3.0, target: 0.42,
  },
  {
    pack: 'xylophone', prefix: 'Xylo', name: 'Xylophone (recorded)',
    stereo: true, loop: false, prefer: ['Medium', 'Hard'], maxHits: 3,
    maxSec: 2.0, target: 0.50,
  },
  {
    pack: 'glockenspiel', prefix: 'glock', name: 'Glockenspiel (recorded)',
    stereo: true, loop: false, prefer: ['medium', 'loud'], maxHits: 3,
    maxSec: 2.2, target: 0.38,
  },
];

/** Digital silence prepended to every encoded file so the sampler can locate
 *  the true onset. Long enough to swamp MP3 pre-echo, short enough to be free. */
const MARKER = 1024;

/** How far below the sustain level a loop seam is allowed to sit. */
const FLOOR_DB = 9;

/** Loudness, by family. Percussive mallets sit lower or they slap the bus. */
const BITRATE = { stereo: 96, mono: 64 };

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : dflt;
};
const DRY = args.includes('--dry-run');
const SRC = flag('src', path.join(process.env.TEMP, 'sf-sample-cache'));
const OUT = path.resolve(repo, flag('out', 'pack'));

/* ------------------------------------------------------------------ utils */

function midiOf(token) {
  const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(token);
  if (!m) return null;
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1].toUpperCase()];
  return (Number(m[3]) + 1) * 12 + base + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}

/** The pitch is the first token that parses as a note; families disagree on where. */
function pitchIn(name) {
  for (const tok of name.split('_')) {
    const m = midiOf(tok);
    if (m != null && m >= 0 && m <= 127) return m;
  }
  return null;
}

/**
 * Rank candidate takes for one pitch against the family's preference list.
 *
 * `prefer` entries are matched anywhere in the filename, so `['soft','main']`
 * takes `Vibes_soft_G5...` over `Vibes_bowed_G5...`. Anything unmatched sorts
 * after everything matched, then alphabetically for a stable build.
 */
function rankTake(filename, prefer) {
  const lower = filename.toLowerCase();
  for (let i = 0; i < prefer.length; i++) {
    if (lower.includes(prefer[i].toLowerCase())) return i;
  }
  return prefer.length;
}

/** Trim leading and trailing silence. Returns the useful frame range. */
function trimSilence(wav, floorDb = -50) {
  const floor = Math.pow(10, floorDb / 20);
  const win = Math.max(1, Math.round(wav.sampleRate * 0.002));
  let peak = 0;
  for (const ch of wav.data) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
  if (peak <= 0) return { from: 0, to: 0, peak: 0 };

  const thr = peak * floor;
  let from = 0;
  for (let i = 0; i + win <= wav.frames; i += win) {
    let m = 0;
    for (const ch of wav.data) for (let j = i; j < i + win; j++) m = Math.max(m, Math.abs(ch[j]));
    if (m > thr) { from = i; break; }
    from = i + win;
  }
  let to = wav.frames;
  for (let i = wav.frames - win; i >= 0; i -= win) {
    let m = 0;
    for (const ch of wav.data) for (let j = Math.max(0, i); j < Math.min(wav.frames, i + win); j++) m = Math.max(m, Math.abs(ch[j]));
    if (m > thr) { to = Math.min(wav.frames, i + win); break; }
  }
  return { from, to, peak };
}

/**
 * Loop points inside a sustaining sample, as fractions of the trimmed length.
 *
 * Picked at local minima of the envelope rather than at fixed fractions: a hard
 * loop seam clicks in proportion to the amplitude at the splice, and a koto or
 * piano body swells and ebbs enough that a fixed 30% often lands on a peak.
 */
function findLoop(wav, from, to, cfg) {
  const len = to - from;
  const sr = wav.sampleRate;
  const dur = len / sr;
  if (dur < 0.5) return null;

  // 10 ms windows over the trimmed range only, so indices count from the attack.
  const win = Math.max(1, Math.round(sr * 0.01));
  const nWin = Math.floor(len / win);
  const env = new Float32Array(nWin);
  for (let w = 0; w < nWin; w++) {
    let s = 0;
    const a = from + w * win;
    const b = Math.min(to, a + win);
    for (const ch of wav.data) for (let i = a; i < b; i++) s += ch[i] * ch[i];
    env[w] = Math.sqrt(s / Math.max(1, (b - a) * wav.data.length));
  }

  // cfg.loopFrom / loopTo are fractions of the sample; convert to window indices.
  const toWin = (frac) => Math.floor((frac * dur) / 0.01);
  let lo = Math.max(1, toWin(cfg.loopFrom));
  let hi = Math.min(nWin - 2, toWin(cfg.loopTo));
  if (!(hi > lo + 4)) return null;

  // The quietest point is not the right point. Picking the global minimum over
  // the tail lands the loop on the last whisper of the decay -- measured at
  // 33 dB under the attack on the piano takes -- so a held note becomes a
  // series of faint clicks. Choose among points that are within FLOOR_DB of the
  // sustain level instead, and take the quietest of *those*, so the seam is both
  // inaudible and audible.
  const sustain = [...env].slice(lo).sort((a, b) => a - b);
  const level = sustain[Math.floor(sustain.length / 2)] || 0;
  const floor = level * Math.pow(10, -FLOOR_DB / 20);

  const minIn = (a, b) => {
    let best = Infinity, at = -1;
    for (let i = a; i <= b; i++) {
      if (env[i] < floor) continue;
      if (env[i] < best) { best = env[i]; at = i; }
    }
    // Nothing inside the floor (a very short or very smooth tail): fall back to
    // the plain quietest window rather than refusing to loop at all.
    if (at < 0) {
      for (let i = a; i <= b; i++) if (env[i] < best) { best = env[i]; at = i; }
    }
    return at < 0 ? a : at;
  };

  const minLoopWin = Math.ceil(cfg.minLoopSec / 0.01);
  if (!(hi > lo + minLoopWin)) return null;

  const endIdx = minIn(Math.max(hi, lo + minLoopWin), nWin - 1);
  const startIdx = minIn(lo, Math.max(lo, endIdx - minLoopWin));
  const spanSec = (endIdx - startIdx) * 0.01;
  if (spanSec < cfg.minLoopSec) return null;
  if (spanSec > dur * 0.7) return null; // looping nearly all of it is not a loop

  return {
    start: +((startIdx * win) / len).toFixed(4),
    end: +((endIdx * win) / len).toFixed(4),
  };
}

/** Slice, optionally downmix, and scale to `target` peak. */
function prepare(wav, from, to, cfg) {
  const len = Math.max(1, to - from);
  const out = cfg.stereo ? [new Float32Array(len), new Float32Array(len)] : [new Float32Array(len)];
  for (let i = 0; i < len; i++) {
    if (cfg.stereo) {
      out[0][i] = (wav.data[0][from + i] + (wav.data[1] ? wav.data[1][from + i] : wav.data[0][from + i])) * 0.5;
      out[1][i] = (wav.data[1] ? wav.data[1][from + i] : wav.data[0][from + i]);
    } else {
      let s = 0;
      for (const ch of wav.data) s += ch[from + i];
      out[0][i] = s / wav.data.length;
    }
  }
  let peak = 0;
  for (const ch of out) for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(ch[i]));
  const gain = peak > 0 ? cfg.target / peak : 1;
  for (const ch of out) for (let i = 0; i < len; i++) ch[i] *= gain;
  return { channels: out, gain, len };
}

/** Prefix the marker silence so the app can find the true onset after decoding. */
function withMarker(channels, marker) {
  const out = channels.map((ch) => {
    const a = new Float32Array(marker + ch.length);
    a.set(ch, marker); // the head stays zero
    return a;
  });
  return out;
}

/* ------------------------------------------------------------------- build */

function collect(srcDir, cfg) {
  const all = fs.readdirSync(srcDir).filter((f) => f.toLowerCase().endsWith('.wav'));
  const byPitch = new Map();
  for (const f of all) {
    if (f.split('_')[0] !== cfg.prefix) continue;
    const midi = pitchIn(path.basename(f, '.wav'));
    if (midi == null) continue;
    if (!byPitch.has(midi)) byPitch.set(midi, []);
    byPitch.get(midi).push(f);
  }
  // Keep the best N takes per pitch, deterministically.
  for (const [midi, list] of byPitch) {
    list.sort((a, b) => rankTake(a, cfg.prefer) - rankTake(b, cfg.prefer) || a.localeCompare(b));
    byPitch.set(midi, list.slice(0, cfg.maxHits));
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
  if (!fs.existsSync(SRC)) {
    console.error(`no sample source at ${SRC}\nPoint --src at the Versilian cache.`);
    process.exit(1);
  }

  const manifest = {
    version: 1,
    builtFrom: 'Versilian Community Edition (CC0)',
    markerSamples: MARKER,
    sampleRate: 44100,
    instruments: {},
  };

  let totalBytes = 0;
  const rows = [];

  for (const cfg of FAMILIES) {
    const byPitch = collect(SRC, cfg);
    if (!byPitch.size) {
      console.warn(`skip ${cfg.pack}: no ${cfg.prefix}* files in ${SRC}`);
      continue;
    }

    if (!DRY) fs.mkdirSync(path.join(OUT, cfg.pack), { recursive: true });

    /** Encoded files, keyed by source pitch, one entry per round-robin hit. */
    const samples = new Map();
    let familyBytes = 0;
    for (const [midi, files] of [...byPitch].sort((a, b) => a[0] - b[0])) {
      const hits = [];
      files.forEach((file, i) => {
        const wav = readWav(fs.readFileSync(path.join(SRC, file)));
        const { from, to, peak } = trimSilence(wav);
        if (to - from < wav.sampleRate * 0.05) return;

        const maxFrames = Math.floor(cfg.maxSec * wav.sampleRate);
        const end = Math.min(to, from + maxFrames);
        const loop = cfg.loop ? findLoop(wav, from, end, cfg) : null;
        const prepared = prepare(wav, from, end, cfg);
        const mp3 = encodeMp3(withMarker(prepared.channels, MARKER), wav.sampleRate,
          cfg.stereo ? BITRATE.stereo : BITRATE.mono);

        const name = `${String(midi).padStart(3, '0')}-${i}.mp3`;
        if (!DRY) fs.writeFileSync(path.join(OUT, cfg.pack, name), mp3);
        familyBytes += mp3.length;

        hits.push({
          f: `${cfg.pack}/${name}`,
          // Every take is already normalised to the family target, so this is 1.
          // It used to be 1/gain, which undid that normalisation and handed the
          // app each recording's original level instead -- and those span 30 dB
          // (the piano is recorded 30 dB below the xylophone), so the piano was
          // inaudible next to a mallet. The family target IS the playing level.
          g: 1,
          srcPeak: +peak.toFixed(5),
          dur: +(prepared.len / wav.sampleRate).toFixed(3),
          // Fractions of this take, so they hold at any playbackRate.
          loop: loop ? [+loop.start.toFixed(4), +loop.end.toFixed(4)] : null,
        });
      });
      if (hits.length) samples.set(midi, hits);
    }
    totalBytes += familyBytes;

    // Fill the gaps by resampling the nearest real take rather than dropping keys.
    const real = [...samples.keys()].sort((a, b) => a - b);
    const lo = Math.max(0, real[0] - 3);
    const hi = Math.min(127, real[real.length - 1] + 3);
    const notes = {};
    let shifted = 0;
    let maxShift = 0;
    for (let midi = lo; midi <= hi; midi++) {
      let rate = 1;
      let hits = samples.get(midi);
      if (!hits) {
        const n = nearest(samples, midi);
        hits = samples.get(n.midi);
        rate = Math.pow(2, n.semitones / 12);
        shifted++;
        maxShift = Math.max(maxShift, Math.abs(n.semitones));
      }
      if (!hits) continue;
      notes[midi] = { rate: +rate.toFixed(6), hits };
    }

    manifest.instruments[cfg.pack] = {
      name: cfg.name,
      lo, hi,
      stereo: cfg.stereo,
      sustains: !!cfg.loop,
      notes,
    };

    rows.push({
      pack: cfg.pack,
      real: real.length,
      keys: Object.keys(notes).length,
      shifted, maxShift,
      lo, hi,
      bytes: familyBytes,
    });
  }

  if (!DRY) {
    fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest), 'utf8');
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
  console.log(`manifest: ${JSON.stringify({
    markerSamples: MARKER,
    keys: Object.fromEntries(Object.entries(manifest.instruments).map(([k, v]) => [k, Object.keys(v.notes).length])),
  })}`);
}

main();