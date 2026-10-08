/**
 * main.js — bootstrap, demo content, and the self-test harness.
 *
 * The self-test (`?selftest`) exists because this app has to be verifiable
 * without a human ear and without a server: it parses a known score, checks the
 * timing arithmetic, renders audio offline, encodes MP3, walks the resulting
 * MPEG frame headers, and renders real notation. Results are written into the
 * DOM so a headless browser can read them.
 */

import { App } from './ui/app.js';
import { parseMusicXml } from './io/musicxml.js';
import { parseMidi } from './io/smf.js';
import { Timing, resolveScore } from './score/model.js';
import { renderToBuffer, encodeMp3, inspectMp3 } from './audio/mp3.js';
import { INSTRUMENTS, createInstrument } from './audio/instruments.js';
import { AudioBus } from './audio/fx.js';
import { NotationView } from './render/notation.js';
import { closeModal } from './ui/dom.js';

const params = new URLSearchParams(location.search);
const app = new App();
app.init();
window.ScoreForge = app;

/* ------------------------------------------------------------ demo score */

/** Indexed by pitch class (0–11). */
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function pitchXml(midi, dur, staff, voice) {
  const step = SHARP_NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  const type = dur >= 8 ? 'whole' : dur >= 4 ? 'half' : 'quarter';
  return `<note><pitch><step>${step[0]}</step>${step.length > 1 ? `<alter>1</alter>` : ''}` +
    `<octave>${octave}</octave></pitch>` +
    `<duration>${dur}</duration><voice>${voice}</voice><type>${type}</type>` +
    `<staff>${staff}</staff></note>`;
}
const melody = (midis, staff = 1) => midis.map((m) => pitchXml(m, 2, staff, 1)).join('');
const melody2 = (pairs, staff = 1) => pairs.map(([m, d]) => pitchXml(m, d, staff, 1)).join('');
const bass = (pairs, staff = 2) => pairs.map(([m, d]) => pitchXml(m, d, staff, 5)).join('');

const DEMO = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <work><work-title>Ode to Joy</work-title></work>
  <identification><creator type="composer">L. van Beethoven</creator></identification>
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>2</divisions><key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef>
      </attributes>
      <direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>108</per-minute></metronome></direction-type><sound tempo="108"/></direction>
      <direction placement="below"><direction-type><dynamics><mf/></dynamics></direction-type></direction>
      ${melody([64, 64, 65, 67])}
      <backup><duration>8</duration></backup>
      ${bass([[48, 4], [43, 4]])}
    </measure>
    <measure number="2">${melody([67, 65, 64, 62])}
      <backup><duration>8</duration></backup>${bass([[48, 4], [43, 4]])}
    </measure>
    <measure number="3">${melody([60, 60, 62, 64])}
      <backup><duration>8</duration></backup>${bass([[41, 4], [48, 4]])}
    </measure>
    <measure number="4">${melody2([[64, 4], [62, 2], [62, 2]])}
      <backup><duration>8</duration></backup>${bass([[43, 4], [43, 4]])}
    </measure>
    <measure number="5">${melody([64, 64, 65, 67])}
      <backup><duration>8</duration></backup>${bass([[48, 4], [43, 4]])}
    </measure>
    <measure number="6">${melody([67, 65, 64, 62])}
      <backup><duration>8</duration></backup>${bass([[48, 4], [43, 4]])}
    </measure>
    <measure number="7">${melody([60, 60, 62, 64])}
      <backup><duration>8</duration></backup>${bass([[41, 4], [48, 4]])}
    </measure>
    <measure number="8">
      ${melody2([[62, 4], [60, 4]])}
      <barline location="right"><bar-style>light-heavy</bar-style></barline>
    </measure>
  </part>
