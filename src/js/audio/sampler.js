/**
 * audio/sampler.js — recorded instruments, played back from a sample pack.
 *
 * The synthesiser in instruments.js is physically modelled and needs nothing
 * from the network. This is the other half: real recordings of real instruments,
 * which sound like themselves rather than like an approximation. Both are in the
 * roster and the user picks.
 *
 * ── Why the bytes come up front but the PCM does not ────────────────────────
 *
 * noteOn is synchronous. The transport calls it up to SCHEDULE_AHEAD seconds
 * before a note sounds, so a voice must be able to place its whole graph in one
 * call. That rules out fetching or decoding a sample inside noteOn: both are
 * asynchronous, so the source node cannot exist yet, and by the time the decode
 * finished the note's start time would be in the past. An earlier attempt at
 * this did exactly that and produced a page that reported playing, advanced the
 * transport, and played nothing at all -- every fetch returned 200 and every
 * decode succeeded, but no source node was ever started.
 *
 * So decoding has to happen at an async boundary *before* the first note. How
 * much of it happens there is the question. Decoding the whole pack up front was
 * fine for nine families (about 40 MiB) and impossible for sixty: the fifty
 * FreePats banks are 2.2 GB of MP3, which decode to 4.3 GB of floating-point
 * PCM, and a browser tab cannot be asked to sit on all of that before playing
 * the first note.
 *
 * Hence the split:
 *
 *   loadPack()    fetches every file once, in compressed form, and stops there.
 *                 Compressed is the cheap half -- the bytes sit in the HTTP
 *                 cache as well, so "fetched once" is still true afterwards.
 *   prepare()     decodes only the keys a piece is about to use, the first
 *                 time that instrument is selected, and keeps a byte budget of
 *                 decoded PCM with least-recently-used eviction.
 *
 * noteOn still only ever touches objects that are already in memory, and
 * `createSampledInstrument` still throws if its pack is not loaded rather than
 * quietly returning a voice that will never make a sound.
 *
 * ── Why every buffer gets its onset measured ────────────────────────────────
 *
 * Chrome does not strip LAME's encoder delay, so a decoded buffer starts about
 * 1105 samples (25 ms) of silence ahead of the audio that went in -- and 1524
 * for stereo at 96 kbps. It is not a constant, so it cannot be a constant in
 * the manifest. The pack builder prepends MARKER samples of digital silence to
 * every file; findOnset() locates where the sound actually begins, once, at
 * load. That costs about 190 bytes per file and is correct on any browser that
 * can decode MP3 at all. See tools/check-codec-delay.mjs.
 */

/** How many files to fetch and decode at once. */
const FETCH_CONCURRENCY = 8;

/**
 * How much decoded PCM to keep, in bytes.
 *
 * A WAV on disk is 16-bit and a decoded AudioBuffer is 32-bit float with the
 * same channel count, so decoded bytes are exactly twice the file. All sixty
 * packs together are about 4.3 GB that way; this holds a useful working set of
 * ordinary instruments instead of all of them.
 *
 * The budget is a target, not a cap: one family is allowed to overshoot it, so
 * that picking a single very large instrument still works. `distorted electric
 * guitar` alone is 1.2 GB decoded, and refusing to play it would be a worse
 * answer than letting the budget go over for it.
 */
let DECODE_BUDGET_BYTES = 1024 * 1024 * 1024;

/** A voice never rings longer than this, whatever the note says. */
const MAX_RING_SECONDS = 12;

/** Release when the key comes up, unless the family sustains while held. */
const KEY_RELEASE = 0.12;

/* ------------------------------------------------------------------- pack */

const packs = new Map();   // packId -> Pack
let loadPromise = null;

/**
 * Decoded PCM, by file, shared across packs.
 *
 * Separate from `packs` because it is the part that has a size limit: a take
 * belongs to one pack but the budget is global. `used` is a clock reading, not
 * a timestamp -- it only has to order evictions.
 */
const decodedFiles = new Map();  // rel -> { buffer, onset, bytes, pack, used }
const preparing = new Map(); // packId -> Promise, so two callers share one decode
let decodedBytes = 0;
let clock = 0;

