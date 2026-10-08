/**
 * tools/run-suites.mjs — run every module test suite and report one verdict.
 *
 * The suites publish a uniform `window.__RESULT__` of `{passCount, failCount,
 * fatal}`, so there is one rule here rather than four output formats to parse.
 * Used by CI, and useful locally.
 *
 *   node tools/run-suites.mjs
 *   node tools/run-suites.mjs musicxml-test smf-test
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(import.meta.dirname, '..');
const cdp = path.join(root, 'tools/cdp.mjs');

const ALL = ['musicxml-test', 'smf-test', 'instruments-test', 'mscx-test'];
const suites = process.argv.slice(2).length ? process.argv.slice(2) : ALL;

function fileUrl(abs) {
  // pathToFileURL would be tidier, but this repo targets Node's global fetch/WebSocket
  // set anyway; keep the transformation explicit and platform-correct.
  const p = abs.replace(/\\/g, '/');
  return 'file:///' + (p.startsWith('/') ? p : '/' + p);
}

function runSuite(name) {
  return new Promise((res) => {
    const page = path.join(root, 'tests', `${name}.html`);
    if (!fs.existsSync(page)) return res({ name, error: 'test page not found' });
    const p = spawn(process.execPath, [
      cdp,
      '--url', fileUrl(page),
      '--wait', 'window.__DONE__===true',
      '--timeout', '180000',
      '--eval', 'JSON.stringify(window.__RESULT__ || null)',
    ], { cwd: root, stdio: 'pipe' });

    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => {
      let envelope = null;
      try { envelope = JSON.parse(out); } catch { /* reported below */ }
      if (!envelope || !envelope.ready) {
        return res({ name, error: `harness did not complete (exit ${code})`, out, err });
      }
      let result = null;
      try { result = JSON.parse(envelope.value); } catch { /* reported below */ }
      if (!result) return res({ name, error: 'suite published no verdict', out, err });
      // A verdict with no counts is not a pass. Treating it as success would let
      // a suite that renamed its output field report green forever.
      if (typeof result.passed !== 'number' || typeof result.failed !== 'number') {
        return res({ name, error: `verdict missing passed/failed counts: ${JSON.stringify(result).slice(0, 160)}` });
      }
      res({ name, result });
    });
  });
}

const rows = [];
for (const name of suites) {
  const r = await runSuite(name);
  rows.push(r);
  if (r.error) {
    console.log(`${name.padEnd(18)} ERROR  ${r.error}`);
    if (r.err) console.log(r.err.split('\n').slice(0, 6).join('\n'));
  } else {
    const { passed, failed, fatal } = r.result;
    console.log(`${name.padEnd(18)} ${String(passed).padStart(4)} passed  ${failed} failed` +
      (fatal ? `  FATAL ${String(fatal).split('\n')[0]}` : ''));
    for (const f of (r.result.failures || []).slice(0, 8)) console.log(`    ${f}`);
  }
}

const bad = rows.filter((r) => r.error || r.result.failed > 0 || r.result.fatal);
// A suite that ran zero checks is not a pass -- it is a suite that silently
// stopped testing anything.
const empty = rows.filter((r) => !r.error && r.result.passed === 0);
for (const e of empty) console.log(`${e.name.padEnd(18)} WARN   reported 0 passing checks`);

const passed = rows.reduce((a, r) => a + (r.result?.passed || 0), 0);
const failed = rows.reduce((a, r) => a + (r.result?.failed || 0), 0);
console.log('-'.repeat(52));
console.log(`${rows.length} suites · ${passed} passed · ${failed} failed`);

if (bad.length) {
  console.error(`SUITES FAILED: ${bad.map((b) => b.name).join(', ')}`);
  process.exit(1);
}
console.log('SUITES OK');