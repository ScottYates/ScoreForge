/**
 * io/omr.js — talking to the Python optical music recognition backend.
 *
 * The recogniser runs server-side (ONNX Runtime, CPU only). It returns MusicXML,
 * which is the format this app already parses for MusicXML uploads, so a scan
 * drops straight into the existing notation / playback / export pipeline.
 *
 * Everything here degrades gracefully: if no backend is reachable the app keeps
 * working fully offline and scans stay reference-only, exactly as before.
 */

import { parseMusicXml } from './musicxml.js';

const DEFAULT_BASE = 'http://127.0.0.1:8000';

/**
 * The backend given explicitly as `?api=http://host:port`, if any.
 *
 * This is the escape hatch for a service that is not on port 8000:
 * `index.html?api=http://127.0.0.1:9100`. It applies to the page load only
 * and is not remembered, so a bookmarked link stays honest about where it points.
 */
function explicitBase() {
  try {
    const raw = new URLSearchParams(location.search).get('api');
    return raw ? raw.replace(/\/+$/, '') : null;
  } catch {
    return null;
  }
}

/**
 * The base the user has pinned, or null when discovery is automatic.
 *
 * This is what the settings panel edits. Reading it through here rather than
 * from localStorage keeps the storage key in one place.
 */
export function configuredBase() {
  try {
    const saved = localStorage.getItem('scoreforge.omrBase');
    return saved ? saved.replace(/\/+$/, '') : null;
  } catch {
    /* storage can be blocked entirely; automatic discovery still works */
    return null;
  }
}

/**
 * Where the backend might be, most likely first.
 *
 * `?api=` wins outright -- it is the per-URL override. Then a base pinned in
 * the settings panel. Then, over http, same-origin, because that is the case
 * where the backend serves the page too. If the page came from somewhere else
 * -- a plain `python -m http.server`, say -- we fall back to the loopback port
 * the backend listens on. Under file:// there is only the loopback option.
 */
function candidateBases() {
  const explicit = explicitBase();
  if (explicit) return [explicit];
  const pinned = configuredBase();
  if (pinned) return [pinned];
  const bases = [];
  if (location.protocol === 'http:' || location.protocol === 'https:') bases.push('');
  bases.push(DEFAULT_BASE);
  return bases;
}

// The base that last answered, so uploads and preview URLs agree with it.
let activeBase = null;

/** The base in use: whatever responded last, else the best guess. */
export function resolveBase() {
  return activeBase !== null ? activeBase : candidateBases()[0];
}

/**
 * Pin the backend the settings panel edits, or clear the pin to go back to
 * automatic discovery. An empty or blank value clears it.
 *
 * The cached status is dropped and the new address probed immediately, so the
 * caller gets the health of what was just set rather than the previous answer.
 */
export function setBase(url) {
  const clean = String(url || '').trim().replace(/\/+$/, '');
  if (clean) localStorage.setItem('scoreforge.omrBase', clean);
  else localStorage.removeItem('scoreforge.omrBase');
  healthCache = null;
  activeBase = null;
  return probeHealth(true);
}

/* ------------------------------------------------------------------ status */

let healthCache = null;
let healthPromise = null;

