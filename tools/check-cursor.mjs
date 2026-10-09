/**
 * tools/check-cursor.mjs — is the playback cursor actually the colour we chose?
 *
 * This exists because the cursor was silently the wrong colour for a long time.
 * OSMD reads `cursorsOptions` once, while applying constructor options, and
 * builds each Cursor from it when the first page renders. There is no cursor
 * object to mutate before then, so the old code — which assigned
 * `osmd.cursor.CursorOptions.color` after `load()` — threw a TypeError, swallowed
 * it, and left the cursor on OSMD's default green while every layer above it
 * looked configured correctly.
 *
 * So this asks three separate questions, in increasing order of what they prove:
 *
 *   asked    what we handed to the constructor      (catches a broken token read)
 *   held     what OSMD's Cursor object ended up with (catches "passed but ignored")
 *   painted  the RGB actually in the <img> on screen (catches "held but not drawn")
 *
 * `painted` is the one that matters; the other two can both be right while the
 * bar on the page is green. It also re-derives the alpha composite rather than
 * comparing the raw hex to the paper, because OSMD lays the bar over the page —
 * comparing the hex overstates every reading by the full alpha, which is how a
 * 2.11:1 cursor got described as 3.9:1.
 *
 * Exits non-zero on failure so verify.mjs can fold it into `npm test`.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CDP = path.join(ROOT, 'tools', 'cdp.mjs');
const URL = pathToFileURL(path.join(ROOT, 'index.html')).href + '?demo';

// Non-text contrast for a control that has to be perceivable to use.
const MIN_CONTRAST = 3.0;

/** `node tools/check-cursor.mjs --shot out.png` also captures the score. */
function argShot() {
  const i = process.argv.indexOf('--shot');
  return i === -1 ? null : process.argv[i + 1];
}

// The whole probe has to run in --start: cdp.mjs's --eval stringifies its
// expression before awaiting it, so an async expression there comes back as "{}".
// --start fires the promise off, --wait polls for it, --eval reads it back.
const START = String.raw`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  try {
    const nv = window.ScoreForge.notation;
    // Put the cursor on a note; a hidden or zero-sized cursor proves nothing.
    nv.showCursorAtQuarter(2);
    await sleep(400);

    const paper = document.querySelector('.paper');
    const pcs = getComputedStyle(paper);
    out.token = pcs.getPropertyValue('--cursor').trim();
    out.paper = pcs.backgroundColor;

    const osmd = nv.osmd;
    out.asked = osmd.cursorsOptions ? JSON.parse(JSON.stringify(osmd.cursorsOptions[0])) : null;
    out.held = nv.osmd.cursor ? JSON.parse(JSON.stringify(nv.osmd.cursor.CursorOptions)) : null;

    const img = nv.osmd.cursor && nv.osmd.cursor.cursorElement;
    if (!img) { out.img = null; out.done = true; window.__probe = out; return; }

    const cs = getComputedStyle(img);
    const r = img.getBoundingClientRect();
    out.img = { id: img.id, display: cs.display, visibility: cs.visibility, w: r.width, h: r.height };

    const bmp = await createImageBitmap(img);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
    const i = (Math.floor(bmp.height / 2) * bmp.width + Math.floor(bmp.width / 2)) * 4;
    out.painted = [d[i], d[i + 1], d[i + 2], d[i + 3]];

    // Where it lands, not just how it looks. The cursor being the right colour
    // in the wrong place is still a broken cursor, and a green default at the
    // last bar looks plausible enough to pass a colour-only check.
    out.measures = nv.measureCount();
    out.seeks = [];
    nv.resetCursor();
    for (const q of [0, 1, 4, 8, 16]) {
      nv.showCursorAtQuarter(q);
      await sleep(60);
      const it = nv.osmd.cursor.iterator;
      const box = nv.osmd.cursor.cursorElement.getBoundingClientRect();
      out.seeks.push({
        q,
        step: nv.stepIndex,
        tableQuarter: nv.steps[nv.stepIndex] ? nv.steps[nv.stepIndex].quarter : null,
        measure: it.CurrentMeasureIndex,
        real: it.currentTimeStamp.RealValue,
        x: Math.round(box.x),
        y: Math.round(box.y),
      });
    }
  } catch (e) {
    out.error = String(e);
  }
  out.done = true;
  window.__probe = out;
})()`;

const cdp = (shot = null) =>
  new Promise((res) => {
    const args = [CDP, '--url', URL, '--start', START, '--wait', 'window.__probe && window.__probe.done',
      '--timeout', '120000', '--eval', 'window.__probe', '--width', '1500', '--height', '950'];
    if (shot) args.push('--shot', shot);
    const p = spawn(process.execPath, args, { cwd: ROOT, stdio: 'pipe' });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => res({ code, out, err }));
  });

// --- colour maths, in the units the user sees ---------------------------------
const parseRgb = (s) => {
  const m = String(s).match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].split(',').map((n) => parseFloat(n));
  return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
};
const parseHex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lin = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const contrast = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** OSMD composites the bar over the page at `alpha`; that blend is what shows. */
const over = (fg, a, bg) => fg.map((c, i) => a * c + (1 - a) * bg[i]);

const failures = [];
const t = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures.push(name + (detail ? ': ' + detail : ''));
};

