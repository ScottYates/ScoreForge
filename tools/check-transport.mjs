/**
 * tools/check-transport.mjs — the transport buttons, pressed for real.
 *
 * The module suites stub the audio engine, so they cannot see where the
 * notation cursor ends up when someone presses Stop, or whether a finished
 * piece rewinds. Those are exactly the things that were wrong: the piece parked
 * at the last bar when it ended, and Stop left position 0 with a cursor sitting
 * on the first note, a state nothing else in the app produces.
 *
 * So this presses the actual buttons in a real browser and reads back what the
 * UI shows -- the time readout, the scrub bar's width, the play icon, and the
 * cursor's real place on the page. The engine's internal offset is recorded but
 * is not the claim: it can read correct while every visible thing is wrong.
 *
 *   node tools/check-transport.mjs
 *
 * Exits non-zero on the first failure.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = process.cwd();

const start = `(async () => {
  const app = window.ScoreForge;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { checks: [], scenarios: {} };

  const sounded = [];
  let ended = 0;
  app.ensureAudio();
  app._engine.on((ev) => {
    if (ev.type === 'note' && ev.on) sounded.push(+ev.note.time.toFixed(3));
    if (ev.type === 'ended') ended++;
  });

  // Everything a person can see, in one snapshot. The engine offset is here
  // only so a failure can say whether the engine and the display disagreed.
  const snap = () => {
    const cur = app.notation.osmd && app.notation.osmd.cursor;
    const el = cur && cur.cursorElement;
    const box = el ? el.getBoundingClientRect() : null;
    const cs = el ? getComputedStyle(el) : null;
    const pos = app.position;
    const q = app.resolved ? app.resolved.timing.quarterAtSeconds(pos) : null;
    return {
      position: +pos.toFixed(3),
      duration: +app.duration().toFixed(3),
      timeReadout: document.querySelector('#tNow').textContent,
      scrubFill: document.querySelector('#scrubFill').style.width,
      playIcon: document.querySelector('#btnPlay use').getAttribute('href'),
      playing: !!app.playing,
      engineOffset: app._engine ? +app._engine._offset.toFixed(3) : null,
      cursorVisible: !!cs && cs.display !== 'none' && cs.visibility === 'visible',
      cursorStep: app.notation.stepIndex,
      cursorX: box ? Math.round(box.x) : null,
      expectedStep: app.notation.steps && q != null ? app.notation._stepIndexFor(q) : null,
    };
  };
  const click = (sel) => document.querySelector(sel).click();

  const t = (name, ok, detail) => out.checks.push({ name, ok: !!ok, detail: String(detail ?? '') });

  // The one rule, stated once and applied to every state this reaches:
  // sitting at the start with nothing playing looks like a fresh load, which
  // has no cursor. Before this, position 0 showed a cursor after a Stop but not
  // before you had played anything, so the same position looked different
  // depending on how you arrived at it.
  const assertIdle = (label, s) => {
    if (s.position > 1e-3) {
      t(label + ': cursor sits on the note for this position',
        s.cursorVisible && s.cursorStep === s.expectedStep,
        \`visible=\${s.cursorVisible} step=\${s.cursorStep} expected=\${s.expectedStep}\`);
    } else {
      t(label + ': at the start shows no cursor, like a fresh load', !s.cursorVisible,
        \`visible=\${s.cursorVisible} step=\${s.cursorStep}\`);
      t(label + ': at the start reads 0:00', s.timeReadout === '0:00', s.timeReadout);
      t(label + ': at the start empties the scrub bar', s.scrubFill === '0%', s.scrubFill);
    }
    t(label + ': the play button offers to play, not pause', s.playIcon === '#i-play', s.playIcon);
    t(label + ': the app agrees the piece is not playing', !s.playing, \`playing=\${s.playing}\`);
    t(label + ': the engine and the display agree on the position', s.engineOffset === s.position,
      \`engine=\${s.engineOffset} ui=\${s.position}\`);
  };

  // A scenario that leaves the piece playing must not be held to the idle rules:
  // a pause icon and a moving playhead are correct there. The engine's offset is
  // the point it started from, so it trails the displayed position rather than
  // equalling it.
  const assertPlaying = (label, s) => {
    t(label + ': the play button offers to pause', s.playIcon === '#i-pause', s.playIcon);
    t(label + ': the app agrees the piece is playing', s.playing, \`playing=\${s.playing}\`);
    t(label + ': the cursor is on the note for this position',
      s.cursorVisible && s.cursorStep === s.expectedStep,
      \`visible=\${s.cursorVisible} step=\${s.cursorStep} expected=\${s.expectedStep}\`);
    t(label + ': the engine started at or before the displayed position',
      s.engineOffset <= s.position + 0.01, \`engine=\${s.engineOffset} ui=\${s.position}\`);
  };

  // \`setup\` runs after the reset and *before* the "before" snapshot, so "before"
  // means "just before the button was pressed" -- the state that button is being
  // asked to move away from. Without it the comparison is against whatever the
  // app happened to be showing beforehand, and "it moved" becomes unverifiable.
  const run = async (name, setup, body, expect = 'idle') => {
    app.stop();
    await sleep(120);
    if (setup) await setup();
    const before = snap();
    sounded.length = 0;
    const endedBefore = ended;
    await body();
    await sleep(250);
    const after = snap();
    out.scenarios[name] = { before, after, firstNote: sounded[0] ?? null, ended: ended - endedBefore };
    if (expect === 'playing') assertPlaying(name, after);
    else assertIdle(name, after);
    return { before, after };
  };

  const dur = app.duration();
  // Press Play, then wait for the stopWhen condition -- the one that ends the
  // wait. Getting this backwards is silent: the loop body never runs, the
  // snapshot is taken before the engine's first time tick, and the cursor has
  // not been shown yet. That reads as "Stop did not move the cursor" when
  // nothing was ever checked.
  const playUntil = async (stopWhen) => {
    click('#btnPlay');
    for (let i = 0; i < 600 && !stopWhen(); i++) await sleep(40);
  };

  out.checks.push({ name: 'the demo loaded a piece to transport', ok: dur > 1, detail: \`duration=\${dur}\` });

  // --- fresh ---------------------------------------------------------------
  {
    app.stop();
    await sleep(200);
    assertIdle('fresh load', snap());
  }

  // --- finishing the piece --------------------------------------------------
  await run('finished', async () => { app.seek(Math.max(0, dur - 2.5)); await sleep(200); },
    async () => { await playUntil(() => !app.playing); });
  t('finished: the engine really did reach the end',
    out.scenarios.finished.ended === 1, \`ended fired \${out.scenarios.finished.ended}x\`);
  t('finished: the piece rewound rather than parking at the last bar',
    out.scenarios.finished.after.position < 1,
    \`position=\${out.scenarios.finished.after.position} of \${dur}\`);

  // --- Back to start, from the middle ---------------------------------------
  {
    const { before, after } = await run('back to start',
      async () => { app.seek(dur * 0.4); await sleep(200); },
      async () => { click('#btnPrev'); });
    t('back to start: it actually moved from where it was',
      before.cursorStep > 0 && before.position > 1 && after.position === 0,
      \`from step \${before.cursorStep} at \${before.position}s to \${after.position}\`);
  }

  // --- Stop, from the start and from the middle ------------------------------
  {
    const { before, after } = await run('stop from the start',
      async () => {
        app.seek(0);
        await sleep(150);
        await playUntil(() => app.position > 1.5 || !app.playing);
      },
      async () => { click('#btnStop'); });
    t('stop from the start: the cursor was on a note and then was cleared',
      before.cursorVisible && !after.cursorVisible,
      \`visible \${before.cursorVisible} -> \${after.cursorVisible}\`);
  }
  {
    const { before, after } = await run('stop from the middle',
      async () => {
        app.seek(dur * 0.5);
        await sleep(150);
        await playUntil(() => app.position > dur * 0.5 + 1.2 || !app.playing);
      },
      async () => { click('#btnStop'); });
    t('stop from the middle: the cursor was on a note and then was cleared',
      before.cursorVisible && !after.cursorVisible,
      \`visible \${before.cursorVisible} -> \${after.cursorVisible}\`);
  }

  // --- Stop, after the piece has already finished ----------------------------
  await run('stop after finishing',
    async () => {
      app.seek(Math.max(0, dur - 2.5));
      await sleep(150);
      await playUntil(() => !app.playing);
    },
    async () => { click('#btnStop'); });

  // --- Play from each starting place -----------------------------------------
  await run('play from the start',
    async () => { app.seek(0); await sleep(150); },
    async () => { click('#btnPlay'); await sleep(900); }, 'playing');
  t('play from the start: the first note sounded is the first note',
    out.scenarios['play from the start'].firstNote === 0,
    \`first note at \${out.scenarios['play from the start'].firstNote}\`);

  await run('play from the middle',
    async () => { app.seek(dur * 0.5); await sleep(200); },
    async () => { click('#btnPlay'); await sleep(900); }, 'playing');
  {
    const s = out.scenarios['play from the middle'];
    t('play from the middle: playback did not jump to the start',
      s.firstNote !== null && s.firstNote >= dur * 0.5 - 1.5,
      \`first note at \${s.firstNote}, asked to start at \${(dur * 0.5).toFixed(2)}\`);
  }

  // Parked at the end is the state a scrub to the far right leaves you in.
  await run('play from the end',
    async () => { app.seek(dur); await sleep(200); },
    async () => { click('#btnPlay'); await sleep(900); }, 'playing');
  {
    const s = out.scenarios['play from the end'];
    t('play from the end: starts again from the top, not the last note',
      s.firstNote === 0, \`first note at \${s.firstNote}\`);
  }

  app.stop();
  window.__transport = out;
  window.__transportDone = true;
  return true;
})()`;

const startFile = path.join(os.tmpdir(), 'check-transport.js');
fs.writeFileSync(startFile, start, 'utf8');

const r = spawnSync(process.execPath, [
  path.join(root, 'tools', 'cdp.mjs'),
  '--url', pathToFileURL(path.join(root, 'index.html')).href + '?demo',
  '--startFile', startFile,
  '--wait', 'window.__transportDone === true',
  '--timeout', '240000',
  '--eval', 'window.__transport',
], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function envelope(text) {
  try { return JSON.parse(text); } catch { /* fall through */ }
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; }
}

const env = envelope(r.stdout || '');
if (!env) {
  console.error('check-transport: the harness produced no result; run tools/cdp.mjs by hand');
  process.stderr.write(r.stderr || '');
  process.exit(1);
}
const res = env.value && typeof env.value === 'string' ? JSON.parse(env.value) : env.value;
const checks = (res && res.checks) || [];
if (!checks.length) {
  console.error('check-transport: no assertions ran');
  console.error(JSON.stringify(res, null, 2));
  process.exit(1);
}

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed++;
  console.log(`${c.ok ? '  ok  ' : ' FAIL '} ${c.name}${c.detail ? '  — ' + c.detail : ''}`);
}
console.log(`\n${checks.length - failed} passed · ${failed} failed`);
process.exit(failed ? 1 : 0);