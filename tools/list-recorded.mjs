/**
 * tools/list-recorded.mjs - what is actually in the recorded sample pack.
 *
 * Everything here is read out of pack/manifest.json and the pack directory, so
 * the list describes the files that shipped rather than what the roster claims.
 *
 *   node tools/list-recorded.mjs            markdown, grouped as the picker groups it
 *   node tools/list-recorded.mjs --tsv      tab separated, for a spreadsheet
 */
import fs from 'node:fs';
import path from 'node:path';
import { FREEPATS_BANKS, groupFor } from './freepats-banks.mjs';

const root = process.cwd();
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'pack/manifest.json'), 'utf8'));

// Which group each pack appears under in the picker. The nine original families
// are all one "Recorded" group; the FreePats banks were given six.
const GROUP = new Map();
for (const b of FREEPATS_BANKS) GROUP.set(b.pack, groupFor(b.pack));
for (const id of Object.keys(manifest.instruments)) {
  if (!GROUP.has(id)) GROUP.set(id, 'Recorded');
}

const dirBytes = (pack) => {
  const dir = path.join(root, 'pack', pack);
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(dir)) n += fs.statSync(path.join(dir, f)).size;
  return n;
};

const rows = [];
for (const [id, inst] of Object.entries(manifest.instruments)) {
  const keys = Object.keys(inst.notes).map(Number);
  const lo = Math.min(...keys), hi = Math.max(...keys);

  // A key counts as real when its take needs no resampling: the rate is within
  // half a semitone of 1. Anything else is a neighbouring sample transposed, and
  // "how far" is what the pitch-shift column reports.
  let real = 0, worst = 0;
  for (const k of keys) {
    const r = inst.notes[k].rate || 1;
    const semis = Math.abs(12 * Math.log2(r));
    if (semis < 0.5) real++;
    if (semis > worst) worst = semis;
  }

  let files = new Set(), loops = 0;
  for (const k of keys) {
    for (const h of inst.notes[k].hits) {
      files.add(h.f);
      if (h.loop) loops++;
    }
  }

  rows.push({
    pack: id,
    name: inst.name,
    group: GROUP.get(id) || 'Recorded',
    lo, hi, covered: keys.length, real,
    shifted: keys.length - real,
    worst: worst < 0.5 ? 0 : worst,
    stereo: !!inst.stereo,
    loop: !!inst.sustains,
    files: files.size,
    bytes: dirBytes(id),
    licence: (manifest.credits?.[id] || []).map((c) => c.licence).join(' + '),
  });
}

const mib = (b) => (b / 1048576).toFixed(2);
const tsv = process.argv.includes('--tsv');

if (tsv) {
  console.log(['pack', 'name', 'group', 'lo', 'hi', 'keys', 'real', 'shifted', 'maxShift', 'stereo', 'loops', 'files', 'MiB', 'licence'].join('\t'));
  for (const r of rows.sort((a, b) => a.group.localeCompare(b.group) || a.lo - b.lo)) {
    console.log([r.pack, r.name, r.group, r.lo, r.hi, r.covered, r.real, r.shifted,
      r.worst.toFixed(1), r.stereo, r.loop, r.files, mib(r.bytes), r.licence].join('\t'));
  }
} else {
  const byGroup = new Map();
  for (const r of rows) {
    if (!byGroup.has(r.group)) byGroup.set(r.group, []);
    byGroup.get(r.group).push(r);
  }
  for (const [group, list] of byGroup) {
    list.sort((a, b) => a.lo - b.lo || a.name.localeCompare(b.name));
    console.log(`\n### ${group}  (${list.length})`);
    console.log('| Instrument | Pack | Range | Real takes | Max shift | | Loops | Files | MiB |');
    console.log('|---|---|---|---|---|---|---|---|---|');
    for (const r of list) {
      console.log(
        `| ${r.name} | \`${r.pack}\` | ${r.lo}–${r.hi} | ${r.real}/${r.covered} | ` +
        `${r.worst ? r.worst.toFixed(1) + ' st' : '—'} | ${r.stereo ? 'stereo' : 'mono'} | ` +
        `${r.loop ? 'yes' : 'no'} | ${r.files} | ${mib(r.bytes)} |`
      );
    }
  }
  const totalBytes = rows.reduce((a, r) => a + r.bytes, 0);
  const totalReal = rows.reduce((a, r) => a + r.real, 0);
  const totalKeys = rows.reduce((a, r) => a + r.covered, 0);
  console.log(`\n**${rows.length} instruments · ${totalBytes / 1048576 < 1024
    ? mib(totalBytes) + ' MB' : (totalBytes / 1073741824).toFixed(2) + ' GB'} · ` +
    `${totalReal}/${totalKeys} keys are real takes · ` +
    `${rows.filter((r) => !/CC0/.test(r.licence)).length} owe a credit**`);
}