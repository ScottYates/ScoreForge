/**
 * tools/drive-omr.mjs — drive the built app in a real browser against a live
 * recognition backend, and report what a person would actually have seen.
 *
 * Needs `python backend/app.py` running on 127.0.0.1:8000 and `node tools/build.mjs`
 * having been run first.
 *
 *   node tools/drive-omr.mjs run   fixtures/tiny.png
 *   node tools/drive-omr.mjs abort fixtures/ode.pdf
 *
 * `run` loads a scan, watches the progress card, presses Save MusicXML and reads
 * the bytes back out of the blob it downloaded.
 *
 * `abort` presses Abort part-way through a slow scan, then asks the *backend* what
 * became of the job id the page was given. A UI that merely stopped watching
 * scores the same as one that actually freed the CPU, so only the server's answer
 * settles it.
 *
 * This exists because the module suites stub fetch: they cannot see whether the
 * page actually forwards progress to the panel, or whether Abort is wired to
 * anything at all.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const mode = process.argv[2];
const fixture = process.argv[3];

if (!['run', 'abort'].includes(mode) || !fixture) {
  console.error('usage: node tools/drive-omr.mjs <run|abort> <fixture>');
  process.exit(2);
}

// The fixture is inlined as base64: the page runs from file://, where fetch()
// of a file: URL hangs, and a 60 KB fixture is small enough to carry that way.
const b64 = fs.readFileSync(path.resolve(root, fixture)).toString('base64');
const mime = fixture.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/png';

/** The page script. Runs on load; publishes window.__uiResult when finished. */
const start = `(async () => {
  window.__uiSamples = [];
  window.__uiDownloads = [];
  window.__uiError = null;
  const app = window.ScoreForge;

  // Record what a download actually produced instead of trusting the click.
  // Keyed by URL, because the page also makes blob URLs for the reference scan
  // -- grabbing "the first blob" would happily read back the PNG.
  window.__uiBlobByUrl = {};
  const realCreate = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (blob) => {
    const url = realCreate(blob);
    window.__uiBlobByUrl[url] = blob;
    return url;
  };
  const realClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download) {
      window.__uiDownloads.push({ name: this.download, href: String(this.href) });
      window.__uiLastDownload = { name: this.download, blob: window.__uiBlobByUrl[this.href] || null };
    } else return realClick.call(this);
  };

  // What the user can actually see while it runs.
  const t0 = Date.now();
  const sampler = setInterval(() => {
    const pct = document.querySelector('.omr-job-pct');
    if (!pct) return;
    const msg = document.querySelector('.omr-job-msg');
    const btn = document.querySelector('.omr-job-foot button');
    window.__uiSamples.push({
      t: Date.now() - t0,
      pct: pct.textContent,
      msg: msg ? msg.textContent : '',
      btn: btn ? btn.textContent : '',
      disabled: btn ? !!btn.disabled : null,
      width: (document.querySelector('.omr-job-fill') || {}).style?.width || '',
    });
  }, 120);

  const bin = atob(${JSON.stringify(b64)});
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const file = new File([bytes], ${JSON.stringify(path.basename(fixture))}, { type: ${JSON.stringify(mime)} });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    const done = app.addFiles([file]);

    if (${JSON.stringify(mode)} === 'abort') {
      // Wait until a job is genuinely under way, then stop it the way a person would.
      let jobId = null, sawCard = false;
      for (let i = 0; i < 200; i++) {
        await sleep(100);
        if (app.omrJob && app.omrJob.view && app.omrJob.view.progress > 0) { jobId = await app.omrJob.handle.jobId; sawCard = true; break; }
      }
      window.__uiJobId = jobId;
      const btn = document.querySelector('.omr-job-foot button');
      const labelBefore = btn ? btn.textContent : null;
      if (btn) btn.click();
      await sleep(150);
      const midBtn = document.querySelector('.omr-job-foot button');
      const midMsg = document.querySelector('.omr-job-msg');
      window.__uiAbort = {
        sawCard,
        labelBefore,
        midLabel: midBtn ? midBtn.textContent : null,
        midDisabled: midBtn ? !!midBtn.disabled : null,
        midMsg: midMsg ? midMsg.textContent : '',
      };
      await done;
    } else {
      await done;
    }

    // Give the final render a beat.
    await sleep(300);

    const report = {
      omrSecHidden: document.getElementById('omrSec').hidden,
      jobCardGone: !document.querySelector('.omr-job'),
      pageChips: document.querySelectorAll('.omr-page').length,
      library: app.library.length,
      libraryNames: app.library.map((s) => s.fileName),
      toasts: [...document.querySelectorAll('.toast, [class*=toast]')].map((t) => t.textContent.trim()).filter(Boolean),
      saveButton: (() => {
        const b = [...document.querySelectorAll('.omr-save button')][0];
        return b ? b.textContent : null;
      })(),
    };

    if (${JSON.stringify(mode)} === 'run') {
      const btn = [...document.querySelectorAll('.omr-save button')][0];
      if (btn) btn.click();
      await sleep(300);
      const got = window.__uiLastDownload;
      const text = got && got.blob ? await got.blob.text() : null;
      report.saved = got ? {
        name: got.name,
        type: got.blob ? got.blob.type : null,
        bytes: got.blob ? got.blob.size : 0,
        startsWith: text ? text.slice(0, 120) : null,
        hasScorePartwise: !!text && /<score-partwise/.test(text),
        noteCount: text ? (text.match(/<note>/g) || []).length : 0,
        endsWith: text ? text.slice(-40) : null,
      } : null;
    } else {
      const id = window.__uiJobId;
      let server = null;
      if (id) {
        try {
          const r = await fetch('http://127.0.0.1:8000/api/omr/jobs/' + id, { cache: 'no-store' });
          server = await r.json();
        } catch (e) { server = { fetchError: String(e) }; }
      }
      report.serverJob = server ? { state: server.state, message: server.message, seconds: server.seconds } : null;
    }

    window.__uiResult = report;
  } catch (e) {
    window.__uiError = String((e && e.stack) || e);
  } finally {
    clearInterval(sampler);
    window.__uiDone = true;
  }
  return true;
})()`;

