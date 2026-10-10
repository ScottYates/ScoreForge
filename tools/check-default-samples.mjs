/**
 * tools/check-default-samples.mjs - a score loaded and played straight away
 * sounds like the recordings, in the built page, against the real pack.
 *
 * The module suites prove the parts: routing-test that every route lands on a
 * recording, sampler-test that a pack prepares before its download finishes.
 * Neither can see the thing a person notices, which is whether the app they
 * opened plays samples. This loads the built index.html, opens the demo score,
 * presses Play at once, and reads back which instrument each part's channel
 * actually built -- the sampled one, or its modelled fallback.
 *
 * Two pages, because both are real:
 *
 *   http   served with the real pack/, every sample file delayed, so the
 *          background download is genuinely still running when Play is
 *          pressed. The claim: the parts play from recordings anyway, and the
 *          export dialog says the render used recorded samples.
 *
 *   file   opened from disk, where no pack can be fetched. The claim: the
 *          parts are still assigned recordings, playback falls back to the
 *          modelled instruments and makes sound, it says so once rather than
 *          on every Play, and an MP3 export completes and says it is modelled
 *          instead of failing.
 *
 *   node tools/check-default-samples.mjs
 *
 * Exits non-zero on any failure.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const PACK_DELAY_MS = 15;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.json': 'application/json',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.js': 'text/javascript',
};

/** The script run inside the page. `mode` is 'http' or 'file'. */
const script = (mode) => `(async () => {
  const MODE = ${JSON.stringify(mode)};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { checks: [], facts: {} };
  const check = (name, ok, detail) => out.checks.push({ name: MODE + ': ' + name, ok: !!ok, detail: detail || '' });
  try {
    const app = window.ScoreForge;
    const until = async (fn, ms = 60000) => {
      const t0 = performance.now();
      while (!fn()) { if (performance.now() - t0 > ms) return false; await sleep(25); }
      return true;
    };

    // Count the fallback toasts, so "once, not on every Play" is measured.
    let fallbackToasts = 0;
    const host = document.querySelector('#toasts');
    new MutationObserver((ms) => {
      for (const m of ms) for (const n of m.addedNodes) {
        if (/modelled instruments instead/.test(n.textContent || '')) fallbackToasts++;
      }
    }).observe(host, { childList: true });

    await until(() => app.score && app.duration() > 1);
    const ids = [...app.partInstruments.values()];
    const sampledIds = new Set(window.__SF_SAMPLED_IDS__ || []);
    check('the demo loaded', app.score && app.duration() > 1, 'parts: ' + ids.join(','));
    check('every part is assigned a recorded instrument',
      ids.length > 0 && ids.every((id) => /^rec-/.test(id)), ids.join(','));

    // Mute and unmute the part before the first Play, through its button. That
    // builds the part's channel while its samples are not decoded yet -- so it
    // is built as the modelled fallback -- and Play has to replace it with the
    // recording once they are, not keep playing the model for the session.
    if (MODE === 'http') {
      app.ensureAudio();
      const mute = document.querySelector('.part-row .mini.mute');
      check('the part has a mute button to press', !!mute);
      if (mute) { mute.click(); await sleep(50); mute.click(); await sleep(50); }
      const pre = app._engine && app._engine._channels ? [...app._engine._channels.values()] : [];
      out.facts.builtBeforePlay = pre.map((c) => ({ id: c.inst.id, sampled: !!c.inst.sampled }));
      check('a channel existed before Play, built as the fallback',
        pre.length > 0 && pre.every((c) => !c.inst.sampled), JSON.stringify(out.facts.builtBeforePlay));
    }

    const stateAtPlay = (document.querySelector('#packStatus') || {}).textContent || '';
    out.facts.statusAtPlay = stateAtPlay;
    const t0 = performance.now();
    await app.togglePlay();
    const started = await until(() => app.playing && app._engine && app._engine._channels && app._engine._channels.size > 0, 60000);
    out.facts.msToPlay = Math.round(performance.now() - t0);
    check('playback started', started, out.facts.msToPlay + ' ms after Play');

    const chans = app._engine && app._engine._channels ? [...app._engine._channels.values()] : [];
    const built = chans.map((c) => ({ id: c.inst.id, sampled: !!c.inst.sampled }));
    out.facts.built = built;

    if (MODE === 'http') {
      const stillLoading = /loading recorded instruments/.test(stateAtPlay);
      check('Play was pressed while the pack was still downloading', stillLoading, stateAtPlay);
      check('every channel plays the recording, not its modelled fallback',
        built.length > 0 && built.every((b) => b.sampled), JSON.stringify(built));
      check('no fallback toast', fallbackToasts === 0, fallbackToasts + ' toast(s)');
    } else {
      check('with no pack, every channel falls back to a modelled instrument',
        built.length > 0 && built.every((b) => !b.sampled), JSON.stringify(built));
    }

    // Let it sound briefly, then stop. With no pack, play a second time: the
    // fallback is announced once per reason, not once per press.
    await sleep(600);
    app.stop();
    if (MODE === 'file') {
      await app.togglePlay();
      await sleep(400);
      app.stop();
      check('the fallback is announced once, not on every Play', fallbackToasts === 1, fallbackToasts + ' toast(s)');
      const status = (document.querySelector('#packStatus') || {}).textContent || '';
      check('the status line says why there are no samples', /unavailable|served over http/.test(status), status);
    }

    // Export, through the dialog a person uses.
    app.openExport();
    await until(() => document.querySelector('.modal .btn.primary'), 5000);
    document.querySelector('.modal .btn.primary').click();
    const rendered = await until(() => [...document.querySelectorAll('.modal .fact .k')].some((k) => k.textContent === 'Instruments'), 180000);
    const factVal = rendered
      ? [...document.querySelectorAll('.modal .fact')].find((f) => f.querySelector('.k').textContent === 'Instruments').querySelector('.v').textContent
      : '';
    out.facts.exportInstruments = factVal;
    check('the MP3 export completes', rendered, (document.querySelector('.modal .progress-label') || {}).textContent || '');
    if (MODE === 'http') {
      check('and says it used the recorded samples', factVal === 'Recorded samples', factVal);
    } else {
      check('and says it fell back to the modelled instruments, and why', /^Modelled .*unavailable/.test(factVal), factVal);
    }
  } catch (e) {
    check('no exception', false, String((e && e.stack) || e));
  }
  window.__defaultSamples = out;
  window.__defaultSamplesDone = true;
  return true;
})()`;