const run = await cdp(argShot());
// cdp.mjs already JSON-parses its --eval payload, so `value` arrives as an
// object; older shapes hand back the string. Accept either.
let probe = null;
try {
  const v = JSON.parse(run.out).value;
  probe = typeof v === 'string' ? JSON.parse(v) : v;
} catch { /* reported below */ }

if (!probe) {
  console.error('cursor check: browser produced no result');
  console.error('--- raw ---\n' + run.out.trim() + '\n--- stderr ---\n' + run.err.trim());
  process.exit(1);
}
if (probe.error) {
  console.error('cursor check: probe threw — ' + probe.error);
  process.exit(1);
}

console.log(`cursor check  paper ${probe.paper}  --cursor ${probe.token}`);

const paper = parseRgb(probe.paper);
const want = parseHex(probe.token);
if (!paper) { console.error('cursor check: could not read the paper background'); process.exit(1); }

t('paper has a colour', Array.isArray(paper), probe.paper);
t('cursor options were passed at construction', !!probe.asked && !!probe.asked.color,
  JSON.stringify(probe.asked));

if (probe.asked) {
  t('cursor colour comes from --cursor', probe.asked.color === probe.token,
    `${probe.asked.color} vs ${probe.token}`);
}
if (probe.held) {
  t('OSMD kept the options we passed', probe.held.color === probe.asked?.color && probe.held.type === probe.asked?.type,
    JSON.stringify(probe.held));
} else {
  t('OSMD built a cursor', false, 'no cursor object after render');
}

t('cursor is shown', !!probe.img && probe.img.display !== 'none' && probe.img.visibility === 'visible',
  JSON.stringify(probe.img));
t('cursor has a size', !!probe.img && probe.img.w > 0 && probe.img.h > 0,
  probe.img ? `${Math.round(probe.img.w)}x${Math.round(probe.img.h)}` : '');

if (Array.isArray(probe.painted)) {
  const [r, g, b, a] = probe.painted;
  const expect = probe.asked
    ? over(parseHex(probe.asked.color), probe.asked.alpha, paper)
    : null;
  const close = expect && [0, 1, 2].every((i) => Math.abs(expect[i] - [r, g, b][i]) <= 2);
  t('painted pixels are the cursor colour, composited', close,
    `painted rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}) a=${(a / 255).toFixed(2)}` +
    (expect ? `  expected ~rgb(${expect.map((v) => Math.round(v)).join(', ')})` : ''));

  const drawn = over([r, g, b], a / 255, paper);
  const ratio = contrast(drawn, paper);
  t(`cursor is legible on the paper (>= ${MIN_CONTRAST}:1)`, ratio >= MIN_CONTRAST,
    `${ratio.toFixed(2)}:1 as drawn`);

  const green = over(parseHex('#33e02f'), 0.5, paper);
  if (ratio < contrast(green, paper)) {
    t('cursor is not OSMD\'s default green', false, `default green would be ${contrast(green, paper).toFixed(2)}:1`);
  }
}

// The iterator reports InvalidTimestamp as 99999; every entry here should be a
// real timestamp, which is a cheap signal that the walk landed on a note rather
// than off the end of the score.
const INVALID_TS = 99999;
if (Array.isArray(probe.seeks) && probe.seeks.length) {
  const last = probe.measures - 1;
  const stuck = (s) => s.measure === last && s.real === INVALID_TS;
  t('seeking to the first note lands on measure 0',
    probe.seeks[0].measure === 0 && probe.seeks[0].real !== INVALID_TS,
    `quarter ${probe.seeks[0].q} -> measure ${probe.seeks[0].measure}, timestamp ${probe.seeks[0].real}`);

  const positions = new Set(probe.seeks.map((s) => `${s.x},${s.y}`));
  t('different quarters put the cursor in different places', positions.size >= 4,
    `${positions.size} distinct positions across ${probe.seeks.length} seeks`);

  const advance = probe.seeks.filter((s, i) => i > 0 && !stuck(s));
  t('seeking forward only moves forward',
    advance.every((s, i) => i === 0 || s.measure >= advance[i - 1].measure),
    advance.map((s) => s.measure).join(' -> '));

  t('no seek lands on an invalid timestamp', !probe.seeks.some(stuck),
    probe.seeks.filter(stuck).map((s) => `q${s.q}`).join(', ') || 'none');

  // Cross-check the seek against our own table rather than against itself: the
  // table records the quarter each step should sound at, and OSMD reports where
  // the iterator actually is. RealValue is whole notes, so x4 gives quarters.
  // An off-by-one step is otherwise invisible -- it still lands on a plausible
  // note in the right measure, just one note late.
  const drifted = probe.seeks.filter(
    (s) => s.real === INVALID_TS || s.tableQuarter === null || Math.abs(s.real * 4 - s.tableQuarter) > 1e-6
  );
  t('the cursor lands on the note the table says it should', drifted.length === 0,
    drifted.length
      ? drifted.map((s) => `q${s.q}: expected ${s.tableQuarter}, OSMD at ${s.real * 4}`).join('; ')
      : probe.seeks.map((s) => `${s.real * 4}`).join(' = '));
}

if (failures.length) {
  console.error('\nCURSOR CHECK FAILED: ' + failures.join('; '));
  process.exit(1);
}
console.log('cursor check OK');