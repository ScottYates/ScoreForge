/**
 * ui/edit.js — the note editor.
 *
 * Selection and edits, wired across both views. A note is selected by clicking
 * it on the engraved score or on the piano roll; the selection is remembered
 * as (part id, xml ordinal), the address io/xmledit.js edits by, so it
 * survives the re-parse every edit causes.
 *
 * The edits themselves are transformations of the score's MusicXML
 * (io/xmledit.js). After each one the app re-parses the text and reloads both
 * views, so notation, roll, playback and Save always show the same score.
 * Undo and redo are snapshots of the text, kept per score.
 *
 * Keys while a note is selected (the usual notation-editor set):
 *   up / down            semitone        shift+up / shift+down   octave
 *   left / right         previous / next note in the part
 *   [ / ]                shorter / longer (into the following rest)
 *   delete / backspace   remove the note (a rest keeps its time)
 *   escape               drop the selection
 * Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y) undo and redo, selection or not.
 */

import { editMusicXml, EditError, nextDuration } from '../io/xmledit.js';
import { midiToName } from '../score/model.js';
import { el, clear, icon, toast } from './dom.js';

const UNDO_LIMIT = 200;

export class EditController {
  /** @param {import('./app.js').App} app */
  constructor(app) {
    this.app = app;
    /** @type {{partId: string, ordinal: number}|null} */
    this.sel = null;
    // Edits queue rather than drop: two fast keystrokes are two edits, and
    // the second must see the score the first produced. Each queued task
    // re-reads the selection when it runs, never when it was typed.
    this._chain = Promise.resolve();
  }

  _enqueue(task) {
    this._chain = this._chain.then(task, task);
    return this._chain;
  }

  /* ------------------------------------------------------------ selection */

  canEdit() {
    return !!(this.app.score && this.app.score.rawMusicXml);
  }

  /** The selected model note in the current score, or null. */
  selectedNote() {
    if (!this.sel || !this.app.score) return null;
    const part = this.app.score.parts.find((p) => p.id === this.sel.partId);
    if (!part) return null;
    return part.notes.find((n) => Array.isArray(n.xmlIndexes) && n.xmlIndexes[0] === this.sel.ordinal) || null;
  }

  /** The resolved (playback) twin of the selected note, for the roll. */
  selectedResolved() {
    const n = this.selectedNote();
    if (!n) return null;
    const notes = (this.app.resolved && this.app.resolved.notes) || [];
    return notes.find((r) => r.partId === this.sel.partId
      && Array.isArray(r.xmlIndexes) && r.xmlIndexes[0] === this.sel.ordinal) || null;
  }

  select(partId, ordinal) {
    this.sel = { partId, ordinal };
    if (!this.selectedNote()) this.sel = null;
    this.refresh();
  }

  clearSelection() {
    if (!this.sel) return;
    this.sel = null;
    this.refresh();
  }

  /** Repaint everything the selection touches: roll, notation, the edit bar. */
  refresh() {
    const app = this.app;
    const resolved = this.selectedResolved();
    app.roll.setSelected(resolved ? resolved.id : null);
    const note = this.selectedNote();
    if (note && app.score.measureStarts) {
      const within = note.quarter - (app.score.measureStarts[note.measure] || 0);
      app.notation.highlightNote({
        partId: this.sel.partId, measureIndex: note.measure, within, midi: note.midi,
      });
    } else {
      app.notation.clearHighlight();
    }
    this._renderBar(note);
  }

  /* ---------------------------------------------------- picks from views */

  /** A click on the engraved score. */
  pickFromNotation(clientX, clientY) {
    if (!this.canEdit()) return false;
    const addr = this.app.notation.noteAtClientPoint(clientX, clientY);
    if (!addr) return false;
    const note = this._modelNoteAt(addr);
    if (!note) return false;
    this.select(addr.partId, note.xmlIndexes[0]);
    return true;
  }

  /** A tap on a roll note. Tapping the selected note again deselects it. */
  pickFromRoll(resolvedNote) {
    if (!this.canEdit() || !resolvedNote || !Array.isArray(resolvedNote.xmlIndexes)) return;
    const ord = resolvedNote.xmlIndexes[0];
    if (this.sel && this.sel.partId === resolvedNote.partId && this.sel.ordinal === ord) {
      this.clearSelection();
    } else {
      this.select(resolvedNote.partId, ord);
    }
  }

  /** A vertical drag on a roll note, committed on release. */
  dragFromRoll(resolvedNote, deltaSemitones) {
    if (!this.canEdit() || !resolvedNote || !Array.isArray(resolvedNote.xmlIndexes)) return;
    this._enqueue(() => {
      this.sel = { partId: resolvedNote.partId, ordinal: resolvedNote.xmlIndexes[0] };
      const note = this.selectedNote();
      if (!note) return undefined;
      return this._applyNow({
        type: 'pitch', partId: resolvedNote.partId, ordinals: note.xmlIndexes,
        midi: Math.max(0, Math.min(127, note.midi + deltaSemitones)),
      });
    });
  }

