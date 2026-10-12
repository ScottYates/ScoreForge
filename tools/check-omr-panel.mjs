/**
 * tools/check-omr-panel.mjs - does the Transcription panel surface the repairs?
 *
 * The recogniser's output is corrected after reading (consensus across the
 * page's other renderings, triplet restoration, a tempo read off the page's
 * text, bars held to the printed meter), and describeRepairs() turns each
 * pass's report into lines. This drives the BUILT page and requires that the
 * panel actually renders them: a transcription with repairs shows a "Cleaned
 * up after reading" section, one line per repair, with the policy repairs --
 * the clipped and padded bars somebody should proof against the scan --
 * flagged and carrying their bar numbers; a clean read shows no section at
 * all. The wording itself is covered in tests/omr-test.html; this check is
 * the wiring from stats to pixels, which no module test can see.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const page = pathToFileURL(path.join(root, 'index.html')).href + '?demo';

const PROBE = `(function () {
  const out = {};
  const app = window.ScoreForge;

  const report = (stats) => ({
    name: 'sonata.png', engine: 'homr', version: '0.7.0', device: 'cpu', seconds: 2.5,
    pages: [{ page: 0, variant: 'clean', seconds: 2.5, stats, musicxml: '<score-partwise/>' }],
  });
  // The panel describes the page on screen, so the active score must claim it.
  app.score.omr = { page: 0, variant: 'clean', seconds: 2.5, preview: null, variantsTried: [] };

  app.omrReport = report({
    notes: 120, measures: 12, time_signature: '12/8',
    consensus: { barsSwapped: [{ number: '2', from: 'contrast' }], candidates: 2 },
    tripletRepair: { measuresSeen: 12, measuresOverfull: 4, measuresRepaired: 3,
                     notesConverted: 36, measuresUnrepairable: ['9'] },
    tempoText: { bpm: 54, source: 'tempo term', matched: 'adagio sostenuto' },
    meterRepair: { barsClipped: [{ number: '9', dropped: 2, trimmed: 0 }],
                   barsPadded: [{ number: '4', padded: 24 }],
                   notesDropped: 2, notesTrimmed: 0, restsAdded: 1 },
  });
  app._renderOmrSection();

  const sec = document.getElementById('omrSec');
  out.sectionShown = !sec.hidden;
  const fixes = [...document.querySelectorAll('#omrCard .omr-fix')];
  out.lines = fixes.map((f) => ({ text: f.textContent, warn: f.classList.contains('warn') }));
  const cap = [...document.querySelectorAll('#omrCard .omr-try-cap')]
    .map((c) => c.textContent).find((t) => /cleaned/i.test(t));
  out.caption = cap || null;
  const warnColor = fixes.length
    ? getComputedStyle(fixes.find((f) => f.classList.contains('warn')) || fixes[0]).color : null;
  const plainColor = fixes.length ? getComputedStyle(fixes[0]).color : null;
  out.warnLooksDifferent = warnColor !== plainColor;

  // A clean read: every pass reports nothing, so the panel says nothing.
  app.omrReport = report({
    notes: 120, measures: 12,
    consensus: { barsSwapped: [], candidates: 2 },
    tripletRepair: { measuresSeen: 12, measuresOverfull: 0, measuresRepaired: 0,
                     notesConverted: 0, measuresUnrepairable: [] },
    tempoText: null,
    meterRepair: { barsClipped: [], barsPadded: [], notesDropped: 0, notesTrimmed: 0, restsAdded: 0 },
  });
  app._renderOmrSection();
  out.cleanLines = document.querySelectorAll('#omrCard .omr-fix').length;
  out.cleanCaption = [...document.querySelectorAll('#omrCard .omr-try-cap')]
    .some((c) => /cleaned/i.test(c.textContent));

  // Save MusicXML is the panel's one real action, and it must LOOK like one:
  // the primary (accent) style, the full width of the panel, touch-sized.
  const save = document.querySelector('#omrCard .omr-save button');
  if (save) {
    const r = save.getBoundingClientRect();
    const cardR = document.getElementById('omrCard').getBoundingClientRect();
    out.save = {
      primary: save.classList.contains('primary'),
      width: Math.round(r.width), cardWidth: Math.round(cardR.width),
      height: Math.round(r.height),
      label: save.textContent.trim(),
    };
  } else {
    out.save = null;
  }

  return JSON.stringify(out);
})()`;

/* --- a scan the recogniser could not read, end to end -------------------
   The whole failing path through the BUILT page: a fake backend accepts the
   job and reports it failed, the file intake attaches the scan to the error,
   and the panel must hold the page and the engine's words -- not just a
   toast that evaporates. The flow is async, and --eval cannot await, so the
   kick-off lives inside the --wait predicate (which runs in the main world)
   and the probe reads the flag it leaves behind. */
const FAIL_MSG = 'no music could be read from this page (original: No staffs found; '
  + 'deskewed: No staffs found). Try a sharper, straighter, more evenly lit '
  + 'photo where the staves fill the frame.';
