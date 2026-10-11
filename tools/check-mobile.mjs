/**
 * tools/check-mobile.mjs - does the whole app function on a phone?
 *
 * Below 940px the sidebars used to be `display: none`, which amputated the
 * app on a phone: no library, no parts and instruments, no key and tempo, no
 * Settings panel. They are slide-in drawers now, opened from two buttons in
 * the top bar. This drives the BUILT page at a phone viewport (390x844), a
 * small phone (320x568) and a desktop one (1280x800) and requires:
 *
 *   phone  - nothing overflows horizontally; the drawer buttons are visible
 *            and touch-sized; opening the inspector puts the part-instrument
 *            picker and the key/tempo controls inside the viewport; the
 *            scrim closes it; the library drawer opens the same way; the
 *            transport's play button is touch-sized; selects are 16px so iOS
 *            does not zoom the page on focus.
 *   roll   - the piano roll answers fingers, not just the wheel: a quick tap
 *            seeks, a one-finger drag pans time and pitch without seeking, a
 *            two-finger pinch zooms, and `touch-action: none` keeps the
 *            browser from claiming those touches for page scroll.
 *   export - the export dialog fits the phone: the modal inside the viewport
 *            with a gutter, the close button and every footer button on
 *            screen and touch-sized (the desktop footer is one row, which
 *            ran 130px past a 390px screen). Toasts sit under the top bar,
 *            clear of the wrapped transport they used to cover.
 *   320px  - on the smallest phones nothing scrolls sideways and the play
 *            button and the top bar's controls stay reachable.
 *   desktop- the drawer buttons do not exist (display none) and both
 *            sidebars sit in the layout as always, no drawer classes needed.
 *
 * Interactions run synchronously inside one evaluation with transitions
 * disabled, so geometry is the settled truth rather than a frame of a slide.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const page = pathToFileURL(path.join(root, 'index.html')).href + '?demo';

const PROBE = `(function () {
  const out = {};
  const $ = (s) => document.querySelector(s);
  const rect = (el) => el ? el.getBoundingClientRect().toJSON() : null;
  const inView = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.left >= -1 && r.right <= innerWidth + 1
      && r.top >= -1 && r.bottom <= innerHeight + 1;
  };

  out.width = innerWidth;
  out.noOverflow = document.documentElement.scrollWidth <= innerWidth;

  const railBtn = $('#btnRailToggle');
  const inspBtn = $('#btnInspToggle');
  const rail = $('.rail');
  const insp = $('.insp');
  const scrim = $('#drawerScrim');
  out.toggleDisplay = getComputedStyle(railBtn).display;

  if (innerWidth <= 940) {
    rail.style.transition = 'none';
    insp.style.transition = 'none';

    out.toggleRect = rect(inspBtn);
    inspBtn.click();
    out.inspOpen = insp.classList.contains('open');
    out.scrimShown = !scrim.hidden;
    out.partSelectInView = inView($('#partList select'));
    out.keyInView = inView($('#selKey'));
    out.selectFontPx = parseFloat(getComputedStyle($('#selKey')).fontSize);

    scrim.click();
    out.closedByScrim = !insp.classList.contains('open') && scrim.hidden;

    railBtn.click();
    out.railOpen = rail.classList.contains('open');
    out.libraryInView = inView($('.rail .sec'));
    scrim.click();

    out.playRect = rect($('#btnPlay'));
    out.tabRect = rect(document.querySelector('.tab'));
  } else {
    out.railInLayout = inView(rail) || rect(rail).width > 0;
    out.inspInLayout = rect(insp).width > 0 && rect(insp).right <= innerWidth + 1;
  }
  return JSON.stringify(out);
})()`;

/* --- the piano roll under fingers (390x844) ---------------------------
   Synthetic PointerEvents, since headless has no touchscreen: a drag must
   pan (viewStart for time, scrollY for pitch) and must NOT seek; a quick
   sub-slop tap must seek to the time under the finger, as the old
   pointerdown handler did; a two-finger pinch must change pixelsPerSecond
   and also not seek. */
