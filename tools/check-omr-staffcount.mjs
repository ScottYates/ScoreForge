/**
 * tools/check-omr-staffcount.mjs - does the second opinion on a page's
 * layout count what a person would count?
 *
 * The failure it guards: the engine's staff detector lost eight of a vocal
 * book's eleven staves and the page shipped as a SUCCESS. The detector
 * cannot audit itself, so backend/staffcount.py counts staves with entirely
 * different machinery -- classical long-run line detection -- and the
 * transcription is compared against that count.
 *
 * The contract:
 *   - drawn 5-line staves are counted as staves; lyric-like rows of short
 *     text strokes are NOT, because only runs spanning a staff's width
 *     survive the horizontal opening;
 *   - used_staves() counts PHYSICAL staves (systems x logical staves), not
 *     MusicXML's per-part staff numbers;
 *   - staff_check() flags only a STRONG mismatch -- close calls pass, tiny
 *     estimates never flag -- so the panel's loudest line cannot cry wolf.
 *
 * Pure python3 + cv2/numpy; skips loudly where they are missing.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

const PY = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(root, 'backend'))})
import numpy as np
from staffcount import estimate_staves, staff_check, used_staves

cases = {}

def draw_page(staves, height=None, width=600, text_rows=0):
    # Each staff: 5 lines, 6px apart; staves 60px apart.
    h = height or (80 + staves * 60 + text_rows * 20)
    img = np.full((h, width, 3), 235, dtype=np.uint8)
    y = 40
    for _ in range(staves):
        for line in range(5):
            img[y + line * 6, 30:width - 30] = 25
        y += 60
    # Lyric-like rows: many SHORT dark strokes, spaced like staff lines so
    # that if they ever counted as lines they would cluster into a "staff".
    # Row ink totals well over the line threshold, but no single run spans
    # a staff's width, so the horizontal opening is what removes them.
    for t in range(text_rows):
        ty = y + t * 6
        for x in range(30, width - 30, 24):
            img[ty, x:x + 14] = 25
    return img

cases['three'] = estimate_staves(draw_page(3))
cases['eleven'] = estimate_staves(draw_page(11))
cases['text'] = estimate_staves(draw_page(2, text_rows=5))

# used_staves: two parts, one with a two-staff grand staff, read across
# three systems -> physical staves = 3 systems x (2 + 1) logical = 9.
def xml(parts):
    body = ''
    for pid, measures in parts:
        body += f'<part id="{pid}">' + measures + '</part>'
    return ('<?xml version="1.0"?><score-partwise version="4.0">' + body
            + '</score-partwise>')
def measure(n, new_system=False, staves=(1,)):
    notes = ''.join(
        f'<note><pitch><step>C</step><octave>4</octave></pitch>'
        f'<duration>4</duration><staff>{s}</staff></note>' for s in staves)
    pr = '<print new-system="yes"/>' if new_system else ''
    return f'<measure number="{n}">{pr}{notes}</measure>'

grand = measure(1, staves=(1, 2)) + measure(2, True, staves=(1, 2)) + measure(3, True, staves=(1, 2))
single = measure(1) + measure(2, True) + measure(3, True)
cases['used'] = used_staves(xml([('P1', grand), ('P2', single)]))
cases['used_one'] = used_staves(xml([('P1', measure(1) + measure(2))]))

# The flag: strong mismatch fires, close call does not, tiny estimate never.
page11 = draw_page(11)
one_staff_xml = xml([('P1', single)])          # 3 systems x 1 = 3 used
cases['flag_strong'] = staff_check(page11, one_staff_xml)
page4 = draw_page(4)
cases['flag_close'] = staff_check(page4, one_staff_xml)   # 4 vs 3: close
page3 = draw_page(3)
cases['flag_tiny'] = staff_check(page3, xml([('P1', measure(1))]))  # est 3 < 4
# Large but not lopsided: 8 vs 5 misses the ratio gate (1.6 < 1.8).
five_sys = measure(1) + ''.join(measure(i, True) for i in range(2, 6))
cases['flag_ratio'] = staff_check(draw_page(8), xml([('P1', five_sys)]))
# Lopsided but small: 4 vs 2 misses the absolute gate (shortfall of 2 < 3).
two_sys = measure(1) + measure(2, True)
cases['flag_small'] = staff_check(draw_page(4), xml([('P1', two_sys)]))

print(json.dumps(cases))
`;

const probe = spawnSync('python3', ['-c', 'import cv2, numpy'], { encoding: 'utf8' });
if (probe.status !== 0) {
  console.log('SKIPPED: check-omr-staffcount needs python3 with cv2+numpy, which this machine lacks.');
  process.exit(0);
}

const r = spawnSync('python3', ['-c', PY], { encoding: 'utf8', timeout: 120000 });
if (r.status !== 0) {
  console.error('check-omr-staffcount: python failed');
  console.error(r.stderr || r.stdout);
  process.exit(1);
}
const c = JSON.parse(r.stdout.trim().split('\n').pop());

let failed = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) failed++;
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${detail ? '  — ' + detail : ''}`);
};

ok('three drawn staves count as three', c.three.staves === 3, JSON.stringify(c.three));
ok('eleven drawn staves count as eleven', c.eleven.staves === 11, JSON.stringify(c.eleven));
ok('rows of lyric-like strokes do not count as staff lines',
  c.text.staves === 2, JSON.stringify(c.text));
ok('used staves are physical: systems times logical staves',
  c.used === 9, JSON.stringify(c.used));
ok('a single-system part counts once', c.used_one === 1, JSON.stringify(c.used_one));
ok('a strong mismatch is flagged, with both numbers',
  c.flag_strong.flagged === true && c.flag_strong.estimated === 11 && c.flag_strong.used === 3,
  JSON.stringify(c.flag_strong));
ok('a close call passes without comment', c.flag_close.flagged === false,
  JSON.stringify(c.flag_close));
ok('a tiny estimate never flags', c.flag_tiny.flagged === false,
  JSON.stringify(c.flag_tiny));
ok('a mismatch that is large but not lopsided passes (8 vs 5)',
  c.flag_ratio.flagged === false && c.flag_ratio.estimated === 8 && c.flag_ratio.used === 5,
  JSON.stringify(c.flag_ratio));
ok('a two-staff shortfall is not worth an alarm (4 vs 2)',
  c.flag_small.flagged === false && c.flag_small.estimated === 4 && c.flag_small.used === 2,
  JSON.stringify(c.flag_small));

console.log(`\n${failed ? 'omr staffcount FAILED' : 'omr staffcount OK'}`);
process.exit(failed ? 1 : 0);