/** Where the pack lives, or null when this page cannot reach one. */
export function packBase() {
  try {
    const q = new URLSearchParams(location.search).get('pack');
    if (q) return q.replace(/\/+$/, '');
  } catch { /* no location */ }

  const protocol = (typeof location !== 'undefined' && location.protocol) || 'file:';
  // Under file:// a relative fetch is blocked, so there is no pack to find and
  // the sampled instruments stay unavailable. Say so rather than pretending.
  if (protocol !== 'http:' && protocol !== 'https:') return null;
  return new URL('pack/', location.href).href.replace(/\/+$/, '');
}

/** True once `packId`'s bytes have been fetched. Decoding is a separate step. */
export function hasPack(packId) {
  return packs.has(packId);
}

/** True once `packId` also has decoded PCM behind it. */
export function isPackDecoded(packId) {
  const p = packs.get(packId);
  return !!p && !!p.buffers;
}

/** What the decode cache is holding, for the UI and for tests. */
export function decodeState() {
  return {
    bytes: decodedBytes,
    budget: DECODE_BUDGET_BYTES,
    files: decodedFiles.size,
    packs: [...packs.values()].filter((p) => p.buffers).map((p) => ({ id: p.id, live: p.live })),
  };
}

/** Progress of the one in-flight load, for the UI. */
export function packState() {
  return {
    base: packBase(),
    loaded: [...packs.keys()],
    progress: loadProgress,
    state: loadState,
    error: loadError,
  };
}

let loadProgress = 0;
let loadState = 'idle';   // idle | loading | ready | failed | unavailable
let loadError = null;

/**
 * Fetch the whole pack, compressed. Decoding is `prepare`'s job.
 *
 * Idempotent: the first call does the work and every later one joins it, so a
 * boot sequence that calls this from two places does not fetch the bytes twice.
 *
 * @param {(p:{done:number,total:number,label:string})=>void} [onProgress]
 * @returns {Promise<Map<string, object>>}
 */
export function loadPack(onProgress) {
  if (packs.size) return Promise.resolve(packs);
  if (loadPromise) return loadPromise;

  const base = packBase();
  if (!base) {
    loadState = 'unavailable';
    loadError = 'this page was opened from a file, so the sample pack cannot be fetched';
    return Promise.resolve(packs);
  }

  loadState = 'loading';
  loadPromise = (async () => {
    const res = await fetch(`${base}/manifest.json`, { cache: 'force-cache' });
    if (!res.ok) throw new Error(`manifest ${res.status} ${res.statusText}`);
    const manifest = await res.json();

    // Every distinct file, so a take shared by several pitches is fetched once.
    const wanted = new Set();
    for (const inst of Object.values(manifest.instruments)) {
      for (const note of Object.values(inst.notes)) {
        for (const hit of note.hits) wanted.add(hit.f);
      }
    }
    const files = [...wanted];

    let done = 0;
    const report = () => {
      loadProgress = files.length ? done / files.length : 1;
      onProgress && onProgress({ done, total: files.length, label: 'sample pack' });
    };
    report();

    // Compressed bytes only. Holding 2.2 GB of MP3 is expensive; holding the
    // 4.3 GB of PCM it decodes to is not something a tab can do at all. These
    // stay in the HTTP cache anyway, so a later decode that has been evicted
    // does not cost a second network round trip.
    const bytes = new Map();
    let next = 0;

    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= files.length) return;
        const rel = files[i];
        const r = await fetch(`${base}/${rel}`, { cache: 'force-cache' });
        if (!r.ok) throw new Error(`${rel}: ${r.status} ${r.statusText}`);
        bytes.set(rel, await r.arrayBuffer());
        done++;
        report();
      }
    };

    await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, files.length) }, worker));

    for (const [id, inst] of Object.entries(manifest.instruments)) {
      packs.set(id, {
        id, ...inst, credits: manifest.credits?.[id] || [],
        files: bytes,        // rel -> compressed ArrayBuffer
        buffers: null,       // rel -> {buffer, onset}; null until prepared
        live: 0,             // voices currently holding this pack's PCM
      });
    }
    loadProgress = 1;
    loadState = 'ready';
    return packs;
  })().catch((e) => {
    loadState = 'failed';
    loadError = e && e.message ? e.message : String(e);
    loadPromise = null;
    throw e;
  });

  return loadPromise;
}

/* ---------------------------------------------------------------- prepare */

/**
 * Which file a pack will actually play for a given key.
 *
 * The same nearest-key rule noteOn uses, kept here so that "decode what this
 * piece needs" and "play what was decoded" cannot disagree about which sample a
 * key resolves to. A duplicated rule would drift, and the drift would only show
 * up as a missing note.
 */
