/**
 * tools/fetch-freepats.mjs - build a catalogue of the FreePats sound banks.
 *
 * FreePats publishes every bank in three or four encodings of the same audio:
 * SFZ+FLAC (smallest), SFZ+WAV ("Best quality"), SF2, and a "-small" of each.
 * Only one of those is the audio we want, and which one is stated per row in a
 * free-text "Comments" column -- so the choice cannot be made from the filename
 * alone. This reads the comments and records them.
 *
 * The licence is recorded per bank, not assumed for the site. FreePats states
 * CC0 throughout today, but "the project is CC0" is exactly the kind of fact
 * that stops being true when one bank is contributed from elsewhere, and an
 * assumed licence is one nobody re-checks. The text is kept verbatim so a human
 * can see what was actually claimed.
 *
 *   node tools/fetch-freepats.mjs                     catalogue + summary
 *   node tools/fetch-freepats.mjs --json <file>        also write the catalogue
 *   node tools/fetch-freepats.mjs --download --out <dir>
 *   node tools/fetch-freepats.mjs --download --out <dir> --only a,b,c
 *
 * --download fetches each selected bank's archive and unpacks it under
 * <dir>/<slug>/ with 7-Zip. One directory per bank, so parallel downloads own
 * disjoint trees and cannot collide.
 *
 * Fetching in-process rather than page by page is not just about speed: each
 * page carries about 7 KB of identical inline stylesheet, and reading thirty of
 * them by hand fills a context window with CSS and achieves nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ORIGIN = 'https://freepats.zenvoid.org';
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const OUT = flag('json', null);
const DL_DIR = flag('out', null);
const ONLY = (flag('only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const SEVENZ = flag('7z', 'C:\\Users\\scott\\files\\tools\\7zip\\7z.exe');

/**
 * Banks deliberately not taken, and why. Excluding by name rather than by a
 * rule means the reason survives in the repository; "everything except a few
 * big ones" re-decides itself the next time the site adds an instrument.
 *
 * The unpitched sets cannot be played by a pitched sampler at all -- they are
 * percussion instruments with no MIDI key per sample -- and wiring a drum
 * trigger for them is its own project.
 */
const SKIP = {
  'Salamander Grand Piano': 'a duplicate of a library already used here; this copy is 48 kHz/24-bit and 1.2 GiB',
  'MuldjordKit': 'drum kit, unpitched; also the one bank under CC BY 4.0',
  'FreePats General MIDI set': 'whole General MIDI set, GPL, and mostly redundant with the synth banks',
  'FreePats General MIDI percussion set': 'unpitched percussion, GPL',
  'FreePats synthesizer percussion': 'unpitched',
  'World percussion': 'unpitched hand percussion',
};

/** A stable, filesystem-safe id for a bank, used as its directory name. */
function slug(bank) {
  return bank.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const UA = 'ScoreForge sample fetcher (CC0 tooling; contact via github)';

/** Strip tags and collapse whitespace, for prose and comments. */
function text(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/\s+/g, ' ')
    .trim();
}

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return res.text();
}

/** Every instrument page linked from the index, deduped, in document order. */
async function instrumentPages() {
  const html = await get(`${ORIGIN}/index.html`);
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/<a\s+href="([^"]+\.html)"/g)) {
    const href = m[1];
    if (href.startsWith('/') || seen.has(href)) continue;
    if (href === 'index.html' || href === 'about.html' || href === 'links.html') continue;
    seen.add(href);
    out.push(href);
  }
  return out;
}

/**
 * Pull the sub-banks and their download tables off one page.
 *
 * The page is a flat sequence of `<h3 id="...">` headings, each followed by a
 * prose block and a `table.download`. Splitting on the headings is more robust
 * than trying to nest them, because that is genuinely how the document is
 * structured.
 */
