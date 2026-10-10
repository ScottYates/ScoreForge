/**
 * tools/lib/guard.mjs — the only place in this repository that may delete anything.
 *
 * Two rules, both of them refusals:
 *
 *   1. Never delete something this repository did not create.
 *   2. Never delete anything outside the working folder.
 *
 * Both are enforced at the point of deletion rather than trusted to review,
 * because a guardrail that only exists as an intention is one refactor away from
 * deleting a cache directory that took an afternoon to rebuild.
 *
 * A directory is deletable only if it carries the marker this module writes when
 * the directory is created. That marker is the receipt: no marker, no delete --
 * including for a path that looks exactly like somewhere this repo writes, since
 * "looks like our output" is how a stray branch deletes the user's own folder.
 *
 * This module is deliberately the only file allowed to call a delete API.
 * tools/check-no-unguarded-deletes.mjs fails the build if any other file under
 * tools/ does, which is what keeps the rules from decaying into convention.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The receipt written into every directory this repository creates. */
export const MARKER = '.scoreforge-owned';

/** The working folder: the repository root. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * True when `child` is `parent` or lives under it.
 *
 * Compared on resolved paths with a trailing separator so that a sibling with a
 * shared prefix cannot pass: `C:\...\docs-archive` is not inside `C:\...\docs`.
 */
function contains(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolve `p` and refuse it unless it is inside the working folder.
 *
 * Returns the resolved path so callers use the value that was checked rather than
 * the string they passed in -- the gap between those two is where a `..` segment
 * turns a checked path into an unchecked one.
 */
export function assertInWorkspace(p, why = 'delete') {
  const abs = path.resolve(p);
  if (!contains(ROOT, abs)) {
    throw new Error(
      `refusing to ${why} ${abs}\n` +
      `  it is outside the working folder (${ROOT}).\n` +
      `  If this really is ours, claim it first with claimTree(), which is the only\n` +
      `  way a directory earns a deletion.`
    );
  }
  // The working folder itself is never deletable, even though it is "inside"
  // itself. Deleting it would take the repository, the guard and this check with it.
  if (abs === ROOT) {
    throw new Error(`refusing to ${why} the working folder itself (${ROOT})`);
  }
  return abs;
}

/**
 * Create `dir` and mark it as ours, ready to be replaced by a later run.
 *
 * Anything already inside is left alone until removeOwnedTree() is called: this
 * only guarantees the marker exists, it does not delete.
 */
export function claimTree(dir, note = '') {
  const abs = assertInWorkspace(dir, 'create');
  fs.mkdirSync(abs, { recursive: true });
  fs.writeFileSync(
    path.join(abs, MARKER),
    [
      `Created by ScoreForge tooling.`,
      note,
      `Deleting this directory is safe; nothing here was not written by that run.`,
      `Do not put hand-written files in a claimed tree -- removeOwnedTree() takes`,
      `the whole directory.`,
      ``,
    ].join('\n'),
    'utf8'
  );
  return abs;
}

/** True when `dir` exists and carries our marker. */
export function isOwned(dir) {
  try {
    return fs.statSync(path.join(path.resolve(dir), MARKER)).isFile();
  } catch {
    return false;
  }
}

/**
 * Delete `dir` recursively, but only if it is ours and inside the working folder.
 *
 * Throws rather than returning a boolean: every caller here is a build step whose
 * next action is to write into the directory, so a silently skipped delete turns
 * into stale files being carried into the output and reported as fresh ones.
 */
export function removeOwnedTree(dir, why = 'remove') {
  const abs = assertInWorkspace(dir, why);
  if (!isOwned(abs)) {
    throw new Error(
      `refusing to ${why} ${abs}\n` +
      `  no ${MARKER} marker, so this directory was not created by this repository.\n` +
      `  If it is genuinely ours, call claimTree() where it is created.`
    );
  }
  fs.rmSync(abs, { recursive: true, force: true });
  return abs;
}