export function filesForKeys(pack, midis) {
  const keys = Object.keys(pack.notes).map(Number);
  const want = midis && midis.length ? midis : keys;
  const files = new Set();
  for (const raw of want) {
    let midi = Math.round(Number(raw));
    if (!Number.isFinite(midi)) continue;
    if (pack.notes[midi]) { /* exact hit */ }
    else {
      let best = keys[0], bestD = Infinity;
      for (const k of keys) {
        const d = Math.abs(k - midi);
        if (d < bestD) { bestD = d; best = k; }
      }
      midi = best;
    }
    for (const hit of pack.notes[midi].hits) files.add(hit.f);
  }
  return [...files];
}

/**
 * Drop least-recently-used decoded PCM until the budget is met again.
 *
 * `keep` is the set just decoded: it is never evicted, so one oversized family
 * overshoots the budget rather than evicting the very buffers it needs.
 *
 * Packs with a voice that has not yet been told to stop are skipped. That is a
 * narrower window than it looks, and deliberately so: an
 * AudioBufferSourceNode holds the AudioBuffer it was given, so dropping our
 * reference does not silence a note that is already sounding. What it *would*
 * break is a voice that has been created but not started, and src.buffer is
 * assigned before src.start, so that window does not exist either. The skip
 * costs nothing and removes the need to reason about it.
 */
function evictToBudget(keep) {
  if (decodedBytes <= DECODE_BUDGET_BYTES) return;
  const order = [...decodedFiles.entries()]
    .filter(([rel, e]) => !keep.has(rel) && (packs.get(e.pack)?.live || 0) === 0)
    .sort((a, b) => a[1].used - b[1].used);
  for (const [rel, entry] of order) {
    if (decodedBytes <= DECODE_BUDGET_BYTES) break;
    decodedFiles.delete(rel);
    decodedBytes -= entry.bytes;
    // The pack's own view has to forget it too, or isPackDecoded() would keep
    // reporting a decode that is no longer there -- and an empty Map is the one
    // value that reads as "ready" while containing nothing.
    const p = packs.get(entry.pack);
    if (p && p.buffers) {
      p.buffers.delete(rel);
      if (!p.buffers.size) p.buffers = null;
    }
  }
}

/** Test seam: move the budget, so eviction can be seen without decoding GB. */
export function __setDecodeBudget(bytes) {
  DECODE_BUDGET_BYTES = Math.max(1, Number(bytes) || 0);
  evictToBudget(new Set());
  return DECODE_BUDGET_BYTES;
}

/**
 * Decode the samples a piece is about to need, for one pack.
 *
 * Idempotent and shared: a second caller while the first is still working joins
 * the same promise rather than decoding twice.
 *
 * @param {string} packId
 * @param {number[]} [midis]  keys to cover; every key when omitted
 * @param {(p:{done:number,total:number})=>void} [onProgress]
 */
export async function preparePack(packId, midis, onProgress) {
  const pack = packs.get(packId);
  if (!pack) {
    return Promise.reject(new Error(
      `sample pack "${packId}" is not loaded (${loadState}: ${loadError || 'no detail'})`
    ));
  }

  const wanted = filesForKeys(pack, midis);
  const todo = wanted.filter((rel) => !decodedFiles.has(rel));
  if (!todo.length) {
    pack.buffers = pack.buffers || new Map();
    for (const rel of wanted) if (decodedFiles.has(rel)) pack.buffers.set(rel, decodedFiles.get(rel));
    // `wanted` is the keep set, not an empty one: a prepare that found nothing
    // to do must not evict the very buffers it just confirmed were present.
    evictToBudget(new Set(wanted));
    return Promise.resolve(pack);
  }

  const inflight = preparing.get(packId);
  // A second caller may want keys the in-flight run is not covering -- it was
  // asked for a different part of the keyboard. Joining its promise would hand
  // back a pack that is missing those keys and the note would be silent, so
  // wait, then look again.
  if (inflight) return inflight.then(() => preparePack(packId, midis, onProgress));

  const promise = (async () => {
    const decodeCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 128, 44100);
    const keep = new Set(todo);
    let done = 0;
    let next = 0;

    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= todo.length) return;
        const rel = todo[i];
        // decodeAudioData detaches the buffer it is given, so never hand it one
        // that is still referenced elsewhere.
        const raw = pack.files.get(rel);
        if (!raw) throw new Error(`${rel}: not fetched`);
        const copy = raw.slice(0);
        const buffer = await decodeCtx.decodeAudioData(copy);
        const bytes = buffer.length * buffer.numberOfChannels * 4;
        decodedFiles.set(rel, { buffer, onset: findOnset(buffer), bytes, pack: packId, used: ++clock });
        decodedBytes += bytes;
        done++;
        onProgress && onProgress({ done, total: todo.length });
      }
    };

    await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, todo.length) }, worker));

    pack.buffers = pack.buffers || new Map();
    for (const rel of wanted) {
      const e = decodedFiles.get(rel);
      if (e) pack.buffers.set(rel, e);
    }
    evictToBudget(keep);
    return pack;
  })();

  preparing.set(packId, promise);
  // Clear the entry the moment the work settles, on success as well as failure.
  //
  // Leaving a settled promise in `preparing` is worse than not caching at all:
  // the next caller with real work to do takes the join-the-in-flight branch,
  // the joined promise calls preparePack again, which finds the same entry
  // still there, and the two of them resolve to each other for ever without a
  // single decode running. The page hangs the second time an instrument is
  // picked after its buffers have been evicted. A failed decode has the same
  // problem, so both paths go through the same cleanup.
  try {
    return await promise;
  } finally {
    if (preparing.get(packId) === promise) preparing.delete(packId);
  }
}

