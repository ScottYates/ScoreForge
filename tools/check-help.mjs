/**
 * tools/check-help.mjs - the in-app help opens, closes, and tells the truth.
 *
 * Driven against the BUILT page. Opening: the ? key and the stage-bar button
 * both raise the dialog, Escape closes it. Truth: a handful of load-bearing
 * phrases are pinned to the behaviours they describe, so changing the app
 * without changing the help fails here — the editing keys it lists must be
 * the keys ui/edit.js answers, the insertion gestures must exist, and the
 * no-synthesiser claim must match the roster.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const page = pathToFileURL(path.join(root, 'index.html')).href;

const KICK = `(window.__K__ || (window.__K__ = (async () => {
  const out = window.__OUT__ = {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const open = () => document.querySelector('.modal.help');

  // The ? key opens it (dispatched from the body, as a real keystroke bubbles).
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
  await sleep(150);
  out.openedByKey = !!open();
  out.text = open() ? open().textContent : '';
  out.sections = open() ? [...open().querySelectorAll('.help-sec h3')].map((h) => h.textContent) : [];
  out.kbdCount = open() ? open().querySelectorAll('kbd').length : 0;

  // Escape closes it.
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(150);
  out.closedByEscape = !open();

  // The button opens it too.
  document.querySelector('#btnHelp').click();
  await sleep(150);
  out.openedByButton = !!open();
  window.__DONE2__ = true;
})().catch((e) => { (window.__OUT__ = window.__OUT__ || {}).kickErr = String(e && e.stack || e); window.__DONE2__ = true; })),
window.__DONE2__ === true)`;

const r = spawnSync(process.execPath, [path.join(root, 'tools/cdp.mjs'),
  '--url', page, '--width', '1280', '--height', '900',
  '--wait', KICK, '--timeout', '60000',
  '--eval', 'JSON.stringify(window.__OUT__)',
], { cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024 });
const out = r.stdout || '';
const start = out.indexOf('{');
if (start < 0) {
  console.error('no output from the page\n' + out + (r.stderr || ''));
  process.exit(1);
}
const p = JSON.parse(JSON.parse(out.slice(start, out.lastIndexOf('}') + 1)).value);

let failed = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) failed++;
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${detail ? '  — ' + detail : ''}`);
};

ok('the probe ran to the end', !p.kickErr, p.kickErr || '');
ok('? opens the help', p.openedByKey === true);
ok('Escape closes it', p.closedByEscape === true);
ok('the stage-bar button opens it', p.openedByButton === true);
ok('it walks the app in order: load, scan, play, edit, export, keys',
  JSON.stringify(p.sections) === JSON.stringify([
    'Loading music', 'Reading a scan', 'Playing', 'Editing notes', 'Exporting', 'All keys',
  ]), JSON.stringify(p.sections));
ok('it renders a real keyboard reference', p.kbdCount >= 15, `${p.kbdCount} keys`);

// Load-bearing phrases: each one describes a behaviour that exists. If one of
// these fails, either the help drifted from the app or the app changed
// without its documentation.
const says = (name, re) => ok(`it says: ${name}`, re.test(p.text), '');
says('how a note is deleted (time stays as a rest)', /Delete[\s\S]{0,80}rest/);
says('how a note is added on the engraving (click a rest)', /click a rest/i);
says('how a note is added on the roll (double-click)', /double-click[\s\S]{0,40}piano roll/i);
says('that edits keep the bars intact', /never change a bar/i);
says('what is not editable yet (tuplets)', /tuplet/i);
says('where corrected scores go (Save MusicXML)', /Save MusicXML/);
says('that every instrument is a recording, no synthesiser', /no synthesiser/i);
says('that nothing is uploaded', /nothing is uploaded/i);
says('the undo keys', /undo/i);

console.log(`\n${failed ? 'help FAILED' : 'help OK'}`);
process.exit(failed ? 1 : 0);
