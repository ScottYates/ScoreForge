/**
 * tools/check-omr-preprocess.mjs - does the page conditioning clear what it
 * should and only what it should?
 *
 * Two additions under test, both motivated by one photographed vocal book:
 *
 *   highlighter suppression -- rehearsal copies come back covered in pink
 *   and yellow, and on the grayscale the engine reads, a mark is a mid-gray
 *   smudge across the very noteheads it was marking. The marks are the only
 *   thing on a printed page that is both saturated AND bright, so they can
 *   be lifted to white without touching ink (dark), paper (colorless), or
 *   the ink UNDER a mark (still dark). The brightness gate is relative to
 *   the page's own paper, because a dim phone photo's pink sits below any
 *   fixed daylight threshold -- and the near-black spiral binding, saturated
 *   by sensor noise, must never be "cleared" to white.
 *
 *   straighten() -- dewarp-plus-deskew where the optional docuwarp package
 *   is installed, exactly the old rotation-only deskew where it is not. The
 *   wiring is tested with a FAKE docuwarp injected into sys.modules, so the
 *   contract holds on machines (like CI) that do not install the real one:
 *   presence is used, absence falls back, and a dewarper that CRASHES must
 *   cost nothing but the flattening.
 *
 * Pure python3 + cv2/numpy; skips loudly where they are missing.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

const PY = `
import json, sys, types
sys.path.insert(0, ${JSON.stringify(path.join(root, 'backend'))})
import cv2
import numpy as np

cases = {}

# --- a synthetic rehearsal page -------------------------------------------
# Dim paper (200), black staff lines and a "notehead", a pink highlighter bar
# crossing the notehead, and a near-black "spiral binding" strip that carries
# saturated sensor noise.
page = np.full((200, 300, 3), 200, dtype=np.uint8)
for i in range(5):
    page[60 + i * 8, 20:280] = 20              # staff lines
page[88:96, 140:150] = 15                      # a notehead below the staff
page[84:100, 100:220] = (180, 160, 230)        # pink bar over paper...
page[88:96, 140:150] = (60, 40, 90)            # ...and darker pink over the notehead
page[:, 0:12] = (40, 20, 60)                   # dark saturated binding strip

import preprocess as pp
out, info = pp.suppress_highlighter(page)
pink_paper = out[90, 110]      # was pink over paper
ink_under = out[92, 145]       # was ink under the mark
binding = out[100, 5]          # dark saturated strip
staff = out[60, 150]           # plain ink
cases['hl'] = {
    'cleared': info['highlighterCleared'],
    'pinkNowWhite': bool((pink_paper == 255).all()),
    'inkStillDark': bool(int(ink_under.max()) < 120),
    'bindingUntouched': bool((binding == np.array([40, 20, 60])).all()),
    'staffUntouched': bool((staff == np.array([20, 20, 20])).all()),
}

clean = np.full((200, 300, 3), 200, dtype=np.uint8)
for i in range(5):
    clean[60 + i * 8, 20:280] = 20
out2, info2 = pp.suppress_highlighter(clean)
cases['hl_clean'] = {
    'cleared': info2['highlighterCleared'],
    'untouched': bool((out2 == clean).all()),
}

# --- straighten(): absence, presence, crash -------------------------------
# Absence: this machine has no docuwarp, so straighten is deskew exactly.
pp._dewarper = None
out3, info3 = pp.straighten(clean)
cases['no_dewarper'] = {'dewarped': info3.get('dewarped'),
                        'deskewKeys': 'deskewed' in info3}

# Presence: a fake docuwarp whose output is recognisably its own.
from PIL import Image
class FakeUnwarp:
    def inference(self, pil):
        arr = np.asarray(pil).copy()
        arr[:, :, :] = 123
        return Image.fromarray(arr)
fake_mod = types.ModuleType('docuwarp'); fake_unwarp = types.ModuleType('docuwarp.unwarp')
fake_unwarp.Unwarp = FakeUnwarp
sys.modules['docuwarp'] = fake_mod
sys.modules['docuwarp.unwarp'] = fake_unwarp
pp._dewarper = None  # force re-discovery through the fake
out4, info4 = pp.straighten(clean)
cases['with_dewarper'] = {'dewarped': info4.get('dewarped'),
                          'pixelsFromDewarper': bool((out4 == 123).all())}

# Crash: a dewarper that throws must cost nothing but the flattening.
class CrashUnwarp:
    def inference(self, pil):
        raise RuntimeError('onnx session poisoned')
fake_unwarp.Unwarp = CrashUnwarp
pp._dewarper = None
try:
    out5, info5 = pp.straighten(clean)
    cases['dewarper_crash'] = {'dewarped': info5.get('dewarped'),
                               'error': info5.get('dewarpError', ''),
                               'pageSurvives': out5.shape == clean.shape}
except Exception as e:  # a regression that re-raises fails the assertion, not the script
    cases['dewarper_crash'] = {'dewarped': None, 'error': str(e), 'pageSurvives': False}

# The variant list keeps its names either way, so nothing downstream moves.
del sys.modules['docuwarp'], sys.modules['docuwarp.unwarp']
pp._dewarper = None
skew = cv2.warpAffine(clean, cv2.getRotationMatrix2D((150, 100), 2.5, 1.0), (300, 200),
                      borderMode=cv2.BORDER_REPLICATE)
vs = pp.build_variants(pp.Page(0, skew, 'image'), mode='auto')
cases['names'] = [v.name for v in vs]

# And the suppression is actually WIRED into the variants: a highlighted page
# through build_variants comes out cleared on the shared base, with the step
# on the record.
vs2 = pp.build_variants(pp.Page(0, page, 'image'), mode='auto')
orig = next(v for v in vs2 if v.name == 'original')
# fit_page may rescale, so measure the mark's survival, not a coordinate:
# after clearing, no pixel should remain both saturated and bright.
ohsv = cv2.cvtColor(orig.image, cv2.COLOR_BGR2HSV)
left = float(((ohsv[:, :, 1] > 60) & (ohsv[:, :, 2] > 140)).mean())
cases['wired'] = {
    'step': orig.report['steps'].get('highlighterCleared'),
    'markGone': left < 0.0005, 'left': round(left, 5),
}

print(json.dumps(cases))
`;

const probe = spawnSync('python3', ['-c', 'import cv2, numpy, PIL'], { encoding: 'utf8' });
if (probe.status !== 0) {
  console.log('SKIPPED: check-omr-preprocess needs python3 with cv2+numpy+PIL, which this machine lacks.');
  process.exit(0);
}

const r = spawnSync('python3', ['-c', PY], { encoding: 'utf8', timeout: 120000 });
if (r.status !== 0) {
  console.error('check-omr-preprocess: python failed');
  console.error(r.stderr || r.stdout);
  process.exit(1);
}
const c = JSON.parse(r.stdout.trim().split('\n').pop());

let failed = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) failed++;
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${detail ? '  — ' + detail : ''}`);
};

ok('highlighter over paper is lifted to white',
  c.hl.cleared === true && c.hl.pinkNowWhite === true, JSON.stringify(c.hl));
ok('the ink under a mark survives, still dark', c.hl.inkStillDark === true, JSON.stringify(c.hl));
ok('a dark saturated binding is never "cleared"', c.hl.bindingUntouched === true);
ok('plain ink is untouched', c.hl.staffUntouched === true);
ok('a page with no highlighter passes through byte for byte',
  c.hl_clean.cleared === false && c.hl_clean.untouched === true, JSON.stringify(c.hl_clean));
ok('without docuwarp, straighten is exactly the old deskew',
  c.no_dewarper.dewarped === false && c.no_dewarper.deskewKeys === true,
  JSON.stringify(c.no_dewarper));
ok('with docuwarp installed, the page goes through the dewarper',
  c.with_dewarper.dewarped === true && c.with_dewarper.pixelsFromDewarper === true,
  JSON.stringify(c.with_dewarper));
ok('a dewarper crash costs nothing but the flattening',
  c.dewarper_crash.dewarped === false && /onnx session poisoned/.test(c.dewarper_crash.error)
    && c.dewarper_crash.pageSurvives === true,
  JSON.stringify(c.dewarper_crash));
ok('the suppression is wired into the variant build, on the record',
  c.wired.step === true && c.wired.markGone === true, JSON.stringify(c.wired));
ok('the variant names do not move when the dewarper comes or goes',
  Array.isArray(c.names) && c.names.includes('deskewed') && c.names.includes('deskew+contrast'),
  JSON.stringify(c.names));

console.log(`\n${failed ? 'omr preprocess FAILED' : 'omr preprocess OK'}`);
process.exit(failed ? 1 : 0);
