/**
 * audio/gm.js — General MIDI program → our instrument id.
 *
 * MIDI files carry a program number and MusicXML carries a `<midi-program>`
 * or a `<score-instrument>` name. Neither tells us which of *our* voices to use,
 * so this maps the 128 GM programs onto the roster in `instruments.js`.
 *
 * Every program lands on a **recorded** instrument. The modelled instruments are
 * not a destination of this table at all: each recorded entry carries its own
 * modelled `fallback`, and that is the only way a part ends up synthesised --
 * when its pack cannot be had. So "which recording is closest" is decided here,
 * and "what if there are no recordings" is decided in the roster, once.
 *
 * The FreePats banks do not cover every GM family with a real instrument. There
 * is no recorded bowed string, brass, flute, choir, celesta or harpsichord in
 * the pack, and the nearest *recording* is used rather than the model: synth
 * strings for a violin, synth brass for a trumpet, the recorder for a flute.
 * Those substitutions are listed in GAPS below so they are visible rather than
 * buried in a table of 128 strings, and so a test can hold the list honest.
 *
 * Choices were made against each bank's real key range (pack/manifest.json),
 * not its name: a bank that only reaches a part by transposing octaves is a
 * worse answer than a neighbouring family recorded in the right register.
 */

import { INSTRUMENTS, DEFAULT_INSTRUMENT } from './instruments.js';

const BY_ID = new Map(INSTRUMENTS.map((i) => [i.id, i]));

const R = (s) => 'rec-fp-' + s;

