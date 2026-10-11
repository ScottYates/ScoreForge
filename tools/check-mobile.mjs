/**
 * tools/check-mobile.mjs - does the whole app function on a phone?
 *
 * Below 940px the sidebars used to be `display: none`, which amputated the
 * app on a phone: no library, no parts and instruments, no key and tempo, no
 * Settings panel. They are slide-in drawers now, opened from two buttons in
 * the top bar. This drives the BUILT page at a phone viewport (390x844) and
 * at a desktop one (1280x800) and requires:
 *
 *   phone  - nothing overflows horizontally; the drawer buttons are visible
 *            and touch-sized; opening the inspector puts the part-instrument
 *            picker and the key/tempo controls inside the viewport; the
 *            scrim closes it; the library drawer opens the same way; the
 *            transport's play button is touch-sized; selects are 16px so iOS
 *            does not zoom the page on focus.
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

function run(width, height) {
  const r = spawnSync(process.execPath, [path.join(root, 'tools/cdp.mjs'),
    '--url', page, '--width', String(width), '--height', String(height),
    '--wait', 'window.ScoreForge && !!window.ScoreForge.score',
    '--timeout', '120000', '--eval', PROBE,
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

const desk = run(1280, 800);
ok('desktop: the drawer buttons do not exist', desk.toggleDisplay === 'none', desk.toggleDisplay);
ok('desktop: both sidebars sit in the layout as always',
  desk.railInLayout === true && desk.inspInLayout === true, JSON.stringify(desk));

console.log(`\n${failed ? 'mobile FAILED' : 'mobile OK'}`);
process.exit(failed ? 1 : 0);
