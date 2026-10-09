/**
 * ui/app.js — the application controller.
 *
 * Owns all mutable state and the flow between the four panels. The important
 * invariant: `resolved` (the flat, timed note list) is derived from
 * (score, transpose, tempoScale) and is the single thing the audio engine, the
 * piano roll and the transport all read from. Changing a key or a tempo
 * recomputes it; nothing else has to know.
 */

import { resolveScore, describeScore, keyNameFromFifths } from '../score/model.js';
import { readScoreFiles } from '../io/files.js';
import { backendHealth, describePage, resolveBase, probeHealth, setBase, configuredBase } from '../io/omr.js';
import { INSTRUMENTS, createInstrument } from '../audio/instruments.js';
import { packState } from '../audio/sampler.js';
import { instrumentForProgram, instrumentForName } from '../audio/gm.js';
import { Engine } from '../audio/engine.js';
import { AudioBus, Meter, ROOMS, linToDb } from '../audio/fx.js';
import { renderToBuffer, encodeMp3, encodeWav, inspectMp3, BITRATES } from '../audio/mp3.js';
import { NotationView } from '../render/notation.js';
import { PianoRoll, PALETTE } from '../render/roll.js';
import { $, el, clear, icon, fmtTime, fmtBytes, fmtDb, toast, modal, bindRange } from './dom.js';

const ROLL_THEME = {
  bg: '#0b0e14',
  rowDark: 'rgba(255,255,255,0.026)',
  lineStrong: 'rgba(255,255,255,0.13)',
  barLine: 'rgba(255,255,255,0.085)',
  bar: 'rgba(255,255,255,0.05)',
  axisText: 'rgba(255,255,255,0.40)',
  text: '#e9ecf3',
  playhead: '#ffb454',
};

export class App {
  constructor() {
    this.library = [];
    this.references = [];
    this.omrReport = null;
    this.omrAccuracy = null;
    this.omrJob = null;
    this.activeId = null;
    this.score = null;
    this.resolved = null;
    this.partInstruments = new Map();
    this.transpose = 0;
    this.tempoScale = 1;
    this.view = 'score';
    this.position = 0;
    this.playing = false;

    this.settings = {
      volume: 0.85,
      roomId: 'studio',
      lowDb: 0, midDb: 0, highDb: 0,
      kbps: 192,
      sampleRate: 44100,
      normalize: true,
      metronome: false,
      countIn: 0,
      humanize: false,
    };

    this._audio = null;
    this._bus = null;
    this._engine = null;
    this._meter = null;
    this._meterRaf = null;
    this._partColors = new Map();
    this._exportAbort = null;
  }

  /* ------------------------------------------------------------- startup */

  init() {
    const d = this.dom = {
      app: $('#app'),
      docTitle: $('#docTitle'), docName: $('#docName'), docMeta: $('#docMeta'),
      libList: $('#libList'), fileInput: $('#fileInput'),
      refSec: $('#refSec'), refCard: $('#refCard'), refHint: $('#refHint'),
      omrSec: $('#omrSec'), omrCard: $('#omrCard'), omrBadge: $('#omrBadge'),
      inpOmrBase: $('#inpOmrBase'), btnOmrUse: $('#btnOmrUse'), btnOmrAuto: $('#btnOmrAuto'),
      omrStatus: $('#omrStatus'), omrBaseHint: $('#omrBaseHint'), packStatus: $('#packStatus'),
      busyBar: $('#busyBar'), dropHint: $('#dropHint'), fmtScan: $('#fmtScan'),
      paper: $('#paper'), paperWrap: $('#paperWrap'), rollWrap: $('#rollWrap'),
      rollCanvas: $('#rollCanvas'), stageEmpty: $('#stageEmpty'), stageBody: $('#stageBody'),
      dropzone: $('#dropzone'),
      partList: $('#partList'), selKey: $('#selKey'),
      selRoom: $('#selRoom'), selKbps: $('#selKbps'), selRate: $('#selRate'),
      btnPlay: $('#btnPlay'), btnStop: $('#btnStop'), btnPrev: $('#btnPrev'), btnNext: $('#btnNext'),
      btnExport: $('#btnExport'), btnOpen: $('#btnOpen'), btnBrowse: $('#btnBrowse'), btnAddMore: $('#btnAddMore'),
      scrubTrack: $('#scrubTrack'), scrubFill: $('#scrubFill'), scrubKnob: $('#scrubKnob'),
      tNow: $('#tNow'), tTotal: $('#tTotal'),
      tempoDisp: $('#tempoDisp'), tempoVal: $('#tempoVal'),
      keyDisp: $('#keyDisp'), transposeVal: $('#transposeVal'),
      zoomLabel: $('#zoomLabel'),
      meterR: $('#meterR'), meterP: $('#meterP'),
      rngTempo: $('#rngTempo'), rngCountIn: $('#rngCountIn'), rngVol: $('#rngVol'),
      rngLow: $('#rngLow'), rngMid: $('#rngMid'), rngHigh: $('#rngHigh'),
      volVal: $('#volVal'), roomVal: $('#roomVal'),
      lowVal: $('#lowVal'), midVal: $('#midVal'), highVal: $('#highVal'),
      kbpsVal: $('#kbpsVal'),
      chkMetronome: $('#chkMetronome'), chkHuman: $('#chkHuman'), chkNormalize: $('#chkNormalize'),
      countInVal: $('#countInVal'),
      btnZoomIn: $('#btnZoomIn'), btnZoomOut: $('#btnZoomOut'),
    };

    this.notation = new NotationView(d.paper);
    this.roll = new PianoRoll(d.rollCanvas, {
      theme: ROLL_THEME,
      onSeek: (t) => this.seek(t),
    });

    this._buildSelects();
    this._wire();
    this._meterLoop();
    this._syncAll();
  }

  _buildSelects() {
    const d = this.dom;
    clear(d.selRoom);
    for (const r of ROOMS) {
      d.selRoom.appendChild(el('option', { value: r.id, text: r.label }));
    }
    d.selRoom.value = this.settings.roomId;

    clear(d.selKbps);
    for (const b of BITRATES) {
      d.selKbps.appendChild(el('option', { value: b, text: `${b} kbps${b === 320 ? ' — best' : b <= 160 ? ' — compact' : ' — recommended'}` }));
    }
    d.selKbps.value = this.settings.kbps;
  }