/** program number (0-based, as stored in MIDI) -> our instrument id */
const GM = [
  // 0-7   Piano: acoustic grand, bright, electric grand, honky-tonk,
  //       EP 1, EP 2, harpsichord, clavinet
  R('upright'), R('upright'), R('upright'), R('honky-tonk'),
  R('fm-piano-1'), R('fm-piano-2'), R('honky-tonk'), R('honky-tonk'),
  // 8-15  Chromatic percussion: celesta, glockenspiel, music box, vibraphone,
  //       marimba, xylophone, tubular bells, dulcimer
  R('kalimba'), R('xylophone'), R('kalimba'), R('xylophone'),
  R('xylophone'), R('xylophone'), R('tubular-bells'), R('harp'),
  // 16-23 Organ: drawbar, percussive, rock, church, reed, accordion,
  //       harmonica, tango accordion
  R('drawbar-organ'), R('percussive-organ'), R('rock-organ'), R('church-organ'),
  R('accordion'), R('accordion'), R('accordion'), R('accordion'),
  // 24-31 Guitar: nylon, steel, jazz, clean, muted, overdriven, distortion,
  //       harmonics
  R('nylon-guitar'), R('steel-guitar'), R('eg-jazz'), R('eg-clean'),
  R('eg-direct'), R('eg-dist-1'), R('eg-dist-2'), R('eg-clean'),
  // 32-39 Bass: acoustic, finger, pick, fretless, slap 1, slap 2,
  //       synth 1, synth 2
  R('bass-guitar'), R('bass-guitar'), R('bass-guitar'), R('bass-guitar'),
  R('bass-guitar'), R('bass-guitar'), R('synth-bass-1'), R('synth-bass-2'),
  // 40-47 Strings: violin, viola, cello, contrabass, tremolo, pizzicato,
  //       harp, timpani
  R('synth-strings-1'), R('synth-strings-1'), R('synth-strings-1'), R('synth-strings-1'),
  R('synth-strings-2'), R('harp'), R('harp'), R('timpani'),
  // 48-55 Ensemble: strings 1, strings 2, synth strings 1, synth strings 2,
  //       choir aahs, voice oohs, synth voice, orchestra hit.
  // The choir and voice programs go to the recorded upright, not to the
  // "Synth Pad, Choir" bank: that bank is a recording OF a synthesiser, and a
  // vocal score played on it sounds like a synthesiser, which is the one thing
  // a roster of recordings must not do by default. A sung line is rehearsed
  // against a piano; the pad stays in the picker for anyone who wants it.
  R('synth-strings-1'), R('synth-strings-2'), R('synth-strings-1'), R('synth-strings-2'),
  R('upright'), R('upright'), R('upright'), R('synth-soundtrack'),
  // 56-63 Brass: trumpet, trombone, tuba, muted trumpet, french horn,
  //       brass section, synth brass 1, synth brass 2
  R('synth-brass-1'), R('synth-brass-1'), R('synth-brass-1'), R('synth-brass-1'),
  R('synth-brass-1'), R('synth-brass-1'), R('synth-brass-1'), R('synth-brass-2'),
  // 64-71 Reed: soprano, alto, tenor, baritone sax, oboe, english horn,
  //       bassoon, clarinet
  R('tenor-sax'), R('tenor-sax'), R('tenor-sax'), R('tenor-sax'),
  R('clarinet'), R('clarinet'), R('clarinet'), R('clarinet'),
  // 72-79 Pipe: piccolo, flute, recorder, pan flute, blown bottle,
  //       shakuhachi, whistle, ocarina
  R('recorder'), R('recorder'), R('recorder'), R('ocarina'),
  R('ocarina'), R('recorder'), R('ocarina'), R('ocarina'),
  // 80-87 Lead: square, sawtooth, calliope, chiff, charang, voice, fifths,
  //       bass + lead
  R('synth-square'), R('synth-bass-lead'), R('synth-calliope'), R('synth-calliope'),
  R('eg-dist-1'), R('synth-pad-choir'), R('synth-fifths'), R('synth-bass-lead'),
  // 88-95 Pad: new age, warm, polysynth, choir, bowed, metallic, halo, sweep
  R('new-age'), R('synth-pad-bowed'), R('synth-strings-2'), R('synth-pad-choir'),
  R('synth-pad-bowed'), R('synth-crystal'), R('synth-pad-choir'), R('sweep-pad'),
  // 96-103 Effects: rain, soundtrack, crystal, atmosphere, brightness,
  //        goblins, echoes, sci-fi
  R('synth-crystal'), R('synth-soundtrack'), R('synth-crystal'), R('new-age'),
  R('synth-crystal'), R('synth-goblins'), R('sweep-pad'), R('synth-sci-fi'),
  // 104-111 Ethnic: sitar, banjo, shamisen, koto, kalimba, bagpipe, fiddle,
  //         shanai
  R('steel-guitar'), R('ukulele'), R('ukulele'), R('harp'),
  R('kalimba'), R('bagpipe'), R('synth-strings-1'), R('clarinet'),
  // 112-119 Percussive: tinkle bell, agogo, steel drums, woodblock, taiko,
  //         melodic tom, synth drum, reverse cymbal
  R('glasses'), R('xylophone'), R('hang'), R('xylophone'),
  R('timpani'), R('timpani'), R('timpani'), R('sweep-pad'),
  // 120-127 Sound effects: fret noise, breath, seashore, bird, telephone,
  //         helicopter, applause, gunshot
  R('nylon-guitar'), R('recorder'), R('sweep-pad'), R('ocarina'),
  R('synth-square'), R('synth-sci-fi'), R('sweep-pad'), R('timpani'),
];

/**
 * GM families the pack has no real recording of, and the recording that
 * stands in. Not used for routing -- GM above is the routing -- but kept so the
 * substitutions are stated in one readable place and checked by a test.
 */
export const GAPS = {
  'bowed strings': R('synth-strings-1'),
  brass: R('synth-brass-1'),
  flute: R('recorder'),
  choir: R('upright'),
  'celesta / music box': R('kalimba'),
  'glockenspiel / vibraphone / marimba': R('xylophone'),
  'harpsichord / clavinet': R('honky-tonk'),
  'oboe / bassoon': R('clarinet'),
};

