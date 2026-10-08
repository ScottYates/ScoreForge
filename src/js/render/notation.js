/**
 * render/notation.js — the engraved score view.
 *
 * Wraps OpenSheetMusicDisplay. Two things matter here beyond "draw the notes":
 *
 *  1. Long scores must not freeze the page. OSMD 2.x can render incrementally
 *     and even drive that from scrolling, which we enable; a 300-bar sonata
 *     appears system by system instead of locking the tab for ten seconds.
 *
 *  2. The playback cursor has to land on the right note. OSMD walks the score
 *     in its own order (voices, ties, repetitions), which is not the same order
 *     as our flat note list — so rather than assuming they line up, we walk
 *     OSMD's iterator once at load time and record the source timestamp of every
 *     cursor step. Playback then binary-searches that table for the quarter to
 *     land on, and steps forward from there.
 */

const OSMD_CTOR_OPTIONS = {
  autoResize: false,
  backend: 'svg',
  drawTitle: true,
  drawSubtitle: false,
  drawComposer: true,
  drawLyricist: true,
  drawCopyright: false,
  drawPartNames: true,
  drawMeasureNumbers: true,
  drawMeasureNumbersOnlyAtSystemStart: false,
  followCursor: true,
  pageFormat: 'EndlessVertical',
  drawingParameters: 'default',
};

const MAX_CURSOR_STEPS = 300000;

export class NotationView {
  /** @param {HTMLElement} container */
  constructor(container) {
    this.container = container;
    this.osmd = null;
    this.steps = null;      // [{quarter, i}] cursor step -> source timestamp
    this.stepIndex = -1;
    this.visible = false;
    this.zoom = 1;
    this._pending = null;
  }

  get available() { return !!this.osmd; }

  /**
   * Load a score for display. Only MusicXML has a notation view; MIDI is shown
   * on the piano roll instead.
   */
  async load(score) {
    this.clear();
    if (!score || !score.rawMusicXml) { this.notAvailable = 'No notation available for this file format.'; return false; }
    const OSMD = window.opensheetmusicdisplay;
    if (!OSMD) { this.notAvailable = 'Notation engine failed to load.'; return false; }

    this.notAvailable = null;
    const osmd = new OSMD.OpenSheetMusicDisplay(this.container, { ...OSMD_CTOR_OPTIONS });
    this.osmd = osmd;
    await osmd.load(score.rawMusicXml, score.title);
    osmd.zoom = this.zoom;

    try {
      osmd.cursor.CursorOptions.color = '#2f6df6';
      osmd.cursor.CursorOptions.type = 2;      // gradient bar
      osmd.cursor.CursorOptions.alpha = 0.55;
      osmd.cursor.SkipInvisibleNotes = true;
    } catch { /* older/newer cursor API — defaults are fine */ }

    this._startRender();
    return true;
  }

  /**
   * Kick off rendering. For a big score we let OSMD fill in as the user scrolls;
   * for a small one we just draw it all at once so the first frame is complete.
   */
  _startRender() {
    const osmd = this.osmd;
    if (!osmd) return;
    const measures = this.measureCount();
    try {
      osmd.resetIncrementalRendering();
      if (measures > 40) {
        osmd.enableIncrementalRenderingOnScroll({ measures: 4, scrollElement: this.container });
      } else {
        osmd.render();
      }
      // Build the cursor table after the first layout so every step has a
      // graphical note to point at.
      const build = () => {
        this._buildCursorTable();
        if (measures > 40) {
          // Prime the first screens so the score is not blank on load.
          for (let i = 0; i < 3; i++) {
            const r = osmd.renderNext({ measures: 6 });
            if (!r || r.done) break;
          }
        }
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(build, 0));
      else setTimeout(build, 0);
    } catch (e) {
      console.error('notation render failed', e);
    }
  }

  measureCount() {
    const sheet = this.osmd && (this.osmd.Sheet || this.osmd.sheet);
    return sheet && sheet.SourceMeasures ? sheet.SourceMeasures.length : 0;
  }

