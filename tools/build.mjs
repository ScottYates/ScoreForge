/**
 * tools/build.mjs — bundle everything into ONE self-contained .html file.
 *
 *   node tools/build.mjs            production build
 *   node tools/build.mjs --dev      readable output, for debugging
 *
 * No network at runtime: the notation engine, the MP3 encoder, the zip reader
 * and every instrument are all inlined here.
 */
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// import.meta.dirname needs Node 20.11; from the module URL it works on 18 too.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dev = process.argv.includes('--dev');
const outFile = path.join(root, 'ScoreForge.html');

const t0 = Date.now();

const bundle = await esbuild.build({
  entryPoints: [path.join(root, 'src/js/main.js')],
  bundle: true,
  format: 'iife',
  target: ['chrome100', 'edge100', 'firefox100', 'safari15'],
  minify: !dev,
  sourcemap: false,
  write: false,
  legalComments: 'none',
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"production"' },
});

const appJs = bundle.outputFiles[0].text;

// The notation engine and the MP3 encoder are already minified browser bundles
// that must not be re-bundled: OSMD is UMD, and lamejs only works in its
// pre-concatenated form (its internal files share one module scope).
const vendorFiles = [
  'node_modules/opensheetmusicdisplay/build/opensheetmusicdisplay.min.js',
  'node_modules/lamejs/lame.min.js',
];
const vendor = vendorFiles.map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n;\n');

const cssRaw = fs.readFileSync(path.join(root, 'src/styles/app.css'), 'utf8');
const css = (await esbuild.transform(cssRaw, { loader: 'css', minify: !dev })).code;

const template = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');

/**
 * A literal `</script` inside a JS string terminates the script element, so any
 * occurrence has to be escaped even though it is inside a string in our source.
 */
const guard = (s) => s.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');

const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || '0.0.0';
const banner = `/*! ScoreForge ${version} — sheet music to MP3, entirely in this file. */`;

const html = template
  .replace('/*{{CSS}}*/', () => banner + '\n' + css)
  .replace('/*{{VENDOR}}*/', () => guard(vendor))
  .replace('/*{{APP}}*/', () => guard(appJs));

fs.writeFileSync(outFile, html, 'utf8');

const kb = (n) => (n / 1024).toFixed(0).padStart(6) + ' KB';
console.log(`built ScoreForge.html  ${kb(Buffer.byteLength(html))}`);
console.log(`  app ${kb(appJs.length)} · vendor ${kb(vendor.length)} · css ${kb(css.length)} · template ${kb(template.length)}`);
console.log(`  ${Date.now() - t0} ms${dev ? ' (dev — not minified)' : ''}`);