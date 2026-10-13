/**
 * ui/help.js — the in-app help.
 *
 * One dialog, opened by the ? button in the stage bar or by pressing ?.
 * It documents what the app does in the order a person meets it: load,
 * read a scan, play, edit, export. The keyboard table at the end repeats
 * every shortcut in one place.
 *
 * The text here is user documentation, not developer documentation; the
 * README covers the internals. When a behaviour changes, change it here in
 * the same commit — tools/check-help.mjs holds a few load-bearing phrases to
 * the behaviours they describe.
 */

import { el, icon, modal } from './dom.js';

const K = (keys) => el('span', {}, ...String(keys).split(' + ').flatMap((k, i) => (
  i ? [' + ', el('kbd', { text: k })] : [el('kbd', { text: k })]
)));

function row(keys, what) {
  return el('tr', {}, el('td', {}, K(keys)), el('td', { text: what }));
}

function section(title, ...kids) {
  return el('section', { class: 'help-sec' }, el('h3', { text: title }), ...kids);
}

const p = (text) => el('p', { text });

export function openHelp() {
  modal((box, closeFn) => {
    box.classList.add('help');
    box.appendChild(el('div', { class: 'modal-head' },
      el('h2', { text: 'How ScoreForge works' }),
      el('button', { class: 'btn ghost icon', onclick: closeFn, title: 'Close (Esc)' }, icon('x'))
    ));

    box.appendChild(el('div', { class: 'modal-body' },

      section('Loading music',
        p('Drop files anywhere on the page, or use Open score. ScoreForge reads '
          + 'MusicXML (.musicxml, .xml, .mxl), MuseScore files (.mscz, .mscx), '
          + 'MIDI (.mid, .midi, .kar) and — through the recognition service — '
          + 'photos and PDFs of printed sheet music. Everything runs in this '
          + 'page; nothing is uploaded anywhere else.'),
      ),

      section('Reading a scan',
        p('A photo or PDF goes to the recognition service, which must be '
          + 'running (its address and status are in Settings, under Backend). '
          + 'The result appears in the library like any other score, and the '
          + 'Transcription panel reports what recognition did: bars it had to '
          + 'repair, clip or pad are listed there, and those are the places to '
          + 'proof against the original. Photos read best sharp, straight-on '
          + 'and evenly lit, with the staves filling the frame.'),
        p('Recognition makes mistakes. Fixing them is what the note editor '
          + 'below is for; Save MusicXML then keeps the corrected score.'),
      ),

      section('Playing',
        p('Space plays and pauses. Click the piano roll, the scrub bar, or use '
          + 'the arrow keys (with no note selected) to move around. Tempo, '
          + 'playback speed and transposition are in the right-hand panel, '
          + 'along with one volume, instrument, mute and solo per part.'),
        p('Every instrument is a recording. The samples are fetched once, as '
          + 'one pack per instrument, when the page is served over http; until '
          + 'a pack has loaded, parts that need it are silent and the page '
          + 'says so. There is no synthesiser.'),
      ),

      section('Editing notes',
        p('Click a note — on the engraved score or on the piano roll — to '
          + 'select it. Both views mark it and a bar of actions appears. The '
          + 'keys do the same things:'),
        el('table', { class: 'help-keys' },
          row('↑ / ↓', 'pitch up or down a semitone'),
          row('Shift + ↑ / ↓', 'pitch up or down an octave'),
          row('← / →', 'select the previous or next note in the part'),
          row('[ / ]', 'shorter or longer'),
          row('Delete', 'remove the note (its time stays, as a rest)'),
          row('Esc', 'deselect'),
          row('Ctrl + Z', 'undo'),
          row('Ctrl + Shift + Z', 'redo'),
        ),
        p('To add a note, click a rest on the engraved score, or double-click '
          + 'an empty spot on the piano roll. The new note starts at a quarter '
          + 'note or whatever the rest holds, picks up the pitch of the nearest '
          + 'note (the roll uses the row you clicked), and stays selected, so '
          + 'the arrows and brackets tune it straight away. On the roll a note '
          + 'can also be dragged up or down; release to commit.'),
        p('Edits never change a bar’s length. A deleted note leaves a '
          + 'rest, a shortened note leaves a rest behind it, and a note only '
          + 'grows into the rest that follows it in its own voice — when a '
          + 'note or the barline is in the way, the edit is refused and a '
          + 'message says why. Not editable yet: tuplet rhythms, and the '
          + 'length of a note tied across a barline (its pitch is editable, '
          + 'and moves the whole tie).'),
        p('Save MusicXML, in the top bar, downloads the score with every edit '
          + 'in it. MIDI files have no notation to edit; open the score in the '
          + 'editor by saving it as MusicXML from the program that made it.'),
      ),

      section('Exporting',
        p('Export MP3 renders the piece offline with the same recordings and '
          + 'effects playback uses, at the bitrate and sample rate set in the '
          + 'dialog; WAV is there too. The export names which parts played '
          + 'which recording, and says plainly when samples were unavailable '
          + 'and parts rendered silent.'),
      ),

      section('All keys',
        el('table', { class: 'help-keys' },
          row('Space', 'play / pause'),
          row('← / →', 'seek 3 s (Shift: 10 s) — with no note selected'),
          row('Home', 'back to the start'),
          row('Shift + E', 'open the export dialog'),
          row('?', 'this help'),
          row('Ctrl + wheel', 'zoom the piano roll'),
          row('Shift + wheel', 'scroll the piano roll in time'),
        ),
        p('Editing keys are listed above and work while a note is selected.'),
      ),
    ));
  });
}