  /** Walk OSMD's iterator once and record every cursor step's source timestamp. */
  _buildCursorTable() {
    const steps = [];
    try {
      const cursor = this.osmd.cursor;
      cursor.reset();
      cursor.hide();
      const it = cursor.iterator;
      let i = 0;
      // Guard against a pathological file; a normal score is a few thousand.
      while (!it.EndReached && i < MAX_CURSOR_STEPS) {
        const ts = it.CurrentSourceTimestamp;
        steps.push({ quarter: fractionToQuarters(ts), i });
        it.moveToNext();
        i++;
      }
      this.steps = steps;
      this.stepIndex = -1;
    } catch (e) {
      console.error('cursor table failed', e);
      this.steps = null;
    }
  }

  /**
   * Move the playback cursor to the note sounding at `quarter`.
   * Cheap during forward playback (steps a few places); a seek costs one reset
   * plus a linear walk, which is fine for an action the user performs rarely.
   */
  showCursorAtQuarter(quarter) {
    if (!this.osmd || !this.steps || !this.steps.length) return;
    const target = this._stepIndexFor(quarter);
    if (target < 0 || target === this.stepIndex) return;
    try {
      const cursor = this.osmd.cursor;
      // Stepping forward from where we are is the common case during playback
      // and costs nothing. A seek (or a long jump) resets and walks, which is
      // O(n) but only happens on an explicit user action.
      const needReset = target < this.stepIndex || target - this.stepIndex > 240;
      if (needReset) {
        cursor.reset();
        for (let k = 0; k < target; k++) cursor.iterator.moveToNext();
      } else {
        for (let k = this.stepIndex; k < target; k++) cursor.iterator.moveToNext();
      }
      this.stepIndex = target;
      cursor.update();
      cursor.show();
    } catch (e) {
      /* the cursor is cosmetic — never let it break playback */
      this.stepIndex = target;
    }
  }

  _stepIndexFor(quarter) {
    const s = this.steps;
    let lo = 0, hi = s.length - 1, best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (s[mid].quarter <= quarter + 1e-6) { best = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return best;
  }

  hideCursor() {
    if (!this.osmd) return;
    try { this.osmd.cursor.hide(); } catch { /* noop */ }
  }

  /** Put the cursor back to the start — call after a seek or stop. */
  resetCursor() {
    if (!this.osmd) return;
    try { this.osmd.cursor.reset(); this.osmd.cursor.hide(); } catch { /* noop */ }
    this.stepIndex = -1;
  }

  setZoom(z) {
    this.zoom = Math.max(0.4, Math.min(2.5, z));
    if (this.osmd) {
      try { this.osmd.zoom = this.zoom; } catch { /* noop */ }
    }
    return this.zoom;
  }

  /** Draw everything at once — used before a snapshot/export. */
  renderAll() {
    if (!this.osmd) return;
    try {
      if (this.osmd.IncrementalRenderingActive) this.osmd.renderRemaining();
      else this.osmd.render();
    } catch (e) { console.error(e); }
  }

  clear() {
    if (this.osmd) {
      try {
        this.osmd.disableIncrementalRenderingOnScroll();
        this.osmd.cursor.Dispose();
        this.osmd.clear();
      } catch { /* noop */ }
    }
    this.osmd = null;
    this.steps = null;
    this.stepIndex = -1;
    this.container.innerHTML = '';
  }
}

/** OSMD's Fraction is in whole notes; we want quarters. */
function fractionToQuarters(ts) {
  if (!ts) return 0;
  if (typeof ts.QuarterValue === 'number') return ts.QuarterValue;
  if (typeof ts.WholeValue === 'number') return ts.WholeValue * 4;
  if (typeof ts.AbsoluteValue === 'number') return ts.AbsoluteValue * 4;
  if (typeof ts.numerator === 'number') return (ts.numerator / (ts.denominator || 1)) * 4;
  return 0;
}