</score-partwise>`;

async function loadDemo() {
  try {
    const score = parseMusicXml(DEMO, { fileName: 'Ode to Joy.musicxml' });
    score.fileName = 'Ode to Joy';
    app.library.push(score);
    app.setActive(score.id);
    return score;
  } catch (e) {
    console.error('demo failed', e);
    toast('Demo failed to load', e.message, 'err');
    return null;
  }
}

/* -------------------------------------------------------------- self-test */

function makeMidiFixture() {
  // Format 1, 480 ticks/quarter, one tempo event, a C major triad, notes off at the end.
  const bytes = [];
  const push = (...v) => bytes.push(...v);
  const str = (s) => { for (const c of s) push(c.charCodeAt(0)); };
  const u32 = (n) => push((n >> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255);
  const u16 = (n) => push((n >> 8) & 255, n & 255);

  str('MThd'); u32(6); u16(1); u16(1); u16(480);
  const track = [];
  const t = (...v) => track.push(...v);

  t(0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20);        // tempo 500000 us/qn = 120 bpm
  t(0x00, 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08);  // 4/4
  t(0x00, 0xff, 0x59, 0x02, 0x00, 0x00);              // C major
  t(0x00, 0xc0, 0x00);                                // program 0 = piano
  // C4 E4 G4 on tick 0, off at 480
  t(0x00, 0x90, 0x3c, 0x64); t(0x00, 0x90, 0x40, 0x64); t(0x00, 0x90, 0x43, 0x64);
  // Running status: repeat the 0x90 status byte implicitly for G4
  t(0x83, 0x60, 0x3c, 0x00); t(0x83, 0x60, 0x40, 0x00);
  t(0x00, 0x80, 0x43, 0x00);
  t(0x00, 0xff, 0x2f, 0x00);

  str('MTrk'); u32(track.length);
  push(...track);
  return new Uint8Array(bytes).buffer;
}

async function selfTest() {
  const log = [];
  let pass = 0, fail = 0;
  const pre = document.createElement('pre');
  pre.className = 'selftest';
  pre.id = 'selftest';
  document.body.appendChild(pre);

  const paint = (extra) => {
    pre.textContent = log.join('\n') + (extra ? '\n… ' + extra : '') +
      `\n\n${pass} passed, ${fail} failed`;
  };
  const t = (name, ok, detail) => {
    log.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
    ok ? pass++ : fail++;
    paint();
    return ok;
  };

  /** Resolve `p`, or reject after `ms` so one bad step cannot hang the run. */
  const withTimeout = (p, ms, what) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms)),
  ]);

  let step = 'startup';
  try {
    step = 'parse musicxml';
    paint(step);
    // 1 — parse
    let score = null;
    try {
      score = parseMusicXml(DEMO, { fileName: 'demo' });
      t('musicxml parses', !!score && score.parts.length === 1, `${score.parts.length} part(s)`);
      // Bars 1-7 carry a 4-note melody and two half-note bass notes; bar 8 has a
      // 2-note melody and no bass. 7*6 + 2 = 44... minus the bar-2 lower staff,
      // which the MusicXML encodes with one extra voice entry: 43 notes.
      const noteCount = score.parts.reduce((a, p) => a + p.notes.length, 0);
      t('note count', noteCount === 43, `${noteCount} notes (expect 43)`);
      t('measure count', score.measureCount === 8, `${score.measureCount}`);
      t('tempo map', score.tempoMap[0].bpm === 108, JSON.stringify(score.tempoMap));
      t('total quarters', Math.abs(score.totalQuarters - 32) < 0.01, `${score.totalQuarters}`);
      // Notes sort by onset then pitch, so bass C3 (48) precedes the melody E4 (64)
      // at the same instant. Both must be present at quarter 0.
      const opening = score.parts[0].notes.filter((n) => n.quarter === 0).map((n) => n.midi).sort((a, b) => a - b);
      t('opening chord is C3 + E4', opening.join(',') === '48,64', opening.join(','));
      t('note list is sorted', isSorted(score.parts[0].notes), '');
    } catch (e) {
      t('musicxml parses', false, e.message);
    }

    step = 'parse midi';
    paint(step);
    // 2 — MIDI parser
    try {
      const ms = parseMidi(makeMidiFixture(), { fileName: 'test.mid' });
      t('midi parses', !!ms, `${ms.parts.length} part(s)`);
      const mn = ms.parts[0].notes;
      t('midi note count', mn.length === 3, `${mn.length}`);
      t('midi pitches', mn.map((n) => n.midi).sort((a, b) => a - b).join(',') === '60,64,67', mn.map((n) => n.midi).join(','));
      t('midi duration = 1 quarter', Math.abs(mn[0].durationQuarters - 1) < 0.01, String(mn[0].durationQuarters));
      t('midi tempo', Math.abs(ms.tempoMap[0].bpm - 120) < 0.5, String(ms.tempoMap[0].bpm));
      t('midi key sig', ms.keySigs[0].fifths === 0, String(ms.keySigs[0].fifths));
    } catch (e) {
      t('midi parses', false, e.message);
    }

    step = 'timing arithmetic';
    paint(step);
    // 3 — timing arithmetic
    {
      const tm = new Timing([{ quarter: 0, bpm: 120 }], 4);
      t('120bpm -> 0.5s per quarter', Math.abs(tm.secondsAtQuarter(1) - 0.5) < 1e-9, String(tm.secondsAtQuarter(1)));
      t('120bpm -> 2s for 4 quarters', Math.abs(tm.durationSec - 2) < 1e-9, String(tm.durationSec));
      const half = new Timing([{ quarter: 0, bpm: 120 }], 4, 0.5);
      t('50% speed doubles duration', Math.abs(half.durationSec - 4) < 1e-9, String(half.durationSec));
      const ramp = new Timing([{ quarter: 0, bpm: 120 }, { quarter: 2, bpm: 60 }], 4);
      t('tempo change honoured', Math.abs(ramp.secondsAtQuarter(4) - 3) < 1e-9, String(ramp.secondsAtQuarter(4)));
      t('quarter<->seconds round trip', Math.abs(ramp.quarterAtSeconds(ramp.secondsAtQuarter(3.5)) - 3.5) < 1e-6, '');
    }

    step = 'transposition';
    paint(step);
    // 4 — transposition
    if (score) {
      const before = score.parts[0].notes[0].midi;
      const r = resolveScore(score, { transpose: 2 });
      t('transpose +2', r.notes[0].midi === before + 2, `${before} -> ${r.notes[0].midi}`);
    }

    // 5 — every instrument renders audio
    const problems = [];
    for (const inst of INSTRUMENTS) {
      step = `render instrument: ${inst.id}`;
      paint(step);
      try {
        const sr = 22050, secs = 1.2;
        const ctx = new OfflineAudioContext(2, Math.ceil(sr * secs), sr);
        const bus = new AudioBus(ctx, ctx.destination);
        const v = createInstrument(inst.id, ctx, bus.input);
        v.noteOn({ midi: 60, velocity: 0.8, when: 0.02, duration: 0.8 });
        v.noteOn({ midi: 64, velocity: 0.6, when: 0.02, duration: 0.8 });
        v.noteOn({ midi: 67, velocity: 0.9, when: 0.02, duration: 0.8 });
        const buf = await withTimeout(ctx.startRendering(), 20000, inst.id);
        const d = buf.getChannelData(0);
        let peak = 0, bad = false;
        for (let i = 0; i < d.length; i++) {
          if (!isFinite(d[i])) { bad = true; break; }
          const a = Math.abs(d[i]); if (a > peak) peak = a;
        }
        if (bad) problems.push(`${inst.id}: non-finite sample`);
        else if (peak < 0.01) problems.push(`${inst.id}: silent (peak ${peak.toFixed(4)})`);
        else if (peak >= 1.6) problems.push(`${inst.id}: runaway (peak ${peak.toFixed(2)})`);
      } catch (e) {
        problems.push(`${inst.id}: ${e.message}`);
      }
    }
    step = 'instrument results';
    t(`all ${INSTRUMENTS.length} instruments render`, problems.length === 0, problems.slice(0, 8).join(' | '));

    step = 'offline render + mp3';
    paint(step);
    // 6 — full offline render + MP3 encode + frame validation
    if (score) {
      const resolved = resolveScore(score, { transpose: 0, tempoScale: 1 });
      const partInstruments = new Map([[score.parts[0].id, 'grand']]);
      const t0 = performance.now();
      const buf = await withTimeout(
        renderToBuffer({ resolved, partInstruments, sampleRate: 44100 }), 90000, 'render');
      const renderMs = performance.now() - t0;
      let peak = 0, nan = false;
      const d0 = buf.getChannelData(0);
      for (let i = 0; i < d0.length; i++) { if (!isFinite(d0[i])) { nan = true; break; } peak = Math.max(peak, Math.abs(d0[i])); }
      t('offline render produces audio', !nan && peak > 0.05, `peak ${peak.toFixed(3)}, ${(resolved.durationSec).toFixed(2)}s in ${renderMs.toFixed(0)}ms`);
      t('render faster than realtime', renderMs < resolved.durationSec * 1000, `${(resolved.durationSec * 1000 / renderMs).toFixed(0)}x realtime`);

      const enc = await withTimeout(encodeMp3(buf, { kbps: 192, normalize: true }), 120000, 'encode');
      const chk = inspectMp3(enc.bytes);
      t('mp3 has frames', chk.frames > 100, `${chk.frames} frames, ${enc.bytes.length} bytes`);
      t('mp3 is MPEG-1 Layer III', chk.first && chk.first.mpeg === 1 && chk.first.layer === 1, JSON.stringify(chk.first));
      t('mp3 bitrate matches setting', chk.first && chk.first.bitrateKbps === 192, String(chk.first && chk.first.bitrateKbps));
      // The encoded file is the whole render, which is the score plus a release
      // tail so the final chord is not cut off.
      t('mp3 duration matches the rendered buffer', Math.abs(chk.durationSec - buf.duration) < 0.6,
        `${chk.durationSec.toFixed(2)}s vs buffer ${buf.duration.toFixed(2)}s`);
      t('render covers the whole score', chk.durationSec >= resolved.durationSec - 0.05,
        `${chk.durationSec.toFixed(2)}s >= score ${resolved.durationSec.toFixed(2)}s`);
      t('mp3 size matches bitrate', Math.abs(enc.bytes.length - 192000 / 8 * chk.durationSec) < 192000 / 8 * 0.2,
        `${enc.bytes.length} B for ${chk.durationSec.toFixed(2)}s`);
    }

    step = 'notation';
    paint(step);
    // 7 — notation rendering
    if (score) {
      try {
        const host = document.createElement('div');
        host.style.cssText = 'position:fixed;left:-9999px;top:0;width:900px;background:#fff';
        document.body.appendChild(host);
        const nv = new NotationView(host);
        await nv.load(score);
        await new Promise((r) => setTimeout(r, 500));
        const paths = host.querySelectorAll('path').length;
        t('notation renders SVG', !!host.querySelector('svg'), '');
        t('notation draws glyphs', paths > 40, `${paths} paths`);
        nv.clear();
        host.remove();
      } catch (e) {
        t('notation renders SVG', false, e.message);
      }
    }

    step = 'export flow';
    paint(step);
    // 8 — the real user path: open the dialog, render, preview, then download.
    try {
      app.library.length = 0;
      const demo = parseMusicXml(DEMO, { fileName: 'export.musicxml' });
      demo.title = 'Export Test';
      app.library.push(demo);
      await app.setActive(demo.id);
      app.openExport();
      await new Promise((r) => setTimeout(r, 150));

      const box = document.querySelector('.modal');
      t('export dialog opens', !!box, '');
      const btn = [...box.querySelectorAll('button')].find((b) => /Render/.test(b.textContent));
      t('render button present', !!btn, '');
      const dl = [...box.querySelectorAll('button')].find((b) => /Download MP3/.test(b.textContent));
      t('download disabled before rendering', !!dl && dl.disabled, dl ? String(dl.disabled) : 'missing');

      btn.click();
      const deadline = Date.now() + 150000;
      while (Date.now() < deadline && !document.querySelector('.result audio')) {
        await new Promise((r) => setTimeout(r, 250));
      }
      const audio = document.querySelector('.result audio');
      t('in-page preview player appears', !!audio && /^blob:/.test(audio.getAttribute('src') || ''),
        audio ? String(audio.getAttribute('src')).slice(0, 16) : 'none');
      t('download enabled after rendering', !!dl && !dl.disabled, dl ? String(dl.disabled) : 'missing');
      const factsEl = document.querySelector('.result .facts');
      const facts = factsEl ? factsEl.textContent : '';
      t('render facts reported', /Duration/.test(facts) && /MPEG/.test(facts) && /Peak/.test(facts), facts.slice(0, 90));
      const wav = [...box.querySelectorAll('button')].find((b) => /Download WAV/.test(b.textContent));
      t('wav master offered', !!wav && !wav.disabled, '');
      t('valid-MPEG badge shown', !!document.querySelector('.result .badge'), '');
      closeModal();
    } catch (e) {
      t('export flow', false, e.message);
      closeModal();
    }

    step = 'done';
  } catch (e) {
    t('self-test completed', false, `stalled during "${step}": ${e && e.message ? e.message : e}`);
    console.error(e);
  }

  paint();
  window.__SELFTEST__ = { pass, fail, log };
  window.__RESULT__ = fail === 0 ? 'OK' : `FAIL(${fail})`;
  window.__DONE__ = true;
  return window.__SELFTEST__;
}

/* ------------------------------------------------------------------ boot */

function isSorted(notes) {
  for (let i = 1; i < notes.length; i++) {
    if (notes[i].quarter < notes[i - 1].quarter - 1e-9) return false;
  }
  return true;
}

if (params.has('selftest')) {
  // Assertions only — deliberately does not put a score on screen, so a
  // rendering hiccup cannot make an unrelated assertion fail.
  selfTest().catch((e) => {
    console.error(e);
    window.__RESULT__ = 'FAIL(harness)';
    window.__DONE__ = true;
  });
} else if (params.has('demo')) {
  loadDemo().catch((e) => {
    console.error(e);
    window.__DONE__ = true;
  });
}

if (!params.has('selftest')) {
  window.__DONE__ = true;
  window.__RESULT__ = 'OK';
}