const FAIL_KICK = `(window.__FAILKICK__ || (window.__FAILKICK__ = (async () => {
  const app = window.ScoreForge;
  const J = (obj, status) => new Response(JSON.stringify(obj),
    { status: status || 200, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/health')) return J({ ok: true, engine: 'homr', version: '0.7.0', device: 'cpu' });
    if (/\\/api\\/omr\\/jobs\\/j1$/.test(u)) return J({ jobId: 'j1', state: 'failed', error: ${JSON.stringify(FAIL_MSG)} });
    if (u.includes('/api/omr/jobs')) return J({ jobId: 'j1', state: 'running', view: { state: 'running', progress: 0, message: 'Starting', seconds: 0 } });
    return J({ detail: 'not here' }, 404);
  };
  await app._probeBackend();
  const file = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'vocal-book.jpg', { type: 'image/jpeg' });
  await app.addFiles([file]);
  window.__FAILDONE__ = true;
})().catch((e) => { window.__FAILERR__ = String(e); window.__FAILDONE__ = true; })),
window.__FAILDONE__ === true)`;

const FAIL_PROBE = `(function () {
  const out = { err: window.__FAILERR__ || null };
  const sec = document.getElementById('omrSec');
  out.sectionShown = !sec.hidden;
  const head = document.querySelector('#omrCard .omr-failed-head');
  const why = document.querySelector('#omrCard .omr-failed-why');
  out.head = head ? head.textContent : null;
  out.why = why ? why.textContent : null;
  out.scanShown = !!document.querySelector('#omrCard img.omr-img');
  const note = document.querySelector('#omrCard .omr-note');
  out.advice = note ? note.textContent : null;
  out.report = window.ScoreForge.omrReport && window.ScoreForge.omrReport.failed === true;
  return JSON.stringify(out);
})()`;

function run(wait, probe) {
  const r = spawnSync(process.execPath, [path.join(root, 'tools/cdp.mjs'),
    '--url', page, '--width', '1280', '--height', '800',
    '--wait', wait,
    '--timeout', '120000', '--eval', probe,
  ], { cwd: root, encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
  const out = r.stdout || '';
  const env = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
  return JSON.parse(env.value);
}

const p = run('window.ScoreForge && !!window.ScoreForge.score', PROBE);

let failed = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) failed++;
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${detail ? '  — ' + detail : ''}`);
};

ok('a repaired page shows the "Cleaned up after reading" section',
  p.sectionShown === true && p.caption !== null, JSON.stringify(p.caption));
ok('every repair gets its line: consensus, triplets, tempo, clip, pad',
  Array.isArray(p.lines) && p.lines.length === 5, JSON.stringify(p.lines && p.lines.length));
ok('the consensus line names the bar and the reading',
  !!p.lines.find((l) => l.text.includes('Bar 2') && l.text.includes('contrast')),
  JSON.stringify(p.lines.map((l) => l.text.slice(0, 40))));
ok('the tempo line carries the words it was read from',
  !!p.lines.find((l) => l.text.includes('adagio sostenuto')));
ok('the refused bar is flagged, with its number, to check against the scan',
  !!p.lines.find((l) => l.warn && l.text.includes('Bar 9') && l.text.includes('check against the scan')),
  JSON.stringify(p.lines.filter((l) => l.warn).map((l) => l.text)));
ok('the padded bar is flagged too', !!p.lines.find((l) => l.warn && l.text.includes('Bar 4')));
ok('the reading-quality lines are not flagged',
  p.lines.filter((l) => !l.warn).length === 3, JSON.stringify(p.lines.map((l) => l.warn)));
ok('a flagged line looks different from a plain one', p.warnLooksDifferent === true);
ok('a clean read shows no repair section at all',
  p.cleanLines === 0 && p.cleanCaption === false,
  JSON.stringify({ lines: p.cleanLines, caption: p.cleanCaption }));

ok('Save MusicXML is the panel\'s loud, primary action',
  p.save && p.save.primary === true && p.save.height >= 36
    && p.save.width >= p.save.cardWidth * 0.9 && p.save.label === 'Save MusicXML',
  JSON.stringify(p.save));

const f = run(FAIL_KICK, FAIL_PROBE);
ok('a failed scan reaches the panel, not just a toast',
  f.err === null && f.report === true && f.sectionShown === true,
  JSON.stringify({ err: f.err, report: f.report, shown: f.sectionShown }));
ok('it names the file', f.head === 'Could not read vocal-book.jpg', JSON.stringify(f.head));
ok('and carries the engine\'s own words, per rendering',
  !!f.why && f.why.includes('original: No staffs found') && f.why.includes('deskewed:'),
  JSON.stringify(f.why));
ok('the scan itself stays on screen beside the failure', f.scanShown === true);
ok('with advice the next photo can act on',
  !!f.advice && /sharp, straight-on/.test(f.advice), JSON.stringify(f.advice));

console.log(`\n${failed ? 'omr panel FAILED' : 'omr panel OK'}`);
process.exit(failed ? 1 : 0);