/** The whole table, for tests. */
export const GM_PROGRAMS = GM.slice();

/** @returns {string} a valid instrument id */
export function instrumentForProgram(program) {
  const p = Number(program);
  if (Number.isFinite(p) && p >= 0 && p < 128) {
    const id = GM[Math.floor(p)];
    if (id && BY_ID.has(id)) return id;
  }
  return DEFAULT_INSTRUMENT;
}

/**
 * Rough name-based routing for MusicXML `<instrument-sound>` /
 * `<score-instrument>` / part names. Order matters: the first match wins, so
 * the specific names sit above the general ones ("electric piano" above
 * "piano", "harpsichord" above "harp", "synth bass" above "bass", any bass
 * above "string").
 */
const NAMES = [
  [/electric piano|rhodes|wurlitzer|\be[-. ]{0,2}piano\b|\bepiano\b/, R('fm-piano-1')],
  [/honky|tack piano|old piano/, R('honky-tonk')],
  [/harpsichord|clavichord|clavinet|virginal/, R('honky-tonk')],
  [/synth bass/, R('synth-bass-1')],
  [/bass guitar|electric bass|fretless|upright bass|double bass|string bass|jazz bass/, R('bass-guitar')],
  [/contrabass|contrebasse|kontrabass/, R('synth-strings-1')],
  [/grand|piano|bösendorfer|steinway|keyboard/, R('upright')],
  [/celesta|celeste|music box|musicbox/, R('kalimba')],
  [/glocken|xylophone|marimba|vibraphone|vibes|balafon|mallet/, R('xylophone')],
  [/tubular bell|chime/, R('tubular-bells')],
  [/timpani|kettledrum/, R('timpani')],
  [/kalimba|mbira/, R('kalimba')],
  [/steel ?drum|steel ?pan|\bhang\b|handpan/, R('hang')],
  [/jaw ?harp|jew'?s ?harp/, R('jaw-harp')],
  [/\bharp\b|harpe|arpa/, R('harp')],
  [/ukulele|banjo|mandolin/, R('ukulele')],
  [/distort|overdrive/, R('eg-dist-1')],
  [/jazz guitar/, R('eg-jazz')],
  [/electric guitar|\be[-. ]{0,2}guitar\b/, R('eg-clean')],
  [/steel[- ]?string|acoustic guitar|folk guitar/, R('steel-guitar')],
  [/guitar/, R('nylon-guitar')],
  [/church organ|pipe organ|organ/, R('church-organ')],
  [/accordion|harmonica|harmonium|concertina|bandoneon|melodica/, R('accordion')],
  [/bagpipe/, R('bagpipe')],
  // Vocal parts. The piano, because that is what a vocal line is rehearsed
  // against, and because the only "choir" in the pack is a synth pad -- the
  // sound this app must not default to. Bare section names (SOP, ALTO, TEN,
  // BARI) say nothing here and fall through to the same recorded default.
  [/choir|voice|vocal|chorus|soprano|mezzo/, R('upright')],
  [/violin|viola|cello|violoncello|fiddle|string|orchestra/, R('synth-strings-1')],
  [/clarinet|oboe|bassoon|english horn|cor anglais/, R('clarinet')],
  [/trumpet|trombone|tuba|horn|cornet|flugel|euphonium|brass/, R('synth-brass-1')],
  [/sax/, R('tenor-sax')],
  [/ocarina|pan ?flute|whistle/, R('ocarina')],
  [/flute|piccolo|recorder|fife/, R('recorder')],
  [/synth.*lead|lead synth|square/, R('synth-square')],
  [/pad|synth|warm/, R('synth-pad-bowed')],
];

/** @returns {string|null} a valid instrument id, or null when the name says nothing */
export function instrumentForName(name) {
  const s = String(name || '').toLowerCase();
  if (!s) return null;
  for (const [re, id] of NAMES) if (re.test(s) && BY_ID.has(id)) return id;
  return null;
}
