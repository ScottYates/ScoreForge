/**
 * tools/check-omr-triplets.mjs - does the triplet repair fix exactly what the
 * numbers prove, and nothing else?
 *
 * The failure it guards (seen on a real Moonlight sonata scan): engravers
 * print the "3" over the first triplet group of a passage; the recogniser
 * marks the groups it saw a digit over and reads the rest as straight
 * eighths, so every such bar comes back half again too long and the piece is
 * rhythmic rubble with nearly every pitch correct.
 *
 * The contract under test, from backend/triplets.py:
 *   - a bar whose voices add up is never touched;
 *   - an overfull bar is repaired only when whole groups of three equal,
 *     unmarked notes account for the overflow EXACTLY, converting just
 *     enough of a run and leaving the rest;
 *   - chords count once; rests and already-marked groups are never converted;
 *   - a bar whose overflow has no exact 3:2 explanation is left byte-for-byte
 *     alone and named in the report, because shrinking an error is not
 *     fixing it.
 *
 * Pure python3 standard library, so it runs on CI and on machines with no
 * backend stack at all.
 */
import { spawnSync } from 'node:child_process';
// Also under test here: enforce_meter(), the policy pass that holds every
// scanned bar to its printed length after the exact repairs have done what
// arithmetic can prove. See backend/triplets.py.
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

const PY = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(root, 'backend'))})
import xml.etree.ElementTree as ET
from triplets import repair_triplets, enforce_meter, merge_consensus

def doc(measures):
    return ('<?xml version="1.0"?><score-partwise version="4.0">'
            '<part-list><score-part id="P1"><part-name>x</part-name></score-part></part-list>'
            '<part id="P1">' + measures + '</part></score-partwise>')

ATTRS = ('<attributes><divisions>12</divisions>'
         '<time><beats>2</beats><beat-type>2</beat-type></time></attributes>')

def note(dur, voice='1', chord=False, marked=False, rest=False):
    body = '<rest/>' if rest else '<pitch><step>C</step><octave>4</octave></pitch>'
    return ('<note>' + ('<chord/>' if chord else '') + body +
            '<duration>%d</duration><voice>%s</voice>' % (dur, voice) +
            ('<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>' if marked else '') +
            '</note>')

def voice_sums(xml):
    out = []
    for m in ET.fromstring(xml).find('part').findall('measure'):
        by = {}
        for n in m.findall('note'):
            if n.find('chord') is not None: continue
            v = n.findtext('voice') or '1'
            by[v] = by.get(v, 0) + int(n.findtext('duration'))
        out.append(by)
    return out

def marked_count(xml):
    return xml.count('<time-modification>') + xml.count('<time-modification />')

cases = {}

# 1. The Moonlight shape: a 2/2 bar of 12 unmarked "eighths" (should be 12
#    triplet eighths), plus a correct whole-note voice. Overflow 24, exactly
#    four triplet groups: all twelve convert and the bar lands on 48.
m = ATTRS + ''.join(note(6) for _ in range(12)) + note(48, voice='2')
fixed, rep = repair_triplets(doc('<measure number="1">' + m + '</measure>'))
cases['moonlight_bar'] = {
    'sums': voice_sums(fixed), 'report': rep.as_dict(), 'marked': marked_count(fixed),
}

# 2. A bar that adds up is untouched, byte for byte.
ok_bar = doc('<measure number="1">' + ATTRS + ''.join(note(6) for _ in range(8)) + '</measure>')
fixed2, rep2 = repair_triplets(ok_bar)
cases['clean_bar'] = {'untouched': fixed2 == ok_bar, 'report': rep2.as_dict()}

# 3. Partial repair: 9 straight "eighths" where the overflow is one group's
#    worth -- exactly one group of three converts, six notes stay straight.
m3 = ATTRS + ''.join(note(6) for _ in range(9))   # sum 54, nominal 48, overflow 6 = d
fixed3, rep3 = repair_triplets(doc('<measure number="1">' + m3 + '</measure>'))
cases['partial'] = {'sums': voice_sums(fixed3), 'marked': marked_count(fixed3), 'report': rep3.as_dict()}

