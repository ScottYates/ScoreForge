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

/** Where the backend is. Same-origin wins when the page is served by it. */
export function resolveBase() {
  const configured = localStorage.getItem('scoreforge.omrBase');
  if (configured) return configured.replace(/\/+$/, '');
  // Served by the backend itself -> same origin, no CORS round trip.
  if (location.protocol === 'http:' || location.protocol === 'https:') return '';
  return DEFAULT_BASE;
}

export function setBase(url) {
  const clean = String(url || '').trim().replace(/\/+$/, '');
  if (clean) localStorage.setItem('scoreforge.omrBase', clean);
  else localStorage.removeItem('scoreforge.omrBase');
  healthCache = null;
  probeHealth(true);
}

/* ------------------------------------------------------------------ status */

let healthCache = null;
let healthPromise = null;

/** Cached backend status. Never throws. */
export async function backendHealth() {
  if (healthCache) return healthCache;
  if (!healthPromise) {
    const base = resolveBase();
    healthPromise = fetch(`${base}/api/health`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => {
        healthCache = { ...j, base, reachable: true };
        return healthCache;
      })
      .catch((e) => {
        healthCache = { reachable: false, error: e && e.message ? e.message : String(e), base };
        return healthCache;
      })
      .finally(() => { healthPromise = null; });
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
      `Could not reach the recognition backend at ${base || 'this page’s origin'}. ` +
      'Start it with: python backend/app.py'
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
 * Transcribe and convert each returned page into an app score.
 *
 * Each page becomes its own score so a multi-page PDF stays navigable rather
 * than being silently flattened into one part.
 */
export async function transcribeToScores(file, opts = {}) {
  const result = await transcribe(file, opts);
  const scores = [];
  for (const page of result.pages) {
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
  return { scores, result };
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