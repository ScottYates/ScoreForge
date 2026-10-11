/**
 * tools/check-notation-load.mjs - does the score view draw what the backend
 * actually sends, and say why when it cannot?
 *
 * The failure it guards (seen on a real vocal-book transcription): every
 * backend post-processing pass re-serialises with ElementTree, which drops
 * the XML declaration, and OSMD's string loader answers "Did not find <?xml
 * at beginning" with a thrown exception. The app's own parser does not care,
 * so the library proudly counted 39 notes above a completely BLANK sheet of
 * paper -- the worst kind of failure, the silent kind, twice over: nothing
 * drawn and nothing said.
 *
 * Driven against the BUILT page:
 *   - a MusicXML file with no declaration must render notation anyway (the
 *     view normalises before handing OSMD the string);
 *   - a document OSMD genuinely cannot draw must put the reason ON the
 *     paper, not throw and leave the sheet blank.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const page = pathToFileURL(path.join(root, 'index.html')).href;

// One bar, two notes, NO <?xml declaration -- the shape every post-processed
// scan arrived in.
const BARE = '<score-partwise version="4.0">'
  + '<part-list><score-part id="P1"><part-name>Voice</part-name></score-part></part-list>'
  + '<part id="P1"><measure number="1">'
  + '<attributes><divisions>1</divisions><key><fifths>0</fifths></key>'
  + '<time><beats>4</beats><beat-type>4</beat-type></time>'
  + '<clef><sign>G</sign><line>2</line></clef></attributes>'
  + '<note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration><type>half</type></note>'
  + '<note><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration><type>half</type></note>'
  + '</measure></part></score-partwise>';

const KICK = `(window.__K__ || (window.__K__ = (async () => {
  const out = window.__OUT__ = {};
  window.__UNCAUGHT__ = [];
  window.addEventListener('error', (e) => window.__UNCAUGHT__.push(String(e.message)));
  const app = window.ScoreForge;

  // 1. A declaration-less MusicXML must still draw.
  await app.addFiles([new File([${JSON.stringify(BARE)}], 'bare.musicxml', { type: 'application/xml' })]);
  // Rendering is asynchronous; poll for the drawing rather than guessing a delay.
  let svg = null, paper = null;
  for (let i = 0; i < 40 && !svg; i++) {
    await new Promise((r) => setTimeout(r, 250));
    paper = document.querySelector('.paper');
    svg = paper && paper.querySelector('svg');
  }
  out.bareSvgNodes = svg ? svg.querySelectorAll('path, rect, text').length : 0;
  out.bareTab = app.view;
  out.bareScore = app.score && app.score.title;
  out.bareDrawn = out.bareSvgNodes >= 10;  // one bar: clef, time, two halves
  out.bareFailShown = !!(paper && paper.querySelector('.paper-fail'));

  // 2. A document OSMD genuinely cannot draw: the reason goes ON the paper.
  let returned = null, threw = null;
  try {
    returned = await app.notation.load({
      rawMusicXml: '<?xml version="1.0"?><not-music-at-all/>',
      title: 'nonsense', measureStarts: [],
    });
  } catch (e) { threw = String(e && e.message || e); }
  const fail = document.querySelector('.paper .paper-fail');
  out.badReturned = returned;
  out.badThrew = threw;
  out.badMessage = fail ? fail.textContent : null;
  out.uncaught = window.__UNCAUGHT__;
  window.__DONE2__ = true;
})().catch((e) => { (window.__OUT__ = window.__OUT__ || {}).kickErr = String(e && e.stack || e); window.__DONE2__ = true; })),
window.__DONE2__ === true)`;

const r = spawnSync(process.execPath, [path.join(root, 'tools/cdp.mjs'),
  '--url', page, '--width', '1280', '--height', '900',
  '--wait', KICK, '--timeout', '120000',
  '--eval', 'JSON.stringify(window.__OUT__)',
], { cwd: root, encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
const out = r.stdout || '';
const env = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
const p = JSON.parse(env.value);

if (process.env.DEBUG) console.log('OUT:', JSON.stringify(p));
let failed = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) failed++;
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${detail ? '  — ' + detail : ''}`);
};

ok('the probe ran to the end', !p.kickErr, p.kickErr || '');
ok('a MusicXML with no <?xml declaration still draws notation',
  p.bareDrawn === true && p.bareFailShown === false,
  JSON.stringify({ nodes: p.bareSvgNodes, fail: p.bareFailShown }));
ok('a document the engine cannot draw says so on the paper',
  p.badReturned === false && typeof p.badMessage === 'string'
    && p.badMessage.includes('could not draw this score'),
  JSON.stringify({ returned: p.badReturned, msg: p.badMessage && p.badMessage.slice(0, 80) }));
ok('and still names what playback can do without it',
  !!p.badMessage && p.badMessage.includes('piano roll still work'), JSON.stringify(p.badMessage));
ok('nothing is thrown and nothing goes uncaught',
  p.badThrew === null && Array.isArray(p.uncaught) && p.uncaught.length === 0,
  JSON.stringify({ threw: p.badThrew, uncaught: p.uncaught }));

console.log(`\n${failed ? 'notation load FAILED' : 'notation load OK'}`);
process.exit(failed ? 1 : 0);