function parsePage(url, html) {
  const title = text(/<h2>([\s\S]*?)<\/h2>/.exec(html)?.[1]);
  const banks = [];

  // Keep the heading positions so each section can be bounded by the next one.
  const heads = [...html.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/g)];
  for (let i = 0; i < heads.length; i++) {
    const name = text(heads[i][1]);
    const start = heads[i].index;
    const end = i + 1 < heads.length ? heads[i + 1].index : html.length;
    const section = html.slice(start, end);

    const downloads = [];
    for (const row of section.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
      const body = row[1];
      const href = /href="([^"]+)"/.exec(body)?.[1];
      if (!href) continue; // the header row
      const cells = [...body.matchAll(/<td>([\s\S]*?)<\/td>/g)].map((c) => c[1]);

      // Formats are read from the row's own badges, not from a fixed column.
      // The tables are not uniform: some banks publish four columns with a
      // "Comments" cell and some only three. Indexing cells positionally threw
      // away every three-column bank -- accordion, clarinet, ukulele, pipe
      // organ and more -- with no error, which is worse than a loud failure.
      const formats = [...body.matchAll(/class="format(\w+)"/g)].map((f) => f[1]);
      const blob = cells.map(text);
      const size = blob.find((t) => /\d\s*(KiB|MiB|GiB|kb|mb|gb)/i.test(t)) || '';
      const comment = blob.find((t) => t !== size && !/^SFZ|SF2|WAV|FLAC/.test(t) && t !== text(cells[0])) || '';

      downloads.push({
        file: decodeURIComponent(href.split('/').pop()),
        // Resolve against the PAGE, not the site root. These hrefs are relative
        // to the directory the page lives in -- `ConcertHarp/…tar.xz` on
        // OrchestralStrings/harp.html is under OrchestralStrings/ -- and
        // joining them onto the origin 404s on every one.
        url: new URL(decodeURIComponent(href), `${ORIGIN}/${url}`).href,
        formats,
        size,
        comment,
      });
    }
    if (!downloads.length) continue;

    const prose = text(/<p>([\s\S]*?)<\/p>/.exec(section.slice(0, section.indexOf('<table')))?.[1] || '');
    const licence = /Creative Commons CC0|CC0 1\.0|public domain dedication/i.test(section)
      ? 'CC0 1.0 Universal (public domain)'
      : (/Creative Commons Attribution 4\.0/i.test(section) ? 'CC BY 4.0'
        : (/Creative Commons Attribution 3\.0/i.test(section) ? 'CC BY 3.0' : null));

    banks.push({ name, page: url, licence, prose, downloads });
  }
  return { page: url, title, banks };
}

/**
 * The one row we want: real WAV audio, at the full size.
 *
 * "Best quality" and "-small" appear only in the free-text comments, so the
 * rule is stated as text. A bank with no such row still gets its largest WAV
 * download, because "no small version exists" is not a reason to skip a bank.
 */
function pickWav(bank) {
  const wavs = bank.downloads.filter((d) => d.formats.includes('WAV'));
  if (!wavs.length) return null;
  const best = wavs.find((d) => /best quality/i.test(d.comment) && !/-small/i.test(d.file));
  return best || wavs.find((d) => !/-small/i.test(d.file)) || wavs[0];
}

/* --------------------------------------------------------------- download */

/**
 * Unpack an archive, including through nested layers.
 *
 * FreePats ships `.tar.xz` and `.tar.bz2`, and those are TWO archives deep: 7-Zip
 * peels the xz off, leaving a `.tar`, and stops. Extracting once and then
 * looking for WAVs finds none, and reports the bank as empty -- which looks
 * exactly like a download that failed. So keep going while there is another
 * archive in the tree.
 *
 * `.7z` banks come out in one pass and simply have nothing nested to do.
 */
const ARCHIVE_EXT = /\.(tar|tgz|tar\.gz|tar\.xz|tar\.bz2|7z|zip)$/i;

function extractAll(dir, depth) {
  if (depth > 3) return { ok: false, error: 'archive nested more than 3 deep' };
  fs.mkdirSync(dir, { recursive: true });

  let found = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile() || !ARCHIVE_EXT.test(e.name)) continue;
    found++;
    const target = path.join(dir, `layer${depth}`);
    const x = spawnSync(SEVENZ, ['x', path.join(dir, e.name), `-o${target}`, '-y', '-bso0', '-bsp0'], { encoding: 'utf8' });
    if (x.status !== 0) return { ok: false, error: `7z exited ${x.status} on ${e.name}: ${(x.stderr || '').slice(0, 160)}` };
    const inner = extractAll(target, depth + 1);
    if (!inner.ok) return inner;
  }
  return { ok: true, found };
}