/**
 * Decode what `ids` will need, for the keys in `midis`.
 *
 * The one call a UI wants: it takes roster ids rather than pack ids, and skips
 * anything that is modelled rather than sampled, so a piece of synths costs
 * nothing.
 *
 * @param {string[]} ids
 * @param {number[]} [midis]
 * @param {(p:{done:number,total:number,label:string})=>void} [onProgress]
 */
export async function prepare(ids, midis, onProgress) {
  const wanted = [...new Set(ids || [])].filter((id) => typeof id === 'string');
  if (!wanted.length) return;

  const jobs = [];
  for (const id of wanted) {
    const packId = PACK_OF.get(id);
    if (packId) jobs.push(packId);
  }
  if (!jobs.length) return;

  // Decoding one whole family at a time keeps peak memory to the largest single
  // family rather than the sum of every family asked for at once.
  for (const packId of jobs) {
    await preparePack(packId, midis, onProgress);
  }
}

/** Roster id -> pack id, filled in by instruments.js at import time. */
const PACK_OF = new Map();
export function __registerPackOf(map) {
  PACK_OF.clear();
  for (const [k, v] of Object.entries(map)) PACK_OF.set(k, v);
}

/**
 * Where the sound starts in a decoded buffer, in seconds.
 *
 * The pack guarantees MARKER samples of true digital silence at the front, and
 * the codec adds its own delay on top, so the first audible sample is later
 * than the file's own start by an amount that varies with the encoder settings.
 * A 1.5 ms RMS window is used rather than a raw sample test: a lone stray
 * sample above the threshold would otherwise cut the onset short and leave the
 * note early.
 */
export function findOnset(buffer) {
  const data = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const win = Math.max(1, Math.round(sr * 0.0015));

  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i]);
    if (a > peak) peak = a;
  }
  if (peak <= 0) return 0;

  const thr = peak * 0.02;
  for (let w = 0; w + win <= data.length; w += win) {
    let sum = 0;
    for (let i = w; i < w + win; i++) sum += data[i] * data[i];
    if (Math.sqrt(sum / win) > thr) return w / sr;
  }
  return 0;
}

/* -------------------------------------------------------------- instrument */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * A sampled instrument, shaped to the same interface as the synthesiser's.
 *
 * Throws if its pack has not been loaded. That is deliberate: returning a voice
 * that cannot make a sound is how this feature failed the first time.
 *
 * @param {string} packId
 * @param {BaseAudioContext} ctx
 * @param {AudioNode} [outputNode]
 */
