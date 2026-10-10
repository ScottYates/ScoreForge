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
import { fileURLToPath } from 'node:url';

// import.meta.dirname needs Node 20.11; from the module URL it works on 18 too.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cdp = path.join(root, 'tools/cdp.mjs');

// The suites run in headless Chrome over the DevTools protocol, which needs the
// global WebSocket Node gained in 22. Say that, instead of four suites each
// failing for a reason that has nothing to do with them.
if (typeof WebSocket === 'undefined') {
  console.error(
    `npm run test:suites needs Node 22 or newer: the global WebSocket it uses to reach\n` +
    `Chrome is not defined on Node ${process.versions.node}. Building with Node 18 is\n` +
    `fine -- only the browser-driven checks need the newer runtime.`
  );
  process.exit(2);
}

const ALL = ['musicxml-test', 'smf-test', 'instruments-test', 'mscx-test', 'omr-test', 'sampler-test', 'routing-test'];
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
      '--eval', "JSON.stringify({result:window.__RESULT__||null,text:document.getElementById('out').textContent})",
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
      let payload = null;
      try { payload = JSON.parse(envelope.value); } catch { /* reported below */ }
      const result = payload?.result;
      const text = payload?.text || '';
      if (!result) return res({ name, error: 'suite published no verdict', out, err });
      // A verdict with no counts is not a pass. Treating it as success would let
      // a suite that renamed its output field report green forever.
      if (typeof result.passed !== 'number' || typeof result.failed !== 'number') {
        return res({ name, error: `verdict missing passed/failed counts: ${JSON.stringify(result).slice(0, 160)}` });
      }
      // "1 failed" with no indication which is not actionable. Pull the failing
      // lines out of the page text -- the suites print "FAIL <name>  — <detail>".
      const failing = (result.failures || []).map(String);
      const fromText = text.split('\n').filter((l) => /^\s*FAIL\b/.test(l)).map((l) => l.trim());
      res({ name, result, failures: [...new Set([...failing, ...fromText])] });
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
    for (const f of (r.failures || []).slice(0, 10)) console.log(`    ${f}`);
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