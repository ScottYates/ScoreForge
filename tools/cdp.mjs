// Minimal Chrome DevTools Protocol harness (no external deps; Node 24 global WebSocket).
//
// Drives headless Edge/Chrome so we can (a) wait for a real async condition,
// (b) read structured results back, and (c) capture a screenshot.
//
// Usage:
//   node tools/cdp.mjs --url <url> [--wait "<js expr, truthy = ready>"] [--timeout ms]
//                      [--start "<js expr run once before waiting>"]
//                      [--startFile <path>]  read --start from a file
//                      [--eval "<js expr returning JSON-able value>"]
//                      [--shot <out.png>] [--width n] [--height n] [--headful]
//                      [--browser <path>]
//
// To drive a file upload, build a File in the page and dispatch `change` on
// the input. Note that fetch() of a data: URL hangs in headless Chrome, so
// decode the bytes with atob() rather than fetching them.
//
// --start and --startFile must be ONE parenthesisable expression -- the harness
// wraps the text in `(${start})`. Several statements are a parse error in that
// wrapper and cannot be caught from inside it, so use an IIFE:
//   (async () => { ... })()
// A parse failure is reported as "[start failed]" rather than silently doing
// nothing. For a large payload, prefer having the page fetch() the file over
// HTTP (see the CORS server used by tools/score_omr.py) rather than inlining it.
//
// Browser selection: --browser, else $SCOREFORGE_BROWSER, else the first
// Chrome/Edge/Chromium found on this platform.
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Talking to Chrome uses the global WebSocket, which Node only gained in 22.
// The build runs on Node 18; these browser-driven checks do not.
if (typeof WebSocket === 'undefined') {
  console.error(
    'tools/cdp.mjs needs Node 22 or newer: the global WebSocket it uses to reach\n' +
    'Chrome is not defined here. Building with `npm run build` works on Node 18.'
  );
  process.exit(2);
}

function arg(name, def = null) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? def : (process.argv[i + 1] ?? true);
}

/**
 * Locate a Chromium browser. The paths differ per platform and CI images move
 * around, so try the well-known locations rather than hardcoding one machine's
 * layout -- a harness that only works on the author's box is not a test suite.
 */
function findBrowser() {
  const explicit = arg('browser', null) || process.env.SCOREFORGE_BROWSER;
  if (explicit) {
    if (!fs.existsSync(explicit)) {
      throw new Error(`browser not found at ${explicit} (--browser / $SCOREFORGE_BROWSER)`);
    }
    return explicit;
  }
  const home = os.homedir();
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(home, 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
      ]
    : process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ]
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
          '/snap/bin/chromium',
          path.join(home, '.cache/ms-playwright/chromium_headless_shell'),
        ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(
      'no Chrome/Chromium/Edge found. Pass --browser <path> or set $SCOREFORGE_BROWSER. ' +
      `Looked in:\n  ${candidates.join('\n  ')}`
    );
  }
  return found;
}

const BROWSER = findBrowser();

async function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
    s.on('error', rej);
  });
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message + ' ' + (msg.error.data || ''))) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP timeout: ' + method));
        }
      }, 180000);
    });
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const url = arg('url');
  if (!url) { console.error('missing --url'); process.exit(2); }
  const waitFor = arg('wait', 'window.__DONE__ === true');
  const timeout = parseInt(arg('timeout', '90000'), 10);
  const evalExpr = arg('eval', null);
  const shot = arg('shot', null);
  const width = parseInt(arg('width', '1600'), 10);
  const height = parseInt(arg('height', '1000'), 10);
