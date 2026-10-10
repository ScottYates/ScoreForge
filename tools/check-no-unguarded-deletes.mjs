/**
 * tools/check-no-unguarded-deletes.mjs - fail if anything under tools/ deletes a
 * file without asking tools/lib/guard.mjs first.
 *
 * Two standing rules, both of which have already been broken once:
 *
 *   1. Never delete anything this repository did not create.
 *   2. Never delete anything outside the working folder.
 *
 * Writing them down is not the same as keeping them. The first violation was a
 * builder that cleared its own output directory -- which also held a hand-written
 * page -- and reported success. The second was a browser profile in os.tmpdir(),
 * deleted on the way out, where anything matching a name prefix was fair game.
 *
 * So this is not a lint rule about style. Part one is a scan: the only file
 * permitted to call a delete API is the guard. Part two is a behavioural test,
 * because a guard that has never been seen refusing is not known to refuse --
 * it is only known to exist.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { assertInWorkspace, claimTree, isOwned, removeOwnedTree, ROOT, MARKER } from './lib/guard.mjs';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));

// Skip these by absolute path, not by substring: this file necessarily contains
// the patterns it looks for (in the scan below and in the test names), and a
// check that reports itself is a check nobody runs. The two guards are skipped
// because they are the only files allowed to call a delete API.
const SELF = fileURLToPath(import.meta.url);
const GUARDS = new Set([
  path.join(toolsDir, 'lib', 'guard.mjs'),
  path.join(ROOT, 'backend', 'guard.py'),
]);

/** Directories under the repo that hold other people's code. */
const NOT_OURS = new Set(['node_modules', '.venv', '__pycache__', 'dist', 'build']);

/**
 * Where ad-hoc deletion is looked for. The Python backend is included because
 * its scratch directory was a tempfile.TemporaryDirectory -- a delete outside
 * the working folder, on every request -- and scanning only tools/ would have
 * reported the guardrails green while the rule was already broken elsewhere.
 */
const SCAN_DIRS = [toolsDir, path.join(ROOT, 'backend')];

/**
 * Delete calls, by language. `fs.rmSync` and `rmdirSync` and `unlinkSync` are
 * named on `fs.` or bare so both `fs.rmSync(x)` and a destructured `rmSync(x)`
 * are caught; the same for Python's `os.remove` / `shutil.rmtree`.
 */
const FORBIDDEN = [
  { re: /\b(?:fs\.)?rmSync\s*\(/g, what: 'rmSync' },
  { re: /\b(?:fs\.)?rm\s*\(/g, what: 'fs.rm' },
  { re: /\brmdirSync\s*\(/g, what: 'rmdirSync' },
  { re: /\bunlinkSync\s*\(/g, what: 'unlinkSync' },
  { re: /\b(?:fs\.)?unlink\s*\(/g, what: 'unlink' },
  { re: /\bshutil\.rmtree\s*\(/g, what: 'shutil.rmtree' },
  { re: /\bos\.(?:remove|rmdir|unlink)\s*\(/g, what: 'os.remove/rmdir' },
  { re: /\bRemove-Item\b/g, what: 'Remove-Item' },
];

const findings = [];
const scanned = [];

function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (NOT_OURS.has(name)) continue;
    const abs = path.join(dir, name);
    const st = fs.statSync(abs);
    if (st.isDirectory()) { walk(abs); continue; }
    if (!/\.(mjs|js|cjs|py)$/i.test(name)) continue;
    if (abs === SELF || GUARDS.has(abs)) continue;
    scanned.push(path.relative(ROOT, abs));
    const src = fs.readFileSync(abs, 'utf8');
    const lines = src.split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const { re, what } of FORBIDDEN) {
        re.lastIndex = 0;
        if (re.test(line)) {
          findings.push(`${path.relative(ROOT, abs)}:${i + 1}  ${what}  ->  ${line.trim().slice(0, 90)}`);
        }
      }
    });
  }
}

for (const dir of SCAN_DIRS) walk(dir);

console.log(`scanned ${scanned.length} source files under ${SCAN_DIRS.map((d) => path.relative(ROOT, d)).join(' and ')}`);
if (findings.length) {
  for (const f of findings) console.log('FAIL ' + f);
  console.log(`\n${findings.length} unguarded delete call(s). Route it through the matching\n` +
    `guard -- removeOwnedTree()/claimTree() from tools/lib/guard.mjs, or owned_tree()\n` +
    `from backend/guard.py -- which refuse to delete a directory without a\n` +
    `${MARKER} marker or outside the working folder.`);
  process.exit(1);
}
console.log(`no unguarded deletes (${FORBIDDEN.length} call shapes checked; only ` +
  `${[...GUARDS].map((g) => path.relative(ROOT, g)).join(' and ')} may delete)`);

// ---- the guard has to actually refuse ---------------------------------------
//
// A scan proves the codebase routes its deletes through guard.mjs. It says
// nothing about whether guard.mjs refuses when it should -- which is the half
// that matters, since a guard that permits everything satisfies the scan too.

const fails = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) fails.push(name);
};