const startFile = path.join(os.tmpdir(), `ui-start-${mode}.js`);
fs.writeFileSync(startFile, start, 'utf8');

const page = pathToFileURL(path.join(root, 'index.html')).href;
const waitFor = 'window.__uiDone === true';
const evalExpr = '({ result: window.__uiResult, error: window.__uiError, abort: window.__uiAbort, samples: window.__uiSamples, downloads: window.__uiDownloads, jobId: window.__uiJobId })';

const args = [
  path.join(root, 'tools', 'cdp.mjs'),
  '--url', page,
  '--startFile', startFile,
  '--wait', waitFor,
  '--timeout', '180000',
  '--eval', evalExpr,
];

const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// The harness prints a pretty-printed JSON envelope on stdout; keep it, then add
// a readable summary. `value` is an object when --eval returned one and a JSON
// string otherwise, so handle both rather than assuming.
const stdout = r.stdout || '';
process.stdout.write(stdout);
process.stderr.write(r.stderr || '');

function envelope(text) {
  try { return JSON.parse(text); } catch { /* fall through to a scan */ }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  try { return JSON.parse(text.slice(first, last + 1)); } catch { return null; }
}

const env = envelope(stdout.trim());
if (!env) {
  console.error('drive-omr: the harness produced no JSON envelope; run tools/cdp.mjs by hand to see why');
  process.exit(1);
}
const value = typeof env.value === 'string' ? JSON.parse(env.value) : env.value;
const out = { mode, ...value };

// Samples are noisy -- the poll interval repeats a state for seconds. Collapse
// them to the distinct things a person would have watched change.
if (Array.isArray(out.samples)) {
  const seen = new Set();
  out.steps = [];
  for (const s of out.samples) {
    const k = [s.pct, s.msg, s.btn, s.disabled, s.width].join('|');
    if (seen.has(k)) continue;
    seen.add(k);
    out.steps.push(`${String(s.pct).padStart(4)}  ${s.msg}  [${s.btn}${s.disabled ? ' disabled' : ''}]  bar=${s.width}`);
  }
  out.sampleCount = out.samples.length;
  delete out.samples;
}
console.log('\n=== drive-omr ' + mode + ' ===');
console.log(JSON.stringify(out, null, 2));
if (out.error) process.exitCode = 1;
process.exit(r.status || process.exitCode || 0);