export function createSampledInstrument(packId, ctx, outputNode) {
  const pack = packs.get(packId);
  if (!pack) {
    throw new Error(
      `sample pack "${packId}" is not loaded (${loadState}: ${loadError || 'no detail'})`
    );
  }
  // Fetched but not decoded is a different mistake from not loaded, and the fix
  // is a different call. Say which one it is rather than sending the caller
  // looking for a fetch that already succeeded.
  if (!pack.buffers) {
    throw new Error(
      `sample pack "${packId}" is fetched but not decoded -- await preparePack("${packId}") before playing it`
    );
  }
  if (!ctx || typeof ctx.createGain !== 'function') {
    throw new TypeError('createSampledInstrument needs an AudioContext or OfflineAudioContext');
  }

  const out = outputNode || ctx.destination;
  const midis = Object.keys(pack.notes).map(Number).sort((a, b) => a - b);
  if (!midis.length) throw new Error(`sample pack "${packId}" has no playable keys`);

  const cap = 48;
  const active = [];
  const params = { level: 1, decay: 1 };
  let sustain = false;
  let disposed = false;
  let roundRobin = 0;

  /**
   * Take this voice out of the pack's live count, at most once.
   *
   * The count is what stops the decode cache evicting a pack that is about to be
   * played. It is released the moment the source is told to stop rather than when
   * the voice is reaped, because a source node keeps the AudioBuffer it was given
   * and reap only ever runs on the *next* noteOn. Counting to reap would pin
   * every instrument you had ever played for the rest of the session, which is
   * the exact failure the budget exists to prevent.
   */
  let counted = false;
  function uncount() {
    if (!counted) return;
    counted = false;
    pack.live = Math.max(0, pack.live - 1);
  }
  const warnings = [];
  const stats = { voices: 0, peakVoices: 0, nodes: 0 };

  /** Nearest key the pack actually has -- samplers fall back, they do not drop. */
  function keyFor(midi) {
    if (pack.notes[midi]) return midi;
    let best = midis[0];
    let bestD = Infinity;
    for (const m of midis) {
      const d = Math.abs(m - midi);
      if (d < bestD) { bestD = d; best = m; }
    }
    return best;
  }

  function noteOn(ev) {
    const e = ev || {};
    const rawMidi = Number(e.midi);
    const midi = clamp(Math.round(Number.isFinite(rawMidi) ? rawMidi : 60), 0, 127);
    const velocity = clamp(Number.isFinite(Number(e.velocity)) ? Number(e.velocity) : 0.7, 0.001, 1);
    const when = Math.max(Number.isFinite(Number(e.when)) ? Number(e.when) : ctx.currentTime, ctx.currentTime);
    const duration = Number.isFinite(Number(e.duration)) ? Math.max(0, Number(e.duration)) : 0;

    reap(when);

    const entry = pack.notes[keyFor(midi)];
    if (!entry) {
      warnings.push(`noteOn: no sample for ${midi}`);
      return null;
    }
    const hit = entry.hits[roundRobin++ % entry.hits.length];
    const decoded = pack.buffers.get(hit.f);
    if (!decoded) {
      warnings.push(`noteOn: "${hit.f}" decoded but missing from the pack`);
      return null;
    }
    // Playing it makes it the most recently used thing in the decode cache, so
    // it is the last to be evicted if the budget has to be enforced.
    decoded.used = ++clock;

    // The attack must begin at `when`, so playback starts at the measured onset
    // rather than at the top of the buffer, which is silence plus codec delay.
    const onset = decoded.onset;

    // Rate comes from the key that was ASKED FOR, not from the key that was
    // found. The two differ whenever a bank does not cover the whole keyboard:
    // a Kalimba runs 48..84, and playing key 60 against its own entry would
    // sound the Kalimba's key 60 rather than the one requested. The entry's
    // rate already carries that sample's own detune, so the interval from the
    // entry's key to the requested one is added on top of it.
    const entryKey = keyFor(midi);
    const rate = (entry.rate || 1) * Math.pow(2, (midi - entryKey) / 12);

    const src = ctx.createBufferSource();
    src.buffer = decoded.buffer;
    src.playbackRate.value = rate;

    const amp = ctx.createGain();
    // Undo the pack's normalisation, then apply the note's own velocity.
    const peakGain = hit.g * Math.pow(velocity, 1.4) * params.level;
    amp.gain.value = peakGain;

    src.connect(amp).connect(out);
    stats.nodes += 2;

    // Loop points are fractions of the take, so they need the onset added to
    // land in buffer time -- and they stay correct at any playbackRate.
    const sustainLoop = duration > hit.dur / rate * 0.85 && hit.loop;
    if (sustainLoop) {
      src.loop = true;
      src.loopStart = onset + hit.loop[0] * hit.dur;
      src.loopEnd = onset + hit.loop[1] * hit.dur;
    }

    const v = {
      midi, when, src, amp, peakGain, sustainLoop,
      loopStart: sustainLoop ? src.loopStart : null,
      loopEnd: sustainLoop ? src.loopEnd : null,
      // Where this take actually starts inside its own buffer, and the rate it
      // plays back at. Together these turn a loop point -- stored as fractions
      // of the take -- into a time on the render timeline, which is the only
      // way to line a loop seam up with the waveform to measure it. Exposed
      // because getting this wrong makes a measurement look like a bug.
      onset, rate,
      /** Live flag off the node, so a scheduled release can be inspected. */
      get looping() { return src.loop; },
      generation: ++roundRobin,
      started: false, released: false,
      releaseAt: Infinity,
      hardStopAt: Infinity,
      start(whenArg) {
        if (this.started) return;
        this.started = true;
        src.start(whenArg, onset);
      },
      release(t) {
        if (!this.started || this.released) return;
        this.released = true;
        this.releaseAt = t;
        // Stopping the source is what ends the loop -- do NOT clear src.loop
        // here. The engine schedules ahead, so noteOff is routinely called
        // before the note has sounded at all, and a flag flipped at that moment
        // applies from the first sample: the note would play once through the
        // take and never sustain, which is exactly what it did.
        const now = Math.max(t, ctx.currentTime);
        amp.gain.cancelScheduledValues(now);
        amp.gain.setValueAtTime(amp.gain.value, now);
        amp.gain.linearRampToValueAtTime(0, now + KEY_RELEASE);
        this.hardStopAt = now + KEY_RELEASE + 0.02;
        src.stop(this.hardStopAt);
        // The node is now told to stop, and it keeps the buffer it was given.
        uncount();
      },
      hardStop(t) {
        try { src.stop(t); } catch (e) { /* already stopped */ }
        this.hardStopAt = t;
        uncount();
      },
      drop() {
        uncount();
        for (const n of [src, amp]) { try { n.disconnect(); } catch (e) { /* gone */ } }
        stats.nodes -= 2;
      },
    };

    // Steal the oldest voice rather than letting nodes pile up.
    if (active.length >= cap) {
      const old = active.shift();
      old.hardStop(when);
      old.drop();
    }

    v.start(when);
    // A note with no loop and no key release still needs a stop time, or a
    // short sample on a long note leaves its buffer resident indefinitely.
    if (!sustainLoop) {
      const ring = Math.min(MAX_RING_SECONDS, Math.max(hit.dur / rate, duration + 0.5));
      v.hardStopAt = when + ring;
      src.stop(when + ring);
      // Same reasoning as release(): the stop is scheduled, so the node keeps
      // what it was given and the pack is free to be evicted.
      uncount();
    }

    active.push(v);
    pack.live++;
    counted = true;
    stats.voices = active.length;
    if (stats.voices > stats.peakVoices) stats.peakVoices = stats.voices;
    return { instrument: api, voice: v, generation: v.generation, midi, when };
  }

  function reap(when) {
    for (let i = active.length - 1; i >= 0; i--) {
      const v = active[i];
      if (v.hardStopAt <= when) { v.drop(); active.splice(i, 1); }
    }
  }

  function noteOff(h, when) {
    if (!h || !h.voice) return;
    const v = h.voice;
    if (h.generation != null && h.generation !== v.generation) return; // recycled
    if (!v.started) return;
    const t = Math.max(Number.isFinite(Number(when)) ? Number(when) : ctx.currentTime, ctx.currentTime);
    if (t <= v.when) return; // a release before the note began would corrupt it
    if (sustain) { v.sustained = true; return; }
    v.release(t);
  }

  /**
   * Damp everything, as the sustain pedal lifting does.
   *
   * Release, not disconnect: a disconnected source stops contributing
   * immediately, which would cut notes that had not finished sounding rather
   * than letting them ring down. `dispose` is the abrupt one, for teardown.
   */
  function allNotesOff(when) {
    const t = Math.max(Number.isFinite(Number(when)) ? Number(when) : ctx.currentTime, ctx.currentTime);
    for (const v of active.slice()) { v.sustained = false; v.release(t); }
  }

  function setSustain(on) {
    sustain = !!on;
    if (!sustain) {
      const t = ctx.currentTime;
      for (const v of active) if (v.sustained) { v.sustained = false; v.release(t); }
    }
  }

  function setParam(name, val) {
    if (name === 'level') params.level = clamp(Number(val) || 0, 0, 2);
    else if (name === 'decay') params.decay = clamp(Number(val) || 0, 0, 4);
    else warnings.push(`setParam: a recorded sample has no "${name}"`);
  }

  function dispose(when) {
    const t = Math.max(Number.isFinite(Number(when)) ? Number(when) : ctx.currentTime, ctx.currentTime);
    for (const v of active.slice()) { v.hardStop(t); v.drop(); }
    active.length = 0;
    stats.voices = 0;
    disposed = true;
  }

  const api = {
    id: packId,
    name: pack.name,
    group: 'Recorded',
    sampled: true,
    noteOn,
    noteOff,
    setSustain,
    allNotesOff,
    setParam,
    dispose,
    get params() { return { ...params }; },
    warnings,
    debugStats() {
      return {
        id: packId, voices: active.length, cap, nodes: stats.nodes,
        peakVoices: stats.peakVoices, sustain, disposed,
        keys: midis.length, low: midis[0], high: midis[midis.length - 1],
        looping: active.filter((v) => v.sustainLoop).length,
        loopPoints: active.filter((v) => v.sustainLoop)
          .map((v) => [+v.loopStart.toFixed(4), +v.loopEnd.toFixed(4)]),
        // Per voice: sample onset in the buffer, playback rate, and start time.
        // NOT called `voices` -- that name is the voice COUNT above, and adding a
        // second key by that name silently replaces it rather than failing.
        timings: active.filter((v) => v.sustainLoop)
          .map((v) => ({ midi: v.midi, when: v.when, onset: +v.onset.toFixed(5), rate: v.rate })),
      };
    },
  };
  return api;
}

