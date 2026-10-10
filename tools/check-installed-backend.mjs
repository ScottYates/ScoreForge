/**
 * tools/check-installed-backend.mjs — is everything backend/ imports actually installed?
 *
 * omr_engine.py imports its siblings by bare name (`from guard import ...`,
 * `from preprocess import ...`). That resolves against the *installed* copy at
 * $PREFIX/backend, not the checkout, so a module that is present in backend/
 * but missing from the installer's copy list is invisible until the service
 * starts. That is not theoretical: guard.py was added to the checkout in the
 * deletion-guardrails change, the installer's file list was written out in two
 * places, neither copy was updated, the install reported success, and the
 * service crash-looped on `No module named 'guard'` until someone read 1200
 * lines of journal to find it.
 *
 * So this reads the installer's list, reads the imports that actually exist,
 * and requires the first to cover the second. It also requires the list to be
 * defined exactly once -- the two copies are the reason the gap went unnoticed,
 * and a list that can be written twice will be.
 *
 * A second, independent check lives in deploy/install.sh: it imports the
 * installed tree at install time and fails the install rather than the service.
 * This one runs in `npm test` on every commit, including on the machines that
 * never run the installer.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND = path.join(ROOT, 'backend');
const INSTALL_SH = path.join(ROOT, 'deploy', 'install.sh');

const fails = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) fails.push(name);
};

const sh = fs.readFileSync(INSTALL_SH, 'utf8');

// ---- the installer's list ----------------------------------------------------
const assignments = [...sh.matchAll(/^BACKEND_FILES="([^"]*)"/gm)];
check('install.sh defines BACKEND_FILES exactly once', assignments.length === 1,
  `found ${assignments.length}`);

const installed = new Set((assignments[0]?.[1] ?? '').split(/\s+/).filter(Boolean));

// Both the preflight and the install step must consume that one variable. The
// pattern is anchored and takes a single word, so it matches only
// `for f in $BACKEND_FILES; do` and ignores unrelated loops over other lists.
const loops = [...sh.matchAll(/^for f in (\S+); do$/gm)].map((m) => m[1]);
check('install.sh ships the backend from $BACKEND_FILES in both places',
  loops.filter((l) => l === '$BACKEND_FILES').length === 2,
  `${loops.length} loop(s) over a file list: ${loops.join(' | ')}`);

// ---- the imports that actually exist ----------------------------------------
/** Sibling modules: a bare `import x` / `from x import y`, no dots, not a stdlib
 *  or third-party package. Parsed from the top-level statements only, because a
 *  dotted name is a package and a name that resolves to neither is a
 *  requirements.txt entry, not a file to copy. */
function siblingImports(source) {
  const names = new Set();
  // Drop comments and docstrings so prose about `from guard import ...` is not
  // mistaken for the code doing it.
  const code = source
    .replace(/"""[\s\S]*?"""/g, '')
    .replace(/'''[\s\S]*?'''/g, '')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  for (const m of code.matchAll(/^\s*import\s+([A-Za-z_][\w.]*)/gm)) names.add(m[1]);
  for (const m of code.matchAll(/^\s*from\s+([A-Za-z_][\w.]*)\s+import\b/gm)) names.add(m[1]);
  return [...names].filter((n) => !n.includes('.'));
}

// Only a bare name that resolves to a file next to the importing module is a
// sibling the installer must ship. Everything else -- cv2, numpy, fastapi -- is
// a package that comes from the venv, and requirements.txt is the thing that
// decides those. Asserting on them here would be a second opinion about a file
// this check has no business owning, and it would fail for the right-sounding
// reason on an unrelated change.
const needed = new Map(); // module -> files that import it
for (const file of fs.readdirSync(BACKEND).filter((f) => f.endsWith('.py'))) {
  const src = fs.readFileSync(path.join(BACKEND, file), 'utf8');
  for (const name of siblingImports(src)) {
    if (!fs.existsSync(path.join(BACKEND, `${name}.py`))) continue;
    if (!needed.has(name)) needed.set(name, []);
    needed.get(name).push(file);
  }
}

const names = [...needed.keys()].sort();
console.log(`     backend modules imported by bare name: ${names.join(', ') || '(none)'}`);

for (const name of names) {
  check(`install.sh ships ${name}.py`, installed.has(`${name}.py`),
    `imported by ${needed.get(name).join(', ')}`);
}

// The other direction: nothing listed that does not exist, which turns a typo
// in the list into a preflight failure rather than a file that silently never
// gets copied.
for (const f of installed) {
  check(`install.sh lists an existing backend/${f}`, fs.existsSync(path.join(BACKEND, f)));
}

// ---- what the unit needs writable must be prepared by the installer ----------
//
// Same drift, one level out. omr_engine creates its scratch under guard.ROOT,
// which resolves to the install prefix, and the unit runs under
// ProtectSystem=strict where /opt is read-only -- so the directory has to exist
// and be named in ReadWritePaths=. A ReadWritePaths= entry that does not exist
// fails the unit at start, so the installer creating it is load-bearing, not
// tidiness. (The unit hardcodes /opt/scoreforge, as it already does for
// WorkingDirectory and ExecStart.)
const PREFIX = '/opt/scoreforge';
const unit = fs.readFileSync(path.join(ROOT, 'deploy', 'scoreforge.service'), 'utf8');
const writable = [...unit.matchAll(/^ReadWritePaths=(\S*)/gm)].map((m) => m[1]).filter(Boolean);
check('the unit declares at least one writable path', writable.length > 0, writable.join(' '));
for (const p of writable) {
  check(`ReadWritePaths=${p} is inside the install prefix`,
    p === PREFIX || p.startsWith(PREFIX + '/'), p);
  const rel = p.slice(PREFIX.length);
  check(`install.sh creates ${p}`,
    new RegExp(`install -d[^\\n]*"\\$PREFIX${rel}"`).test(sh),
    'no install -d line makes this directory');
}

if (fails.length) {
  console.error('\nINSTALLED BACKEND INCOMPLETE: ' + fails.join('; '));
  process.exit(1);
}
console.log('installed backend OK');