if (DL_DIR) {
  const catPath = path.join(path.dirname(DL_DIR), 'catalogue.json');
  const cat = JSON.parse(fs.readFileSync(flag('catalogue', catPath), 'utf8'));

  let todo = cat.banks.filter((b) => !SKIP[b.bank]);
  if (ONLY.length) {
    const want = new Set(ONLY);
    todo = todo.filter((b) => want.has(slug(b.bank)));
  }
  console.log(`downloading ${todo.length} bank(s) into ${DL_DIR}\n`);

  fs.mkdirSync(DL_DIR, { recursive: true });
  const summary = [];

  for (const bank of todo) {
    const dir = path.join(DL_DIR, slug(bank.bank));
    const archive = path.join(dir, bank.file);
    const done = path.join(dir, 'extracted');
    fs.mkdirSync(dir, { recursive: true });

    // Already fetched? Do not fetch it again -- these are large files and a
    // re-run after one bad bank should not re-download the other forty.
    if (!fs.existsSync(archive)) {
      process.stdout.write(`  ${slug(bank.bank).padEnd(34)} fetching ${bank.size.padStart(10)} ... `);
      const r = await fetch(bank.url, { headers: { 'User-Agent': UA } });
      if (!r.ok) { console.log(`FAILED ${r.status}`); continue; }
      const bytes = Buffer.from(await r.arrayBuffer());
      fs.writeFileSync(archive, bytes);
      console.log(`${(bytes.length / 1048576).toFixed(1)} MiB`);
    } else {
      process.stdout.write(`  ${slug(bank.bank).padEnd(34)} cached ${bank.size.padStart(10)}\n`);
    }

    if (!fs.existsSync(done) || !fs.readdirSync(done).length) {
      fs.mkdirSync(done, { recursive: true });
      const first = spawnSync(SEVENZ, ['x', archive, `-o${done}`, '-y', '-bso0', '-bsp0'], { encoding: 'utf8' });
      if (first.status !== 0) {
        console.log(`    !! 7z exited ${first.status}: ${(first.stderr || '').slice(0, 200)}`);
        continue;
      }
      // Peel anything the first pass left behind -- a .tar inside a .tar.xz.
      const inner = extractAll(done, 0);
      if (!inner.ok) { console.log(`    !! ${inner.error}`); continue; }
    }

    // Where did the WAVs land, and what are they? The archives differ in layout
    // -- some nest samples/ three deep, some put them at the root -- so the
    // directory is discovered rather than assumed.
    const wavs = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.wav$/i.test(e.name)) wavs.push(p);
      }
    })(done);

    const sfz = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.sfz$/i.test(e.name)) sfz.push(p);
      }
    })(done);

    summary.push({
      slug: slug(bank.bank), bank: bank.bank, section: bank.section,
      licence: bank.licence, wavs: wavs.length, sfz: sfz.length,
      dir: path.dirname(wavs[0] || '') || null,
      mebibytes: +(fs.statSync(archive).size / 1048576).toFixed(1),
    });
    console.log(`  ${slug(bank.bank).padEnd(34)} ${String(wavs.length).padStart(4)} wav  ${String(sfz.length).padStart(3)} sfz`);
  }

  const listFile = path.join(DL_DIR, 'downloaded.json');
  const prior = fs.existsSync(listFile) ? JSON.parse(fs.readFileSync(listFile, 'utf8')) : [];
  const merged = new Map([...prior, ...summary].map((r) => [r.slug, r]));
  fs.writeFileSync(listFile, JSON.stringify([...merged.values()], null, 2));

  console.log(`\n${summary.length} bank(s) in this run, ${merged.size} total`);
  console.log(`wav files: ${[...merged.values()].reduce((a, b) => a + b.wavs, 0)}`);
  const empty = [...merged.values()].filter((r) => !r.wavs);
  if (empty.length) console.log(`\n!! no WAVs found in: ${empty.map((r) => r.slug).join(', ')}`);
  process.exit(0);
}

const pages = await instrumentPages();
console.log(`${pages.length} instrument pages on ${ORIGIN}\n`);

const catalogue = [];
let wavBanks = 0, skipped = [];
for (const p of pages) {
  let page;
  try {
    page = parsePage(p, await get(`${ORIGIN}/${p}`));
  } catch (e) {
    console.warn(`  !! ${p}: ${e.message}`);
    continue;
  }
  for (const bank of page.banks) {
    const wav = pickWav(bank);
    if (!wav) { skipped.push(`${bank.name} (${p}) — no WAV download`); continue; }
    wavBanks++;
    catalogue.push({
      bank: bank.name,
      section: page.title,
      page: `${ORIGIN}/${p}`,
      licence: bank.licence,
      file: wav.file,
      url: wav.url,
      size: wav.size,
      comment: wav.comment,
      alternatives: bank.downloads.filter((d) => d !== wav).map((d) => `${d.formats.join('+')} ${d.size}`),
    });
  }
}

const licenceTally = {};
for (const b of catalogue) licenceTally[b.licence || 'UNSTATED'] = (licenceTally[b.licence || 'UNSTATED'] || 0) + 1;

console.log(`found ${catalogue.length} banks with a WAV download (of ${pages.length} pages)\n`);
console.log('licence as stated on the page:');
for (const [k, v] of Object.entries(licenceTally).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);

console.log('\nby section:');
const bySection = new Map();
for (const b of catalogue) {
  if (!bySection.has(b.section)) bySection.set(b.section, []);
  bySection.get(b.section).push(b);
}
for (const [sec, list] of bySection) {
  console.log(`\n  ${sec}  (${list.length})`);
  for (const b of list) console.log(`    ${b.bank.padEnd(30)} ${String(b.size).padStart(9)}  ${b.file}`);
}

if (skipped.length) {
  console.log('\nno WAV download:');
  for (const s of skipped) console.log(`  ${s}`);
}

const unknown = catalogue.filter((b) => !b.licence);
if (unknown.length) {
  console.log(`\n!! ${unknown.length} bank(s) do not state a licence on their page -- read them before use:`);
  for (const b of unknown) console.log(`   ${b.bank}  ${b.page}`);
}

if (OUT) {
  fs.writeFileSync(OUT, JSON.stringify({ fetched: new Date().toISOString(), origin: ORIGIN, banks: catalogue }, null, 2));
  console.log(`\ncatalogue written to ${OUT}`);
}