/** The pack ids this build can play, for the roster and the tests. */
export function loadedPackIds() {
  return [...packs.keys()];
}

/**
 * Who the samples came from and what licence they carry, read straight out of
 * the manifest.
 *
 * This exists because the pack is not uniformly free of obligations. Most of it
 * is CC0 and owes nothing, but the FSS steel-string guitar is GPL-3+ with the
 * sound-sample exception, and a licence nobody is shown is a licence nobody is
 * complying with. The values are not written here: they are built by
 * tools/make-pack.mjs from the SOURCES table and travel inside the pack, so
 * they cannot fall out of step with the files that were actually shipped.
 *
 * Deduplicated by source, because one library covers forty-nine of the fifty
 * packs and listing it forty-nine times would read as an error rather than as a
 * credit.
 */
export function packCredits() {
  const bySource = new Map();
  for (const p of packs.values()) {
    for (const c of p.credits || []) {
      let entry = bySource.get(c.source);
      if (!entry) bySource.set(c.source, (entry = { ...c, packs: [] }));
      entry.packs.push(p.name);
    }
  }
  return [...bySource.values()];
}

/**
 * Test seam: install a pack directly, without a network fetch.
 *
 * Takes raw AudioBuffers and runs the same onset measurement loadPack does, so
 * a test exercises the real code path rather than a shortcut that skips the
 * step that decides when a note actually starts.
 */