  _wire() {
    const d = this.dom;

    if (d.inpOmrBase) {
      d.inpOmrBase.value = configuredBase() || '';
      d.inpOmrBase.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        this._applyBase(d.inpOmrBase.value);
      });
    }
    if (d.btnOmrUse) d.btnOmrUse.addEventListener('click', () => this._applyBase(d.inpOmrBase.value));
    if (d.btnOmrAuto) d.btnOmrAuto.addEventListener('click', () => this._applyBase(''));

    this._probeBackend();

    d.btnBrowse.addEventListener('click', () => d.fileInput.click());
    d.btnOpen.addEventListener('click', () => d.fileInput.click());
    d.btnAddMore.addEventListener('click', () => d.fileInput.click());
    d.fileInput.addEventListener('change', (e) => {
      this.addFiles([...e.target.files]);
      e.target.value = '';
    });

    // Drag & drop anywhere on the page.
    let dragDepth = 0;
    window.addEventListener('dragenter', (e) => {
      if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
      e.preventDefault();
      dragDepth++;
      d.dropzone.classList.add('hot');
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('dragleave', () => {
      if (--dragDepth <= 0) { dragDepth = 0; d.dropzone.classList.remove('hot'); }
    });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      d.dropzone.classList.remove('hot');
      if (e.dataTransfer?.files?.length) this.addFiles([...e.dataTransfer.files]);
    });

    d.btnPlay.addEventListener('click', () => this.togglePlay());
    d.btnStop.addEventListener('click', () => this.stop());
    d.btnPrev.addEventListener('click', () => this.seek(0));
    d.btnNext.addEventListener('click', () => this._stepNote(1));
    d.btnExport.addEventListener('click', () => this.openExport());

    // Scrubbing
    const scrubTo = (e) => {
      const r = d.scrubTrack.getBoundingClientRect();
      const p = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      this.seek(p * this.duration());
    };
    let scrubbing = false;
    d.scrubTrack.addEventListener('pointerdown', (e) => {
      scrubbing = true;
      d.scrubTrack.setPointerCapture(e.pointerId);
      scrubTo(e);
    });
    d.scrubTrack.addEventListener('pointermove', (e) => { if (scrubbing) scrubTo(e); });
    d.scrubTrack.addEventListener('pointerup', (e) => {
      scrubbing = false;
      try { d.scrubTrack.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    });

    bindRange(d.rngTempo, (v) => {
      this.tempoScale = v / 100;
      this.recompute({ keepPlaying: this.playing });
      this._syncTempo();
    });
    bindRange(d.rngCountIn, (v) => {
      this.settings.countIn = v;
      d.countInVal.textContent = v === 0 ? 'off' : `${v} bar${v > 1 ? 's' : ''}`;
    });
    bindRange(d.rngVol, (v) => {
      this.settings.volume = v / 100;
      d.volVal.textContent = v + '%';
      this._bus?.setParams({ volume: this.settings.volume });
    });
    for (const [key, node, label] of [['lowDb', d.rngLow, d.lowVal], ['midDb', d.rngMid, d.midVal], ['highDb', d.rngHigh, d.highVal]]) {
      bindRange(node, (v) => {
        this.settings[key] = v;
        label.textContent = fmtDb(v);
        this._bus?.setParams({ [key === 'lowDb' ? 'lowDb' : key === 'midDb' ? 'midDb' : 'highDb']: v });
      });
    }

    d.selRoom.addEventListener('change', () => {
      this.settings.roomId = d.selRoom.value;
      const room = ROOMS.find((r) => r.id === this.settings.roomId);
      d.roomVal.textContent = room.label;
      this._bus?.setRoom(room);
    });
    d.selKbps.addEventListener('change', () => {
      this.settings.kbps = +d.selKbps.value;
      d.kbpsVal.textContent = `${this.settings.kbps} kbps`;
    });
    d.selRate.addEventListener('change', () => { this.settings.sampleRate = +d.selRate.value; });
    d.chkMetronome.addEventListener('change', () => { this.settings.metronome = d.chkMetronome.checked; });
    d.chkHuman.addEventListener('change', () => { this.settings.humanize = d.chkHuman.checked; });
    d.chkNormalize.addEventListener('change', () => { this.settings.normalize = d.chkNormalize.checked; });

    d.selKey.addEventListener('change', () => {
      this.transpose = +d.selKey.value;
      this.recompute({ keepPlaying: this.playing });
      this._syncKey();
    });

    $('#tempoUp').addEventListener('click', () => this._nudgeTempo(+2));
    $('#tempoDown').addEventListener('click', () => this._nudgeTempo(-2));
    $('#keyUp').addEventListener('click', () => this._nudgeKey(1));
    $('#keyDown').addEventListener('click', () => this._nudgeKey(-1));

    d.btnZoomIn.addEventListener('click', () => this._zoom(+0.15));
    d.btnZoomOut.addEventListener('click', () => this._zoom(-0.15));

    for (const t of document.querySelectorAll('.tab[data-view]')) {
      t.addEventListener('click', () => this.setView(t.dataset.view));
    }

    window.addEventListener('keydown', (e) => {
      if (e.target.matches('input,select,textarea')) return;
      if (e.key === ' ') { e.preventDefault(); this.togglePlay(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); this.seek(Math.max(0, this.position - (e.shiftKey ? 10 : 3))); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); this.seek(Math.min(this.duration(), this.position + (e.shiftKey ? 10 : 3))); }
      else if (e.key === 'Home') { e.preventDefault(); this.seek(0); }
      else if (e.key === 'e' && (e.metaKey || e.ctrlKey)) return;
      else if (e.key === 'E') { e.preventDefault(); this.openExport(); }
    });

    window.addEventListener('beforeunload', () => { this._engine?.dispose(); });
  }

  /* --------------------------------------------------------------- files */

  async addFiles(files) {
    const usable = files.filter((f) => /\.(musicxml|xml|mxl|mscz|mscx|mid|midi|kar|rmi|png|jpe?g|webp|gif|bmp|pdf)$/i.test(f.name));
    if (!usable.length) {
      toast('Nothing to load', 'That file type is not supported.', 'err');
      return;
    }

    const scans = usable.filter((f) => /\.(png|jpe?g|webp|gif|bmp|pdf)$/i.test(f.name));
    if (scans.length) {
      const health = await backendHealth();
      if (!health.reachable) {
        toast(
          'Recognition service not running',
          'The scan is attached for reference instead.', 'warn'
        );
      } else {
        this._setBusy(`Reading ${scans.length === 1 ? scans[0].name : `${scans.length} scans`}…`);
      }
    }

    let read;
    try {
      read = await readScoreFiles(usable, {
        onProgress: (m) => this._setBusy(m),
        onOmrStarted: (job) => this._beginOmrJob(job),
        onOmrProgress: (view) => this._paintOmrJob(view),
      });
    } finally {
      this._setBusy(null);
      this._endOmrJob();
    }
    const { ok, failed } = read;

    for (const r of ok) {
      if (r.kind === 'score') {
        this.library.push(r.score);
        // A multi-page PDF yields one score per page.
        for (const extra of r.extraScores || []) this.library.push(extra);
        if (r.reference) {
          this.references = this.references.filter((x) => x.url !== r.reference.url);
          this.references.push(r.reference);
        }
        if (r.omr) {
          this.omrReport = { ...r.omr, name: r.score.fileName, reference: r.reference };
          this._renderOmrSection();
        }
      } else {
        this.references = this.references.filter((x) => x.url !== r.reference.url);
        this.references.push(r.reference);
      }
    }
    for (const f of failed) {
      if (f.cancelled) toast(`Stopped reading ${f.file.name}`, 'The scan was not transcribed.', 'warn');
      else toast(`Could not read ${f.file.name}`, f.error, 'err');
    }

    this._renderLibrary();
    this._renderReferences();

    const first = ok.find((r) => r.kind === 'score');
    if (first && !this.activeId) this.setActive(first.score.id);
    else if (first) {
      const wasActive = this.activeId;
      this.setActive(first.score.id);
      if (wasActive && wasActive !== first.score.id) { /* keep the new one selected */ }
    }

    if (ok.some((r) => r.kind === 'score')) {
      const scanned = ok.find((r) => r.omr);
      const n = ok.filter((r) => r.kind === 'score').length + ok.reduce((a, r) => a + (r.extraScores?.length || 0), 0);
      if (scanned) {
        const p = scanned.omr;
        toast(
          `Read ${p.totalNotes} note${p.totalNotes === 1 ? '' : 's'} from ${scanned.reference.name}`,
          `${p.engine} ${p.version} on CPU · ${p.seconds.toFixed(1)}s · check the transcription panel`, 'ok'
        );
      } else {
        toast(n === 1 ? 'Score loaded' : `${n} scores loaded`,
          first && first.score.warnings.length ? first.score.warnings[0] : '', 'ok');
      }
    } else if (ok.length) {
      toast('Scan attached', 'Shown in the Source scan panel for reference.', 'ok');
    }
  }

  /* ------------------------------------------------- recognition backend */

  /**
   * Tell the user up front whether scans will be transcribed or only kept as
   * reference. Probing is one request and never blocks startup.
   */
  async _probeBackend() {
    this._paintBackend(await probeHealth(true));
  }

  /**
   * Pin the recognition backend, or clear the pin and go back to discovery.
   * The input is updated here rather than in the paint, so a probe that lands
   * mid-edit cannot overwrite what the user is typing.
   */
  async _applyBase(value) {
    const clean = String(value || '').trim().replace(/\/+$/, '');
    if (this.dom.inpOmrBase) this.dom.inpOmrBase.value = clean;
    this._paintBackend(await setBase(clean));
  }

  /**
   * Repaint everything that depends on the backend's state: the header badge,
   * the file-type help, and the recognition service panel.
   */
  _paintBackend(health) {
    const badge = this.dom.omrBadge;
    const fmt = this.dom.fmtScan;
    const hint = this.dom.dropHint;
    if (health.reachable && health.ok) {
      if (badge) {
        badge.classList.remove('off');
        badge.textContent = `${(health.engine || 'omr').toUpperCase()} · CPU`;
        badge.title = `${health.engine} ${health.version} — ${health.notes}`;
      }
      if (fmt) fmt.innerHTML = `<b>Scans</b> .png .jpg .webp .pdf — read on the CPU by ${health.engine}`;
      if (hint) {
        hint.innerHTML = 'MusicXML and MIDI are read in this page. ' +
          'Photos and PDFs are read by the recognition service.';
      }
    } else {
      if (badge) {
        badge.classList.add('off');
        badge.textContent = 'OFFLINE';
        badge.title = health.reachable
          ? `Recognition service reachable but not ready: ${health.error || 'engine not initialised'}`
          : `Recognition service is not running at ${health.base}`;
      }
      if (fmt) fmt.innerHTML = '<b>Reference</b> .png .jpg .pdf — recognition service not running';
      if (hint) {
        hint.innerHTML = 'MusicXML and MIDI are read in this page. ' +
          'Photos and PDFs are attached as reference images, because no recognition service is running.';
      }
    }
    this._paintBasePanel(health);
    this._loadAccuracy(health);
  }

  /**
   * Where the recorded-instrument pack has got to.
   *
   * This is worth showing because the two states look identical from the
   * instrument list: a recorded instrument chosen before its pack is ready
   * quietly plays the modelled one instead, and without this the user would
   * pick "Concert Grand (recorded)" and hear the synthesiser.
   */
  _paintPackProgress(p) {
    const el = this.dom.packStatus;
    if (!el) return;
    const s = packState();
    const pct = p ? Math.round((p.done / Math.max(1, p.total)) * 100) : Math.round(s.progress * 100);

    let text, tone;
    if (s.state === 'ready') {
      text = `recorded instruments ready — ${s.loaded.length} instruments`;
      tone = 'ok';
    } else if (s.state === 'loading') {
      text = `loading recorded instruments — ${pct}%`;
      tone = '';
    } else if (s.state === 'unavailable') {
      text = 'recorded instruments need this page to be served over http, not opened as a file';
      tone = 'warn';
    } else if (s.state === 'failed') {
      text = `recorded instruments unavailable — ${s.error || 'the pack could not be fetched'}`;
      tone = 'bad';
    } else {
      text = 'recorded instruments not loaded';
      tone = '';
    }
    el.textContent = text;
    el.className = `hint ${tone}`.trim();
  }

  /**
   * The settings panel's own status line and hint.
   *
   * The mode matters as much as the reachability: a base pinned in the panel
   * and a base forced by `?api=` behave identically to everything downstream,
   * but the user needs to know which one they are looking at before changing
   * the field has any effect.
   */
  _paintBasePanel(health) {
    const status = this.dom.omrStatus;
    const note = this.dom.omrBaseHint;
    if (!status && !note) return;

    const pinned = configuredBase();
    let link = null;
    try {
      link = new URLSearchParams(location.search).get('api');
    } catch { /* the field still works without it */ }

    // Same precedence as candidateBases(): the link override wins over the pin,
    // so the label must lead with the link or it names the wrong source.
    const mode = link
      ? `Set by this link (${link.replace(/\/+$/, '')})`
      : pinned
        ? `Pinned to ${pinned}`
        : 'Automatic';

    const answering = health.base || location.origin;
    let label;
    let detail;
    let tone;

    if (health.reachable && health.ok) {
      label = 'ready';
      detail = `${mode} · answering at ${answering}`;
      tone = 'ok';
    } else if (health.reachable) {
      label = 'not ready';
      detail = `${mode} · ${answering} is up but the engine is still warming up` +
        (health.error ? `: ${health.error}` : '');
      tone = 'bad';
    } else {
      label = 'not running';
      const tried = (health.tried || []).map((t) => t.base).filter(Boolean);
      detail = `${mode} · nothing answered at ${tried.length ? tried.join(' or ') : answering}`;
      tone = 'bad';
    }

    if (status) {
      status.textContent = label;
      status.title = health.reachable && health.ok
        ? `${health.engine} ${health.version} — ${health.notes}`
        : health.error || detail;
    }
    if (note) {
      note.textContent = detail;
      note.className = `hint ${tone}`;
    }
  }

  async _loadAccuracy(health) {
    if (!health.reachable) return;
    try {
      const res = await fetch(`${resolveBase()}/api/accuracy`, { cache: 'no-store' });
      if (!res.ok) return;
      const body = await res.json();
      if (body && body.available !== false && body.summary) {
        this.omrAccuracy = body;
        this._renderOmrSection();
      }
    } catch { /* the panel is optional */ }
  }

  _setBusy(message) {
    const bar = this.dom.busyBar;
    if (!bar) return;
    if (!message) { bar.hidden = true; bar.textContent = ''; return; }
    bar.hidden = false;
    bar.textContent = message;
  }

  /**
   * Take ownership of a submitted transcription so the panel can follow it and
   * the user can stop it. One scan is read at a time, so there is exactly one
   * of these; a second load replaces it.
   */
  _beginOmrJob(handle) {
    this.omrJob = { handle, view: null, stopping: false };
    this._renderOmrSection();
  }

  /** Follow one polled view from the recognition service. */
  _paintOmrJob(view) {
    const job = this.omrJob;
    if (!job) return;
    job.view = view;
    // The server says "Stopping after the current page" while it finishes the
    // page in flight. Mirror that rather than inventing a second idea of when
    // the scan has actually stopped.
    job.stopping = /stopping/i.test(view.message || '');
    const pct = Math.round((view.progress || 0) * 100);
    this._setBusy(job.stopping ? 'Stopping after the current page…' : `${view.message || 'Reading'} · ${pct}%`);
    this._renderOmrSection();
  }

  _endOmrJob() {
    if (!this.omrJob) return;
    this.omrJob = null;
    this._renderOmrSection();
  }

  /**
   * Stop a running transcription. The engine reads a page in one blocking
   * call, so the page in flight always finishes -- which is why the button
   * says so rather than pretending to stop instantly.
   */
  async _abortOmrJob() {
    const job = this.omrJob;
    if (!job || job.stopping) return;
    job.stopping = true;
    this._setBusy('Stopping after the current page…');
    this._renderOmrSection();
    await job.handle.cancel();
  }

  /** The Transcription panel shows whichever of the two things is current. */
  _renderOmrSection() {
    if (this.omrJob) return this._renderOmrJob();
    return this._renderOmrReport();
  }

  /** The Transcription panel while a scan is being read. */
  _renderOmrJob() {
    const d = this.dom;
    if (!d.omrSec) return;
    d.omrSec.hidden = false;
    const card = clear(d.omrCard);
    const job = this.omrJob;
    const view = job.view || {};
    const pct = Math.max(0, Math.min(100, Math.round((view.progress || 0) * 100)));
    const msg = job.stopping
      ? 'Stopping after the current page…'
      : (view.message || 'Sending this scan to the recogniser…');

    card.appendChild(el('div', { class: 'omr-job' },
      el('div', { class: 'omr-job-head' },
        el('span', { class: 'omr-job-title', text: job.stopping ? 'Stopping' : 'Reading this scan' }),
        el('span', { class: 'omr-job-pct', text: `${pct}%` })),
      el('div', { class: 'omr-job-track' },
        el('div', { class: 'omr-job-fill', style: { width: `${pct}%` } })),
      el('div', { class: 'omr-job-foot' },
        el('span', { class: 'omr-job-msg', text: msg }),
        view.seconds ? el('span', { class: 'omr-job-time', text: `${view.seconds.toFixed(1)}s` }) : null,
        el('button', {
          class: 'btn ghost sm',
          text: job.stopping ? 'Stopping…' : 'Abort',
          disabled: job.stopping,
          title: 'Stop reading this scan. The page being read finishes first.',
          onclick: () => this._abortOmrJob(),
        }))));

    card.appendChild(el('div', {
      class: 'omr-note',
      text: 'Recognition runs in the background on the CPU, so you can carry on with the rest of the page. The transcription appears here when it is ready.',
    }));
  }

  /**
   * Save the MusicXML for one transcribed page.
   *
   * This is the recogniser's own output rather than the app's internal model
   * written back out, so what lands on disk opens as-is in a notation editor.
   */
  _saveOmrXml(page) {
    const rep = this.omrReport || {};
    const stem = String(rep.name || 'scan').replace(/\.[^.]+$/, '');
    const suffix = (rep.pages || []).length > 1 ? `-page${page.page + 1}` : '';
    const filename = `${stem}${suffix}.musicxml`;
    saveBlob(
      new Blob([page.musicxml], { type: 'application/vnd.recordare.musicxml+xml' }),
      filename
    );
    toast('MusicXML saved', filename, 'ok');
  }

  /** Side-by-side: what the recogniser was shown, and what it made of it. */
  _renderOmrReport() {
    const d = this.dom;
    if (!d.omrSec) return;
    const rep = this.omrReport;
    // Clear before the early return. Otherwise a job that ended with no report
    // -- a cancelled scan, say -- leaves its progress card sitting in a hidden
    // section, still offering an Abort button for a job that no longer exists.
    const card = clear(d.omrCard);
    if (!rep) { d.omrSec.hidden = true; return; }
    d.omrSec.hidden = false;
    const active = this.score && this.score.omr;
    const pages = rep.pages || [];

    const grid = el('div', { class: 'omr-grid' });
    const scanSide = el('div', { class: 'omr-side' },
      el('div', { class: 'omr-cap', text: 'What the recogniser saw' }));
    const resultSide = el('div', { class: 'omr-side' },
      el('div', { class: 'omr-cap', text: 'What it read' }));

    if (active && active.preview) {
      scanSide.appendChild(el('img', { class: 'omr-img', src: active.preview, alt: 'Preprocessed page sent to the recogniser' }));
    } else if (this.references.length) {
      const ref = this.references[this.references.length - 1];
      if (ref.type === 'image') scanSide.appendChild(el('img', { class: 'omr-img', src: ref.url, alt: ref.name }));
      else scanSide.appendChild(el('embed', { class: 'omr-img', src: ref.url, type: 'application/pdf' }));
    }
    scanSide.appendChild(el('div', { class: 'omr-sub', text: `${rep.name || ''} — blank margins cropped for display`.trim() }));

    const stats = el('div', { class: 'omr-stats' });
    pages.forEach((p) => {
      const isActive = active && active.page === p.page;
      stats.appendChild(el('button', {
        class: 'omr-page' + (isActive ? ' active' : ''),
        onclick: () => {
          const score = this.library.find((s) => s.omr && s.omr.page === p.page);
          if (score) this.setActive(score.id);
        },
      },
        el('div', { class: 'omr-page-no', text: `Page ${p.page + 1}` }),
        el('div', { class: 'omr-page-stats', text: describePage(p) }),
        el('div', { class: 'omr-page-t', text: `${p.seconds.toFixed(1)}s · best: ${p.variant}` }),
      ));
    });
    resultSide.appendChild(stats);
    resultSide.appendChild(el('div', {
      class: 'omr-sub',
      text: `${rep.engine} ${rep.version} · ${rep.device.toUpperCase()} · ${rep.pages.length} page${rep.pages.length === 1 ? '' : 's'} · ${rep.seconds.toFixed(1)}s`,
    }));

    grid.appendChild(scanSide);
    grid.appendChild(resultSide);
    card.appendChild(grid);

    const tried = (active && active.variantsTried) || [];
    if (tried.length > 1) {
      card.appendChild(el('div', { class: 'omr-try' },
        el('span', { class: 'omr-try-cap', text: 'Read attempts' }),
        ...tried.map((v) => el('span', {
          class: 'omr-try-chip' + (v.variant === active.variant ? ' win' : ''),
          text: `${v.variant} · ${v.notes}`,
        }))
      ));
    }

    const acc = this.omrAccuracy;
    if (acc && acc.summary) {
      const s = acc.summary;
      const others = Object.entries(acc.modes || {})
        .filter(([k]) => k !== 'none')
        .map(([k, m]) => `${(m.label || k)} ${m.f1}%`);
      card.appendChild(el('div', { class: 'omr-acc' },
        `Measured on this machine: ${s.f1}% of notes read correctly across ${s.fixtures} test scores` +
        (others.length ? ` (${others.join(', ')} after degradation)` : '') +
        `, ${s.secondsPerPage}s per page on the CPU.`));
    }

    // Only offer the save for the page on screen, and only once the report has
    // a body to save -- a page the recogniser gave up on has no MusicXML.
    const shown = active && pages.find((p) => p.page === active.page);
    if (shown && shown.musicxml) {
      card.appendChild(el('div', { class: 'omr-save' },
        el('button', {
          class: 'btn ghost sm',
          text: 'Save MusicXML',
          title: `Download page ${shown.page + 1} as MusicXML`,
          onclick: () => this._saveOmrXml(shown),
        }),
        el('span', {
          class: 'omr-note',
          text: `The MusicXML for page ${shown.page + 1}, exactly as the recogniser wrote it.` +
            (pages.length > 1 ? ' Pick a page on the right to save a different one.' : ''),
        })));
    }
  }

  _renderLibrary() {
    const list = clear(this.dom.libList);
    if (!this.library.length) {
      list.appendChild(el('p', { style: 'color:var(--ink-3);font-size:12px;margin:2px 4px', text: 'Nothing loaded yet.' }));
      return;
    }
    this.library.forEach((s, i) => {
      const color = PALETTE[i % PALETTE.length];
      const item = el('div', {
        class: 'lib-item' + (s.id === this.activeId ? ' active' : ''),
        onclick: (e) => { if (!e.target.closest('.x')) this.setActive(s.id); },
      },
        el('span', { class: 'dot', style: { background: color } }),
        el('div', { class: 'tx' },
          el('div', { class: 'n', text: s.title || s.fileName || 'Untitled' }),
          el('div', { class: 's', text: `${s.sourceFormat === 'midi' ? 'MIDI' : s.sourceFormat === 'mscx' ? 'MuseScore' : 'MusicXML'} · ${describeScore(s)}` })
        ),
        el('button', {
          class: 'x', title: 'Remove', text: '×',
          onclick: () => this.removeScore(s.id),
        })
      );
      list.appendChild(item);
    });
  }

  _renderReferences() {
    const d = this.dom;
    const ref = this.references[this.references.length - 1];
    if (!ref) { d.refSec.hidden = true; return; }
    d.refSec.hidden = false;
    const card = clear(d.refCard);
    const holder = el('div', { class: 'ref-card' });
    if (ref.type === 'image') holder.appendChild(el('img', { src: ref.url, alt: ref.name }));
    else holder.appendChild(el('embed', { src: ref.url, type: 'application/pdf' }));
    holder.appendChild(el('div', { class: 'ref-meta' },
      el('span', { text: ref.name }),
      el('button', {
        class: 'btn ghost sm', text: 'Remove',
        onclick: () => {
          URL.revokeObjectURL(ref.url);
          this.references = this.references.filter((r) => r !== ref);
          this._renderReferences();
        },
      })
    ));
    card.appendChild(holder);

    // The "can't read notes" warning is only true while nothing has read this
    // scan. Once a transcription exists the reference panel is just the source,
    // so it must not keep claiming the scan was never read.
    const hint = d.refHint;
    if (hint) {
      const read = this.omrReport && this.omrReport.reference;
      hint.hidden = !!read;
      if (read) {
        hint.textContent = 'This is the original scan. The Transcription panel below shows what the recogniser was shown and what it made of it.';
      }
    }
  }

  removeScore(id) {
    const wasActive = this.activeId === id;
    this.library = this.library.filter((s) => s.id !== id);
    this._renderLibrary();
    if (wasActive) {
      this.activeId = null;
      this.setActive(this.library[0]?.id || null);
    }
  }

  /* --------------------------------------------------------- score active */

  async setActive(id) {
    this.stop();
    this.activeId = id;
    const score = this.library.find((s) => s.id === id) || null;
    this.score = score;
    this.transpose = 0;

    this._renderLibrary();
    this.dom.btnExport.disabled = !score;
    this._renderOmrSection();

    if (!score) {
      this.resolved = null;
      this.notation.clear();
      this.roll.setScore([], null, 0);
      this.dom.stageEmpty.hidden = false;
      this.dom.paperWrap.hidden = true;
      this.dom.rollWrap.hidden = true;
      this.dom.docTitle.classList.add('empty');
      this.dom.docName.textContent = 'No score loaded';
      this.dom.docMeta.textContent = '';
      this._syncAll();
      return;
    }

    // Choose an instrument per part from whatever the file told us.
    this.partInstruments = new Map();
    score.parts.forEach((p, i) => {
      const id = instrumentForName(p.name) || instrumentForProgram(p.midiProgram) || 'grand';
      this.partInstruments.set(p.id, id);
      if (!this._partColors.has(p.id)) this._partColors.set(p.id, PALETTE[i % PALETTE.length]);
    });
    this.roll.setColorForPart(this._partColors);
    this.roll.setTimeSigs(score.timeSigs);

    this.dom.stageEmpty.hidden = true;
    this.dom.docTitle.classList.remove('empty');
    this.dom.docName.textContent = score.title || score.fileName || 'Untitled';
    this.dom.docMeta.textContent = `${score.composer ? score.composer + ' · ' : ''}${describeScore(score)}`;

    this.recompute({ keepPlaying: false });

    const hasNotation = !!score.rawMusicXml;
    document.querySelector('.tab[data-view="score"]').disabled = !hasNotation;
    if (!hasNotation) this.view = 'roll';
    this.setView(hasNotation ? 'score' : 'roll');

    if (hasNotation) {
      await this.notation.load(score);
      this.notation.resetCursor();
    } else {
      this.notation.clear();
      this.dom.paper.innerHTML = '';
    }
  }

  recompute({ keepPlaying = false } = {}) {
    if (!this.score) return;
    if (keepPlaying) this._engine?.pause();
    this.resolved = resolveScore(this.score, {
      transpose: this.transpose,
      tempoScale: this.tempoScale,
    });
    if (this._engine) {
      this._engine.load(this.resolved, { score: this.score, partInstruments: this.partInstruments });
    }
    this.roll.setScore(this.resolved.notes, this.resolved.timing, this.resolved.durationSec);
    this.position = 0;
    this._syncAll();
    if (keepPlaying && this.playing) this._engine?.play(0);
  }

  duration() { return this.resolved ? this.resolved.durationSec : 0; }

  /* ------------------------------------------------------------ playback */

  ensureAudio() {
    if (this._audio) return this._audio;
    const AC = window.AudioContext || window.webkitAudioContext;
    this._audio = new AC({ latencyHint: 'interactive' });
    this._bus = new AudioBus(this._audio, this._audio.destination);
    this._bus.setRoom(ROOMS.find((r) => r.id === this.settings.roomId));
    this._bus.setParams({
      volume: this.settings.volume,
      lowDb: this.settings.lowDb, midDb: this.settings.midDb, highDb: this.settings.highDb,
    });
    this._engine = new Engine(this._audio, { bus: this._bus });
    this._meter = new Meter(this._bus.analyser);
    this._wireEngine();
    if (this.resolved) {
      this._engine.load(this.resolved, { score: this.score, partInstruments: this.partInstruments });
    }
    return this._audio;
  }

  _wireEngine() {
    const e = this._engine;
    e.on((ev) => {
      if (ev.type === 'note' && ev.on) {
        this.roll.flash(ev.note);
      } else if (ev.type === 'time') {
        this._tickPosition(ev.position);
      } else if (ev.type === 'ended') {
        this.playing = false;
        this._syncPlayButton();
      }
    });
  }

  togglePlay() {
    if (!this.score) { this.dom.fileInput.click(); return; }
    this.ensureAudio();
    if (this._audio.state === 'suspended') this._audio.resume();
    if (this.playing) {
      this._engine.pause();
      this.playing = false;
    } else {
      this._engine.metronome = this.settings.metronome;
      this._engine.countInBeats = this.settings.countIn > 0 ? this.settings.countIn * 4 : 0;
      this._engine.humanize = this.settings.humanize ? 1 : 0;
      // Parked at the end means "play again", not "play the last note over".
      // The seek has to come before the read: the engine emits its new
      // position on the next tick, so reading this.position here would still
      // give the old end time and playback would start on the final bar.
      let from = this.position;
      if (from >= this.duration() - 0.05) { this._engine.seek(0); from = 0; }
      this._engine.play(from);
      this.playing = true;
    }
    this._syncPlayButton();
  }

  /**
   * Play a short figure on an instrument, so picking one is audible rather
   * than a guess from a list of names.
   *
   * It goes through the same instrument builder and the same master bus as
   * playback, so what you hear is the sound the instrument will have in the
   * mix -- same room, same EQ -- rather than a separate preview sound. Only
   * one audition is ever alive: changing the selection again cuts the last
   * one off instead of stacking them.
   */
  auditionInstrument(instrumentId) {
    const ctx = this.ensureAudio();
    if (ctx.state === 'suspended') ctx.resume();

    if (this._auditionTimer) clearTimeout(this._auditionTimer);
    if (this._auditionInst) {
      try { this._auditionInst.dispose(ctx.currentTime + 0.02); } catch { /* already gone */ }
      this._auditionInst = null;
    }

    let inst;
    try {
      inst = createInstrument(instrumentId, ctx, this._bus.input);
    } catch (e) {
      console.error('could not audition instrument', instrumentId, e);
      return;
    }
    this._auditionInst = inst;

    // C4-E4-G4 rolled rather than struck together, so the attack is part of
    // what you hear. The lead absorbs the gap while a suspended context resumes.
    const start = ctx.currentTime + 0.08;
    [60, 64, 67].forEach((midi, i) => {
      try {
        inst.noteOn({ midi, velocity: 0.75, when: start + i * 0.11, duration: 1.3, channel: 0 });
      } catch (e) {
        console.error('audition note failed', e);
      }
    });

    const lifeMs = 2600;
    this._auditionTimer = setTimeout(() => {
      this._auditionTimer = null;
      this._auditionInst = null;
      try { inst.dispose(ctx.currentTime + 0.05); } catch { /* already gone */ }
    }, lifeMs);
  }

  stop() {
    if (this._engine) this._engine.stop();
    this.playing = false;
    this.position = 0;
    this.notation.resetCursor();
    this._syncPlayButton();
    this._tickPosition(0);
  }

  seek(sec) {
    const t = Math.max(0, Math.min(this.duration(), sec));
    this.position = t;
    if (this._engine) this._engine.seek(t);
    this._tickPosition(t);
  }

  _stepNote(dir) {
    if (!this.resolved) return;
    const notes = this.resolved.notes;
    let t = this.position;
    if (dir > 0) { const n = notes.find((x) => x.time > t + 1e-3); t = n ? n.time : this.duration(); }
    else {
      const prior = notes.filter((x) => x.time < t - 1e-3);
      t = prior.length ? prior[prior.length - 1].time : 0;
    }
    this.seek(t);
  }

  /* ------------------------------------------------------------- display */

  _tickPosition(t) {
    this.position = t;
    const dur = this.duration();
    const p = dur ? Math.max(0, Math.min(1, t / dur)) : 0;
    this.dom.scrubFill.style.width = (p * 100) + '%';
    this.dom.scrubKnob.style.left = (p * 100) + '%';
    this.dom.tNow.textContent = fmtTime(t);

    this.roll.setPlayhead(t);

    if (this.view === 'score' && this.resolved && this._engine) {
      const q = this.resolved.timing.quarterAtSeconds(t);
      this.notation.showCursorAtQuarter(q);
    }
  }

  setView(view) {
    if (view === 'score' && !this.score?.rawMusicXml) view = 'roll';
    this.view = view;
    for (const t of document.querySelectorAll('.tab[data-view]')) {
      t.classList.toggle('active', t.dataset.view === view);
    }
    this.dom.paperWrap.hidden = view !== 'score';
    this.dom.rollWrap.hidden = view !== 'roll';
    if (view === 'roll') this.roll.resize();
    if (view === 'score') this.notation.resetCursor();
  }

  _zoom(delta) {
    if (this.view === 'score') {
      const z = this.notation.setZoom(this.notation.zoom + delta);
      this.dom.zoomLabel.textContent = Math.round(z * 100) + '%';
    } else {
      const z = this.roll.pixelsPerSecond * (1 + delta);
      this.roll.setZoom(z);
      this.dom.zoomLabel.textContent = Math.round((z / 46) * 100) + '%';
    }
  }

  _meterLoop() {
    const tick = () => {
      if (this._meter && this._audio && this._audio.state === 'running') {
        const { peak, rms } = this._meter.read();
        this.dom.meterR.style.width = clampPct(rms);
        this.dom.meterP.style.width = clampPct(peak);
      } else {
        this.dom.meterR.style.width = '0%';
        this.dom.meterP.style.width = '0%';
      }
      this._meterRaf = requestAnimationFrame(tick);
    };
    this._meterRaf = requestAnimationFrame(tick);
  }

  /* --------------------------------------------------------------- panels */

  _renderParts() {
    const host = clear(this.dom.partList);
    if (!this.score || !this.score.parts.length) {
      host.appendChild(el('p', { style: 'color:var(--ink-3);font-size:12px', text: 'Load a score to see its parts.' }));
      return;
    }
    const groups = groupBy(INSTRUMENTS, (i) => i.group);

    this.score.parts.forEach((p) => {
      const sel = el('select', {
        title: 'Instrument for ' + p.name,
        onchange: (e) => {
          this.partInstruments.set(p.id, e.target.value);
          if (this._engine) this._engine.setPartInstrument(p.id, e.target.value);
          // While the music is running the swap is already audible, so an
          // audition would only talk over it.
          if (!this.playing) this.auditionInstrument(e.target.value);
        },
      });
      for (const [g, items] of groups) {
        const og = el('optgroup', { label: g });
        for (const i of items) og.appendChild(el('option', { value: i.id, text: i.name }));
        sel.appendChild(og);
      }
      sel.value = this.partInstruments.get(p.id) || 'grand';

      const mute = el('button', {
        class: 'mini mute' + (p.muted ? ' on' : ''), text: 'M', title: 'Mute',
        onclick: () => {
          p.muted = !p.muted;
          mute.classList.toggle('on', p.muted);
          this._applyMix();
        },
      });
      const solo = el('button', {
        class: 'mini' + (p.solo ? ' on' : ''), text: 'S', title: 'Solo',
        onclick: () => {
          p.solo = !p.solo;
          solo.classList.toggle('on', p.solo);
          this._applyMix();
        },
      });

      const row = el('div', { class: 'part-row' },
        el('div', { class: 'pr-top' },
          el('span', { class: 'dot', style: { width: '8px', height: '8px', borderRadius: '50%', background: this._partColors.get(p.id), flexShrink: 0 } }),
          el('span', { class: 'pr-name', text: p.name, title: p.name }),
          el('span', { class: 'pr-meta', text: `${p.notes.length}` }),
          mute, solo
        ),
        sel
      );
      host.appendChild(row);
    });
  }

  _applyMix() {
    this.recompute({ keepPlaying: this.playing });
    if (this._engine && this.score) {
      for (const p of this.score.parts) {
        this._engine.setPartMix(p.id, {
          muted: p.muted, solo: p.solo, gain: p.gain, pan: p.pan,
        });
      }
    }
  }

  _renderKeys() {
    const sel = clear(this.dom.selKey);
    sel.appendChild(el('option', { value: 0, text: 'Original key' }));
    for (let n = -12; n <= 12; n++) {
      if (n === 0) continue;
      sel.appendChild(el('option', {
        value: n,
        text: `${n > 0 ? '+' : '−'}${Math.abs(n)} semitone${Math.abs(n) > 1 ? 's' : ''}`,
      }));
    }
    sel.value = String(this.transpose);
  }

  _nudgeTempo(delta) {
    const v = Math.max(25, Math.min(200, this.tempoScale * 100 + delta));
    this.dom.rngTempo.value = v;
    this.dom.rngTempo.dispatchEvent(new Event('input'));
  }

  _nudgeKey(d) {
    const v = Math.max(-12, Math.min(12, this.transpose + d));
    this.dom.selKey.value = String(v);
    this.dom.selKey.dispatchEvent(new Event('change'));
  }

  /* --------------------------------------------------------- sync helpers */

  _syncPlayButton() {
    const use = this.playing ? 'pause' : 'play';
    const u = this.dom.btnPlay.querySelector('use');
    if (u) u.setAttribute('href', '#i-' + use);
    this.dom.btnPlay.title = this.playing ? 'Pause  (Space)' : 'Play  (Space)';
  }

  _syncTempo() {
    this.dom.tempoDisp.textContent = Math.round(this.tempoScale * 100);
    this.dom.tempoVal.textContent = '×' + this.tempoScale.toFixed(2);
    if (this.resolved) {
      const bpm = this.resolved.timing.bpmAtQuarter(this.resolved.timing.quarterAtSeconds(this.position));
      this.dom.tempoDisp.title = `${Math.round(bpm)} bpm at the playhead`;
    }
  }

  _syncKey() {
    const base = this.score && this.score.keySigs && this.score.keySigs.length ? this.score.keySigs[0] : null;
    const fifths = (base ? base.fifths : 0) + this.transpose;
    const name = keyNameFromFifths(fifths, base && base.mode);
    this.dom.keyDisp.textContent = this.transpose === 0 ? (base ? shortKey(base.fifths) : 'C') : name.split(' ')[0];
    this.dom.transposeVal.textContent = this.transpose === 0 ? 'original' : `${this.transpose > 0 ? '+' : '−'}${Math.abs(this.transpose)}`;
  }

  _syncAll() {
    const dur = this.duration();
    this.dom.tTotal.textContent = fmtTime(dur);
    if (!this.playing) this._tickPosition(this.position);
    this._renderParts();
    this._renderKeys();
    this._syncTempo();
    this._syncKey();
    this._syncPlayButton();
  }

  /* -------------------------------------------------------------- export */

  async openExport() {
    if (!this.score) { this.dom.fileInput.click(); return; }
    this.ensureAudio();
    if (this._audio.state === 'suspended') this._audio.resume();

    let resultUrl = null;
    let wavBlob = null;

    modal((box, closeFn) => {
      const facts = el('div', { class: 'facts' });
      const bar = el('i');
      const label = el('div', { class: 'progress-label', text: 'Ready.' });
      const progress = el('div', { class: 'progress' }, bar);
      const out = el('div');

      const status = (text, ratio) => {
        label.textContent = text;
        progress.classList.toggle('indet', ratio == null);
        if (ratio != null) bar.style.width = Math.round(ratio * 100) + '%';
      };

      const doRender = async () => {
        this.stop();
        btn.disabled = true;
        out.innerHTML = '';
        this._exportAbort = new AbortController();
        try {
          status('Synthesising…', 0.04);
          const buffer = await renderToBuffer({
            resolved: this.resolved,
            partInstruments: this.partInstruments,
            sampleRate: this.settings.sampleRate,
            busOptions: {
              room: ROOMS.find((r) => r.id === this.settings.roomId),
              params: {
                volume: this.settings.volume,
                lowDb: this.settings.lowDb, midDb: this.settings.midDb, highDb: this.settings.highDb,
              },
            },
            signal: this._exportAbort.signal,
            onProgress: (p) => status(p.message, p.ratio),
          });

          const enc = await encodeMp3(buffer, {
            kbps: this.settings.kbps,
            normalize: this.settings.normalize,
            signal: this._exportAbort.signal,
            onProgress: (p) => status(p.message, 0.55 + p.ratio * 0.45),
          });

          // Verify what we actually produced rather than trusting the encoder.
          const check = inspectMp3(enc.bytes);
          const ok = check.frames > 10 && Math.abs(check.durationSec - (this.resolved.durationSec)) < 2.5;

          if (resultUrl) URL.revokeObjectURL(resultUrl);
          resultUrl = URL.createObjectURL(enc.blob);
          wavBlob = encodeWav(buffer);

          const baseName = (this.score.title || this.score.fileName || 'score')
            .replace(/\.[a-z0-9]+$/i, '').replace(/[^\w\-. ]+/g, '_').trim() || 'score';

          clear(facts);
          const f = (k, v) => el('div', { class: 'fact' }, el('span', { class: 'k', text: k }), el('span', { class: 'v', text: v }));
          facts.appendChild(f('Duration', fmtTime(check.durationSec)));
          facts.appendChild(f('Size', fmtBytes(enc.bytes.length)));
          facts.appendChild(f('Bitrate', `${check.first?.bitrateKbps || enc.kbps} kbps · ${(check.first?.sampleRate || enc.sampleRate) / 1000} kHz`));
          facts.appendChild(f('Peak', `${linToDb(enc.peak).toFixed(1)} dBFS${enc.appliedGainDb > 0.05 ? ` (+${enc.appliedGainDb.toFixed(1)} dB)` : ''}`));
          facts.appendChild(f('MPEG frames', `${check.frames}${check.badSync ? ` · ${check.badSync} resyncs` : ''}`));
          facts.appendChild(f('Channels', enc.channels === 2 ? 'Stereo' : 'Mono'));

          out.innerHTML = '';
          out.appendChild(el('div', { class: 'result' },
            el('h3', {}, 'Preview your render', el('span', { class: 'badge' + (ok ? '' : ' warn'), style: 'margin-left:8px', text: ok ? '✓ valid MPEG-1 Layer III' : '⚠ verify frame stream' })),
            el('audio', { controls: true, src: resultUrl }),
            facts
          ));

          status('Done.', 1);
          btn.disabled = false;

          dl.onclick = () => saveBlob(enc.blob, `${baseName}.mp3`, 'audio/mpeg');
          dlWav.onclick = () => saveBlob(wavBlob, `${baseName}.wav`, 'audio/wav');
          dl.disabled = false;
          dlWav.disabled = false;
        } catch (err) {
          status('Render failed.', null);
          if (err && err.name !== 'RenderCancelled') {
            out.innerHTML = '';
            out.appendChild(el('div', { class: 'result' },
              el('h3', { text: 'Could not render' }),
              el('p', { style: 'color:var(--ink-2);font-size:12.5px;margin:0', text: err.message || String(err) })
            ));
            toast('Render failed', err.message || String(err), 'err');
          }
          btn.disabled = false;
        }
      };

      const btn = el('button', { class: 'btn primary', onclick: doRender },
        icon('wave'), `Render ${this.settings.kbps} kbps MP3`);
      const dl = el('button', { class: 'btn', disabled: true, onclick: () => {} }, icon('export'), 'Download MP3');
      const dlWav = el('button', { class: 'btn', disabled: true, onclick: () => {} }, 'Download WAV');

      box.appendChild(el('div', { class: 'modal-head' },
        el('h2', { text: 'Export MP3' }),
        el('button', { class: 'btn ghost icon', onclick: closeFn, title: 'Close' }, icon('x'))
      ));
      box.appendChild(el('div', { class: 'modal-body' },
        el('div', { class: 'grid3' },
          el('div', { class: 'field' }, el('label', { text: 'Quality' }),
            el('select', { onchange: (e) => { this.settings.kbps = +e.target.value; } },
              ...BITRATES.map((b) => el('option', { value: b, selected: b === this.settings.kbps, text: `${b} kbps` })))),
          el('div', { class: 'field' }, el('label', { text: 'Sample rate' }),
            el('select', { onchange: (e) => { this.settings.sampleRate = +e.target.value; } },
              el('option', { value: 44100, selected: this.settings.sampleRate === 44100, text: '44.1 kHz' }),
              el('option', { value: 48000, selected: this.settings.sampleRate === 48000, text: '48 kHz' }))),
          el('div', { class: 'field' }, el('label', { text: 'Room' }),
            el('select', { onchange: (e) => { this.settings.roomId = e.target.value; this._bus?.setRoom(ROOMS.find((r) => r.id === e.target.value)); } },
              ...ROOMS.map((r) => el('option', { value: r.id, selected: r.id === this.settings.roomId, text: r.label }))))
        ),
        el('p', { style: 'color:var(--ink-3);font-size:12px;margin:2px 0 0' },
          `Rendering ${this.score.title || 'score'} · ${describeScore(this.score)} · key ${this.transpose === 0 ? 'original' : (this.transpose > 0 ? '+' : '') + this.transpose} · tempo ×${this.tempoScale.toFixed(2)}. Rendering ignores "humanise" so every export is identical.`),
        progress, label, out
      ));
      box.appendChild(el('div', { class: 'modal-foot' },
        btn, el('div', { class: 'spacer' }), dlWav, dl
      ));
    });
  }

  /* --------------------------------------------------------------- debug */

  /** Used by the self-test harness. */
  debugState() {
    return {
      scores: this.library.length,
      active: this.activeId,
      title: this.score?.title,
      notes: this.resolved?.notes.length,
      duration: this.duration(),
      playing: this.playing,
    };
  }
}

/* -------------------------------------------------------------- helpers */

function groupBy(arr, fn) {
  const m = new Map();
  for (const x of arr) {
    const k = fn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

function clampPct(v) {
  // Map linear magnitude onto a meter that reads sensibly (dB-ish).
  const db = linToDb(v);
  const p = db <= -60 ? 0 : Math.min(100, ((db + 60) / 60) * 100);
  return p.toFixed(1) + '%';
}

function shortKey(fifths) {
  const n = keyNameFromFifths(fifths).split(' ')[0];
  return n;
}

function saveBlob(blob, filename, type) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.type = type || blob.type;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export { saveBlob };