const GESTURES = `(function () {
  const out = {};
  const app = window.ScoreForge;
  document.querySelector('.tab[data-view="roll"]').click();
  const cv = document.getElementById('rollCanvas');
  const roll = app.roll;
  const r = cv.getBoundingClientRect();
  out.touchAction = getComputedStyle(cv).touchAction;
  const pe = (type, id, x, y) => cv.dispatchEvent(new PointerEvent(type, {
    pointerId: id, pointerType: 'touch', isPrimary: id === 1,
    clientX: r.left + x, clientY: r.top + y, buttons: 1, bubbles: true,
  }));

  // Start the view away from 0 so a rightward pan has somewhere to go.
  roll.viewStart = 5; roll.draw();

  const vs0 = roll.viewStart, sy0 = roll.scrollY, pos0 = app.position;
  pe('pointerdown', 1, 200, 200);
  pe('pointermove', 1, 150, 230);
  pe('pointermove', 1, 120, 260);
  pe('pointerup',   1, 120, 260);
  out.dragViewDelta = roll.viewStart - vs0;     // finger left = view later
  out.dragScrollDelta = roll.scrollY - sy0;     // finger down = view lower
  out.dragSeeked = app.position !== pos0;

  pe('pointerdown', 2, 250, 150);
  pe('pointerup',   2, 252, 151);               // 2.2px, well under the slop
  out.tapTime = app.position;
  out.tapExpected = roll.timeForX(252);

  const pps0 = roll.pixelsPerSecond;
  pe('pointerdown', 3, 150, 200);
  pe('pointerdown', 4, 250, 200);
  pe('pointermove', 3, 100, 200);
  pe('pointermove', 4, 300, 200);               // 100px apart -> 200px apart
  pe('pointerup',   3, 100, 200);
  pe('pointerup',   4, 300, 200);
  out.pinchPpsRatio = roll.pixelsPerSecond / pps0;
  out.pinchSeeked = app.position !== out.tapTime;
  return JSON.stringify(out);
})()`;

/* --- the export dialog and the toasts (phone sizes) -------------------
   openExport() on the demo score shows the dialog without rendering (the
   render is minutes of real synthesis; geometry does not need it). */
const EXPORT_TOASTS = `(function () {
  const out = {};
  const style = document.createElement('style');
  style.textContent = '* { transition: none !important; animation: none !important; }';
  document.head.appendChild(style);
  const within = (r) => r.left >= -1 && r.right <= innerWidth + 1
    && r.top >= -1 && r.bottom <= innerHeight + 1;

  window.ScoreForge.openExport();
  const modal = document.querySelector('.modal');
  out.modalShown = !!modal;
  if (modal) {
    const mr = modal.getBoundingClientRect();
    out.modalWithin = within(mr);
    out.modalGutter = Math.min(mr.left, innerWidth - mr.right);
    const close = modal.querySelector('.modal-head .btn');
    const cr = close.getBoundingClientRect();
    out.closeOk = within(cr) && cr.height >= 42 && cr.width >= 42;
    out.footBtns = [...modal.querySelectorAll('.modal-foot .btn')].map((b) => {
      const r = b.getBoundingClientRect();
      return { ok: within(r) && r.height >= 42, h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) };
    });
  }
  document.querySelector('.scrim')?.remove();

  // A toast the shape the app makes (dom.js builds the same classes), long
  // enough to wrap: it must stay on screen and off the transport's controls.
  const t = document.createElement('div');
  t.className = 'toast err';
  t.innerHTML = '<div class="tx"><div class="tt">Render failed</div>'
    + '<div class="ts">A long explanatory line of the kind the renderer writes when an export dies, to make the toast wrap on a phone.</div></div>';
  document.getElementById('toasts').appendChild(t);
  const tr = t.getBoundingClientRect();
  const tp = document.querySelector('.transport').getBoundingClientRect();
  out.toastWithin = within(tr);
  out.toastClearOfTransport = tr.bottom <= tp.top || tr.top >= tp.bottom;
  t.remove();
  return JSON.stringify(out);
})()`;

/* --- the smallest phones (320x568) -------------------------------------
   Nothing scrolls sideways, and the controls that matter are reachable:
   play in the transport, and the last top bar button (Export) on screen. */
const NARROW = `(function () {
  const out = {};
  const within = (r) => r.left >= -1 && r.right <= innerWidth + 1
    && r.top >= -1 && r.bottom <= innerHeight + 1;
  out.noOverflow = document.documentElement.scrollWidth <= innerWidth;
  out.scrollWidth = document.documentElement.scrollWidth;
  const play = document.querySelector('#btnPlay').getBoundingClientRect();
  out.playOk = within(play) && play.height >= 42 && play.width >= 42;
  out.topActions = [...document.querySelectorAll('.top-actions .btn')].map((b) => {
    const r = b.getBoundingClientRect();
    return { id: b.id, ok: r.width > 0 && within(r) };
  });
  // The wordmark gives way below 560px so the score's own name can show.
  // With the wordmark back, "Ode to Joy" got 18px of the 73px it needs --
  // one character and an ellipsis. The expectation comes from the text
  // itself (scrollWidth), not a guessed pixel count.
  const title = document.querySelector('.doc-title .t');
  out.titleShown = title.scrollWidth - title.getBoundingClientRect().width < 1.5;
  out.titlePx = { has: Math.round(title.getBoundingClientRect().width), needs: title.scrollWidth };
  return JSON.stringify(out);
})()`;

