/**
 * tools/drive-transport.mjs — press one transport button and report what a
 * person would actually have seen.
 *
 *   node tools/drive-transport.mjs <scenario> [--shot out.png]
 *
 * Scenarios:
 *   fresh           just loaded, nothing played
 *   finish          play to the end, then look
 *   back            seek into the middle, press Back to start
 *   stop            play from the start, press Stop part-way through
 *   stop-middle     play from the middle, press Stop
 *   stop-ended      play to the end, then press Stop
 *   play-end        parked at the end, press Play
 *
 * Everything reported is in the units the user sees: the time readout, the
 * scrub bar's width, and the notation cursor's actual place on the page. The
 * engine's internal offset is included but is not the claim -- it can read
 * correct while all three of the others are wrong, which is the whole reason
 * this drives the buttons instead of calling the engine.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const scenario = process.argv[2] || 'finish';
const shotArg = process.argv.indexOf('--shot');
const shot = shotArg === -1 ? null : process.argv[shotArg + 1];

const body = `
  const app = window.ScoreForge;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { scenario: ${JSON.stringify(scenario)} };

  const sounded = [];
  app.ensureAudio();
  app._engine.on((ev) => {
    if (ev.type === 'note' && ev.on) sounded.push(+ev.note.time.toFixed(3));
    if (ev.type === 'ended') out.endedFired = (out.endedFired || 0) + 1;
  });

  const snap = (label) => {
    const cur = app.notation.osmd && app.notation.osmd.cursor;
    const el = cur && cur.cursorElement;
    const box = el ? el.getBoundingClientRect() : null;
    const cs = el ? getComputedStyle(el) : null;
    const vis = !!cs && cs.display !== 'none' && cs.visibility === 'visible';
    const pos = app.position;
    const q = app.resolved ? app.resolved.timing.quarterAtSeconds(pos) : null;
    return {
      label,
      position: +pos.toFixed(3),
      duration: +app.duration().toFixed(3),
      timeReadout: document.querySelector('#tNow').textContent,
      scrubFill: document.querySelector('#scrubFill').style.width,
      playIcon: document.querySelector('#btnPlay use').getAttribute('href'),
      playing: !!app.playing,
      engineOffset: app._engine ? +app._engine._offset.toFixed(3) : null,
      cursorVisible: vis,
      cursorStep: app.notation.stepIndex,
      cursorX: box ? Math.round(box.x) : null,
      cursorY: box ? Math.round(box.y) : null,
      expectedStep: app.notation.steps && q != null ? app.notation._stepIndexFor(q) : null,
    };
  };
  const click = (sel) => document.querySelector(sel).click();
  const runToEnd = async () => {
    click('#btnPlay');
    for (let i = 0; i < 600 && app.playing; i++) await sleep(40);
    await sleep(300);
  };

  out.before = snap('before');
  const dur = app.duration();

  if (${JSON.stringify(scenario)} === 'fresh') {
    // nothing to do
  } else if (${JSON.stringify(scenario)} === 'finish') {
    app.seek(Math.max(0, dur - 2.5));
    await sleep(150);
    out.before = snap('seeked near the end');
    await runToEnd();
  } else if (${JSON.stringify(scenario)} === 'back') {
    app.seek(dur * 0.4);
    await sleep(200);
    out.before = snap('seeked to the middle');
    click('#btnPrev');
    await sleep(250);
  } else if (${JSON.stringify(scenario)} === 'stop') {
    app.seek(0);
    await sleep(150);
    click('#btnPlay');
    for (let i = 0; i < 300 && app.position < 1.5; i++) await sleep(25);
    out.before = snap('mid-playback');
    click('#btnStop');
    await sleep(300);
  } else if (${JSON.stringify(scenario)} === 'stop-middle') {
    app.seek(dur * 0.5);
    await sleep(150);
    click('#btnPlay');
    for (let i = 0; i < 300 && app.position < dur * 0.5 + 1.2; i++) await sleep(25);
    out.before = snap('mid-playback from the middle');
    click('#btnStop');
    await sleep(300);
  } else if (${JSON.stringify(scenario)} === 'stop-ended') {
    app.seek(Math.max(0, dur - 2.5));
    await sleep(150);
    await runToEnd();
    out.before = snap('after the piece finished');
    click('#btnStop');
    await sleep(300);
  } else if (${JSON.stringify(scenario)} === 'play-end') {
    app.seek(dur);
    await sleep(200);
    sounded.length = 0;
    click('#btnPlay');
    await sleep(900);
  }

  out.after = snap('after');
  out.firstNoteSounded = sounded.length ? sounded[0] : null;
  out.notesSounded = sounded.slice(0, 5);
  window.__transport = out;
  window.__transportDone = true;
  return true;
`;

const startFile = path.join(os.tmpdir(), `transport-${scenario}.js`);
fs.writeFileSync(startFile, `(async () => {${body}})()`, 'utf8');

const args = [
  path.join(root, 'tools', 'cdp.mjs'),
  '--url', pathToFileURL(path.join(root, 'index.html')).href + '?demo',
  '--startFile', startFile,
  '--wait', 'window.__transportDone === true',
  '--timeout', '180000',
  '--eval', 'window.__transport',
  '--width', '1500', '--height', '950',
];
if (shot) args.push('--shot', shot);

const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
process.stdout.write(r.stdout || '');
process.stderr.write(r.stderr || '');
process.exit(r.status ?? 0);