/**
 * tools/make-fixtures.mjs — render ground-truth score images.
 *
 * For each fixture: load tools/score-render.html?piece=<name>, screenshot the
 * score only, and write the known note list next to the image. The OMR accuracy
 * check compares homr's transcription against these.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// import.meta.dirname needs Node 20.11; from the module URL it works on 18 too.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'fixtures');
fs.mkdirSync(out, { recursive: true });

const pieces = process.argv.slice(2).length ? process.argv.slice(2)
  : ['tiny', 'simple', 'ode', 'rhythm', 'grand', 'sharps'];

/**
 * Paper width per piece, in CSS pixels. The accuracy set is engraved wide,
 * because it stands in for a real page and should exercise one. The end-to-end
 * install check reads `tiny`, which wants the smallest image that still reads
 * cleanly rather than a realistic-looking one.
 */
const PAPER = { tiny: 520 };
const DEFAULT_PAPER = 1400;

function cdp(args) {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, [path.join(root, 'tools/cdp.mjs'), ...args], { cwd: root, stdio: 'pipe' });
    let outp = '', err = '';
    p.stdout.on('data', d => { outp += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('close', () => { try { res(JSON.parse(outp)); } catch { rej(new Error(err || outp)); } });
  });
}

for (const piece of pieces) {
  const paper = PAPER[piece] || DEFAULT_PAPER;
  const url = `file:///${path.join(root, 'tools/score-render.html').replace(/\\/g, '/')}?piece=${piece}&paper=${paper}`;
  const png = path.join(out, `${piece}.png`);
  const r = await cdp([
    '--url', url,
    '--wait', 'window.__DONE__ === true',
    '--timeout', '60000',
    '--eval', 'JSON.stringify(window.__GT__)',
    '--selector', '#paper',
    '--shot', png,
    '--width', String(paper + 120), '--height', '900',
  ]);
  if (!r.ready) { console.log(`${piece}: RENDER FAILED`); continue; }
  let gt = null;
  try { gt = JSON.parse(typeof r.value === 'string' ? r.value : JSON.stringify(r.value)); } catch { /* fall through */ }
  if (gt) fs.writeFileSync(path.join(out, `${piece}.gt.json`), JSON.stringify(gt, null, 1));
  const bytes = fs.existsSync(png) ? fs.statSync(png).size : 0;
  console.log(`${piece.padEnd(8)} ${String(Math.round(bytes / 1024)).padStart(5)} KB  ` +
    `${paper}px  ${gt ? gt.notes.length : '?'} ground-truth notes  ` +
    `${gt && gt.consistent ? '' : gt ? 'GT MISMATCH ' : ''}` +
    `${gt ? `first=${gt.notes[0]?.midi} last=${gt.notes.at(-1)?.midi}` : 'NO GT'}`);
}