const refuses = (fn) => {
  try { fn(); return null; } catch (e) { return e.message; }
};

// A pure predicate, so testing the outside-the-workspace rule through it is
// safe: there is no code path where this can delete os.tmpdir() even if the
// guard is completely broken.
const outside = path.join(os.tmpdir(), 'scoreforge-guard-probe');
check('refuses a path outside the working folder',
  Boolean(refuses(() => assertInWorkspace(outside, 'probe'))), outside);
check('refuses the working folder itself',
  Boolean(refuses(() => assertInWorkspace(ROOT, 'probe'))));
check('refuses a sibling directory sharing a name prefix',
  Boolean(refuses(() => assertInWorkspace(ROOT + '-archive', 'probe'))), ROOT + '-archive');
check('accepts a path inside the working folder',
  assertInWorkspace(path.join(ROOT, 'pack', 'samples'), 'probe') !== undefined);

// The unmarked case is attempted against removeOwnedTree(), not the predicate.
// If the guard were broken the worst outcome is the loss of a throwaway
// directory this script created a moment earlier -- chosen here rather than
// os.tmpdir() precisely so that a broken guard is not destructive.
const probeDir = path.join(ROOT, '.tmp', 'guard-probe');
claimTree(path.join(probeDir, 'claimed'), 'throwaway, from check-no-unguarded-deletes');
fs.mkdirSync(path.join(probeDir, 'unclaimed'), { recursive: true });
// A file with a name nobody would generate by accident, so "is it still there"
// cannot be answered by a stray write elsewhere in the run.
const keepMe = path.join(probeDir, 'unclaimed', 'keep.txt');
fs.writeFileSync(keepMe, 'x', 'utf8');

check('a claimed directory reports as owned', isOwned(path.join(probeDir, 'claimed')));
check('an unclaimed directory does not report as owned', !isOwned(path.join(probeDir, 'unclaimed')));
check('refuses to delete a directory it did not create',
  Boolean(refuses(() => removeOwnedTree(path.join(probeDir, 'unclaimed'), 'probe'))));
check('the unclaimed directory survived the refusal', fs.existsSync(keepMe));

removeOwnedTree(path.join(probeDir, 'claimed'), 'clean up claimed probe');
check('deletes a directory it did create',
  !fs.existsSync(path.join(probeDir, 'claimed')));

claimTree(probeDir, 'throwaway parent, from check-no-unguarded-deletes');
removeOwnedTree(probeDir, 'clean up probe parent');
check('probe parent cleaned up', !fs.existsSync(probeDir));

if (fails.length) {
  console.error('\nGUARDRAILS FAILED: ' + fails.join('; '));
  process.exit(1);
}

// The Python guard gets the same treatment. The scan above covers it -- one rule,
// both runtimes -- but a scan cannot tell whether it refuses, so its refusals
// are exercised for real. Run with the backend venv: system Python may not have
// the backend's dependencies, and the self-test needs none of them, but the
// interpreter that actually imports omr_engine.py is the one under test.
{
  const py = path.join(ROOT, 'backend', '.venv', 'Scripts', 'python.exe');
  const fallback = '/usr/bin/python3';
  const exe = fs.existsSync(py) ? py : fallback;
  const r = spawnSync(exe, [path.join(ROOT, 'backend', 'guard.py')], {
    cwd: ROOT, encoding: 'utf8',
  });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  if (r.error) {
    console.log(`skip  backend/guard.py self-test: no interpreter at ${exe}`);
  } else {
    console.log(out);
    if (r.status !== 0) {
      console.error('\nGUARDRAILS FAILED: backend/guard.py self-test exited ' + r.status);
      process.exit(1);
    }
  }
}

console.log('guardrails OK');