function run(width, height, probe = PROBE) {
  const r = spawnSync(process.execPath, [path.join(root, 'tools/cdp.mjs'),
    '--url', page, '--width', String(width), '--height', String(height),
    '--wait', 'window.ScoreForge && !!window.ScoreForge.score',
    '--timeout', '120000', '--eval', probe,
  ], { cwd: root, encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
  const out = r.stdout || '';
  const env = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
  return JSON.parse(env.value);
}

let failed = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) failed++;
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${detail ? '  — ' + detail : ''}`);
};

const phone = run(390, 844);
ok('phone: nothing scrolls sideways', phone.noOverflow === true, `scrollWidth vs ${phone.width}`);
ok('phone: the drawer buttons exist and are touch-sized',
  phone.toggleDisplay !== 'none' && phone.toggleRect && phone.toggleRect.height >= 40,
  JSON.stringify(phone.toggleRect));
ok('phone: opening the inspector shows the part-instrument picker',
  phone.inspOpen === true && phone.partSelectInView === true, JSON.stringify({ open: phone.inspOpen, sel: phone.partSelectInView }));
ok('phone: and the key control, behind the scrim', phone.keyInView === true && phone.scrimShown === true);
ok('phone: selects are 16px, so iOS does not zoom on focus', phone.selectFontPx >= 16, `${phone.selectFontPx}px`);
ok('phone: the scrim closes the drawer', phone.closedByScrim === true);
ok('phone: the library drawer opens too', phone.railOpen === true && phone.libraryInView === true);
ok('phone: the play button is touch-sized', phone.playRect && phone.playRect.height >= 42 && phone.playRect.width >= 42,
  JSON.stringify(phone.playRect));
ok('phone: the view tabs are touch-sized', phone.tabRect && phone.tabRect.height >= 40, JSON.stringify(phone.tabRect));

const g = run(390, 844, GESTURES);
ok('roll: the canvas owns its touches (touch-action none)', g.touchAction === 'none', g.touchAction);
ok('roll: a one-finger drag pans the time axis', g.dragViewDelta > 1 && g.dragViewDelta < 3,
  `viewStart moved ${g.dragViewDelta?.toFixed(3)}s (80px at 46 px/s should be ~1.74)`);
ok('roll: and the pitch axis', g.dragScrollDelta < -1, `scrollY moved ${g.dragScrollDelta?.toFixed(2)} semitones`);
ok('roll: a drag is not a seek', g.dragSeeked === false);
ok('roll: a quick sub-slop tap still seeks, to the time under the finger',
  g.tapTime > 0 && Math.abs(g.tapTime - g.tapExpected) < 1e-6,
  `seeked to ${g.tapTime} vs ${g.tapExpected}`);
ok('roll: a two-finger pinch zooms', g.pinchPpsRatio > 1.5 && g.pinchPpsRatio < 2.5,
  `pixelsPerSecond x${g.pinchPpsRatio?.toFixed(2)} (fingers spread 100px -> 200px should be ~x2)`);
ok('roll: a pinch is not a seek', g.pinchSeeked === false);

const ex = run(390, 844, EXPORT_TOASTS);
ok('export: the dialog opens inside the viewport, with a gutter',
  ex.modalShown === true && ex.modalWithin === true && ex.modalGutter >= 8, `gutter ${ex.modalGutter}px`);
ok('export: the close button is on screen and touch-sized', ex.closeOk === true);
ok('export: every footer button is on screen and touch-sized',
  Array.isArray(ex.footBtns) && ex.footBtns.length === 3 && ex.footBtns.every((b) => b.ok),
  JSON.stringify(ex.footBtns));
ok('toasts: a toast stays on screen', ex.toastWithin === true);
ok('toasts: and off the transport controls', ex.toastClearOfTransport === true);

const tiny = run(320, 568, NARROW);
ok('320px: nothing scrolls sideways', tiny.noOverflow === true, `scrollWidth ${tiny.scrollWidth}`);
ok('320px: the play button is reachable and touch-sized', tiny.playOk === true);
ok('320px: every top bar control is on screen',
  Array.isArray(tiny.topActions) && tiny.topActions.length === 4 && tiny.topActions.every((b) => b.ok),
  JSON.stringify(tiny.topActions));
ok('320px: the score\'s name shows whole, not an ellipsis', tiny.titleShown === true,
  JSON.stringify(tiny.titlePx));

const desk = run(1280, 800);
ok('desktop: the drawer buttons do not exist', desk.toggleDisplay === 'none', desk.toggleDisplay);
ok('desktop: both sidebars sit in the layout as always',
  desk.railInLayout === true && desk.inspInLayout === true, JSON.stringify(desk));

console.log(`\n${failed ? 'mobile FAILED' : 'mobile OK'}`);
process.exit(failed ? 1 : 0);