export function __setPack({ id, name, lo, hi, sustains, notes, buffers }) {
  const measured = new Map();
  for (const [rel, buf] of Object.entries(buffers)) {
    measured.set(rel, { buffer: buf, onset: findOnset(buf) });
  }
  packs.set(id, { id, name, lo, hi, sustains, notes, buffers: measured, files: new Map(), live: 0 });
  loadState = 'ready';
  return packs.get(id);
}

/**
 * Test seam: install a pack as *fetched but not decoded*.
 *
 * The state a real page is in between loadPack() and prepare(), and the one that
 * matters most to test: without a guard here, an instrument whose decode was
 * forgotten falls back to its modelled twin and still makes a sound, so nothing
 * anywhere reports a problem.
 */
export function __setFetchedPack({ id, name, lo, hi, sustains, notes, files = new Map() }) {
  packs.set(id, { id, name, lo, hi, sustains, notes, files, buffers: null, live: 0 });
  return packs.get(id);
}

/** Undo __setPack, so one test cannot leave a pack behind for the next. */
export function __clearPacks() {
  packs.clear();
  decodedFiles.clear();
  preparing.clear();
  decodedBytes = 0;
  clock = 0;
  loadState = 'idle';
  loadProgress = 0;
  loadError = null;
  loadPromise = null;
}