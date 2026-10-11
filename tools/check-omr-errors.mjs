/**
 * tools/check-omr-errors.mjs - does one bad rendering take the page down, and
 * does a page read as nothing ship as an empty "success"?
 *
 * The failures it guards (seen on a real vocal-book photo -- a tilted page of
 * single melody lines, lyrics and highlighter):
 *
 *   - homr raises outright when it finds no staffs. The ORIGINAL rendering of
 *     a tilted phone photo is exactly where that happens, and the crash used
 *     to abort the whole variant loop -- the deskewed rendering, the one
 *     built to survive that photo, never ran.
 *   - a rendering that parses but reads zero pitched notes used to count as
 *     a valid winner, so the app received a SUCCESSFUL, silently empty score:
 *     "it does not produce notes on the web page", with nothing to act on.
 *
 * The contract under test, from backend/omr_engine.py transcribe_page():
 *   - a variant that raises is recorded as a failed attempt, with the
 *     engine's own words, and the remaining variants still run;
 *   - the page succeeds off a later variant when one reads actual notes;
 *   - every variant failing, or every variant reading zero pitched notes,
 *     raises one error that names what each rendering did, plus the advice
 *     (sharper, straighter, fill the frame) the person can act on.
 *
 * Needs python3 with cv2+numpy (homr itself is monkeypatched out); skips
 * loudly where they are missing, like the other backend checks.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

const PY = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(root, 'backend'))})
import numpy as np
import omr_engine as oe
from preprocess import Page, Variant

cases = {}

XML_NOTES = ('<?xml version="1.0"?><score-partwise version="4.0">'
    '<part-list><score-part id="P1"><part-name>x</part-name></score-part></part-list>'
    '<part id="P1"><measure number="1">'
    '<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>'
    '<note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice></note>'
    '<note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice></note>'
    '</measure></part></score-partwise>')
XML_RESTS = ('<?xml version="1.0"?><score-partwise version="4.0">'
    '<part-list><score-part id="P1"><part-name>x</part-name></score-part></part-list>'
    '<part id="P1"><measure number="1">'
    '<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>'
    '<note><rest/><duration>4</duration><voice>1</voice></note>'
    '</measure></part></score-partwise>')

img = np.full((40, 60, 3), 255, dtype=np.uint8)
page = Page(0, img, 'image')

# The engine itself is monkeypatched out: this tests the loop's POLICY, which
# is pure python, not homr. warm_up and build_variants are module globals of
# omr_engine, so transcribe_page picks the patches up at call time.
oe.warm_up = lambda: {'ready': True}
oe.build_variants = lambda p, mode='auto': [
    Variant('original', img.copy(), {'steps': {}}),
    Variant('deskewed', img.copy(), {'steps': {}}),
]
# Tempo OCR is best-effort and already guarded; keep it out of the way here.
oe._ocr_top_lines = lambda image: []

script = {}
def fake_run(variant, workdir, on_line=None):
    action = script[variant.name]
    if isinstance(action, Exception):
        raise action
    return action, []
oe._run_variant = fake_run

# 1. The first rendering crashes ("No staffs found"), the second reads music:
#    the page must succeed off the second, with the crash on the record.
#    (try/except so a regression that re-propagates the crash fails the named
#    assertion below instead of killing this whole script.)
script = {'original': Exception('No staffs found'), 'deskewed': XML_NOTES}
try:
    r = oe.transcribe_page(page)
    cases['survives'] = {
        'variant': r.variant,
        'notes': r.stats.get('notes'),
        'attempts': [{k: a.get(k) for k in ('variant', 'notes', 'error')} for a in r.variants_tried],
    }
except Exception as e:
    cases['survives'] = {'variant': None, 'notes': None, 'attempts': [], 'raised': str(e)}

# 2. Every rendering crashes: one error, naming what each rendering did,
#    ending in the advice the person can act on.
script = {'original': Exception('No staffs found'), 'deskewed': Exception('No staffs found')}
try:
    oe.transcribe_page(page)
    cases['all_crash'] = {'raised': False}
except Exception as e:
    cases['all_crash'] = {'raised': isinstance(e, ValueError), 'message': str(e)}

# 3. Every rendering parses but reads zero pitched notes (a page of lyrics
#    comes back as rests): that is a failure, not an empty score.
script = {'original': XML_RESTS, 'deskewed': XML_RESTS}
try:
    oe.transcribe_page(page)
    cases['all_empty'] = {'raised': False}
except Exception as e:
    cases['all_empty'] = {'raised': isinstance(e, ValueError), 'message': str(e)}

# 4. A zero-note rendering beside a real one: the real one wins as before.
script = {'original': XML_RESTS, 'deskewed': XML_NOTES}
try:
    r = oe.transcribe_page(page)
    cases['zero_loses'] = {'variant': r.variant, 'notes': r.stats.get('notes')}
except Exception as e:
    cases['zero_loses'] = {'variant': None, 'notes': None, 'raised': str(e)}

print(json.dumps(cases))
`;

const probe = spawnSync('python3', ['-c', 'import cv2, numpy'], { encoding: 'utf8' });
if (probe.status !== 0) {
  console.log('SKIPPED: check-omr-errors needs python3 with cv2+numpy, which this machine lacks.');
  console.log('         The variant-loop policy was NOT checked here.');
  process.exit(0);
}

const r = spawnSync('python3', ['-c', PY], { encoding: 'utf8', timeout: 120000 });
if (r.status !== 0) {
  console.error('check-omr-errors: python failed');
  console.error(r.stderr || r.stdout);
  process.exit(1);
}
const c = JSON.parse(r.stdout.trim().split('\n').pop());

let failed = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) failed++;
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${detail ? '  — ' + detail : ''}`);
};

ok('a variant that crashes does not take the page down',
  c.survives.variant === 'deskewed' && c.survives.notes === 2,
  JSON.stringify(c.survives));
ok('the crash stays on the record, in the engine\'s own words',
  c.survives.attempts.length === 2 && c.survives.attempts[0].error === 'No staffs found'
    && !('error' in c.survives.attempts[1] && c.survives.attempts[1].error),
  JSON.stringify(c.survives.attempts));
ok('every variant crashing raises one error naming what each rendering did',
  c.all_crash.raised === true && c.all_crash.message.includes('original: No staffs found')
    && c.all_crash.message.includes('deskewed: No staffs found'),
  JSON.stringify(c.all_crash));
ok('and it ends in advice the person can act on',
  c.all_crash.raised === true && /sharper, straighter/.test(c.all_crash.message));
ok('a page read as zero pitched notes is a failure, not an empty score',
  c.all_empty.raised === true && c.all_empty.message.includes('0 notes'),
  JSON.stringify(c.all_empty));
ok('a zero-note rendering loses to one that read music',
  c.zero_loses.variant === 'deskewed' && c.zero_loses.notes === 2,
  JSON.stringify(c.zero_loses));

console.log(`\n${failed ? 'omr errors FAILED' : 'omr errors OK'}`);
process.exit(failed ? 1 : 0);
