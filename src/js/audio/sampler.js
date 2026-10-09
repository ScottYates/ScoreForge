/**
 * audio/sampler.js — recorded instruments, played back from a sample pack.
 *
 * The synthesiser in instruments.js is physically modelled and needs nothing
 * from the network. This is the other half: real recordings of real instruments,
 * which sound like themselves rather than like an approximation. Both are in the
 * roster and the user picks.
 *
 * ── Why everything is decoded up front ──────────────────────────────────────
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
 * So loadPack() fetches and decodes the entire pack before any instrument is
 * created, and noteOn only ever touches objects that are already in memory.
 * `createSampledInstrument` throws if its pack is not loaded rather than
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

/** A voice never rings longer than this, whatever the note says. */
const MAX_RING_SECONDS = 12;

/** Release when the key comes up, unless the family sustains while held. */
const KEY_RELEASE = 0.12;

/* ------------------------------------------------------------------- pack */

const packs = new Map();   // packId -> Pack
let loadPromise = null;

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

/** True once `packId` has a fully decoded pack behind it. */
export function hasPack(packId) {
  return packs.has(packId);
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
 * Fetch and decode the whole pack.
 *
 * Idempotent: the first call does the work and every later one joins it, so a
 * boot sequence that calls this from two places does not fetch 5 MB twice.
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

    const decodeCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 128, 44100);
    const buffers = new Map();
    let next = 0;

    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= files.length) return;
        const rel = files[i];
        const r = await fetch(`${base}/${rel}`, { cache: 'force-cache' });
        if (!r.ok) throw new Error(`${rel}: ${r.status} ${r.statusText}`);
        const bytes = await r.arrayBuffer();
        // decodeAudioData detaches the buffer it is given, so never hand it one
        // that is still referenced elsewhere.
        const buf = await decodeCtx.decodeAudioData(bytes);
        buffers.set(rel, { buffer: buf, onset: findOnset(buf) });
        done++;
        report();
      }
    };

    await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, files.length) }, worker));

    for (const [id, inst] of Object.entries(manifest.instruments)) {
      packs.set(id, { id, ...inst, credits: manifest.credits?.[id] || [], buffers });
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

    // The attack must begin at `when`, so playback starts at the measured onset
    // rather than at the top of the buffer, which is silence plus codec delay.
    const onset = decoded.onset;
    const rate = entry.rate || 1;

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
      },
      hardStop(t) {
        try { src.stop(t); } catch (e) { /* already stopped */ }
        this.hardStopAt = t;
      },
      drop() {
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
    }

    active.push(v);
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
 * This exists because attribution is not optional for part of the pack. The
 * grand in sgpiano is Salamander Grand Piano V3 under CC BY 3.0, and CC BY
 * wants the credit where the material is actually used -- which, for a web
 * page, is in the page. The values are not written here: they are built by
 * tools/make-pack.mjs from the SOURCES table and travel inside the pack, so
 * they cannot fall out of step with the files that were actually shipped.
 *
 * Deduplicated by source, because one library covers eight of the nine packs
 * and listing it eight times would read as an error rather than a credit.
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
  packs.set(id, { id, name, lo, hi, sustains, notes, buffers: measured });
  loadState = 'ready';
  return packs.get(id);
}

/** Undo __setPack, so one test cannot leave a pack behind for the next. */
export function __clearPacks() {
  packs.clear();
  loadState = 'idle';
  loadProgress = 0;
  loadError = null;
  loadPromise = null;
}