# 4. Inexact overflow refuses -- even with a convertible run present. Nine
#    unmarked eighths offer savings in steps of 6; a stray duration-3 note
#    makes the overflow 9, which no combination of whole groups reaches, so
#    the bar must come back byte for byte, not "improved" by 6.
m4 = ATTRS + ''.join(note(6) for _ in range(9)) + note(3)
raw4 = doc('<measure number="7">' + m4 + '</measure>')
fixed4, rep4 = repair_triplets(raw4)
cases['inexact'] = {'untouched': fixed4 == raw4, 'report': rep4.as_dict()}

# 5. Chords count once; a chord-y run converts as groups of onsets.
m5 = ATTRS + ''.join(note(6) + note(6, chord=True) for _ in range(12))
fixed5, rep5 = repair_triplets(doc('<measure number="1">' + m5 + '</measure>'))
cases['chords'] = {'sums': voice_sums(fixed5), 'report': rep5.as_dict()}

# 6. Already-marked groups are never converted again: six correct triplet
#    quarters (24) plus six unmarked straight eighths (36) overflow by 12 --
#    exactly two unmarked groups -- so the unmarked six convert and the
#    marked six keep their duration of 4.
m6 = ATTRS + ''.join(note(4, marked=True) for _ in range(6)) + ''.join(note(6) for _ in range(6))
fixed6, rep6 = repair_triplets(doc('<measure number="1">' + m6 + '</measure>'))
dur4 = fixed6.count('<duration>4</duration>')
cases['respects_marked'] = {'sums': voice_sums(fixed6), 'report': rep6.as_dict(),
                            'marked': marked_count(fixed6), 'dur4': dur4}

# 7. A marked note whose duration was never adjusted is a contradiction in
#    the input -- converting it again on top of its marking would halve it.
#    The pass trusts the marking, counts the note out, and so refuses.
m7 = ATTRS + ''.join(note(6, marked=True) for _ in range(12))
raw7 = doc('<measure number="9">' + m7 + '</measure>')
fixed7, rep7 = repair_triplets(raw7)
cases['marked_unadjusted'] = {'untouched': fixed7 == raw7, 'report': rep7.as_dict()}

# --- meter enforcement: a scanned bar keeps its printed length ----------
# 8. The unrepairable overfull bar: clipped at the barline, with the clip
#    counted -- not stretched into the neighbouring bars' time.
m8 = ATTRS + ''.join(note(6) for _ in range(9)) + note(3)
fixed8, _r8 = repair_triplets(doc('<measure number="7">' + m8 + '</measure>'))
fixed8, met8 = enforce_meter(fixed8)
cases['meter_clip'] = {'sums': voice_sums(fixed8), 'report': met8.as_dict()}

# 9. A straddling note is shortened to fit, not dropped.
m9 = ATTRS + note(24) + note(36)
fixed9, met9 = enforce_meter(doc('<measure number="3">' + m9 + '</measure>'))
cases['meter_trim'] = {'sums': voice_sums(fixed9), 'report': met9.as_dict()}

# 10. A short voice is padded with an explicit rest, so a lost beat becomes
#     a silent beat instead of a shortened bar.
m10 = ATTRS + ''.join(note(6) for _ in range(4))
fixed10, met10 = enforce_meter(doc('<measure number="4">' + m10 + '</measure>'))
root10 = ET.fromstring(fixed10)
rests = [n for n in root10.iter('note') if n.find('rest') is not None]
cases['meter_pad'] = {'sums': voice_sums(fixed10), 'rests': len(rests),
                      'rest_dur': rests[-1].findtext('duration') if rests else None,
                      'report': met10.as_dict()}

# 11. A bar that already adds up is untouched byte for byte.
ok11 = doc('<measure number="1">' + ATTRS + ''.join(note(6) for _ in range(8)) + '</measure>')
fixed11, met11 = enforce_meter(ok11)
cases['meter_clean'] = {'untouched': fixed11 == ok11,
                        'empty_report': met11.as_dict() == {'barsClipped': [], 'barsPadded': [],
                                                            'notesDropped': 0, 'notesTrimmed': 0, 'restsAdded': 0}}

