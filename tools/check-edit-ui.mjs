/**
 * tools/check-edit-ui.mjs - can a user actually edit a note in the built page?
 *
 * Driven against the BUILT index.html in headless Chrome, end to end: load a
 * two-bar score, click a notehead on the engraved score (a real click position
 * taken from the drawn SVG), and check the whole loop -- selection appears in
 * both views, arrow keys change the pitch, the duration keys grow a note into
 * the rest after it, delete leaves a rest, undo walks it all back, and the
 * edited MusicXML is what Save would download. Every assertion reads the
 * re-parsed score, not the editor's own state, so a break anywhere in
 * click -> XML -> re-parse -> re-render fails here.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const page = pathToFileURL(path.join(root, 'index.html')).href;

// Two bars in 4/4, divisions 2. Bar 2 ends in rests so a note can grow.
const FIXTURE = '<?xml version="1.0" encoding="UTF-8"?>'
  + '<score-partwise version="4.0">'
  + '<part-list><score-part id="P1"><part-name>Voice</part-name></score-part></part-list>'
  + '<part id="P1"><measure number="1">'
  + '<attributes><divisions>2</divisions><key><fifths>0</fifths></key>'
  + '<time><beats>4</beats><beat-type>4</beat-type></time>'
  + '<clef><sign>G</sign><line>2</line></clef></attributes>'
  + '<note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>half</type></note>'
  + '<note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><type>half</type></note>'
  + '</measure><measure number="2">'
  + '<note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><type>quarter</type></note>'
  + '<note><rest/><duration>2</duration><type>quarter</type></note>'
  + '<note><rest/><duration>4</duration><type>half</type></note>'
  + '</measure></part></score-partwise>';

const KICK = `(window.__K__ || (window.__K__ = (async () => {
  const out = window.__OUT__ = { steps: [] };
  window.__UNCAUGHT__ = [];
  window.addEventListener('error', (e) => window.__UNCAUGHT__.push(String(e.message)));
  const app = window.ScoreForge;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const notesOf = () => app.score.parts[0].notes.map((n) => [n.quarter, n.midi, n.durationQuarters]);
  const waitFor = async (fn, ms = 20000) => {
    const t0 = performance.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (performance.now() - t0 > ms) return null;
      await sleep(120);
    }
  };

  await app.addFiles([new File([${JSON.stringify(FIXTURE)}], 'edit-me.musicxml', { type: 'application/xml' })]);
  const svg = await waitFor(() => document.querySelector('.paper svg'));
  out.rendered = !!svg;
  await sleep(1500); // let the layout settle (CI runners are slow)
  out.saveEnabled = !document.querySelector('#btnSaveXml').disabled;

  // ---- 1. click the first notehead on the engraved score -------------------
  const heads = document.querySelectorAll('.paper svg g.vf-notehead');
  out.noteheads = heads.length;
  let target = null;
  // The first notehead by x is the first note of bar 1 (C5, midi 72).
  for (const h of heads) {
    const r = h.getBoundingClientRect();
    if (!r.width) continue;
    if (!target || r.left < target.left) target = r;
  }
  if (target) {
    const picked = app.editor.pickFromNotation(target.left + target.width / 2, target.top + target.height / 2);
    out.picked = picked;
    out.selAfterClick = app.editor.sel && { ...app.editor.sel };
    out.selMidi = app.editor.selectedNote()?.midi;
    out.barShown = !document.querySelector('#editBar').hidden;
    out.highlighted = !!document.querySelector('.paper g.sf-selected');
  }

  // ---- 2. arrow keys edit the pitch through the XML ------------------------
  const key = (k, shiftKey = false) => app.editor.handleKey({ key: k, shiftKey, metaKey: false, ctrlKey: false, preventDefault() {} });
  key('ArrowUp');
  out.upEdited = !!(await waitFor(() => app.score.parts[0].notes[0].midi === 73));
  out.upXml = /<alter>1<\\/alter>/.test(app.score.rawMusicXml);
  // The engraving must redraw the edited score: asking the drawn page what
  // sits at the same spot must answer the NEW pitch.
  out.redrawn = !!(await waitFor(() => {
    const h2 = [...document.querySelectorAll('.paper svg g.vf-notehead')]
      .map((h) => h.getBoundingClientRect()).filter((r) => r.width)
      .sort((a, b) => a.left - b.left)[0];
    if (!h2) return false;
    const addr = app.notation.noteAtClientPoint(h2.left + h2.width / 2, h2.top + h2.height / 2);
    return addr && addr.midi === 73;
  }));
  key('ArrowDown', true); // an octave down from C#5 -> C#4
  out.octaveEdited = !!(await waitFor(() => app.score.parts[0].notes[0].midi === 61));
  out.stillSelected = app.editor.selectedNote()?.midi === 61;
  out.rollSelected = !!app.roll.selectedId;

  // ---- 3. undo twice returns the original reading --------------------------
  await app.editor.undo();
  await app.editor.undo();
  out.undone = !!(await waitFor(() => app.score.parts[0].notes[0].midi === 72));
  out.undoNotes = notesOf();

  // ---- 4. the roll: hit-test, pick, drag-to-transpose ----------------------
  app.setView('roll');
  await sleep(300);
  const rn = app.resolved.notes.find((n) => n.midi === 67); // G4
  const hit = app.roll.noteAt(app.roll.xForTime(rn.time) + 3, app.roll.yForMidi(rn.midi) + 3);
  out.rollHit = hit && hit.midi === 67;
  app.editor.pickFromRoll(rn);
  out.rollPickSelected = app.roll.selectedId === rn.id && app.editor.selectedNote()?.midi === 67;
  app.editor.dragFromRoll(rn, -2);
  out.dragEdited = !!(await waitFor(() => app.score.parts[0].notes[1].midi === 65));
  // The playback model follows the edit: the resolved notes the engine and
  // roll read must carry the new pitch, not the pre-edit one.
  out.dragResolved = !!(await waitFor(() => app.resolved.notes.some((n) => n.midi === 65)
    && !app.resolved.notes.some((n) => n.midi === 67)));

  // ---- 5. durations: grow into the rest, shrink leaves one ------------------
  const e4 = app.score.parts[0].notes[2]; // E4 quarter at bar 2
  app.editor.select('P1', e4.xmlIndexes[0]);
  key(']'); // quarter -> dotted quarter, eaten from the rest after it
  out.grew = !!(await waitFor(() => Math.abs(app.score.parts[0].notes[2].durationQuarters - 1.5) < 1e-9));
  out.growNotes = notesOf();
  key('['); // back down one ladder step: 1.5 -> 1
  out.shrank = !!(await waitFor(() => Math.abs(app.score.parts[0].notes[2].durationQuarters - 1) < 1e-9));

  // ---- 6. delete leaves the bar intact --------------------------------------
  const before = app.score.totalQuarters;
  const count = app.score.parts[0].notes.length;
  app.editor.select('P1', app.score.parts[0].notes[1].xmlIndexes[0]);
  key('Delete');
  out.deleted = !!(await waitFor(() => app.score.parts[0].notes.length === count - 1));
  out.barsStable = app.score.totalQuarters === before;
  out.selMoved = !!app.editor.sel;

  // ---- 7. escape drops the selection and the bar hides -----------------------
  key('Escape');
  out.cleared = !app.editor.sel && document.querySelector('#editBar').hidden;
  out.uncaught = window.__UNCAUGHT__;
  window.__DONE2__ = true;
})().catch((e) => { (window.__OUT__ = window.__OUT__ || {}).kickErr = String(e && e.stack || e); window.__DONE2__ = true; })),
window.__DONE2__ === true)`;

const r = spawnSync(process.execPath, [path.join(root, 'tools/cdp.mjs'),
  '--url', page, '--width', '1280', '--height', '900',
  '--wait', KICK, '--timeout', '180000',
  '--eval', 'JSON.stringify(window.__OUT__)',
], { cwd: root, encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
const out = r.stdout || '';
const start = out.indexOf('{');
if (start < 0) {
  console.error('no output from the page\n' + out + (r.stderr || ''));
  process.exit(1);
}
const env = JSON.parse(out.slice(start, out.lastIndexOf('}') + 1));
const p = JSON.parse(env.value);

if (process.env.DEBUG) console.log('OUT:', JSON.stringify(p, null, 1));
let sawFail = false;
let failed = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) { failed++; sawFail = true; }
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${detail ? '  — ' + detail : ''}`);
};

ok('the probe ran to the end', !p.kickErr, p.kickErr || '');
ok('the score rendered with noteheads to click', p.rendered && p.noteheads >= 3, JSON.stringify({ noteheads: p.noteheads }));
ok('Save MusicXML is offered for an editable score', p.saveEnabled === true);
ok('clicking a notehead selects that note', p.picked === true && p.selMidi === 72,
  JSON.stringify({ picked: p.picked, sel: p.selAfterClick, midi: p.selMidi }));
ok('the selection shows: edit bar up, notehead painted', p.barShown === true && p.highlighted === true,
  JSON.stringify({ bar: p.barShown, painted: p.highlighted }));
ok('arrow-up moves the pitch a semitone, through the XML', p.upEdited === true && p.upXml === true,
  JSON.stringify({ edited: p.upEdited, xml: p.upXml }));
ok('the engraving redraws the edited score', p.redrawn === true);
ok('shift+arrow moves an octave and keeps the selection', p.octaveEdited === true && p.stillSelected === true);
ok('the roll mirrors the selection', p.rollSelected === true);
ok('undo walks the edits back to the original', p.undone === true, JSON.stringify(p.undoNotes));
ok('the roll hit-test finds the note under the pointer', p.rollHit === true);
ok('a roll tap selects; the editor and roll agree', p.rollPickSelected === true);
ok('a roll drag commits a transposition', p.dragEdited === true);
ok('the playback model follows the edit', p.dragResolved === true);
ok('] grows the note into the rest after it', p.grew === true, JSON.stringify(p.growNotes));
ok('[ shrinks it again', p.shrank === true);
ok('delete removes the note and keeps the bars', p.deleted === true && p.barsStable === true);
ok('the selection moves on after a delete', p.selMoved === true);
ok('escape clears the selection and hides the bar', p.cleared === true);
ok('nothing goes uncaught', Array.isArray(p.uncaught) && p.uncaught.length === 0, JSON.stringify(p.uncaught));

if (sawFail) console.log('STATE: ' + JSON.stringify(p));
console.log(`\n${failed ? 'edit ui FAILED' : 'edit ui OK'}`);
process.exit(failed ? 1 : 0);