const delay = parseInt(arg('delay', '0'), 10);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-profile-'));

  const port = await freePort();
  const args = [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--allow-file-access-from-files',
    '--disable-features=CalculateNativeWinOcclusion',
    '--force-device-scale-factor=1',
    `--window-size=${width},${height}`,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ];
  const proc = spawn(BROWSER, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderrBuf = '';
  proc.stderr.on('data', d => { stderrBuf += d.toString(); });

  const cleanup = () => {
    try { proc.kill(); } catch {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  };

  try {
    // wait for the debugging endpoint
    let ver = null;
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (r.ok) { ver = await r.json(); break; }
      } catch {}
      await sleep(100);
    }
    if (!ver) throw new Error('browser never exposed DevTools endpoint\n' + stderrBuf.slice(-2000));

    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new CDP(ws);

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Log.enable', {}, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);

    await cdp.send('Page.navigate', { url }, sessionId);

    // collect console + exceptions
    const consoleLines = [];
    const pump = setInterval(() => {
      while (cdp.events.length) {
        const ev = cdp.events.shift();
        if (ev.method === 'Runtime.consoleAPICalled') {
          consoleLines.push(`[${ev.params.type}] ` + ev.params.args.map(a =>
            a.value !== undefined ? a.value : (a.description || a.type)).join(' '));
        } else if (ev.method === 'Runtime.exceptionThrown') {
          const d = ev.params.exceptionDetails;
          consoleLines.push(`[exception] ${d.exception?.description || d.text}`);
        } else if (ev.method === 'Log.entryAdded') {
          consoleLines.push(`[log:${ev.params.entry.level}] ${ev.params.entry.text}`);
        }
      }
    }, 100);

    // Navigation is async, so the document is usually not parsed yet. Wait for
    // it before running anything against the DOM.
    const domReadyAt = Date.now();
    while (Date.now() - domReadyAt < Math.min(timeout, 30000)) {
      try {
        const r = await cdp.send('Runtime.evaluate',
          { expression: "document.readyState === 'complete' && !!document.body", returnByValue: true }, sessionId);
        if (r.result && r.result.value) break;
      } catch {}
      await sleep(120);
    }

    const t0 = Date.now();
    let ready = false;
    // Optional kick-off: run once before waiting. Needed when the thing being
    // waited on is *started* by the test itself (uploading a file, for
    // instance) rather than by page load. --startFile reads it from disk, for
    // scripts too big to pass on the command line.
    const startFile = arg('startFile', null);
    const startExpr = arg('start', null)
      || (startFile ? fs.readFileSync(startFile, 'utf8') : null);
    if (startExpr) {
      // The navigation above is async, so the page's own script has usually
      // not run yet -- evaluating immediately hits "undefined is not a
      // function". Wait for the document to finish parsing first.
      const readyAt = Date.now();
      while (Date.now() - readyAt < Math.min(timeout, 30000)) {
        try {
          const r = await cdp.send('Runtime.evaluate',
            { expression: "document.readyState === 'complete'", returnByValue: true }, sessionId);
          if (r.result && r.result.value) break;
        } catch {}
        await sleep(120);
      }
      try {
        const r = await cdp.send('Runtime.evaluate',
          { expression: `(() => { try { (${startExpr}); } catch (e) { console.error('start: ' + e); } })()`, returnByValue: true, awaitPromise: false },
          sessionId);
        // The expression above is wrapped in parentheses, so --start must be a
        // single expression. A multi-statement one is a *parse* error in this
        // wrapper, which the inner try/catch cannot see: the run then just
        // quietly does nothing and the wait times out looking like a failure of
        // whatever was being tested. Report it instead.
        const d = r && r.exceptionDetails;
        if (d) consoleLines.push('[start failed] ' + ((d.exception && d.exception.description) || d.text));
      } catch (e) { consoleLines.push(`[start error] ${e}`); }
    }
    while (Date.now() - t0 < timeout) {
      try {
        const r = await cdp.send('Runtime.evaluate',
          { expression: `(() => { try { return !!(${waitFor}); } catch (e) { return false; } })()`, returnByValue: true },
          sessionId);
        if (r.result && r.result.value) { ready = true; break; }
      } catch {}
      await sleep(250);
    }
    const elapsed = Date.now() - t0;
    clearInterval(pump);

    let value = null;
    if (evalExpr) {
      try {
        const r = await cdp.send('Runtime.evaluate',
          { expression: `(() => { try { return JSON.stringify(${evalExpr}); } catch (e) { return JSON.stringify({ __evalError: String(e) }); } })()`, returnByValue: true, awaitPromise: true },
          sessionId);
        value = r.result ? r.result.value : null;
      } catch (e) { value = JSON.stringify({ __evalError: String(e) }); }
    }

    if (shot) {
      if (delay) await sleep(delay);
      try {
        let clip = null;
        const sel = arg('selector', null);
        if (sel) {
          const r = await cdp.send('Runtime.evaluate',
            { expression: `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return JSON.stringify({x:b.x, y:b.y, width:b.width, height:b.height}); })()`, returnByValue: true },
            sessionId);
          if (r.result && r.result.value) clip = JSON.parse(r.result.value);
        }
        const params = { format: 'png', captureBeyondViewport: true };
        if (clip) { params.clip = { ...clip, scale: 2 }; }
        else {
          const metrics = await cdp.send('Page.getLayoutMetrics', {}, sessionId);
          const cs = metrics.cssContentSize || metrics.contentSize;
          const h = Math.min(Math.max(Math.ceil(cs.height), height), 8000);
          await cdp.send('Emulation.setDeviceMetricsOverride',
            { width, height: h, deviceScaleFactor: 1, mobile: false }, sessionId);
          await sleep(350);
        }
        const r = await cdp.send('Page.captureScreenshot', params, sessionId);
        fs.writeFileSync(shot, Buffer.from(r.data, 'base64'));
      } catch (e) { console.error('screenshot failed: ' + e.message); }
    }

    console.log(JSON.stringify({
      ready, elapsedMs: elapsed, url,
      value: (() => { try { return JSON.parse(value); } catch { return value; } })(),
      console: consoleLines.slice(0, 200),
    }, null, 2));

    ws.close();
    cleanup();
    process.exit(ready ? 0 : 1);
  } catch (e) {
    console.error('HARNESS ERROR: ' + e.message);
    console.error(stderrBuf.slice(-2000));
    cleanup();
    process.exit(3);
  }
})();