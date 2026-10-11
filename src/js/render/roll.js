/**
 * render/roll.js — the piano roll.
 *
 * Two jobs beyond "show the notes":
 *  - it is the only score view for MIDI files, which have no notation;
 *  - it is the reliable playback cursor. Driving the notation cursor requires
 *    OSMD to have laid out the page; the roll is always available, always
 *    correct, and highlights every sounding note in the part's own colour.
 */

import { midiToName } from '../score/model.js';

const PALETTE = [
  '#5b8cff', '#f2994a', '#56c596', '#c084fc',
  '#f472b6', '#facc15', '#38bdf8', '#a3e635',
];

export class PianoRoll {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.notes = [];
    this.timing = null;
    this.duration = 0;
    this.playhead = 0;
    this.pixelsPerSecond = 46;
    this.viewStart = 0;   // seconds at the left edge of the note area
    this.rowH = 9;         // adapts to the piece's range in centreView()
    this.scrollY = 0;     // in semitones from the bottom
    this.lit = new Map(); // note.id -> expiry time, for the "sounding" tint
    this.onSeek = opts.onSeek || null;
    this.theme = opts.theme || {};
    this._dpr = 1;
    this._raf = null;

    canvas.addEventListener('pointerdown', (e) => this._onPointer(e));
    canvas.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });

    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(this.canvas.parentElement || this.canvas);
    this.resize();
  }

  setColorForPart(map) { this.partColors = map; }

  setScore(notes, timing, durationSec) {
    this.notes = notes || [];
    this.timing = timing;
    this.duration = Math.max(1, durationSec || 0);
    this.lit.clear();
    this.viewStart = 0;
    this.centreView();
  }

  centreView() {
    if (!this.notes.length) return;
    let lo = 127, hi = 0;
    for (const n of this.notes) { if (n.midi < lo) lo = n.midi; if (n.midi > hi) hi = n.midi; }
    this.range = { lo, hi };
    // Adaptive row height: a piece spanning two octaves should fill the pane,
    // not sit in a strip with eight empty octaves above and below it.
    const wantRows = Math.max(16, (hi - lo) + 14);
    const h = this._h || (this.canvas.clientHeight || 600);
    this.rowH = Math.max(7, Math.min(18, (h - 22) / wantRows));
    this.scrollY = (lo + hi) / 2 + (h - 22) / this.rowH / 2;
    this.clampScroll();
    this.draw();
  }

  _viewRows() {
    const h = this._h || (this.canvas.clientHeight || 600);
    return Math.max(12, Math.ceil((h - 22) / this.rowH));
  }

  clampScroll() {
    const rows = this._viewRows();
    const max = 128 + rows;
    this.scrollY = Math.max(rows - 2, Math.min(max, this.scrollY));
  }

  resize() {
    // Measure the CONTAINER, never the canvas. The canvas has no intrinsic
    // size, so sizing it from its own rect is a feedback loop that latches at
    // whatever it happened to be (1×1 when the view was hidden).
    const host = this.canvas.parentElement || this.canvas;
    const rect = host.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this._dpr = dpr;
    this._w = w;
    this._h = h;
    // Row height depends on the pane height, so re-fit the pitch range.
    if (this.notes.length) this.centreView(); else this.draw();
  }

  setZoom(pps) {
    this.pixelsPerSecond = Math.max(8, Math.min(400, pps));
    this._followPlayhead();
    this.draw();
  }

  setPlayhead(t) {
    this.playhead = t;
    this._followPlayhead();
    this._scheduleDraw();
  }

  /**
   * Keep the playhead inside the pane by moving the view, not the playhead.
   *
   * The view scrolls only when the playhead leaves the window -- off the left
   * after a seek, or past the right 80% while playing -- and then places it at
   * 30% from the left, so each jump buys most of a pane of music before the
   * next one. Between jumps the view is still, which is what leaves manual
   * scrolling (shift+wheel) usable while the piece plays.
   */
  _followPlayhead() {
    const w = this._w || (this.canvas.clientWidth || 800);
    const x0 = 78;
    const span = (w - x0) / this.pixelsPerSecond;
    if (span <= 0) return;
    const px = this.xForTime(this.playhead);
    if (px < x0 || px > w - 0.2 * (w - x0)) {
      const target = this.playhead - 0.3 * span;
      this.viewStart = Math.max(0, Math.min(target, this.duration - span * 0.5));
    }
  }

  flash(note) {
    this.lit.set(note.id, performance.now() + 140);
    this._scheduleDraw();
  }

  _scheduleDraw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = null; this.draw(); });
  }

  yForMidi(m) {
    const rows = this._viewRows();
    return (m - (this.scrollY - rows)) * this.rowH + 22;
  }

  midiForY(y) {
    const rows = this._viewRows();
    return Math.round((y - 22) / this.rowH + this.scrollY - rows);
  }

  xForTime(t) { return 78 + (t - this.viewStart) * this.pixelsPerSecond; }

  timeForX(x) { return Math.max(0, (x - 78) / this.pixelsPerSecond + this.viewStart); }

  draw() {
    const c = this.ctx;
    if (!c || !this._w) return;
    const { _w: w, _h: h } = this;
    const t = this.theme;

    c.save();
    c.scale(this._dpr, this._dpr);
    c.clearRect(0, 0, w, h);
    c.fillStyle = t.bg || '#0e1116';
    c.fillRect(0, 0, w, h);

    const rows = this._viewRows();
    const topMidi = Math.ceil(this.scrollY);
    const botMidi = Math.floor(this.scrollY - rows);

    // Pitch grid
    c.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    c.textBaseline = 'middle';
    for (let m = botMidi; m <= topMidi; m++) {
      if (m < 0 || m > 127) continue;
      const y = this.yForMidi(m);
      const pc = ((m % 12) + 12) % 12;
      const isBlack = [1, 3, 6, 8, 10].includes(pc);
      if (pc === 0) {
        c.fillStyle = t.lineStrong || 'rgba(255,255,255,0.14)';
        c.fillRect(78, y, w - 78, this.rowH);
      } else if (isBlack) {
        c.fillStyle = t.rowDark || 'rgba(255,255,255,0.028)';
        c.fillRect(78, y, w - 78, this.rowH);
      }
      if (pc === 0 || isBlack === false) {
        c.fillStyle = t.axisText || 'rgba(255,255,255,0.42)';
        c.fillText(midiToName(m), 10, y + this.rowH / 2);
      }
    }

    // Bar lines
    if (this.timing) {
      const bars = this.measureStarts();
      c.strokeStyle = t.barLine || 'rgba(255,255,255,0.10)';
      c.lineWidth = 1;
      for (const bs of bars) {
        const x = Math.round(this.xForTime(bs.sec)) + 0.5;
        if (x < 78 || x > w) continue;
        c.beginPath(); c.moveTo(x, 18); c.lineTo(x, h); c.stroke();
      }
    }

    // Notes
    const now = performance.now();
    const x0 = 78;
    // Cull against the window the view actually shows. The old culling used a
    // window derived from the playhead on the assumption that the view
    // followed it -- it did not, so as playback advanced, notes still sitting
    // visibly in the pane were culled off its left while the playhead walked
    // off its right.
    const viewStart = this.viewStart;
    const viewEnd = viewStart + (w - x0) / this.pixelsPerSecond;

    for (const n of this.notes) {
      if (n.time > viewEnd || n.time + n.duration < viewStart) continue;
      const y = this.yForMidi(n.midi);
      if (y < 14 || y > h) continue;
      // A note that began before the window clips at the gutter instead of
      // being drawn across the key labels.
      const x = Math.max(x0 - 1, this.xForTime(n.time));
      const nx = this.xForTime(n.time + Math.max(0.05, n.duration));
      const wdt = Math.max(2, nx - x - 1);
      if (nx < x0) continue;
      const col = (this.partColors && this.partColors.get(n.partId)) || PALETTE[0];
      const alpha = 0.42 + 0.5 * Math.min(1, n.velocity);
      const nh = Math.max(3, Math.min(9, this.rowH - 2));
      c.fillStyle = hexA(col, alpha);
      c.beginPath();
      if (c.roundRect) c.roundRect(x, y + 1, wdt, nh, 2);
      else c.rect(x, y + 1, wdt, nh);
      c.fill();

      if (this.lit.has(n.id) && this.lit.get(n.id) > now) {
        c.fillStyle = col;
        c.globalAlpha = 0.95;
        c.fill();
        c.globalAlpha = 1;
      }
    }

    // Playhead
    const px = this.xForTime(this.playhead);
    if (px >= x0 - 2) {
      c.strokeStyle = t.playhead || '#ff5f56';
      c.lineWidth = 1.5;
      c.beginPath();
      c.moveTo(Math.round(px) + 0.5, 0);
      c.lineTo(Math.round(px) + 0.5, h);
      c.stroke();
      c.fillStyle = t.playhead || '#ff5f56';
      c.beginPath();
      c.moveTo(px - 5, 0); c.lineTo(px + 5, 0); c.lineTo(px, 8); c.closePath();
      c.fill();
    }

    // Playhead ruler — current time
    c.fillStyle = t.bar || 'rgba(255,255,255,0.06)';
    c.fillRect(0, 0, w, 18);
    c.fillStyle = t.text || '#e8eaf0';
    c.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    c.textAlign = 'left';
    c.fillText(fmtTime(this.playhead), 8, 9);
    if (this.timing) {
      c.textAlign = 'right';
      c.fillStyle = t.axisText || 'rgba(255,255,255,0.5)';
      c.fillText(fmtTime(this.duration), w - 8, 9);
    }
    c.textAlign = 'left';
    c.restore();
  }

  /** Quarter positions of bar lines, derived from the time signature. */
  measureStarts() {
    if (this._measureCache && this._measureCacheLen === this.notes.length) return this._measureCache;
    const out = [];
    if (this.timing) {
      const ts = this.timing;
      let q = 0;
      const sig = { beats: 4, beatType: 4 };
      const map = this.timeSigs || [];
      let mapIdx = 0;
      let guard = 0;
      while (q <= ts.totalQuarters && guard++ < 20000) {
        while (mapIdx + 1 < map.length && map[mapIdx + 1].quarter <= q + 1e-6) {
          mapIdx++;
          sig.beats = map[mapIdx].beats;
          sig.beatType = map[mapIdx].beatType;
        }
        out.push({ quarter: q, sec: ts.secondsAtQuarter(q) });
        q += (sig.beats * 4) / sig.beatType;
      }
    }
    this._measureCache = out;
    this._measureCacheLen = this.notes.length;
    return out;
  }

  setTimeSigs(sigs) { this.timeSigs = sigs; this._measureCache = null; }

  _onPointer(e) {
    const rect = this.canvas.getBoundingClientRect();
    const t = this.timeForX(e.clientX - rect.left);
    if (this.onSeek) this.onSeek(Math.min(this.duration, t));
  }

  _onWheel(e) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      this.setZoom(this.pixelsPerSecond * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
    } else if (e.shiftKey) {
      e.preventDefault();
      // The canvas is pane-sized and scrolls by moving its own view window;
      // the old parentElement.scrollLeft had nothing to move and did nothing.
      this.viewStart = Math.max(0, Math.min(this.viewStart + e.deltaY / this.pixelsPerSecond,
        Math.max(0, this.duration - 1)));
      this.draw();
    } else {
      e.preventDefault();
      this.scrollY -= Math.sign(e.deltaY) * (e.deltaMode === 1 ? 1 : 3);
      this.clampScroll();
      this.draw();
    }
  }

  destroy() {
    if (this._ro) this._ro.disconnect();
  }
}

function fmtTime(sec) {
  if (!isFinite(sec)) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function hexA(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export { PALETTE };