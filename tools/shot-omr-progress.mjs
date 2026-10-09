/**
 * tools/shot-omr-progress.mjs — screenshot the progress card while a scan runs.
 *
 * drive-omr.mjs proves the card advances; this shows it. cdp.mjs takes its
 * screenshot once the --wait condition is true, so waiting for "the job is
 * between 30% and 75%" is what lands the picture mid-scan rather than after it.
 *
 *   node tools/shot-omr-progress.mjs [fixture] [out.png]
 *
 * Needs `python backend/app.py` running on 127.0.0.1:8000.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const fixture = process.argv[2] || 'fixtures/ode.png';
const out = process.argv[3] || path.join(process.env.TEMP, 'omr-progress.png');

const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.pdf': 'application/pdf' }[
  path.extname(fixture).toLowerCase()
] || 'application/octet-stream';

const b64 = fs.readFileSync(fixture).toString('base64');

const start = `(async () => {
  const app = window.ScoreForge;
  const bin = atob(${JSON.stringify(b64)});
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const file = new File([bytes], ${JSON.stringify(path.basename(fixture))}, { type: ${JSON.stringify(mime)} });
  app.addFiles([file]);
  return true;
})()`;

const startFile = path.join(process.env.TEMP, 'omr-shot-start.js');
fs.writeFileSync(startFile, start, 'utf8');

const args = [
  path.join(root, 'tools', 'cdp.mjs'),
  '--url', pathToFileURL(path.join(root, 'index.html')).href,
  '--startFile', startFile,
  // Land the shot in the middle of the bar, where the old code was frozen.
  '--wait', 'window.ScoreForge.omrJob && window.ScoreForge.omrJob.view && window.ScoreForge.omrJob.view.progress > 0.3 && window.ScoreForge.omrJob.view.progress < 0.8',
  '--timeout', '120000',
  '--eval', 'window.ScoreForge.omrJob.view.message',
  '--shot', out,
  '--width', '1500', '--height', '950',
];

const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
process.stdout.write(r.stdout || '');
process.stderr.write(r.stderr || '');
if (r.status !== 0) process.exit(r.status ?? 1);
console.log(`screenshot -> ${out}`);