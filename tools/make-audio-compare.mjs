/**
 * tools/make-audio-compare.mjs - build the WAV vs MP3 comparison page.
 *
 * The point of this is to separate two questions that have been tangled up:
 * does the browser play the recording, and does the MP3 survive the conversion?
 *
 * So the MP3 here is encoded from the ORIGINAL WAV and nothing else happens in
 * between. No silence trimmed, no 1024-sample marker prepended, no peak
 * normalisation to a family target, no resampling, no loop points. Those are all
 * things the pack builder does, and each of them is a reason a packed file can
 * sound different from its source -- but they are not the encoder's fault, and
 * burying a conversion test inside that pipeline proves nothing.
 *
 *   node tools/make-audio-compare.mjs <wav> [--kbps 192]
 *
 * The WAV is copied byte for byte and kept as the reference. The output lands in
 * docs/audio-compare/, which is served over http by the README's one-liner.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWav, peakOf } from './lib/wav.mjs';
import { encodeMp3 } from './lib/lame.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// One level up, not two: this file sits in tools/, and tools/lib/lame.mjs goes
// up twice because IT sits in tools/lib. Getting this wrong writes the whole
// output tree outside the repository while still reporting success.
const repo = path.resolve(here, '..');

const args = process.argv.slice(2);
const src = args.find((a) => !a.startsWith('--'));
if (!src) {
  console.error('usage: node tools/make-audio-compare.mjs <wav> [--kbps 192]');
  process.exit(1);
}
const kbpsArg = args.indexOf('--kbps');
const KBPS = kbpsArg >= 0 ? Number(args[kbpsArg + 1]) : 192;
const nameArg = args.indexOf('--name');
// A download or a chat attachment arrives called
// 00-30-54-780-asset_20261010-003054-780_<guid>-A2vL.wav, which is not a name
// anyone wants to read on a button. The real sample name is the last token
// before the extension.
const stem = nameArg >= 0
  ? args[nameArg + 1]
  : (path.basename(src).replace(/\.wav$/i, '').match(/([A-Za-z][A-Za-z0-9#-]*)$/) || [null, 'sample'])[1];

const OUT = path.join(repo, 'docs', 'audio-compare');
fs.mkdirSync(OUT, { recursive: true });

// The reference, untouched. Not re-read, not re-written, not normalised.
const raw = fs.readFileSync(src);
const wav = readWav(raw);
const base = stem;

const wavName = `${base}-original.wav`;
const mp3Name = `${base}-direct-${KBPS}k.mp3`;

fs.writeFileSync(path.join(OUT, wavName), raw);
const mp3 = encodeMp3(wav.data, wav.sampleRate, KBPS);
fs.writeFileSync(path.join(OUT, mp3Name), mp3);

const secs = wav.frames / wav.sampleRate;
console.log(`reference   ${wavName}`);
console.log(`  ${wav.sampleRate} Hz, ${wav.channels} ch, ${secs.toFixed(3)} s, `
  + `${wav.data[0].constructor.name}, peak ${peakOf(wav).toFixed(5)}`);
console.log(`  ${raw.length} bytes copied byte for byte from ${src}`);
console.log(`conversion  ${mp3Name}`);
console.log(`  encoded from the same ${wav.sampleRate} Hz PCM at ${KBPS} kbps, ${mp3.length} bytes`);
console.log(`  ${secs.toFixed(3)} s of audio in, ${(secs * KBPS * 1000 / 8 / 1024).toFixed(1)} KB out at that bitrate`);
console.log(`  nothing else was done to it: no trim, no normalisation, no resample, no marker`);
console.log(`\npage        docs/audio-compare/index.html`);

// --serve keeps a static server on the folder and prints the address. The page
// fetches its audio, and a page opened from file:// cannot fetch anything, so
// it has to be served -- the same rule the app itself has.
if (args.includes('--serve')) {
  const MIME = { '.html': 'text/html; charset=utf-8', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' };
  const server = http.createServer((req, res) => {
    const file = path.join(OUT, path.basename(new URL(req.url, 'http://x').pathname));
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  server.listen(8731, '127.0.0.1', () => {
    console.log(`serving     http://127.0.0.1:8731/   (ctrl-c to stop)`);
  });
}