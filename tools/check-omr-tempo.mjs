/**
 * tools/check-omr-tempo.mjs - does the tempo-text reader turn the words on a
 * page into the tempo they mean, and write it where a parser will find it?
 *
 * The failure it guards: the notes engine ignores words, so every scan came
 * back with no tempo and played at the app's default -- a page marked
 * "Adagio sostenuto." at roughly double speed. The contract, from
 * backend/tempo_text.py:
 *
 *   - a printed metronome number ("M.M. = 92") outranks any term, within the
 *     range a metronome can plausibly print -- an opus number or page header
 *     digit must not become a tempo;
 *   - among terms, the longest match wins ("adagio sostenuto" is not
 *     "adagio"), case- and punctuation-blind, whole words only ("allegrost"
 *     is nothing);
 *   - injection writes one direction with <words> and <sound tempo> before
 *     the first note, and a document that already declares any tempo is
 *     returned untouched.
 *
 * Pure python3 standard library, so it runs on CI and depless machines; the
 * OCR half lives next to homr's own title detection and is exercised on a
 * real host.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

const PY = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(root, 'backend'))})
import xml.etree.ElementTree as ET
from tempo_text import detect_tempo, inject_tempo

cases = {}
cases['moonlight'] = detect_tempo(['SONATE.', 'Op.27. No 2.', 'Adagio sostenuto.',
                                   'Si deve suonare tutto questo pezzo delicatissimamente e senza sordini.'])
cases['stem_not_qualified'] = detect_tempo(['Adagio.'])
cases['metronome_wins'] = detect_tempo(['Allegro (M.M. = 92)'])
cases['opus_digits_ignored'] = detect_tempo(['Op. 27 No. 2', 'page 248'])
cases['implausible_mark'] = detect_tempo(['= 248', 'Largo'])
cases['word_boundary'] = detect_tempo(['Allegrostrasse 12'])
cases['nothing'] = detect_tempo(['The pedal indications are the composers'])
# OCR often splits a heading across boxes; the qualified term on a LATER line
# must still beat the stem found earlier -- longest match, not first match.
cases['longest_across_lines'] = detect_tempo(['Allegro', 'Allegro ma non troppo'])

xml = ('<?xml version="1.0"?><score-partwise version="4.0">'
       '<part-list><score-part id="P1"><part-name>x</part-name></score-part></part-list>'
       '<part id="P1"><measure number="1">'
       '<attributes><divisions>12</divisions></attributes>'
       '<note><pitch><step>C</step><octave>4</octave></pitch><duration>12</duration></note>'
       '</measure></part></score-partwise>')
injected = inject_tempo(xml, 54, 'Adagio sostenuto')
root_el = ET.fromstring(injected)
measure = root_el.find('part').find('measure')
children = [c.tag for c in measure]
snd = measure.find('.//sound')
cases['inject'] = {
    'order': children,
    'tempo': snd.get('tempo') if snd is not None else None,
    'words': measure.findtext('.//words'),
}
cases['inject_respects_existing'] = inject_tempo(injected, 200, 'Presto') == injected

print(json.dumps(cases))
`;

const r = spawnSync('python3', ['-c', PY], { encoding: 'utf8', timeout: 120000 });
if (r.status !== 0) {
  console.error('check-omr-tempo: python failed');
  console.error(r.stderr || r.stdout);
  process.exit(1);
}
const c = JSON.parse(r.stdout.trim().split('\n').pop());

let failed = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) failed++;
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${detail ? '  — ' + detail : ''}`);
};

ok('the Moonlight heading reads as Adagio sostenuto, not Adagio',
  c.moonlight && c.moonlight.matched === 'adagio sostenuto' && c.moonlight.bpm === 54,
  JSON.stringify(c.moonlight));
ok('the bare stem keeps its own value', c.stem_not_qualified && c.stem_not_qualified.bpm === 64,
  JSON.stringify(c.stem_not_qualified));
ok('a printed metronome number outranks the term',
  c.metronome_wins && c.metronome_wins.source === 'metronome mark' && c.metronome_wins.bpm === 92,
  JSON.stringify(c.metronome_wins));
ok('opus and page digits are not a tempo', c.opus_digits_ignored === null, JSON.stringify(c.opus_digits_ignored));
ok('an implausible mark falls through to the term',
  c.implausible_mark && c.implausible_mark.matched === 'largo', JSON.stringify(c.implausible_mark));
ok('terms match whole words only', c.word_boundary === null, JSON.stringify(c.word_boundary));
ok('a page with no tempo text says so', c.nothing === null, JSON.stringify(c.nothing));
ok('a qualified term on a later line beats the stem found first',
  c.longest_across_lines && c.longest_across_lines.matched === 'allegro ma non troppo'
    && c.longest_across_lines.bpm === 118, JSON.stringify(c.longest_across_lines));
ok('injection lands before the first note with words and tempo',
  c.inject.order.join(',') === 'attributes,direction,note' && c.inject.tempo === '54'
    && c.inject.words === 'Adagio sostenuto', JSON.stringify(c.inject));
ok('a document that already declares a tempo is untouched', c.inject_respects_existing === true);

console.log(`\n${failed ? 'omr tempo FAILED' : 'omr tempo OK'}`);
process.exit(failed ? 1 : 0);
