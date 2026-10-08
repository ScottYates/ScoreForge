/**
 * io/files.js — turning whatever the user dropped on the page into something
 * the app understands.
 *
 * Accepts:
 *   .musicxml .xml .mxl  MusicXML (optionally zipped)
 *   .mscz .mscx          MuseScore projects
 *   .mid .midi .kar .rmi Standard MIDI Files
 *   .png .jpg .webp .gif A scan or photo of the score
 *   .pdf                 A PDF score
 *
 * Images and PDFs are sent to the Python recognition backend when one is
 * reachable and come back as MusicXML. With no backend the page still works
 * entirely offline: MusicXML and MIDI parse locally and scans stay
 * reference-only.
 */

import { unzipSync, strFromU8 } from 'fflate';
import { parseMusicXml } from './musicxml.js';
import { parseMidi } from './smf.js';
import { parseMuseScoreXml } from './mscx.js';
import { backendHealth, transcribeToScores } from './omr.js';

export const FORMATS = {
  musicxml: { label: 'MusicXML', exts: ['.musicxml', '.xml', '.mxl'], hint: 'MuseScore, Sibelius, Dorico, Finale, Noteflight' },
  mscz: { label: 'MuseScore', exts: ['.mscz', '.mscx'], hint: 'MuseScore project files' },
  midi: { label: 'MIDI', exts: ['.mid', '.midi', '.kar', '.rmi'], hint: 'Standard MIDI File' },
  image: { label: 'Image', exts: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'], hint: 'Scan or photo of a score' },
  pdf: { label: 'PDF', exts: ['.pdf'], hint: 'PDF score' },
};

const EXT_MAP = Object.entries(FORMATS).reduce((m, [k, v]) => {
  v.exts.forEach((e) => m[e] = k);
  return m;
}, {});

export function formatForFile(name) {
  const lower = String(name).toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return null;
  return EXT_MAP[lower.slice(dot)] || null;
}

export function isAcceptedFile(file) {
  return !!formatForFile(file.name);
}

export function acceptedExtensions() {
  return Object.values(FORMATS).flatMap((f) => f.exts);
}

/**
 * A file the app can show but cannot read notes from on its own.
 *
 * Only true while no recognition backend is reachable: with the backend up,
 * images and PDFs are transcribed into MusicXML like any other score.
 */
export async function isReferenceOnly(file) {
  const f = formatForFile(file.name);
  if (f !== 'image' && f !== 'pdf') return false;
  const health = await backendHealth();
  return !health.reachable;
}

/* ------------------------------------------------------------------ read */

function startsWith(u8, bytes, offset = 0) {
  for (let i = 0; i < bytes.length; i++) if (u8[offset + i] !== bytes[i]) return false;
  return true;
}

/** Look inside a zip for a file with the given extension. */
function findInZip(files, ext) {
  const keys = Object.keys(files);
  const exact = keys.find((k) => k.toLowerCase().endsWith(ext));
  if (exact) return exact;
  const any = keys.find((k) => k.toLowerCase().includes(ext.slice(1)));
  return any || null;
}

function pickScoreXml(xml, containerName) {
  // A compressed container often holds the score plus metadata files.
  const candidates = Object.keys(xml)
    .filter((k) => /\.(musicxml|xml)$/i.test(k))
    .filter((k) => !/(museScore|manifest|container|thumbnails|metaInf)/i.test(k))
    .sort((a, b) => {
      const score = (n) => (/score/i.test(n) ? 0 : /part/i.test(n) ? 1 : 2);
      return score(a) - score(b) || a.length - b.length;
    });
  if (!candidates.length) {
    throw new Error(`No score file found inside ${containerName}.`);
  }
  return strFromU8(xml[candidates[0]]);
}

/**
 * Parse one file into `{kind, score?, reference?, warnings?}`.
 *
 * Images and PDFs go to the recognition backend when one is reachable and come
 * back as MusicXML; otherwise they are kept as reference material.
 *
 * @param {File} file
 * @param {object} [opts]
 * @param {'auto'|'original'|'clean'} [opts.omrMode]
 * @param {(msg:string)=>void} [opts.onProgress]
 * @returns {Promise<{kind:'score'|'reference', score?, reference?, warnings:string[], omr?}>}
 */
export async function readScoreFile(file, opts = {}) {
  const name = file.name;
  const kind = formatForFile(name);
  const buf = new Uint8Array(await file.arrayBuffer());

  if (kind === 'midi' || startsWith(buf, [0x4d, 0x54, 0x68, 0x64])) {
    return { kind: 'score', score: parseMidi(buf.buffer, { fileName: name }), warnings: [] };
  }

  const isImage = kind === 'image' || (!kind && looksLikeRaster(buf));
  const isPdf = kind === 'pdf' || startsWith(buf, [0x25, 0x50, 0x44, 0x46]);

  if (isImage || isPdf) {
    const reference = {
      type: isPdf ? 'pdf' : 'image',
      name,
      blob: file,
      url: URL.createObjectURL(file),
    };
    const health = await backendHealth();
    if (!health.reachable) {
      return { kind: 'reference', reference, warnings: [] };
    }
    opts.onProgress && opts.onProgress(`Reading ${name}…`);
    const { scores, result } = await transcribeToScores(file, { mode: opts.omrMode });
    if (!scores.length) throw new Error(`No music could be read from ${name}.`);
    return {
      kind: 'score',
      score: scores[0],
      reference,
      warnings: [],
      omr: { ...result, pageCount: scores.length },
      extraScores: scores.slice(1),
    };
  }

  // Everything else is text, possibly inside a zip.
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b;

  if (kind === 'musicxml' || (!kind && looksLikeXml(buf))) {
    if (isZip) {
      const xml = unzipSync(buf);
      const text = pickScoreXml(xml, name);
      return { kind: 'score', score: parseMusicXml(text, { fileName: name }), warnings: [] };
    }
    return { kind: 'score', score: parseMusicXml(strFromU8(buf), { fileName: name }), warnings: [] };
  }

  if (kind === 'mscz' || isZip) {
    const xml = unzipSync(buf);
    const musicxml = findInZip(xml, '.musicxml') || findInZip(xml, '.xml');
    if (musicxml && !/musescore\.xml/i.test(musicxml)) {
      const text = strFromU8(xml[musicxml]);
      if (/<score-partwise|<score-timewise/.test(text)) {
        return { kind: 'score', score: parseMusicXml(text, { fileName: name }), warnings: [] };
      }
    }
    const mscx = findInZip(xml, '.mscx') || (musicxml && /mscx/i.test(musicxml) ? musicxml : null);
    if (mscx) {
      return {
        kind: 'score',
        score: parseMuseScoreXml(strFromU8(xml[mscx]), { fileName: name }),
        warnings: [],
      };
    }
    throw new Error(`${name} is a zip archive but contains no score I can read.`);
  }

  if (kind === 'mscx') {
    return { kind: 'score', score: parseMuseScoreXml(strFromU8(buf), { fileName: name }), warnings: [] };
  }

  throw new Error(`Unsupported file type: ${name}`);
}

function looksLikeXml(u8) {
  const head = new TextDecoder('utf-8').decode(u8.subarray(0, 400)).trimStart();
  return head.startsWith('<?xml') || head.startsWith('<score-partwise') || head.startsWith('<score-timewise')
    || head.startsWith('<museScore');
}

const RASTER_MAGIC = [
  [0x89, 0x50, 0x4e, 0x47], // png
  [0xff, 0xd8, 0xff],       // jpeg
  [0x47, 0x49, 0x46, 0x38], // gif
  [0x42, 0x4d],             // bmp
];

function looksLikeRaster(u8) {
  if (startsWith(u8, [0x52, 0x49, 0x46, 0x46]) && u8[8] === 0x57 && u8[9] === 0x45) return true; // webp
  return RASTER_MAGIC.some((m) => startsWith(u8, m));
}

/** Read many files, keeping successes and collecting per-file errors. */
export async function readScoreFiles(files, opts = {}) {
  const ok = [];
  const failed = [];
  for (const file of files) {
    try {
      const r = await readScoreFile(file, opts);
      if (r.kind === 'score') r.score.fileName = file.name;
      else if (r.reference) r.reference.fileName = file.name;
      ok.push(r);
    } catch (e) {
      failed.push({ file, error: e && e.message ? e.message : String(e) });
    }
  }
  return { ok, failed };
}