  /** Editor address (part, measure, offset, midi) -> the model note it names. */
  _modelNoteAt(addr) {
    const score = this.app.score;
    const part = score.parts.find((p) => p.id === addr.partId);
    if (!part) return null;
    let best = null;
    let bestScore = Infinity;
    for (const n of part.notes) {
      if (n.measure !== addr.measureIndex || !Array.isArray(n.xmlIndexes)) continue;
      const within = n.quarter - (score.measureStarts ? score.measureStarts[n.measure] || 0 : 0);
      const d = Math.abs(within - addr.within) + (n.midi === addr.midi ? 0 : 100);
      if (d < bestScore) { bestScore = d; best = n; }
    }
    // A wrong-pitch match within the beat is still the clicked spot (the
    // model may differ from OSMD by a tie or an enharmonic reading); a match
    // in a different beat is a miss.
    return bestScore < 100.05 ? best : null;
  }

  /* -------------------------------------------------------------- keyboard */

  /** @returns {boolean} true when the key was an edit action */
  handleKey(e) {
    if (!this.canEdit()) return false;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key === 'z' || e.key === 'Z')) {
      e.shiftKey ? this.redo() : this.undo();
      return true;
    }
    if (mod && (e.key === 'y' || e.key === 'Y')) { this.redo(); return true; }
    if (!this.sel) return false;

    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowDown': {
        const step = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1);
        this._enqueue(() => {
          const note = this.selectedNote();
          if (!note) return undefined;
          return this._applyNow({
            type: 'pitch', partId: this.sel.partId, ordinals: note.xmlIndexes,
            midi: Math.max(0, Math.min(127, note.midi + step)),
          });
        });
        return true;
      }
      case 'ArrowLeft':
      case 'ArrowRight':
        this._enqueue(() => this._step(e.key === 'ArrowRight' ? 1 : -1));
        return true;
      case '[':
      case ']': {
        this._enqueue(() => {
          const note = this.selectedNote();
          if (!note) return undefined;
          const target = nextDuration(note.durationQuarters, e.key === ']' ? 1 : -1);
          if (target == null) return undefined;
          return this._applyNow({ type: 'duration', partId: this.sel.partId, ordinals: note.xmlIndexes, quarters: target });
        });
        return true;
      }
      case 'Delete':
      case 'Backspace':
        this.deleteSelected();
        return true;
      case 'Escape':
        this.clearSelection();
        return true;
      default:
        return false;
    }
  }

  /** Move the selection to the previous / next note of the same part. */
  _step(dir) {
    const part = this.app.score.parts.find((p) => p.id === this.sel.partId);
    const note = this.selectedNote();
    if (!part || !note) return;
    const i = part.notes.indexOf(note);
    const next = part.notes[i + dir];
    if (next && Array.isArray(next.xmlIndexes)) this.select(this.sel.partId, next.xmlIndexes[0]);
  }

  /* ------------------------------------------------------------- the edits */

  deleteSelected() {
    this._enqueue(() => {
      const note = this.selectedNote();
      if (!note) return undefined;
      const part = this.app.score.parts.find((p) => p.id === this.sel.partId);
      const i = part.notes.indexOf(note);
      const follow = part.notes[i + 1] || part.notes[i - 1] || null;
      return this._applyNow(
        { type: 'delete', partId: this.sel.partId, ordinals: note.xmlIndexes },
        follow && Array.isArray(follow.xmlIndexes)
          ? { partId: this.sel.partId, quarter: follow.quarter, midi: follow.midi }
          : 'clear'
      );
    });
  }

  addChordTone() {
    this._enqueue(() => {
      const note = this.selectedNote();
      if (!note) return undefined;
      const part = this.app.score.parts.find((p) => p.id === this.sel.partId);
      // The tones already sounding at this onset, to pick an interval that is
      // actually new: a third if it is free, else walk the candidates.
      const sounding = new Set(part.notes
        .filter((n) => Math.abs(n.quarter - note.quarter) < 1e-9 && n.voice === note.voice)
        .map((n) => n.midi));
      const candidate = [4, 3, 5, 7, -3, -4, -5, 12, -12]
        .map((d) => note.midi + d)
        .find((m) => m >= 0 && m <= 127 && !sounding.has(m));
      if (candidate == null) return undefined;
      return this._applyNow(
        { type: 'addChord', partId: this.sel.partId, ordinals: [note.xmlIndexes[0]], midi: candidate },
        { partId: this.sel.partId, quarter: note.quarter, midi: candidate }
      );
    });
  }

  /* ---------------------------------------------------------- undo / redo */

  _stacks() {
    const s = this.app.score;
    if (!s._editUndo) { s._editUndo = []; s._editRedo = []; }
    return { undo: s._editUndo, redo: s._editRedo };
  }

  get dirty() {
    return !!(this.app.score && this.app.score._editUndo && this.app.score._editUndo.length);
  }

  undo() {
    return this._enqueue(async () => {
      const { undo, redo } = this._stacks();
      if (!undo.length) return;
      redo.push(this.app.score.rawMusicXml);
      await this._swap(undo.pop());
    });
  }

  redo() {
    return this._enqueue(async () => {
      const { undo, redo } = this._stacks();
      if (!redo.length) return;
      undo.push(this.app.score.rawMusicXml);
      await this._swap(redo.pop());
    });
  }

  /**
   * Run one edit: transform the XML, snapshot for undo, reload everything,
   * and put the selection back. Runs inside the queue — callers reach it
   * through _enqueue, never directly from an event handler.
   *
   * @param {object} op for io/xmledit.js
   * @param {'keep'|'clear'|{partId,quarter,midi}} [reselect] where the
   *        selection lands afterwards; default keeps the same ordinal.
   */
  async _applyNow(op, reselect = 'keep') {
    const xml = this.app.score.rawMusicXml;
    let next;
    try {
      next = editMusicXml(xml, op);
    } catch (err) {
      if (err instanceof EditError) {
        toast('That edit is not possible', err.message, 'warn');
        return;
      }
      throw err;
    }
    const { undo, redo } = this._stacks();
    undo.push(xml);
    if (undo.length > UNDO_LIMIT) undo.shift();
    redo.length = 0;
    const keep = this.sel;
    await this._swap(next);
    if (reselect === 'clear') this.sel = null;
    else if (reselect !== 'keep' && reselect) this.sel = this._findByPlace(reselect);
    else this.sel = keep;
    if (this.sel && !this.selectedNote()) this.sel = null;
    this.refresh();
  }

  async _swap(xml) {
    await this.app.replaceScoreXml(xml);
    this.refresh();
  }

  /** Re-find a note by its place (part, quarter, midi) after a re-parse. */
  _findByPlace({ partId, quarter, midi }) {
    const part = this.app.score.parts.find((p) => p.id === partId);
    if (!part) return null;
    let best = null;
    let bestScore = Infinity;
    for (const n of part.notes) {
      if (!Array.isArray(n.xmlIndexes)) continue;
      const d = Math.abs(n.quarter - quarter) * 10 + (n.midi === midi ? 0 : 1);
      if (d < bestScore) { bestScore = d; best = n; }
    }
    return best && bestScore < 2 ? { partId, ordinal: best.xmlIndexes[0] } : null;
  }

  /* --------------------------------------------------------------- the bar */

  /** The floating bar above the transport: what is selected, and the actions. */
  _renderBar(note) {
    const host = this.app.dom.editBar;
    if (!host) return;
    if (!note) {
      host.hidden = true;
      clear(host);
      return;
    }
    host.hidden = false;
    clear(host);
    const name = midiToName(note.midi);
    const btn = (label, title, fn, cls = '') => el('button', {
      class: `btn sm ${cls}`.trim(), title, onclick: fn,
    }, label);
    const { undo, redo } = this._stacks();
    host.append(
      el('span', { class: 'edit-note' },
        el('b', { text: name }),
        ` · bar ${note.measure + 1}`),
      btn('▲', 'Semitone up (↑)', () => this._keyless('ArrowUp')),
      btn('▼', 'Semitone down (↓)', () => this._keyless('ArrowDown')),
      btn('8va', 'Octave up (shift+↑)', () => this._keyless('ArrowUp', true)),
      btn('8vb', 'Octave down (shift+↓)', () => this._keyless('ArrowDown', true)),
      btn('−', 'Shorter ( [ )', () => this._keyless('[')),
      btn('+', 'Longer ( ] )', () => this._keyless(']')),
      btn('+tone', 'Add a chord tone', () => this.addChordTone()),
      btn('Delete', 'Remove the note (Del)', () => this.deleteSelected(), 'danger'),
      el('span', { class: 'edit-gap' }),
      btn('Undo', 'Undo (Ctrl+Z)', () => this.undo(), undo.length ? '' : 'ghost'),
      btn('Redo', 'Redo (Ctrl+Shift+Z)', () => this.redo(), redo.length ? '' : 'ghost'),
      btn('✕', 'Deselect (Esc)', () => this.clearSelection(), 'ghost'),
    );
    void icon;
  }

  _keyless(key, shiftKey = false) {
    this.handleKey({ key, shiftKey, metaKey: false, ctrlKey: false, preventDefault() {} });
  }
}