# --- per-bar consensus across the page's other readings -----------------
def pnote(d, p='C'):
    return ('<note><pitch><step>%s</step><octave>4</octave></pitch>'
            '<duration>%d</duration><voice>1</voice></note>' % (p, d))
def rnote(d):
    return '<note><rest/><duration>%d</duration><voice>1</voice></note>' % d

base = doc('<measure number="1">' + ATTRS + pnote(48) + '</measure>'
           + '<measure number="2">' + pnote(6) * 9 + '</measure>'
           + '<measure number="3">' + pnote(24, 'E') * 2 + '</measure>')

good = doc('<measure number="1">' + ATTRS + pnote(48) + '</measure>'
           + '<measure number="2">' + pnote(12, 'G') * 4 + '</measure>'
           + '<measure number="3">' + pnote(48, 'D') + '</measure>')
out, rep = merge_consensus(base, [('contrast', good)])
cases['consensus_swap'] = {'report': rep.as_dict(), 'gotG': '<step>G</step>' in out,
                           'bar3kept': '<step>D</step>' not in out, 'sums': voice_sums(out)}

# A reading that saw a different number of bars is misaligned from the first
# extra barline on: its bar 2, however exact, is not evidence about the
# winner's bar 2. This one is longer than the base so that, were the guard
# gone, its exact bar 2 would be swapped in (a shorter reading would merely
# crash the lookup, which proves nothing about the alignment rule).
long = doc('<measure number="1">' + ATTRS + pnote(48) + '</measure>'
           + '<measure number="2">' + pnote(12, 'G') * 4 + '</measure>'
           + '<measure number="3">' + pnote(48, 'D') + '</measure>'
           + '<measure number="4">' + pnote(48, 'A') + '</measure>')
out2, rep2 = merge_consensus(base, [('deskewed', long)])
cases['consensus_shape'] = {'untouched': out2 == base, 'report': rep2.as_dict()}

# A mid-piece clef change: the base's broken bar 2 carries <attributes>, the
# candidate's exact bar 2 does not. Swapping would delete the clef change.
CLEF = '<attributes><clef><sign>F</sign><line>4</line></clef></attributes>'
attr_broken = doc('<measure number="1">' + ATTRS + pnote(48) + '</measure>'
                  + '<measure number="2">' + CLEF + pnote(6) * 9 + '</measure>')
attr_good = doc('<measure number="1">' + ATTRS + pnote(48) + '</measure>'
                + '<measure number="2">' + pnote(48, 'G') + '</measure>')
out3, rep3 = merge_consensus(attr_broken, [('contrast', attr_good)])
cases['consensus_attrs'] = {'untouched': out3 == attr_broken, 'report': rep3.as_dict()}

# The other direction: the candidate's exact bar carries a clef change the
# base never saw. Transplanting it would inject a bogus clef.
plain_broken = doc('<measure number="1">' + ATTRS + pnote(48) + '</measure>'
                   + '<measure number="2">' + pnote(6) * 9 + '</measure>')
clefy_good = doc('<measure number="1">' + ATTRS + pnote(48) + '</measure>'
                 + '<measure number="2">' + CLEF + pnote(48, 'G') + '</measure>')
out3b, rep3b = merge_consensus(plain_broken, [('contrast', clefy_good)])
cases['consensus_attrs_cand'] = {'untouched': out3b == plain_broken, 'report': rep3b.as_dict()}

resty = doc('<measure number="1">' + ATTRS + pnote(48) + '</measure>'
            + '<measure number="2">' + rnote(48) + '</measure>'
            + '<measure number="3">' + pnote(24, 'E') * 2 + '</measure>')
out4, rep4 = merge_consensus(base, [('silent', resty)])
cases['consensus_rests'] = {'untouched': out4 == base, 'report': rep4.as_dict()}