function runPage(url, mode) {
  const startFile = path.join(os.tmpdir(), `check-default-samples-${mode}.js`);
  fs.writeFileSync(startFile, script(mode), 'utf8');
  // spawn, not spawnSync: the http page is served from this process.
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(root, 'tools', 'cdp.mjs'),
      '--url', url,
      '--startFile', startFile,
      '--wait', 'window.__defaultSamplesDone === true',
      '--timeout', '300000',
      '--eval', 'window.__defaultSamples',
    ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', () => {
      let env = null;
      try { env = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)); } catch { /* below */ }
      const v = env && (typeof env.value === 'string' ? JSON.parse(env.value) : env.value);
      resolve(v || { checks: [{ name: `${mode}: harness produced a result`, ok: false, detail: (err || out).slice(0, 400) }] });
    });
  });
}

// ---------------------------------------------------------------- http page
let packRequests = 0;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const file = path.join(root, decodeURIComponent(url.pathname));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    return res.end('not found');
  }
  const send = () => {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  };
  // Every sample file is slowed down, so the 4,000-file background download
  // is still running when Play is pressed -- the situation that used to play
  // the synthesiser.
  if (url.pathname.startsWith('/pack/') && !url.pathname.endsWith('manifest.json')) {
    packRequests++;
    setTimeout(send, PACK_DELAY_MS);
  } else {
    send();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

if (!fs.existsSync(path.join(root, 'pack', 'manifest.json'))) {
  console.error('check-default-samples: no pack/ in this checkout -- the http half needs it');
  process.exit(1);
}

const httpRes = await runPage(`http://127.0.0.1:${port}/index.html?demo`, 'http');
server.close();
const fileRes = await runPage(pathToFileURL(path.join(root, 'index.html')).href + '?demo', 'file');

let failed = 0;
for (const r of [httpRes, fileRes]) {
  for (const c of r.checks || []) {
    if (!c.ok) failed++;
    console.log(`${c.ok ? '  ok  ' : ' FAIL '} ${c.name}${c.detail ? '  — ' + c.detail : ''}`);
  }
}
console.log(`  http: Play to first channel ${httpRes.facts?.msToPlay ?? '?'} ms, ${packRequests} sample requests served`);
const total = (httpRes.checks || []).length + (fileRes.checks || []).length;
if (!total) { console.error('check-default-samples: no assertions ran'); process.exit(1); }
console.log(`\n${total - failed} passed · ${failed} failed`);
process.exit(failed ? 1 : 0);
