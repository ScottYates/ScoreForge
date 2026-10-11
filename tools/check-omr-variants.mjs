/**
 * tools/check-omr-variants.mjs - does the OMR front end stop paying for
 * duplicate inference passes?
 *
 * Each preprocessing variant costs one full inference pass, and on a straight
 * page deskew() is a no-op that returns the identical pixels -- so "deskewed"
 * duplicated "original", "deskew+contrast" duplicated "contrast", and every
 * straight page paid four passes for two distinct images. This drives
 * backend/preprocess.py (cv2 + numpy, no recognition model needed) with
 * synthetic pages and requires:
 *
 *   - a straight page yields no two byte-identical renderings, and fewer
 *     renderings than a skewed one;
 *   - a genuinely skewed page still gets its deskewed renderings;
 *   - what was folded away is recorded on the surviving variant, so the
 *     report still says what was considered;
 *   - "original" mode is exactly one rendering, and every mode's list is
 *     deduplicated.
 *
 * Runs the real module in python3. Skips (exit 0, saying so) when cv2 is not
 * importable, the same way the other backend checks skip without their venv.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

const PY = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(root, 'backend'))})
try:
    import cv2, numpy as np
except Exception as e:
    print(json.dumps({"skip": str(e)})); raise SystemExit(0)
from preprocess import Page, build_variants

def staff_page(skew_deg):
    img = np.full((1000, 1400, 3), 245, np.uint8)
    for top in (200, 420, 640):
        for line in range(5):
            y = top + line * 14
            img[y:y+2, 120:1280] = 20
    if skew_deg:
        m = cv2.getRotationMatrix2D((700, 500), skew_deg, 1.0)
        img = cv2.warpAffine(img, m, (1400, 1000), flags=cv2.INTER_CUBIC,
                             borderMode=cv2.BORDER_REPLICATE)
    return Page(0, img, "image")

def describe(mode, skew):
    vs = build_variants(staff_page(skew), mode=mode)
    blobs = [v.image.tobytes() for v in vs]
    return {
        "mode": mode, "skew": skew,
        "names": [v.name for v in vs],
        "distinct": len(set(blobs)) == len(blobs),
        "sameAs": {v.name: v.report.get("sameAs", []) for v in vs if v.report.get("sameAs")},
    }

print(json.dumps({
    "straight": describe("auto", 0),
    "skewed": describe("auto", 2.0),
    "original": describe("original", 0),
    "clean": describe("clean", 0),
}))
`;

const r = spawnSync('python3', ['-c', PY], { encoding: 'utf8', timeout: 180000 });
if (r.status !== 0) {
  console.error('check-omr-variants: python failed');
  console.error(r.stderr || r.stdout);
  process.exit(1);
}
const data = JSON.parse(r.stdout.trim().split('\n').pop());
if (data.skip) {
  console.log(`skip  omr variants: cv2 unavailable (${data.skip})`);
  process.exit(0);
}

let failed = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) failed++;
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${detail ? '  — ' + detail : ''}`);
};

const { straight, skewed, original, clean } = data;
ok('a straight page folds its no-op deskew renderings away',
  straight.names.length < skewed.names.length,
  `straight: [${straight.names}] vs skewed: [${skewed.names}]`);
ok('and keeps original and contrast', straight.names.includes('original') && straight.names.includes('contrast'),
  straight.names.join(','));
ok('what was folded is recorded on the survivor', Object.keys(straight.sameAs).length > 0,
  JSON.stringify(straight.sameAs));
ok('a genuinely skewed page still gets its deskewed renderings',
  skewed.names.includes('deskewed') && skewed.names.includes('deskew+contrast'),
  skewed.names.join(','));
for (const d of [straight, skewed, original, clean]) {
  ok(`no two renderings are byte-identical (${d.mode}, skew ${d.skew})`, d.distinct, d.names.join(','));
}
ok('"original" mode is exactly one rendering', original.names.length === 1, original.names.join(','));

console.log(`\n${failed ? 'omr variants FAILED' : 'omr variants OK'}`);
process.exit(failed ? 1 : 0);