print(json.dumps(cases))
`;

const r = spawnSync('python3', ['-c', PY], { encoding: 'utf8', timeout: 120000 });
if (r.status !== 0) {
  console.error('check-omr-triplets: python failed');
  console.error(r.stderr || r.stdout);
  process.exit(1);
}
const c = JSON.parse(r.stdout.trim().split('\n').pop());

let failed = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) failed++;
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${detail ? '  — ' + detail : ''}`);
};

ok('a bar of unmarked triplet eighths lands exactly on its signature',
  c.moonlight_bar.sums[0]['1'] === 48 && c.moonlight_bar.sums[0]['2'] === 48,
  JSON.stringify(c.moonlight_bar.sums));
ok('and every converted note carries the 3:2 marking', c.moonlight_bar.marked === 12, `${c.moonlight_bar.marked}`);
ok('a bar that adds up is untouched byte for byte', c.clean_bar.untouched === true);
ok('a partial run converts exactly one group and leaves the rest',
  c.partial.sums[0]['1'] === 48 && c.partial.marked === 3, JSON.stringify(c.partial));
ok('an overflow with no exact 3:2 explanation is refused, untouched, and named',
  c.inexact.untouched === true && c.inexact.report.measuresUnrepairable.includes('7'),
  JSON.stringify(c.inexact.report));
ok('chords count once and convert together',
  c.chords.sums[0]['1'] === 48 && c.chords.report.notesConverted === 24, JSON.stringify(c.chords.report));
ok('already-marked groups are left alone while their unmarked neighbours convert',
  c.respects_marked.sums[0]['1'] === 48 && c.respects_marked.report.notesConverted === 6
    && c.respects_marked.marked === 12 && c.respects_marked.dur4 === 12,
  JSON.stringify(c.respects_marked));

ok('a marked note with an unadjusted duration is a contradiction, so the bar is refused',
  c.marked_unadjusted.untouched === true && c.marked_unadjusted.report.measuresUnrepairable.includes('9'),
  JSON.stringify(c.marked_unadjusted.report));

ok('an unrepairable overfull bar is clipped at the barline, and the clip is counted',
  c.meter_clip.sums[0]['1'] === 48 && c.meter_clip.report.barsClipped.length === 1
    && c.meter_clip.report.barsClipped[0].number === '7',
  JSON.stringify(c.meter_clip));
ok('a note straddling the barline is shortened, not dropped',
  c.meter_trim.sums[0]['1'] === 48 && c.meter_trim.report.notesTrimmed === 1
    && c.meter_trim.report.notesDropped === 0, JSON.stringify(c.meter_trim.report));
ok('a short voice gets an explicit rest for the beat the reader lost',
  c.meter_pad.sums[0]['1'] === 48 && c.meter_pad.rests === 1 && c.meter_pad.rest_dur === '24',
  JSON.stringify(c.meter_pad));
ok('meter enforcement leaves a correct bar untouched byte for byte',
  c.meter_clean.untouched === true && c.meter_clean.empty_report === true, JSON.stringify(c.meter_clean));

ok('a broken bar is replaced by an exact bar from another reading, and named',
  c.consensus_swap.report.barsSwapped.length === 1 && c.consensus_swap.report.barsSwapped[0].from === 'contrast'
    && c.consensus_swap.gotG === true && c.consensus_swap.sums[1]['1'] === 48,
  JSON.stringify(c.consensus_swap.report));
ok('a bar the winner read exactly is never replaced', c.consensus_swap.bar3kept === true);
ok('a reading with a different shape is not evidence, and is ignored',
  c.consensus_shape.untouched === true && c.consensus_shape.report.candidates === 0,
  JSON.stringify(c.consensus_shape.report));
ok('a bar carrying attributes is never swapped, even broken',
  c.consensus_attrs.untouched === true, JSON.stringify(c.consensus_attrs.report));
ok('a candidate bar carrying attributes is never transplanted',
  c.consensus_attrs_cand.untouched === true, JSON.stringify(c.consensus_attrs_cand.report));
ok('a bar of rests is exact but says nothing, and is not used',
  c.consensus_rests.untouched === true, JSON.stringify(c.consensus_rests.report));

console.log(`\n${failed ? 'omr triplets FAILED' : 'omr triplets OK'}`);
process.exit(failed ? 1 : 0);
