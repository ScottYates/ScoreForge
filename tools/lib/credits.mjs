/**
 * lib/credits.mjs - render the sample-pack attribution block.
 *
 * CC BY 3.0 requires the credit to travel with the material, and it obliges
 * you to state what you changed. That makes it a *generated* block rather than
 * prose: the facts live in the SOURCES table in tools/make-pack.mjs, reach the
 * app through pack/manifest.json, and appear in NOTICE.md from here.
 *
 * Rendering it in one place and comparing rather than grepping for strings is
 * the point. A check that looks for "Alexander Holm" in NOTICE.md passes when
 * the licence has been downgraded to CC0 by hand, and passes when the block has
 * been deleted along with the pack that caused it. Regenerating the block and
 * comparing it byte for byte fails on both.
 */

export const BEGIN = '<!-- BEGIN generated credits -->';
export const END = '<!-- END generated credits -->';

/** The licence string that means "you owe nothing", used to spot the rest. */
export const PUBLIC_DOMAIN = 'CC0 1.0 Universal (public domain)';

/** Licences that require a visible credit wherever the work is used. */
export function needsAttribution(licence) {
  return !!licence && licence !== PUBLIC_DOMAIN;
}

/**
 * One row per source library, not per pack. Eight of the nine instruments come
 * from one place, and listing it eight times reads as an error rather than as
 * a credit.
 */
export function bySource(manifest) {
  const out = new Map();
  const credits = manifest.credits || {};
  for (const [packId, inst] of Object.entries(manifest.instruments || {})) {
    for (const c of credits[packId] || []) {
      let e = out.get(c.source);
      if (!e) out.set(c.source, (e = { ...c, usedBy: [] }));
      e.usedBy.push(inst.name);
    }
  }
  return [...out.values()].sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
}

/**
 * The markdown block, markers included.
 *
 * Every value that can change goes through escapeMd, because a title or author
 * name is free text from outside this repository and a stray pipe would break
 * the table it is being rendered into.
 */
export function noticeBlock(manifest) {
  const rows = bySource(manifest);
  const owed = rows.filter((r) => needsAttribution(r.licence));

  const lines = [
    BEGIN,
    '',
    '## Recorded-instrument samples',
    '',
    '`pack/` is built by `tools/make-pack.mjs` from the libraries below. The block',
    'between these two markers is generated from `pack/manifest.json` — edit the',
    '`SOURCES` table in `tools/make-pack.mjs` and rebuild, never this file.',
    '',
    '| Samples | By | Licence | Instruments |',
    '|---|---|---|---|',
  ];
  for (const r of rows) {
    lines.push(
      `| ${escapeMd(r.title)} | ${escapeMd(r.author)} | ${escapeMd(r.licence)} | ` +
      `${r.usedBy.map(escapeMd).sort().join(', ')} |`
    );
  }

  if (owed.length) {
    lines.push('');
    for (const r of owed) {
      lines.push(`\`${r.title}\` is licensed **${escapeMd(r.licence)}** and requires attribution. ` +
        `Author: ${escapeMd(r.author)}. Source: <${r.url}>.`);
      if (r.changes) lines.push('', `Changes made to the recordings: ${r.changes}`);
      lines.push('');
    }
    lines.push(
      'Music made with these samples is covered by the licence above. The sample',
      'recordings themselves remain the property of their authors, and neither the',
      'licence nor their inclusion here implies their endorsement of this project.'
    );
  } else {
    lines.push('', 'Every sample library here is CC0, so none of them requires a credit.');
  }

  lines.push('', END);
  return lines.join('\n');
}

/** Replace the generated block in a NOTICE, or append one if there is none. */
export function applyNoticeBlock(notice, block) {
  const at = notice.indexOf(BEGIN);
  if (at < 0) return notice.replace(/\s*$/, '\n\n') + block + '\n';
  const tail = notice.indexOf(END, at);
  if (tail < 0) return notice; // damaged marker: leave it alone so it is visible
  return notice.slice(0, at) + block + notice.slice(tail + END.length);
}

function escapeMd(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}