/** Cached backend status. Never throws. */
export async function backendHealth() {
  if (healthCache) return healthCache;
  if (!healthPromise) {
    healthPromise = (async () => {
      const tried = [];
      for (const base of candidateBases()) {
        try {
          const res = await fetch(`${base}/api/health`, { cache: 'no-store' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = await res.json();
          activeBase = base;
          healthCache = { ...body, base, reachable: true, tried };
          return healthCache;
        } catch (e) {
          tried.push({ base: base || location.origin, error: e && e.message ? e.message : String(e) });
        }
      }
      healthCache = {
        reachable: false,
        error: tried.map((t) => `${t.base}: ${t.error}`).join('; '),
        base: candidateBases()[0],
        tried,
      };
      return healthCache;
    })().finally(() => { healthPromise = null; });
  }
  return healthPromise;
}

export async function probeHealth(force = false) {
  if (force) healthCache = null;
  return backendHealth();
}

/* ------------------------------------------------------------- recognition */

/**
 * Transcribe one image/PDF with the backend.
 *
 * @param {File} file
 * @param {object} [opts]
 * @param {'auto'|'original'|'clean'} [opts.mode]  preprocessing strategy
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{pages: Array, engine: object, elapsed: number}>}
 */
export async function transcribe(file, opts = {}) {
  const base = resolveBase();
  const form = new FormData();
  form.append('file', file, file.name);
  form.append('mode', opts.mode || 'auto');

  let res;
  try {
    res = await fetch(`${base}/api/omr`, { method: 'POST', body: form, signal: opts.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    throw new Error(
      `The recognition service is not running at ${base || 'this page’s origin'}.`
    );
  }

  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body && body.detail) detail = body.detail;
    } catch { /* non-JSON error body */ }
    throw new Error(detail);
  }

  const body = await res.json();
  return { ...body, base };
}

/**
 * Convert a finished transcription into one score per page.
 *
 * Each page becomes its own score so a multi-page PDF stays navigable rather
 * than being silently flattened into one part.
 */
export function scoresFromResult(file, result) {
  const scores = [];
  for (const page of result.pages || []) {
    const score = parseMusicXml(page.musicxml, {
      fileName: pageLabel(file, page.page),
    });
    // The recogniser usually cannot read a title off a scan, which would leave
    // every transcription called "Untitled". Fall back to the file name.
    if (!score.title || !score.title.trim() || score.title === 'Untitled') {
      score.title = pageLabel(file, page.page);
    }
    score.omr = {
      page: page.page,
      variant: page.variant,
      seconds: page.seconds,
      stats: page.stats,
      variantsTried: page.variantsTried,
      preview: page.preview ? `${resolveBase()}/api/preview/${page.preview}` : null,
      engine: { name: result.engine, version: result.version, device: result.device },
    };
    scores.push(score);
  }
  return scores;
}

/** Transcribe in one blocking call and convert the pages into scores. */
export async function transcribeToScores(file, opts = {}) {
  return scoresFromResult(file, await transcribe(file, opts));
}

/* ------------------------------------------------------------ background jobs */

/** How often to ask the service how a job is doing. */
const JOB_POLL_MS = 600;

/**
 * Consecutive failed polls to ride out before giving up on a job.
 *
 * A transcription takes tens of seconds on the CPU. Over that span a laptop
 * will change network, sleep, or restart a proxy in front of the backend. Three
 * seconds of silence is not a reason to throw away work already done; a
 * sustained outage is.
 */
const JOB_POLL_TOLERANCE = 5;

/**
 * Start a transcription as a background job and return a handle on it.
 *
 * This exists rather than a single blocking call because a page of music takes
 * long enough on the CPU that the user can see it happening, and long enough
 * that they may want to stop it.
 *
 * `cancel()` asks the *server* to stop, rather than abandoning the poll. That
 * distinction is the whole point: dropping the connection would leave the
 * recogniser grinding through a scan the user has already given up on, holding
 * the CPU for nobody. Cancellation is checked between pages, so one page in
 * flight always finishes -- `promise` rejects with an `err.cancelled` flag when
 * it does, rather than pretending the scan was read.
 *
 * @param {File} file
 * @param {object} [opts]
 * @param {'auto'|'original'|'clean'} [opts.mode] preprocessing strategy
 * @param {(view:object)=>void} [opts.onProgress] called with every polled view
 * @param {number} [opts.pollMs]
 * @returns {{jobId: Promise<string>, promise: Promise<object>, cancel: () => Promise<object|null>}}
 */
export function startTranscription(file, opts = {}) {
  const base = resolveBase();
  const pollMs = opts.pollMs || JOB_POLL_MS;
  const emit = opts.onProgress;

  // Lets cancel() cut the sleep between polls short, so "stopping" is shown
  // when the user asks for it rather than up to pollMs later.
  let wake = null;
  const sleep = (ms) => new Promise((resolve) => {
    let timer = null;
    const finish = () => { clearTimeout(timer); timer = null; wake = null; resolve(); };
    timer = setTimeout(finish, ms);
    wake = finish;
  });

  async function readJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (res.status === 404) {
      throw new Error('the service no longer knows about this job — it may have restarted');
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return res.json();
  }

  const jobId = (async () => {
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('mode', opts.mode || 'auto');

    let res;
    try {
      res = await fetch(`${base}/api/omr/jobs`, { method: 'POST', body: form });
    } catch {
      throw new Error(
        `The recognition service is not running at ${base || 'this page’s origin'}.`
      );
    }
    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`;
      try {
        const body = await res.json();
        if (body && body.detail) detail = body.detail;
      } catch { /* non-JSON error body */ }
      throw new Error(detail);
    }
    const body = await res.json();
    // Say something the moment the job exists. Waiting for the first poll would
    // leave the panel looking idle for a request that has already been sent.
    emit && emit({ state: 'running', progress: 0, message: 'Starting', seconds: 0 });
    return body.jobId;
  })();

  const promise = jobId.then(async (id) => {
    let misses = 0;
    for (;;) {
      let view = null;
      try {
        view = await readJson(`${base}/api/omr/jobs/${id}`);
        misses = 0;
      } catch (e) {
        if (++misses > JOB_POLL_TOLERANCE) throw e;
      }
      if (view) {
        emit && emit(view);
        if (view.state !== 'running') {
          if (view.state === 'done') return { ...view.result, base };
          if (view.state === 'cancelled') {
            const err = new Error('Stopped before the scan was finished.');
            err.cancelled = true;
            throw err;
          }
          const err = new Error(view.error || view.message || 'Recognition failed.');
          err.status = view.status;
          throw err;
        }
      }
      await sleep(pollMs);
    }
  });

  return {
    jobId,
    promise,
    /** Ask the server to stop. Resolves with the server's answer, or null. */
    async cancel() {
      let id;
      try { id = await jobId; } catch { return null; }
      try {
        const res = await fetch(`${base}/api/omr/jobs/${id}/cancel`, { method: 'POST' });
        if (!res.ok) return null;
        if (wake) wake();
        return await res.json();
      } catch {
        return null;
      }
    },
  };
}

function pageLabel(file, index) {
  const name = file.name.replace(/\.[^.]+$/, '');
  return index > 0 ? `${name} — page ${index + 1}` : name;
}

/** Short human summary of one transcribed page, for the report panel. */
export function describePage(page) {
  const s = page.stats || {};
  const bits = [];
  if (s.notes != null) bits.push(`${s.notes} note${s.notes === 1 ? '' : 's'}`);
  if (s.staves > 1) bits.push(`${s.staves} staves`);
  else if (s.measures) bits.push(`${s.measures} measure${s.measures === 1 ? '' : 's'}`);
  if (s.time_signature) bits.push(s.time_signature);
  if (s.tempo) bits.push(`♩=${s.tempo}`);
  return bits.join(' · ');
}