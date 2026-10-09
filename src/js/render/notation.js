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

/**
 * The playback cursor colour, read from the stylesheet.
 *
 * `--cursor` is the single source of truth, so the cursor cannot be legible on
 * paper in one place and invisible in the other. The fallback is for the
 * offscreen host the self-test renders into, which has no stylesheet attached.
 */
function cursorColour(container) {
  try {
    const v = getComputedStyle(container).getPropertyValue('--cursor').trim();
    if (v) return v;
  } catch { /* no window, or the host is detached */ }
  return '#1f4fc9';
}

/**
 * Build the `cursorsOptions` array OSMD reads once, when it is constructed.
 *
 * The array is indexed per cursor, so a single cursor means a one-entry array —
 * `{color, type, alpha}` hung directly off it is silently ignored, which is how
 * this went wrong before. OSMD defaults every field it wants, so an entry only
 * has to carry what we actually want to differ.
 *
 * `type` is OSMD's ShortThinTopLeft: a small bar on the note's top-left corner.
 * The default Standard is a wide band drawn *behind* the staff, and a wide
 * translucent band on the dimmed paper reads as a smudge rather than a position.
 * OSMD treats this type as a solid colour and scales one pixel up, so there is no
 * gradient to soften it.
 *
 * `alpha` is 1, not OSMD's 0.5. OSMD composites the bar over the paper, so the
 * colour you see is a blend: at half strength this bar measures 1.96:1 against
 * --paper, under the 3:1 a position marker needs. Opaque, it measures 3.95:1.
 * (Comparing the raw hex to the paper overstates every reading by the alpha —
 * which is how this was first judged fine at "3.9:1" while drawing at half
 * strength. tools/check-cursor.mjs measures the painted pixels.)
 */
function cursorOptions(container) {
  return [{
    type: 2,                                   // CursorType.ShortThinTopLeft
    color: cursorColour(container),
    alpha: 1,
    follow: true,
  }];
}

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
    // cursorsOptions has to be passed here, not assigned after load(): OSMD reads
    // it once while applying options and hands each Cursor one entry when the
    // first page renders. There is no cursor object to mutate until then --
    // osmd.cursor is osmd.cursors[0], still undefined at this point -- so a
    // post-load assignment threw a TypeError that the catch below swallowed, and
    // the cursor stayed OSMD's default green no matter what we set.
    const osmd = new OSMD.OpenSheetMusicDisplay(this.container, {
      ...OSMD_CTOR_OPTIONS,
      cursorsOptions: cursorOptions(this.container),
    });
    this.osmd = osmd;
    await osmd.load(score.rawMusicXml, score.title);
    osmd.zoom = this.zoom;

    // Nothing else to configure here. OSMD's Cursor constructor already defaults
    // SkipInvisibleNotes to true, and its CursorOptions getter hands back the
    // entry we passed above, so the two lines that used to sit here (setting a
    // colour and a type on osmd.cursor) were not configurable state at all --
    // there was no cursor to configure until the first page rendered.

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
      // The walk above runs the iterator to the end of the score. Leave it back
      // at the start so "the cursor sits before step 0" is the state the seek
      // below assumes, rather than something it has to remember to undo.
      cursor.reset();
      cursor.hide();
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
      //
      // stepIndex < 0 means the cursor has never been placed, so there is no
      // position to step from and the walk has to start at the reset point.
      // Reading it as a forward step instead walked the iterator one past the
      // requested step from wherever it was left, which -- because the table
      // build finishes at the end of the score -- pinned the cursor to the last
      // measure for the whole piece.
      const needReset = this.stepIndex < 0 || target < this.stepIndex || target - this.stepIndex > 240;
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

/**
 * OSMD's Fraction counts whole notes; the score's timeline counts quarters.
 *
 * RealValue is the whole-note value *including* its fractional part -- 0, 1/4,
 * 1/2, 3/4, 1, ... across a 4/4 bar -- so scaling it by 4 is what lines the
 * cursor table up with the notes.
 *
 * WholeValue is only the integer part: it reads 0,0,0,0,1,1,1,1,2... across the
 * same bar. Scaling that throws the remainder away and yields a table that
 * jumps a whole bar every four steps, which leaves the cursor stranded several
 * bars behind the music and growing further out of step as it plays.
 */
function fractionToQuarters(ts) {
  if (!ts) return 0;
  if (typeof ts.RealValue === 'number') return ts.RealValue * 4;
  if (typeof ts.realValue === 'number') return ts.realValue * 4;
  // Otherwise reconstruct the absolute value from its parts.
  const num = typeof ts.Numerator === 'number' ? ts.Numerator : ts.numerator;
  const den = typeof ts.Denominator === 'number' ? ts.Denominator : ts.denominator;
  if (typeof num === 'number') {
    const whole = typeof ts.WholeValue === 'number' ? ts.WholeValue
      : typeof ts.wholeValue === 'number' ? ts.wholeValue : 0;
    return (whole + num / (den || 1)) * 4;
  }
  if (typeof ts.WholeValue === 'number') return ts.WholeValue * 4;
  return 0;
}