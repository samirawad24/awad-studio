'use strict';
/* Awad Studio core: state, audio graph, transport, recording, playlist, export. */

const $ = (s) => document.querySelector(s);
const TH = 84, RH = 40;
const COLORS = ['#d9a05b', '#6fb0d0', '#c9718f', '#8fbd6c', '#a98ad6', '#d47a6a', '#5dbfa6', '#cdbb5c'];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dbToGain = (db) => Math.pow(10, db / 20);
let idc = 1;
const nid = (p) => p + (idc++) + Date.now().toString(36);

const FX_DEFAULT = { preset: 'none', hp: 20, lp: 20000, low: 0, mid: 0, high: 0, sat: 0, comp: 0, rev: 0, dly: 0, dbl: 0 };

const S = {
  bpm: 120, key: null, tracks: [], loop: { on: false, start: 0, end: 8 },
  channels: [], patterns: [], curPat: null, curCh: null, mode: 'song', markers: [],
  master: { vol: 1, auto: false },
  metro: false, countIn: true, punch: false, snap: true, pps: 50, pos: 0, sel: null,
  latencyMs: null, monitor: false, noiseClean: false, deviceId: '',
  scaleLock: true, typePiano: false, projectName: '', dirty: false, liveTune: 'off', recTuned: false,
};
const beatLen = () => 60 / S.bpm;
const barLen = () => beatLen() * 4;
const stepSec = () => beatLen() / 4;

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('awadstudio.prefs') || '{}');
    for (const k of ['latencyMs', 'monitor', 'noiseClean', 'deviceId', 'countIn', 'metro', 'scaleLock', 'liveTune', 'recTuned']) if (k in p) S[k] = p[k];
  } catch (e) { /* storage unavailable */ }
}
function savePrefs() {
  try {
    localStorage.setItem('awadstudio.prefs', JSON.stringify({
      latencyMs: S.latencyMs, monitor: S.monitor, noiseClean: S.noiseClean,
      deviceId: S.deviceId, countIn: S.countIn, metro: S.metro, scaleLock: S.scaleLock, liveTune: S.liveTune, recTuned: S.recTuned,
    }));
  } catch (e) { /* storage unavailable */ }
}

let colorIdx = 0;
function newTrack(name, arm = false) {
  return { id: nid('t'), name, color: COLORS[colorIdx++ % COLORS.length], vol: 1, pan: 0, mute: false, solo: false, arm, clips: [], takeCount: 0, fx: { ...FX_DEFAULT } };
}

/* ---------- buffers ---------- */
const buffers = new Map();
const bufSrc = new Map();
function makePeaks(buf) {
  const step = 256, n = Math.ceil(buf.length / step), p = new Float32Array(n);
  for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) {
      let m = 0; const e = Math.min(d.length, (i + 1) * step);
      for (let j = i * step; j < e; j++) { const v = d[j] < 0 ? -d[j] : d[j]; if (v > m) m = v; }
      if (m > p[i]) p[i] = m;
    }
  }
  return { peaks: p, rate: buf.sampleRate / step };
}
function addBuffer(id, buffer, src) { buffers.set(id, { buffer, ...makePeaks(buffer) }); if (src) bufSrc.set(id, src); }
const bufOf = (c) => buffers.get(c.bufs[c.take || 0]);

/* ---------- audio graph: strips, buses, master ---------- */
let AC = null, G = null, masterAn, metroOut, ctxP = null;

function sp(g, param, v) { if (g.live) param.setTargetAtTime(v, g.ac.currentTime, 0.02); else param.value = v; }
function buildGraph(ac, out, live) {
  const g = { ac, live, strips: new Map(), chans: new Map() };
  g.masterIn = ac.createGain();
  g.masterIn.gain.value = 0.78; // headroom so kick + 808 never clip
  g.mComp = ac.createDynamicsCompressor(); g.mMake = ac.createGain();
  g.mLim = ac.createDynamicsCompressor(); g.mVol = ac.createGain();
  g.masterIn.connect(g.mComp); g.mComp.connect(g.mMake); g.mMake.connect(g.mLim); g.mLim.connect(g.mVol); g.mVol.connect(out);
  g.revIn = ac.createGain();
  const conv = ac.createConvolver(); conv.buffer = makeImpulse(ac, 2.4);
  const revOut = ac.createGain(); revOut.gain.value = 0.7;
  g.revIn.connect(conv); conv.connect(revOut); revOut.connect(g.masterIn);
  g.dlyIn = ac.createGain(); g.dly = ac.createDelay(3);
  const fb = ac.createGain(); fb.gain.value = 0.33;
  const dlp = ac.createBiquadFilter(); dlp.type = 'lowpass'; dlp.frequency.value = 3500;
  g.dlyIn.connect(g.dly); g.dly.connect(dlp); dlp.connect(fb); fb.connect(g.dly); dlp.connect(g.masterIn);
  applyMaster(g);
  return g;
}
function applyMaster(g) {
  const auto = S.master.auto;
  sp(g, g.mComp.threshold, auto ? -16 : 0); sp(g, g.mComp.ratio, auto ? 2.5 : 1);
  g.mComp.attack.value = 0.02; g.mComp.release.value = 0.25; g.mComp.knee.value = 8;
  sp(g, g.mMake.gain, auto ? 1.7 : 1);
  sp(g, g.mLim.threshold, auto ? -1.5 : 0); sp(g, g.mLim.ratio, auto ? 20 : 1);
  g.mLim.attack.value = 0.002; g.mLim.release.value = 0.12; g.mLim.knee.value = 0;
  sp(g, g.mVol.gain, S.master.vol);
  sp(g, g.dly.delayTime, beatLen() * 0.75);
}
function getStrip(g, t) {
  let s = g.strips.get(t.id);
  if (s) return s;
  const ac = g.ac;
  const biq = (type, f) => { const b = ac.createBiquadFilter(); b.type = type; if (f) b.frequency.value = f; return b; };
  s = {
    input: ac.createGain(), hp: biq('highpass', 20), lp: biq('lowpass', 20000), low: biq('lowshelf', 110),
    mid: biq('peaking', 1500), high: biq('highshelf', 8000), sat: ac.createWaveShaper(),
    comp: ac.createDynamicsCompressor(), make: ac.createGain(), dry: ac.createStereoPanner(),
    dd: ac.createDelay(0.1), dg: ac.createGain(), dpan: ac.createStereoPanner(), sum: ac.createGain(),
    pan: ac.createStereoPanner(), vol: ac.createGain(), rev: ac.createGain(), dly: ac.createGain(),
  };
  s.hp.Q.value = 0.7; s.lp.Q.value = 0.7; s.mid.Q.value = 0.9;
  s.dd.delayTime.value = 0.019;
  s.input.connect(s.hp); s.hp.connect(s.lp); s.lp.connect(s.low); s.low.connect(s.mid); s.mid.connect(s.high);
  s.high.connect(s.sat); s.sat.connect(s.comp); s.comp.connect(s.make);
  s.make.connect(s.dry); s.dry.connect(s.sum);
  s.make.connect(s.dd); s.dd.connect(s.dg); s.dg.connect(s.dpan); s.dpan.connect(s.sum);
  s.sum.connect(s.pan); s.pan.connect(s.vol); s.vol.connect(g.masterIn);
  s.vol.connect(s.rev); s.rev.connect(g.revIn);
  s.vol.connect(s.dly); s.dly.connect(g.dlyIn);
  if (g.live) { s.an = ac.createAnalyser(); s.an.fftSize = 512; s.vol.connect(s.an); }
  g.strips.set(t.id, s);
  applyStrip(g, t);
  return s;
}
function applyStrip(g, t) {
  const s = g.strips.get(t.id); if (!s) return;
  const fx = t.fx || FX_DEFAULT;
  sp(g, s.hp.frequency, fx.hp); sp(g, s.lp.frequency, fx.lp);
  sp(g, s.low.gain, fx.low); sp(g, s.mid.gain, fx.mid); sp(g, s.high.gain, fx.high);
  s.sat.curve = fx.sat > 0.01 ? satCurve(1 + fx.sat * 4) : null;
  sp(g, s.comp.threshold, -fx.comp * 30); sp(g, s.comp.ratio, 1 + fx.comp * 5);
  s.comp.attack.value = 0.006; s.comp.release.value = 0.15;
  sp(g, s.make.gain, dbToGain(fx.comp * 6));
  sp(g, s.dry.pan, -0.65 * fx.dbl); sp(g, s.dpan.pan, 0.65 * fx.dbl); sp(g, s.dg.gain, fx.dbl * 0.85);
  sp(g, s.pan.pan, t.pan);
  sp(g, s.vol.gain, t.id === '__pat' || audible(t) ? t.vol : 0);
  sp(g, s.rev.gain, fx.rev); sp(g, s.dly.gain, fx.dly);
}
function chanNode(g, t, ch) {
  const k = t.id + '|' + ch.id;
  let n = g.chans.get(k);
  if (!n) {
    n = { gain: g.ac.createGain(), pan: g.ac.createStereoPanner(), ch };
    n.gain.connect(n.pan); n.pan.connect(getStrip(g, t).input);
    n.gain.gain.value = ch.vol; n.pan.pan.value = ch.pan;
    g.chans.set(k, n);
  }
  return n.gain;
}
function applyChans() {
  if (!G) return;
  for (const [k, n] of G.chans) {
    const ch = S.channels.find((c) => c.id === k.split('|')[1]);
    if (ch) { sp(G, n.gain.gain, ch.vol); sp(G, n.pan.pan, ch.pan); }
  }
}
function audible(t) { const anySolo = S.tracks.some((x) => x.solo); return anySolo ? t.solo : !t.mute; }
function updateMix() {
  if (!G) return;
  for (const t of S.tracks) { getStrip(G, t); applyStrip(G, t); }
  applyChans(); applyMaster(G);
}

function ensureCtx() {
  if (!ctxP) {
    ctxP = (async () => {
      AC = new AudioContext({ latencyHint: 'interactive' });
      masterAn = AC.createAnalyser(); masterAn.fftSize = 1024; masterAn.connect(AC.destination);
      G = buildGraph(AC, masterAn, true);
      metroOut = AC.createGain(); metroOut.gain.value = 0.7; metroOut.connect(AC.destination);
      await AC.audioWorklet.addModule('recorder-worklet.js');
      updateMix();
      ensureSounds();
    })();
  }
  return ctxP.then(async () => { if (AC.state === 'suspended') await AC.resume(); return AC; });
}
function ensureSounds() {
  return Promise.all(S.channels.filter((c) => c.kind === 'drum').map((c) => loadDrum(c.kit, c.sound)));
}

/* ---------- clip and pattern scheduling ---------- */
function envAt(c, x) {
  let v = 1;
  if (c.fadeIn > 0) v = Math.min(v, x / c.fadeIn);
  if (c.fadeOut > 0) v = Math.min(v, (c.dur - x) / c.fadeOut);
  return Math.max(0, v) * c.gain;
}
function fixFades(c) {
  if (c.kind === 'pat') return;
  c.fadeIn = clamp(c.fadeIn, 0, c.dur);
  c.fadeOut = clamp(c.fadeOut, 0, c.dur - c.fadeIn);
}
function track(list, srcs) {
  if (!list) return;
  for (const s of srcs) {
    list.push(s);
    s.addEventListener('ended', () => { const i = list.indexOf(s); if (i >= 0) list.splice(i, 1); });
  }
}
function scheduleClip(ac, dest, c, passCtx, from, to, list) {
  const b = bufOf(c); if (!b) return;
  const a = Math.max(c.start, from), e = Math.min(c.start + c.dur, to);
  if (e <= a + 1e-4) return;
  let when = passCtx + (a - from), la = a - c.start;
  const lb = e - c.start;
  if (when < ac.currentTime) { la += ac.currentTime - when; when = ac.currentTime; if (la >= lb) return; }
  const src = ac.createBufferSource(); src.buffer = b.buffer;
  const g = ac.createGain();
  g.gain.setValueAtTime(envAt(c, la), when);
  const pts = [c.fadeIn, c.dur - c.fadeOut].filter((p) => p > la && p < lb).sort((x, y) => x - y);
  for (const p of pts) g.gain.linearRampToValueAtTime(envAt(c, p), when + (p - la));
  g.gain.linearRampToValueAtTime(envAt(c, lb), when + (lb - la));
  src.connect(g); g.connect(dest);
  src.start(when, c.offset + la, lb - la);
  track(list, [src]);
}
const patById = (id) => S.patterns.find((p) => p.id === id);
const patLenSec = (p) => p.bars * 16 * stepSec();
function chHasNotes(p, ch) { const n = p.notes[ch.id]; return !!(n && n.length); }
function patEvents(p) {
  const st = stepSec(), ev = [], total = p.bars * 16;
  const sw = (i) => i + (i % 2 === 1 ? (p.swing || 0) * 0.5 : 0);
  for (const ch of S.channels) {
    if (chHasNotes(p, ch)) {
      for (const n of p.notes[ch.id]) {
        if (n.s >= total) continue;
        ev.push({ ch, t: sw(n.s) * st, dur: n.l * st, midi: n.p, vel: n.v, notes: true });
      }
    } else {
      const steps = p.steps[ch.id]; if (!steps) continue;
      for (let i = 0; i < total; i++) {
        const r = steps[i]; if (!r) continue;
        for (let k = 0; k < r; k++) ev.push({ ch, t: (sw(i) + k / r) * st, dur: st / r, midi: ch.note || 60, vel: k ? 0.62 : 0.85, notes: false });
      }
    }
  }
  return ev;
}
function trigger(g, t, ev, when, maxDur, list) {
  const ch = ev.ch;
  if (ch.mute) return;
  const dest = chanNode(g, t, ch), dur = Math.max(0.02, Math.min(ev.dur, maxDur));
  if (ch.kind === 'synth') { track(list, playNote(g.ac, dest, ch.preset, ev.midi, when, dur, ev.vel)); return; }
  const buf = ch.kind === 'drum' ? drumCache.get(drumKey(ch.kit, ch.sound)) : (buffers.get(ch.bufId) || {}).buffer;
  if (!buf) return;
  const s = g.ac.createBufferSource(); s.buffer = buf;
  s.playbackRate.value = Math.pow(2, (ev.midi - 60) / 12);
  const gn = g.ac.createGain(); gn.gain.value = ev.vel;
  s.connect(gn); gn.connect(dest);
  s.start(when);
  if (ch.kind === 'sample' && ev.notes) {
    gn.gain.setValueAtTime(ev.vel, when + dur);
    gn.gain.linearRampToValueAtTime(0, when + dur + 0.03);
    s.stop(when + dur + 0.04);
  }
  track(list, [s]);
}
function schedPatClip(g, t, c, base, posA, posB, list) {
  const p = patById(c.patId); if (!p) return;
  const L = patLenSec(p); if (L <= 0) return;
  const a = Math.max(posA, c.start), b = Math.min(posB, c.start + c.dur);
  if (b <= a) return;
  const origin = c.start - c.offset, evs = patEvents(p);
  for (let k = Math.floor((a - origin) / L); origin + k * L < b; k++) {
    const rs = origin + k * L;
    for (const ev of evs) {
      const tt = rs + ev.t;
      if (tt < a || tt >= b) continue;
      trigger(g, t, ev, base + tt, c.start + c.dur - tt, list);
    }
  }
}
function songEnd() {
  let e = 0;
  for (const t of S.tracks) for (const c of t.clips) e = Math.max(e, c.start + c.dur);
  return e;
}

function metClick(ac, when, accent, dest) {
  const o = ac.createOscillator(), g = ac.createGain();
  o.frequency.value = accent ? 1600 : 1050;
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(accent ? 0.9 : 0.55, when + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
  o.connect(g); g.connect(dest); o.start(when); o.stop(when + 0.06);
}

/* ---------- transport ---------- */
let P = null;
const PAT_TRACK = { id: '__pat', vol: 1, pan: 0, fx: { ...FX_DEFAULT } };
function patRouteTrack(patId) {
  for (const t of S.tracks) if (t.clips.some((c) => c.kind === 'pat' && c.patId === patId)) return t;
  return PAT_TRACK;
}

async function play(from = S.pos, opt = {}) {
  await ensureCtx();
  await ensureSounds();
  if (P) stop();
  const now = AC.currentTime + 0.06;
  const ci = opt.countIn ? barLen() : 0;
  const t0 = now + ci;
  const patMode = S.mode === 'pat' && !opt.recording;
  let loopOn = S.loop.on && !opt.punch && S.loop.end - S.loop.start > 0.05, ls = S.loop.start, le = S.loop.end;
  if (patMode) {
    const p = patById(S.curPat);
    if (!p) { toast('Make a pattern first in the Channel rack.'); return; }
    loopOn = true; ls = 0; le = patLenSec(p);
    from = from % le;
  }
  if (loopOn && !patMode && (from < ls || from >= le - 0.01)) from = ls;
  P = { passes: [], sources: [], loopOn, ls, le, patMode, recording: !!opt.recording, returnPos: patMode ? S.pos : (opt.returnPos ?? from), metroUntil: t0, schedUntil: AC.currentTime, startPos: from };
  if (ci) for (let k = 0; k < 4; k++) metClick(AC, now + k * beatLen(), k === 0, metroOut);
  addPass(t0, from, loopOn ? le : Infinity);
  P.timer = setInterval(tick, 25);
  tick();
  syncTransport();
}
function addPass(ctxT, from, to) {
  P.passes.push({ ctx: ctxT, from, to });
  if (P.patMode) return;
  for (const t of S.tracks) for (const c of t.clips) if (c.kind !== 'pat') scheduleClip(AC, getStrip(G, t).input, c, ctxT, from, to, P.sources);
}
function schedPatterns(wa, wb) {
  for (const ps of P.passes) {
    const pEnd = ps.to === Infinity ? Infinity : ps.ctx + (ps.to - ps.from);
    const a = Math.max(ps.ctx, wa), b = Math.min(pEnd, wb);
    if (b <= a) continue;
    const posA = ps.from + (a - ps.ctx), posB = ps.from + (b - ps.ctx), base = ps.ctx - ps.from;
    if (P.patMode) {
      const p = patById(S.curPat); if (!p) continue;
      schedPatClip(G, patRouteTrack(p.id), { patId: p.id, start: 0, dur: P.le, offset: 0 }, base, posA, posB, P.sources);
    } else {
      for (const t of S.tracks) for (const c of t.clips) if (c.kind === 'pat') schedPatClip(G, t, c, base, posA, posB, P.sources);
    }
  }
}
function tick() {
  if (!P) return;
  const now = AC.currentTime;
  if (P.loopOn) {
    const L = P.le - P.ls;
    const last = P.passes[P.passes.length - 1];
    let end = last.ctx + (last.to - last.from);
    while (end < now + 0.6) { addPass(end, P.ls, P.le); end += L; }
    if (P.passes.length > 6) P.passes.splice(0, P.passes.length - 6);
  }
  const horizon = now + 0.2;
  if (S.metro) {
    const bl = beatLen();
    for (const ps of P.passes) {
      const pEnd = ps.to === Infinity ? Infinity : ps.ctx + (ps.to - ps.from);
      const a = Math.max(ps.ctx, P.metroUntil), b = Math.min(pEnd, horizon);
      if (b <= a) continue;
      const posA = ps.from + (a - ps.ctx), posB = ps.from + (b - ps.ctx);
      for (let k = Math.ceil(posA / bl - 1e-9); k * bl < posB; k++) {
        const when = ps.ctx + (k * bl - ps.from);
        if (when >= a && when < b) metClick(AC, when, k % 4 === 0, metroOut);
      }
    }
  }
  P.metroUntil = Math.max(P.metroUntil, horizon);
  const wb = now + 0.3;
  if (wb > P.schedUntil) { schedPatterns(P.schedUntil, wb); P.schedUntil = wb; }
  if (!P.loopOn && !P.recording && posNow() > songEnd() + 0.25) stop();
}
function posNow() {
  if (!P) return S.pos;
  const t = AC.currentTime, ps = P.passes;
  if (t < ps[0].ctx) return ps[0].from;
  let cur = ps[0];
  for (const p of ps) { if (p.ctx <= t) cur = p; else break; }
  return Math.min(cur.from + (t - cur.ctx), cur.to);
}
function stop() {
  if (!P) return;
  const p = P;
  for (const s of p.sources) { try { s.stop(); } catch (e) { /* already stopped */ } }
  p.sources.length = 0;
  clearInterval(p.timer);
  P = null;
  S.pos = p.returnPos;
  if (p.recording && curRec && mic) {
    curRec.stopCtx = AC.currentTime;
    curRec.passes = p.passes;
    mic.node.port.postMessage('stop');
  }
  syncTransport(); draw();
}
function togglePlay() { if (P) stop(); else play(S.pos); }
function setPos(t) {
  S.pos = Math.max(0, t);
  if (P && !P.recording && !P.patMode) play(S.pos); else draw();
}
function restartIfPlaying() { if (P && !P.recording && !P.patMode) play(posNow()); }
function setMode(m) {
  if (S.mode === m) return;
  if (P && P.recording) return;
  const was = !!P;
  if (P) stop();
  S.mode = m;
  syncToolbar();
  if (was) play(m === 'pat' ? 0 : S.pos);
}

/* ---------- microphone and recording ---------- */
let mic = null, curRec = null;

async function ensureMic() {
  await ensureCtx();
  if (mic) return mic;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: S.deviceId ? { exact: S.deviceId } : undefined,
      echoCancellation: false, noiseSuppression: S.noiseClean, autoGainControl: false, channelCount: 1,
    },
  });
  const src = AC.createMediaStreamSource(stream);
  const analyser = AC.createAnalyser(); analyser.fftSize = 1024;
  const monitor = AC.createGain(); monitor.gain.value = S.monitor ? 1 : 0;
  const node = new AudioWorkletNode(AC, 'awad-rec', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
  const sink = AC.createGain(); sink.gain.value = 0;
  const tune = new AudioWorkletNode(AC, 'awad-tune', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit', processorOptions: { mode: S.liveTune, allowed: tuneAllowed() } });
  src.connect(analyser);
  src.connect(tune); tune.connect(monitor);
  (S.recTuned && S.liveTune !== 'off' ? tune : src).connect(node);
  node.connect(sink); sink.connect(AC.destination);
  node.port.onmessage = onRecMsg;
  tune.port.onmessage = (e) => { if (mic) { mic.stat = e.data; mic.statAt = performance.now(); } };
  const st = stream.getAudioTracks()[0].getSettings();
  mic = { stream, src, analyser, monitor, node, sink, tune, inLatency: st.latency || 0, sentKey: undefined };
  sendTune();
  updateMonitorRoute();
  fillDevices();
  updateLatInfo();
  return mic;
}
function closeMic() {
  if (!mic) return;
  mic.stream.getTracks().forEach((t) => t.stop());
  for (const n of [mic.src, mic.monitor, mic.node, mic.sink, mic.tune]) n.disconnect();
  mic = null;
}
const autoLatency = () => (AC ? (AC.outputLatency || 0) + (AC.baseLatency || 0) : 0.02) + (mic ? mic.inLatency || 0.01 : 0.01);
const latencySec = () => (S.latencyMs != null ? S.latencyMs / 1000 : autoLatency()) + (S.recTuned && S.liveTune !== 'off' ? 0.0175 : 0);

/* live auto-tune in the headphones */
function tuneAllowed() { return keyAllowed(S.key); }
function keyAllowed(key) {
  const k = parseKey(key);
  return Array.from({ length: 12 }, (_, pc) => !k || SCALES[k.mode].includes((pc - k.root + 12) % 12));
}
function sendTune() {
  if (!mic) return;
  mic.tune.port.postMessage({ mode: S.liveTune, allowed: tuneAllowed() });
  mic.sentKey = S.key;
}
// you hear yourself through the armed track's effects, so vocal presets apply live
function updateMonitorRoute() {
  if (!mic) return;
  mic.monitor.disconnect();
  const t = S.tracks.find((x) => x.arm);
  if (t && G) mic.monitor.connect(getStrip(G, t).input); else mic.monitor.connect(AC.destination);
  mic.monitor.gain.value = S.monitor ? 1 : 0;
}
let tuneInfoAt = 0;
function updateTuneInfo() {
  const now = performance.now();
  if (now - tuneInfoAt < 100) return;
  tuneInfoAt = now;
  const el = $('#tuneInfo');
  let txt = '', cls = '';
  if (S.liveTune === 'off') txt = '';
  else if (!mic) txt = 'Mic is not on yet. Click the red dot on a track.';
  else if (!S.monitor) txt = 'Tuning, but "Hear myself" is off in Settings, so you will not hear it.';
  else if (!mic.statAt || now - mic.statAt > 1200) txt = 'No sound from the mic. Check the microphone in Settings.';
  else {
    const st = mic.stat;
    if (st.level < 2e-5) txt = 'Live tune ready. Sing a note to see it work.';
    else if (st.midi == null) txt = 'Hearing you, but no clear note yet. Hold a note.';
    else if (st.note == null) txt = 'Hearing ' + noteName(Math.round(st.midi)) + '.';
    else {
      const cents = Math.round((st.midi - st.note) * 100);
      const off = Math.abs(cents) < 8 ? 'right on it' : `${Math.abs(cents)} cents ${cents < 0 ? 'flat' : 'sharp'}`;
      txt = `You: ${noteName(Math.round(st.midi))} (${off})  >  tuned to ${noteName(st.note)}`;
      cls = 'live';
    }
  }
  if (el.textContent !== txt) el.textContent = txt;
  el.className = cls;
}
const TUNE_LABEL = { off: 'Live tune: off', natural: 'Live tune: natural', hard: 'Live tune: hard' };
async function cycleLiveTune() {
  S.liveTune = S.liveTune === 'off' ? 'natural' : S.liveTune === 'natural' ? 'hard' : 'off';
  if (S.liveTune !== 'off' && !S.monitor) S.monitor = true;
  savePrefs(); syncToolbar();
  try { await ensureMic(); } catch (e) { toast('The microphone is blocked. Allow it in the address bar first.'); return; }
  if (S.recTuned) { closeMic(); await ensureMic(); }
  sendTune(); updateMonitorRoute();
  if (S.liveTune === 'natural') toast(`Live tune on (natural): you hear yourself tuned to ${S.key || 'the nearest note (pick a key at the top for better results)'}, with your track's effects. Wear headphones. Bluetooth adds a delay.`, 9000);
  else if (S.liveTune === 'hard') toast('Live tune on (hard): the robotic trap sound. Click again to turn it off.');
  else toast('Live tune off.');
}

function onRecMsg(e) {
  const m = e.data, r = curRec;
  if (!r) return;
  if (m.type === 'data') { if (r.firstFrame == null) r.firstFrame = m.frame; r.chunks.push(m.data); }
  else if (m.type === 'done') { curRec = null; (r.onDone || finishRecording)(r); }
}
function joinChunks(r) {
  const total = r.chunks.reduce((a, c) => a + c.length, 0);
  const data = new Float32Array(total);
  let o = 0;
  for (const c of r.chunks) { data.set(c, o); o += c.length; }
  return data;
}

async function startRecord() {
  if (curRec) return;
  await ensureCtx();
  const t = S.tracks.find((x) => x.arm);
  if (!t) { toast('Choose a track to record on: click the red dot on the left of a track first.'); return; }
  try { await ensureMic(); } catch (err) {
    toast('The microphone is blocked. Click the icon at the left of the address bar, allow the microphone, then try again.');
    return;
  }
  if (P) stop();
  if (S.mode === 'pat') { S.mode = 'song'; syncToolbar(); }
  const mode = S.loop.on ? 'loop' : (S.punch ? 'punch' : 'normal');
  if (mode !== 'normal' && S.loop.end - S.loop.start < 0.2) {
    toast('Drag across the ruler (the strip with bar numbers) to mark the section first.');
    return;
  }
  const from = mode === 'loop' ? S.loop.start : mode === 'punch' ? Math.max(0, S.loop.start - barLen()) : S.pos;
  curRec = { chunks: [], firstFrame: null, mode, trackId: t.id, sr: AC.sampleRate };
  mic.node.port.postMessage('start');
  await play(from, { recording: true, countIn: S.countIn && mode !== 'punch', punch: mode === 'punch', returnPos: mode === 'normal' ? S.pos : from });
}

function finishRecording(r) {
  if (r.firstFrame == null || !r.chunks.length) { toast('No sound came in from the mic. Check the microphone in Settings.'); return; }
  const data = joinChunks(r), total = data.length;
  const sr = r.sr, recStart = r.firstFrame / sr, L = latencySec();
  const slice = (ctxT, dur) => {
    const i0 = Math.round((ctxT + L - recStart) * sr), n = Math.max(1, Math.round(dur * sr));
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) { const j = i0 + i; if (j >= 0 && j < total) out[i] = data[j]; }
    return out;
  };
  const t = S.tracks.find((x) => x.id === r.trackId);
  if (!t || !r.passes || !r.passes.length) return;
  const ps = r.passes, p0 = ps[0], stopT = r.stopCtx;
  let start, dur;
  const takes = [];
  if (r.mode === 'loop') {
    dur = p0.to - p0.from; start = p0.from;
    for (const p of ps) {
      if (p.ctx >= stopT) break;
      const played = stopT - p.ctx;
      if (played >= dur - 0.03) takes.push(slice(p.ctx, dur));
      else if (!takes.length && played > 0.4) takes.push(slice(p.ctx, dur));
    }
  } else if (r.mode === 'punch') {
    const a = S.loop.start, b = S.loop.end;
    const endPos = Math.min(b, p0.from + (stopT - p0.ctx));
    dur = endPos - a; start = a;
    if (dur < 0.1) { toast('You stopped before the marked section started, so nothing was kept.'); return; }
    takes.push(slice(p0.ctx + (a - p0.from), dur));
  } else {
    dur = stopT - p0.ctx; start = p0.from;
    if (dur < 0.25) { toast('That recording was too short, nothing was kept.'); return; }
    takes.push(slice(p0.ctx, dur));
  }
  if (!takes.length) { toast('That recording was too short, nothing was kept.'); return; }
  pushUndo();
  const ids = takes.map((d) => {
    const b = AC.createBuffer(1, d.length, sr);
    b.copyToChannel(d, 0);
    const id = nid('r'); addBuffer(id, b);
    return id;
  });
  t.takeCount = (t.takeCount || 0) + 1;
  replaceRegion(t, start, start + dur);
  const c = { id: nid('c'), bufs: ids, take: ids.length - 1, start, offset: 0, dur, fadeIn: 0.01, fadeOut: 0.01, gain: 1, name: `${t.name} take ${t.takeCount}` };
  t.clips.push(c);
  S.sel = { tid: t.id, cid: c.id };
  draw(); renderSel();
  toast(ids.length > 1 ? `Kept ${ids.length} takes. Use the arrows next to "Take" above to pick the best one.` : 'Recorded. Press Space to hear it back.');
  if (AWAD.local) fetch('/api/take?name=' + encodeURIComponent(c.name), { method: 'POST', body: encodeWav([data], sr) }).catch(() => {});
}

function replaceRegion(t, a, b, exceptId) {
  const out = [];
  for (const c of t.clips) {
    const cs = c.start, ce = c.start + c.dur;
    if (c.id === exceptId || ce <= a + 1e-4 || cs >= b - 1e-4) { out.push(c); continue; }
    if (cs < a) { const l = { ...c, bufs: c.bufs ? [...c.bufs] : undefined, dur: a - cs }; fixFades(l); out.push(l); }
    if (ce > b) {
      const d = b - cs;
      const r = { ...c, id: nid('c'), bufs: c.bufs ? [...c.bufs] : undefined, start: b, offset: c.offset + d, dur: ce - b, fadeIn: 0 };
      fixFades(r); out.push(r);
    }
  }
  t.clips = out;
}

/* ---------- tap test (latency calibration) ---------- */
async function tapTest() {
  const out = $('#tapRes');
  try { await ensureMic(); } catch (e) { out.textContent = 'The microphone is blocked, allow it in the address bar first.'; return; }
  if (P) stop();
  if (curRec) return;
  const gap = 0.6, n = 8, t0 = AC.currentTime + 0.8;
  out.textContent = 'Listen in your headphones and tap the mic with a finger on each of the 8 clicks...';
  for (let k = 0; k < n; k++) metClick(AC, t0 + k * gap, k === 0, metroOut);
  curRec = { chunks: [], firstFrame: null, sr: AC.sampleRate, onDone: (r) => analyzeTaps(r, t0, gap, n) };
  mic.node.port.postMessage('start');
  setTimeout(() => mic && mic.node.port.postMessage('stop'), (0.8 + n * gap + 0.6) * 1000);
}
function analyzeTaps(r, t0, gap, n) {
  const out = $('#tapRes');
  if (r.firstFrame == null) { out.textContent = 'No sound came in. Check the microphone above.'; return; }
  const d = joinChunks(r), sr = r.sr, recStart = r.firstFrame / sr, offs = [];
  for (let k = 1; k < n; k++) {
    const exp = t0 + k * gap;
    const i0 = clamp(Math.round((exp - 0.12 - recStart) * sr), 0, d.length);
    const i1 = clamp(Math.round((exp + 0.45 - recStart) * sr), 0, d.length);
    let mx = 0;
    for (let i = i0; i < i1; i++) mx = Math.max(mx, Math.abs(d[i]));
    if (mx < 0.02) continue;
    for (let i = i0; i < i1; i++) if (Math.abs(d[i]) >= mx * 0.35) { offs.push(i / sr + recStart - exp); break; }
  }
  if (offs.length < 4) { out.textContent = "Couldn't hear enough taps. Tap a little harder, right on the mic, and try again."; return; }
  offs.sort((a, b) => a - b);
  const ms = Math.round(offs[Math.floor(offs.length / 2)] * 1000);
  if (ms < 0 || ms > 700) { out.textContent = `Got an odd result (${ms} ms). Try again and tap right on each click.`; return; }
  S.latencyMs = ms; savePrefs();
  $('#latMs').value = ms;
  out.textContent = `Done. Your setup has about ${ms} ms of delay, and new recordings will be lined up to fix it.`;
  updateLatInfo();
}

/* ---------- undo ---------- */
const undoStack = [], redoStack = [];
const snapState = () => JSON.stringify({
  bpm: S.bpm, key: S.key, tracks: S.tracks, loop: S.loop, channels: S.channels, patterns: S.patterns,
  curPat: S.curPat, curCh: S.curCh, markers: S.markers, master: S.master,
});
function pushUndo() { undoStack.push(snapState()); if (undoStack.length > 150) undoStack.shift(); redoStack.length = 0; S.dirty = true; }
function restore(str) {
  const o = JSON.parse(str);
  Object.assign(S, { bpm: o.bpm, key: o.key, tracks: o.tracks, loop: o.loop, channels: o.channels, patterns: o.patterns, curPat: o.curPat, curCh: o.curCh, markers: o.markers, master: o.master, sel: null, dirty: true });
  if (P && !P.recording) stop();
  refreshAll();
}
function undo() { if (!undoStack.length || curRec) return; redoStack.push(snapState()); restore(undoStack.pop()); }
function redo() { if (!redoStack.length || curRec) return; undoStack.push(snapState()); restore(redoStack.pop()); }
function refreshAll() {
  renderHeads(); updateMix(); syncToolbar(); renderSel(); draw();
  if (typeof renderRack === 'function') renderRack();
  if (typeof drawRoll === 'function') drawRoll();
  if (typeof renderMixer === 'function') renderMixer();
  if (G) ensureSounds();
}

/* ---------- arrangement drawing ---------- */
const lanes = $('#lanes'), cv = $('#cv'), ruler = $('#ruler'), heads = $('#heads'), spacer = $('#spacer');
const g2 = cv.getContext('2d'), rg = ruler.getContext('2d');

function gridStep() {
  const b = beatLen(), bp = b * S.pps;
  if (bp > 120) return b / 4;
  if (bp > 60) return b / 2;
  if (bp > 14) return b;
  return barLen();
}
function snapT(t, e) {
  if (!S.snap || (e && e.altKey)) return t;
  const st = gridStep();
  return Math.round(t / st) * st;
}
function fitCanvas(c, ctx2, w, h) {
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    c.style.width = w + 'px'; c.style.height = h + 'px';
  }
  ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function updateSpacer() {
  const len = Math.max(songEnd(), S.loop.end, P && !P.patMode ? posNow() : 0, 30) + barLen() * 16;
  spacer.style.width = Math.round(len * S.pps) + 'px';
  spacer.style.height = S.tracks.length * TH + 'px';
}
const MARK_COLORS = { Intro: '#6fb0d0', Hook: '#e0a458', Verse: '#8fbd6c', 'Pre-hook': '#cdbb5c', Bridge: '#a98ad6', Outro: '#6fb0d0' };
const markColor = (name) => MARK_COLORS[name.replace(/ \d+$/, '')] || '#8b919a';

function draw() {
  updateSpacer();
  const W = lanes.clientWidth, Hh = lanes.clientHeight, g = g2;
  fitCanvas(cv, g, W, Hh);
  const sl = lanes.scrollLeft, st = lanes.scrollTop, pps = S.pps;
  g.fillStyle = '#15171a'; g.fillRect(0, 0, W, Hh);
  S.tracks.forEach((t, i) => {
    const y = i * TH - st;
    g.fillStyle = i % 2 ? '#17191d' : '#191c20'; g.fillRect(0, y, W, TH);
    if (t.arm) { g.fillStyle = 'rgba(224,82,74,0.05)'; g.fillRect(0, y, W, TH); }
    g.fillStyle = '#23272c'; g.fillRect(0, y + TH - 1, W, 1);
  });
  for (const m of S.markers) {
    g.fillStyle = markColor(m.name) + '0d';
    g.fillRect(m.bar * barLen() * pps - sl, 0, m.bars * barLen() * pps, Hh);
  }
  if (S.loop.on || S.punch) {
    g.fillStyle = S.punch ? 'rgba(224,82,74,0.07)' : 'rgba(95,179,168,0.07)';
    g.fillRect(S.loop.start * pps - sl, 0, (S.loop.end - S.loop.start) * pps, Hh);
  }
  const step = gridStep(), bl = barLen(), t0 = sl / pps, t1 = (sl + W) / pps;
  for (let k = Math.floor(t0 / step); k * step <= t1; k++) {
    const t = k * step, x = Math.round(t * pps - sl) + 0.5;
    const isBar = Math.abs(t / bl - Math.round(t / bl)) < 1e-6;
    const isBeat = Math.abs(t / beatLen() - Math.round(t / beatLen())) < 1e-6;
    g.fillStyle = isBar ? '#2d3238' : isBeat ? '#22262b' : '#1e2125';
    g.fillRect(x, 0, 1, Hh);
  }
  S.tracks.forEach((t, i) => { for (const c of t.clips) drawClip(t, c, i * TH - st, sl, W); });
  if (P && P.recording && curRec && curRec.trackId) {
    const i = S.tracks.findIndex((x) => x.id === curRec.trackId);
    const pn = posNow();
    let a = P.startPos, b = pn;
    if (curRec.mode === 'loop') a = S.loop.start;
    if (curRec.mode === 'punch') { a = S.loop.start; b = Math.min(pn, S.loop.end); }
    if (i >= 0 && b > a) { g.fillStyle = 'rgba(224,82,74,0.28)'; g.fillRect(a * pps - sl, i * TH - st + 3, (b - a) * pps, TH - 6); }
  }
  if (!S.tracks.some((t) => t.clips.length) && !P) {
    g.fillStyle = '#7d848d'; g.font = '14px "Segoe UI", sans-serif'; g.textAlign = 'center';
    const y = Math.min(Hh - 60, S.tracks.length * TH + 50);
    g.fillText('Use a beat from YouTube: paste the link above and click Get beat.', W / 2, y);
    g.fillText('Or make your own: click Starter beat, or open the Channel rack below.', W / 2, y + 24);
    g.fillText('To record: click the red dot on Vocal 1, then press R.', W / 2, y + 48);
    g.textAlign = 'left';
  }
  if (!(P && P.patMode)) {
    const px = Math.round(posNow() * pps - sl) + 0.5;
    g.fillStyle = P && P.recording ? '#e0524a' : '#e8eaed';
    g.fillRect(px - 0.5, 0, 1.5, Hh);
  }
  drawRuler();
}

function drawClip(t, c, y0, sl, W) {
  const g = g2, pps = S.pps, x = c.start * pps - sl, w = c.dur * pps;
  if (x + w < 0 || x > W) return;
  const y = y0 + 3, h = TH - 6, sel = S.sel && S.sel.cid === c.id;
  const isPat = c.kind === 'pat', p = isPat ? patById(c.patId) : null;
  const col = isPat ? (p ? p.color : '#888') : t.color;
  g.globalAlpha = audible(t) ? 1 : 0.45;
  g.fillStyle = col + '2e'; g.fillRect(x, y, w, h);
  g.fillStyle = col; g.fillRect(x, y, w, 15);
  g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip();
  g.fillStyle = '#121417'; g.font = '600 11px "Segoe UI", sans-serif';
  const label = isPat ? (p ? p.name : 'Missing pattern') : c.bufs.length > 1 ? `${c.name}  (take ${c.take + 1} of ${c.bufs.length})` : c.name;
  g.fillText(label, Math.max(x, 0) + 5, y + 11);
  if (isPat && p) {
    const L = patLenSec(p), evs = patEvents(p), top = y + 18, hh = h - 22;
    const chans = S.channels.filter((ch) => chHasNotes(p, ch) || (p.steps[ch.id] || []).some(Boolean));
    let lo = 127, hi = 0;
    for (const e of evs) if (e.notes) { lo = Math.min(lo, e.midi); hi = Math.max(hi, e.midi); }
    const origin = c.start - c.offset;
    g.fillStyle = col;
    for (let k = Math.floor((c.start - origin) / L); origin + k * L < c.start + c.dur; k++) {
      const rs = origin + k * L;
      const rx = rs * pps - sl;
      if (rx > W || rx + L * pps < 0) continue;
      if (k > Math.floor((c.start - origin) / L)) { g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(rx, top, 1, hh); g.fillStyle = col; }
      for (const e of evs) {
        const tt = rs + e.t;
        if (tt < c.start || tt >= c.start + c.dur) continue;
        let yy;
        if (e.notes && hi >= lo) yy = top + hh - 3 - ((e.midi - lo) / Math.max(1, hi - lo)) * (hh - 4);
        else yy = top + (Math.max(0, chans.indexOf(e.ch)) / Math.max(1, chans.length)) * hh;
        g.fillRect(tt * pps - sl, yy, Math.max(2, e.dur * pps - 1), 2.5);
      }
    }
  } else {
    const b = bufOf(c);
    if (b) {
      const top = y + 17, hh = h - 19, mid = top + hh / 2;
      g.fillStyle = col;
      const xa = Math.max(0, Math.floor(x)), xb = Math.min(W, Math.ceil(x + w));
      for (let px = xa; px < xb; px++) {
        const la = (px - x) / pps, lb = (px + 1 - x) / pps;
        let i0 = Math.floor((c.offset + la) * b.rate), i1 = Math.ceil((c.offset + lb) * b.rate);
        i0 = clamp(i0, 0, b.peaks.length - 1); i1 = clamp(i1, i0 + 1, b.peaks.length);
        let m = 0;
        for (let i = i0; i < i1; i++) if (b.peaks[i] > m) m = b.peaks[i];
        m = Math.min(1, m * envAt(c, clamp(la, 0, c.dur)));
        const a = Math.max(0.5, m * hh / 2);
        g.fillRect(px, mid - a, 1, a * 2);
      }
    }
    g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = 1;
    if (c.fadeIn > 0.012) { g.beginPath(); g.moveTo(x, y + h); g.lineTo(x + c.fadeIn * pps, y + 16); g.stroke(); }
    if (c.fadeOut > 0.012) { g.beginPath(); g.moveTo(x + w, y + h); g.lineTo(x + w - c.fadeOut * pps, y + 16); g.stroke(); }
  }
  g.restore();
  if (sel && w > 30 && !isPat) {
    g.fillStyle = '#fff';
    g.fillRect(x + c.fadeIn * pps - 3, y + 16, 6, 6);
    g.fillRect(x + w - c.fadeOut * pps - 3, y + 16, 6, 6);
  }
  g.globalAlpha = 1;
  if (sel) { g.strokeStyle = '#ffffff'; g.lineWidth = 1.5; g.strokeRect(x + 0.75, y + 0.75, w - 1.5, h - 1.5); }
}

function drawRuler() {
  const W = ruler.clientWidth;
  fitCanvas(ruler, rg, W, RH);
  const sl = lanes.scrollLeft, pps = S.pps, bl = barLen(), barPx = bl * pps;
  rg.fillStyle = '#202328'; rg.fillRect(0, 0, W, RH);
  rg.font = '600 10px "Segoe UI", sans-serif';
  for (const m of S.markers) {
    const x = m.bar * barPx - sl, w = m.bars * barPx;
    if (x + w < 0 || x > W) continue;
    rg.fillStyle = markColor(m.name) + '55'; rg.fillRect(x, 0, w - 1, 13);
    rg.fillStyle = markColor(m.name); rg.fillRect(x, 0, 2, 13);
    rg.save(); rg.beginPath(); rg.rect(x, 0, w - 2, 13); rg.clip();
    rg.fillStyle = '#e8eaed'; rg.fillText(m.name, x + 5, 10); rg.restore();
  }
  const lx0 = S.loop.start * pps - sl, lw = (S.loop.end - S.loop.start) * pps;
  rg.fillStyle = S.punch ? 'rgba(224,82,74,0.5)' : S.loop.on ? 'rgba(95,179,168,0.5)' : 'rgba(255,255,255,0.09)';
  rg.fillRect(lx0, 14, lw, 8);
  let every = 1;
  while (barPx * every < 44) every *= 2;
  rg.font = '11px "Segoe UI", sans-serif';
  const beatPx = beatLen() * pps;
  for (let b = Math.floor(sl / barPx); b * barPx < sl + W; b++) {
    const x = Math.round(b * barPx - sl) + 0.5;
    if (b % every === 0) {
      rg.fillStyle = '#59606a'; rg.fillRect(x, 23, 1, RH - 23);
      rg.fillStyle = '#c4c8ce'; rg.fillText(String(b + 1), x + 4, 35);
    } else { rg.fillStyle = '#3a4048'; rg.fillRect(x, 31, 1, RH - 31); }
    if (beatPx > 10) for (let k = 1; k < 4; k++) { rg.fillStyle = '#33383f'; rg.fillRect(Math.round(x + k * beatPx), 35, 1, 5); }
  }
  if (!(P && P.patMode)) {
    const px = posNow() * pps - sl;
    rg.fillStyle = P && P.recording ? '#e0524a' : '#e8eaed';
    rg.beginPath(); rg.moveTo(px - 5, 23); rg.lineTo(px + 5, 23); rg.lineTo(px, 30); rg.fill();
    rg.fillRect(px - 0.5, 30, 1.5, RH - 30);
  }
}

/* ---------- mouse: lanes ---------- */
let drag = null;
function hitInfo(e) {
  const r = cv.getBoundingClientRect();
  const vx = e.clientX - r.left, vy = e.clientY - r.top;
  return { vx, vy, t: (vx + lanes.scrollLeft) / S.pps, ti: Math.floor((vy + lanes.scrollTop) / TH) };
}
function clipAt(h) {
  const t = S.tracks[h.ti];
  if (!t) return null;
  for (let i = t.clips.length - 1; i >= 0; i--) {
    const c = t.clips[i];
    if (h.t >= c.start && h.t <= c.start + c.dur) return { t, c };
  }
  return null;
}
function zoneOf(h, t, c) {
  const pps = S.pps, sl = lanes.scrollLeft;
  const x0 = c.start * pps - sl, x1 = x0 + c.dur * pps;
  const yl = h.vy + lanes.scrollTop - h.ti * TH;
  const w = x1 - x0;
  if (c.kind !== 'pat') {
    if (yl < 26 && w > 30 && Math.abs(h.vx - (x0 + c.fadeIn * pps)) < 7) return 'fadeIn';
    if (yl < 26 && w > 30 && Math.abs(h.vx - (x1 - c.fadeOut * pps)) < 7) return 'fadeOut';
  }
  if (h.vx - x0 < 7 && w > 16) return 'trimL';
  if (x1 - h.vx < 7 && w > 16) return 'trimR';
  return 'move';
}
const CURSORS = { fadeIn: 'pointer', fadeOut: 'pointer', trimL: 'ew-resize', trimR: 'ew-resize', move: 'grab' };

cv.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  ensureCtx();
  const h = hitInfo(e), hit = clipAt(h);
  if (hit) {
    const mode = zoneOf(h, hit.t, hit.c);
    S.sel = { tid: hit.t.id, cid: hit.c.id };
    if (hit.c.kind === 'pat') { S.curPat = hit.c.patId; if (typeof renderRack === 'function') { renderRack(); drawRoll(); } syncToolbar(); }
    pushUndo();
    drag = { mode, c: hit.c, tid: hit.t.id, orig: { ...hit.c }, t0: h.t, moved: false };
    cv.setPointerCapture(e.pointerId);
    if (mode === 'move') cv.style.cursor = 'grabbing';
  } else {
    S.sel = null;
    if (!(P && P.recording)) setPos(snapT(h.t, e));
  }
  renderSel(); draw();
});
cv.addEventListener('pointermove', (e) => {
  const h = hitInfo(e);
  if (!drag) {
    const hit = clipAt(h);
    cv.style.cursor = hit ? CURSORS[zoneOf(h, hit.t, hit.c)] : 'default';
    return;
  }
  const { c, orig, mode } = drag, dt = h.t - drag.t0;
  if (Math.abs(dt * S.pps) > 2) drag.moved = true;
  if (!drag.moved) return;
  const bdur = c.kind === 'pat' ? Infinity : bufOf(c) ? bufOf(c).buffer.duration : orig.offset + orig.dur;
  if (mode === 'move') {
    c.start = Math.max(0, snapT(orig.start + dt, e));
    const target = S.tracks[clamp(h.ti, 0, S.tracks.length - 1)];
    if (target && target.id !== drag.tid) {
      const from = S.tracks.find((x) => x.id === drag.tid);
      from.clips = from.clips.filter((x) => x !== c);
      target.clips.push(c);
      drag.tid = target.id; S.sel.tid = target.id;
    }
  } else if (mode === 'trimL') {
    let ns = snapT(orig.start + dt, e);
    ns = clamp(ns, Math.max(0, orig.start - orig.offset), orig.start + orig.dur - 0.05);
    const d = ns - orig.start;
    c.start = ns; c.offset = orig.offset + d; c.dur = orig.dur - d; fixFades(c);
  } else if (mode === 'trimR') {
    let ne = snapT(orig.start + orig.dur + dt, e);
    ne = clamp(ne, orig.start + 0.05, orig.start + (bdur - orig.offset));
    c.dur = ne - c.start; fixFades(c);
  } else if (mode === 'fadeIn') {
    c.fadeIn = clamp(h.t - c.start, 0, c.dur - c.fadeOut);
  } else if (mode === 'fadeOut') {
    c.fadeOut = clamp(c.start + c.dur - h.t, 0, c.dur - c.fadeIn);
  }
  draw();
});
cv.addEventListener('pointerup', () => {
  if (!drag) return;
  if (!drag.moved) undoStack.pop();
  else restartIfPlaying();
  drag = null; cv.style.cursor = 'default';
  renderSel(); draw();
});
cv.addEventListener('dblclick', (e) => {
  const h = hitInfo(e), hit = clipAt(h);
  if (hit) {
    if (hit.c.kind === 'pat') { S.curPat = hit.c.patId; openDock('rack'); syncToolbar(); }
    else setPos(hit.c.start);
    return;
  }
  const t = S.tracks[h.ti];
  if (!t) return;
  const p = patById(S.curPat);
  if (!p) { toast('Make a pattern in the Channel rack first, then double-click here to place it.'); return; }
  pushUndo();
  const bl = barLen(), start = Math.floor(h.t / bl) * bl, L = patLenSec(p);
  replaceRegion(t, start, start + L);
  const c = { id: nid('c'), kind: 'pat', patId: p.id, start, dur: L, offset: 0 };
  t.clips.push(c);
  S.sel = { tid: t.id, cid: c.id };
  renderSel(); draw(); restartIfPlaying();
});
lanes.addEventListener('wheel', (e) => {
  if (e.ctrlKey) {
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    zoomTo(S.pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX - r.left);
  }
}, { passive: false });
lanes.addEventListener('scroll', () => { heads.scrollTop = lanes.scrollTop; draw(); });
heads.addEventListener('wheel', (e) => { lanes.scrollTop += e.deltaY; }, { passive: true });

function zoomTo(pps, anchorVx) {
  const t = (anchorVx + lanes.scrollLeft) / S.pps;
  S.pps = clamp(pps, 6, 500);
  updateSpacer();
  lanes.scrollLeft = t * S.pps - anchorVx;
  draw();
}

/* ---------- mouse: ruler ---------- */
let rdrag = null;
ruler.addEventListener('pointerdown', (e) => {
  ensureCtx();
  const r = ruler.getBoundingClientRect(), vx = e.clientX - r.left, vy = e.clientY - r.top;
  const t = (vx + lanes.scrollLeft) / S.pps;
  if (vy < 14) {
    const m = S.markers.find((mk) => t >= mk.bar * barLen() && t < (mk.bar + mk.bars) * barLen());
    if (m && !(P && P.recording)) { setPos(m.bar * barLen()); return; }
  }
  const x0 = S.loop.start * S.pps - lanes.scrollLeft, x1 = S.loop.end * S.pps - lanes.scrollLeft;
  let mode = 'new';
  if (Math.abs(vx - x0) < 6) mode = 'start'; else if (Math.abs(vx - x1) < 6) mode = 'end';
  pushUndo();
  rdrag = { mode, anchor: snapT(t, e), vx, moved: false };
  ruler.setPointerCapture(e.pointerId);
});
ruler.addEventListener('pointermove', (e) => {
  const r = ruler.getBoundingClientRect(), vx = e.clientX - r.left;
  const t = Math.max(0, (vx + lanes.scrollLeft) / S.pps);
  if (!rdrag) {
    const x0 = S.loop.start * S.pps - lanes.scrollLeft, x1 = S.loop.end * S.pps - lanes.scrollLeft;
    ruler.style.cursor = e.clientY - r.top < 14 ? 'pointer' : Math.abs(vx - x0) < 6 || Math.abs(vx - x1) < 6 ? 'ew-resize' : 'text';
    return;
  }
  if (Math.abs(vx - rdrag.vx) > 4) rdrag.moved = true;
  if (!rdrag.moved) return;
  const st = snapT(t, e);
  if (rdrag.mode === 'new') { S.loop.start = Math.min(rdrag.anchor, st); S.loop.end = Math.max(rdrag.anchor, st); }
  else if (rdrag.mode === 'start') S.loop.start = Math.min(st, S.loop.end - 0.05);
  else S.loop.end = Math.max(st, S.loop.start + 0.05);
  draw();
});
ruler.addEventListener('pointerup', (e) => {
  if (!rdrag) return;
  if (!rdrag.moved) {
    undoStack.pop();
    const r = ruler.getBoundingClientRect();
    if (!(P && P.recording)) setPos(snapT((e.clientX - r.left + lanes.scrollLeft) / S.pps, e));
  } else if (!S.loop.on && !S.punch) {
    toast('Section marked. Turn on Loop to repeat it, or Punch to re-record just that part.');
  }
  rdrag = null; draw();
});

/* ---------- track headers ---------- */
function renderHeads() {
  heads.innerHTML = '';
  S.tracks.forEach((t) => {
    const d = document.createElement('div');
    d.className = 'th' + (t.arm ? ' armed' : '');
    d.innerHTML = `
      <span class="stripe" style="background:${t.color}"></span>
      <div class="row1">
        <button class="arm ${t.arm ? 'on' : ''}" title="Record on this track"><i></i></button>
        <input class="tname" value="${esc(t.name)}" spellcheck="false" title="Click to rename">
        <button class="mute ${t.mute ? 'on' : ''}" title="Mute: silence this track">M</button>
        <button class="solo ${t.solo ? 'on' : ''}" title="Solo: hear only this track">S</button>
        <button class="tdel" title="Delete track">&times;</button>
      </div>
      <div class="row2">
        <span>Vol</span><input type="range" class="vol" min="0" max="1.5" step="0.01" value="${t.vol}" title="Track volume. Double-click to reset.">
        <span>Pan</span><input type="range" class="pan" min="-1" max="1" step="0.01" value="${t.pan}" title="Left or right. Double-click to center.">
      </div>
      ${t.arm ? '<canvas class="imeter" width="6" height="40" title="Mic level. Aim for the middle, never the top."></canvas>' : ''}`;
    d.querySelector('.arm').onclick = async () => {
      const on = !t.arm;
      S.tracks.forEach((x) => { x.arm = false; });
      t.arm = on;
      renderHeads(); draw(); renderSel();
      if (on) { try { await ensureMic(); } catch (e) { toast('The microphone is blocked. Allow it in the address bar to record.'); } }
      updateMonitorRoute();
    };
    const nm = d.querySelector('.tname');
    nm.onchange = () => { pushUndo(); t.name = nm.value.trim() || t.name; draw(); if (typeof renderMixer === 'function') renderMixer(); };
    nm.onkeydown = (e) => { if (e.key === 'Enter') nm.blur(); };
    d.querySelector('.mute').onclick = () => { t.mute = !t.mute; S.dirty = true; renderHeads(); updateMix(); draw(); if (typeof renderMixer === 'function') renderMixer(); };
    d.querySelector('.solo').onclick = () => { t.solo = !t.solo; S.dirty = true; renderHeads(); updateMix(); draw(); if (typeof renderMixer === 'function') renderMixer(); };
    d.querySelector('.tdel').onclick = () => {
      if (curRec) return;
      pushUndo();
      S.tracks = S.tracks.filter((x) => x !== t);
      if (S.sel && S.sel.tid === t.id) S.sel = null;
      refreshAll();
      toast('Track deleted. Press Ctrl+Z to bring it back.');
    };
    const vol = d.querySelector('.vol'), pan = d.querySelector('.pan');
    vol.oninput = () => { t.vol = +vol.value; S.dirty = true; updateMix(); };
    vol.ondblclick = () => { t.vol = 1; vol.value = 1; updateMix(); };
    pan.oninput = () => { t.pan = +pan.value; S.dirty = true; updateMix(); };
    pan.ondblclick = () => { t.pan = 0; pan.value = 0; updateMix(); };
    heads.appendChild(d);
  });
  const filler = document.createElement('div');
  filler.style.height = '2000px';
  heads.appendChild(filler);
  heads.scrollTop = lanes.scrollTop;
}

/* ---------- selection bar ---------- */
function selClip() {
  if (!S.sel) return null;
  const t = S.tracks.find((x) => x.id === S.sel.tid);
  const c = t && t.clips.find((x) => x.id === S.sel.cid);
  return c ? { t, c } : null;
}
function hintText() {
  if (!S.tracks.some((t) => t.clips.length)) return 'Start: paste a beat link, or click Starter beat to make your own.';
  if (!S.tracks.some((t) => t.arm)) return 'Next: click the red dot on a track, then press R to record.';
  if (!S.markers.length) return 'Tip: click Layout to mark Intro, Hook and Verse so you know where to record.';
  return 'Tip: drag across the ruler to mark a section. Loop records take after take, Punch fixes only that part.';
}
function renderSel() {
  const bar = $('#selbar'), s = selClip();
  if (!s) { bar.innerHTML = `<span class="hint">${esc(hintText())}</span>`; return; }
  const { c } = s;
  if (c.kind === 'pat') {
    const p = patById(c.patId);
    bar.innerHTML = `
      <span class="cname">${esc(p ? p.name : 'Pattern')}</span><span class="sep"></span>
      <button id="cEdit" title="Open this pattern in the Channel rack">Edit pattern</button>
      <span class="sep"></span>
      <button id="cSplit" title="Cut the clip in two at the playhead (S)">Split</button>
      <button id="cDup" title="Copy the clip right after itself (Ctrl+D)">Duplicate</button>
      <button id="cDel" title="Delete the clip (Del)">Delete</button>`;
    $('#cEdit').onclick = () => { S.curPat = c.patId; openDock('rack'); syncToolbar(); };
  } else {
    const db = c.gain > 0 ? (20 * Math.log10(c.gain)).toFixed(1) + ' dB' : 'off';
    bar.innerHTML = `
      <span class="cname" title="${esc(c.name)}">${esc(c.name)}</span>
      ${c.bufs.length > 1 ? `<span class="sep"></span><span class="lbl">Take</span>
        <button id="tkPrev" title="Previous take">&lsaquo;</button><span>${c.take + 1} of ${c.bufs.length}</span>
        <button id="tkNext" title="Next take">&rsaquo;</button>` : ''}
      <span class="sep"></span><span class="lbl">Clip volume</span>
      <input type="range" id="cGain" min="0" max="2" step="0.01" value="${c.gain}" title="Double-click to reset">
      <span id="cGainDb">${db}</span>
      <span class="sep"></span>
      <button id="cStems" title="Breaks this beat into 4 tracks: drums, bass and 808, melody, and vocals or tags. Then mute, cut or add effects to each part.">Split into stems</button>
      <button id="cHalf" title="If the beat sounds half a beat off from the grid or metronome, this moves it half a beat so they line up">Shift &frac12; beat</button>
      <button id="cTune" title="Auto-tune: pulls the singing onto the notes of the key. Adds the tuned version as a new take, so you can switch back.">Auto-tune</button>
      <button id="cSplit" title="Cut the clip in two at the playhead (S)">Split</button>
      <button id="cDup" title="Copy the clip right after itself (Ctrl+D)">Duplicate</button>
      <button id="cDel" title="Delete the clip (Del)">Delete</button>`;
    const tk = (d) => { pushUndo(); c.take = (c.take + d + c.bufs.length) % c.bufs.length; renderSel(); draw(); restartIfPlaying(); };
    if (c.bufs.length > 1) { $('#tkPrev').onclick = () => tk(-1); $('#tkNext').onclick = () => tk(1); }
    const gi = $('#cGain');
    gi.onpointerdown = () => pushUndo();
    gi.oninput = () => {
      c.gain = +gi.value;
      $('#cGainDb').textContent = c.gain > 0 ? (20 * Math.log10(c.gain)).toFixed(1) + ' dB' : 'off';
      draw();
    };
    gi.onchange = () => restartIfPlaying();
    gi.ondblclick = () => { c.gain = 1; renderSel(); draw(); };
    $('#cTune').onclick = () => openTune(s.t, c);
    $('#cStems').onclick = () => splitStems(s.t, c);
    $('#cHalf').onclick = () => {
      pushUndo();
      const h = beatLen() / 2;
      if (c.start >= h) c.start -= h; else if (c.offset + h < bufOf(c).buffer.duration) c.offset += h, c.dur -= h; else c.start += h;
      draw(); restartIfPlaying();
      toast('Moved half a beat. Turn on the Metronome and play to check it lines up. If it sounds worse, click it again.');
    };
  }
  $('#cSplit').onclick = splitSel;
  $('#cDup').onclick = dupSel;
  $('#cDel').onclick = delSel;
}
function splitSel() {
  const s = selClip(); if (!s) return;
  const { t, c } = s, p = S.pos;
  if (p <= c.start + 0.02 || p >= c.start + c.dur - 0.02) { toast('Move the playhead inside the clip first, then press Split.'); return; }
  pushUndo();
  const c2 = { ...c, id: nid('c'), bufs: c.bufs ? [...c.bufs] : undefined, start: p, offset: c.offset + (p - c.start), dur: c.start + c.dur - p, fadeIn: 0 };
  c.dur = p - c.start; if (c.kind !== 'pat') c.fadeOut = 0;
  fixFades(c); fixFades(c2);
  t.clips.push(c2);
  S.sel = { tid: t.id, cid: c2.id };
  renderSel(); draw();
}
function dupSel() {
  const s = selClip(); if (!s) return;
  const { t, c } = s;
  pushUndo();
  const c2 = { ...c, id: nid('c'), bufs: c.bufs ? [...c.bufs] : undefined, start: c.start + c.dur };
  replaceRegion(t, c2.start, c2.start + c2.dur);
  t.clips.push(c2);
  S.sel = { tid: t.id, cid: c2.id };
  renderSel(); draw();
}
function delSel() {
  const s = selClip(); if (!s) return;
  pushUndo();
  s.t.clips = s.t.clips.filter((x) => x !== s.c);
  S.sel = null; renderSel(); draw(); restartIfPlaying();
}

/* ---------- toolbar ---------- */
function syncToolbar() {
  $('#bpm').value = S.bpm;
  const ks = $('#keySel');
  if (ks.options.length !== ALL_KEYS.length + 1) {
    ks.innerHTML = '<option value="">No key</option>' + ALL_KEYS.map((k) => `<option>${k}</option>`).join('');
  }
  ks.value = S.key || '';
  document.querySelectorAll('.tg').forEach((b) => {
    const k = b.dataset.tg;
    b.classList.toggle('on', k === 'loop' ? S.loop.on : !!S[k]);
  });
  $('#mPat').classList.toggle('on', S.mode === 'pat');
  $('#mSong').classList.toggle('on', S.mode === 'song');
  const ps = $('#patSel');
  ps.innerHTML = S.patterns.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('') + '<option value="__new">+ New pattern</option>';
  ps.value = S.curPat || '';
  $('#projName').value = S.projectName;
  const lt = $('#bLiveTune'); lt.textContent = TUNE_LABEL[S.liveTune]; lt.classList.toggle('on', S.liveTune !== 'off');
}
function syncTransport() {
  $('#bPlay').classList.toggle('on', !!P && !P.recording);
  $('#bRec').classList.toggle('on', !!P && P.recording);
}
function setBpm(v) {
  v = clamp(Math.round(v * 10) / 10, 40, 300);
  if (!isFinite(v) || v === S.bpm) { syncToolbar(); return; }
  pushUndo();
  const ratio = S.bpm / v;
  // patterns and markers follow the beat; audio stays where it is
  for (const t of S.tracks) for (const c of t.clips) if (c.kind === 'pat') { c.start *= ratio; c.dur *= ratio; c.offset *= ratio; }
  if (!S.tracks.some((t) => t.clips.some((c) => c.kind !== 'pat'))) { S.loop.start *= ratio; S.loop.end *= ratio; }
  S.bpm = v;
  if (G) applyMaster(G);
  syncToolbar(); draw(); restartIfPlaying();
  if (typeof drawRoll === 'function') drawRoll();
}
document.querySelectorAll('.tg').forEach((b) => {
  b.onclick = () => {
    const k = b.dataset.tg;
    if (k === 'loop') {
      S.loop.on = !S.loop.on;
      if (S.loop.on) S.punch = false;
    } else if (k === 'punch') {
      S.punch = !S.punch;
      if (S.punch) S.loop.on = false;
    } else S[k] = !S[k];
    if ((k === 'loop' || k === 'punch') && (S.loop.on || S.punch) && S.loop.end - S.loop.start < 0.2) {
      const bl = barLen(), st = Math.floor(S.pos / bl) * bl;
      S.loop.start = st; S.loop.end = st + bl * 4;
    }
    savePrefs(); syncToolbar(); draw();
    if (k === 'loop') restartIfPlaying();
  };
});
$('#bPlay').onclick = () => { if (P && P.recording) return; play(S.mode === 'pat' ? 0 : S.pos); };
$('#bStop').onclick = () => { if (P) stop(); else setPos(0); };
$('#bRec').onclick = () => { if (P && P.recording) stop(); else startRecord(); };
$('#bLiveTune').onclick = cycleLiveTune;
$('#mPat').onclick = () => setMode('pat');
$('#mSong').onclick = () => setMode('song');
$('#bpm').onchange = () => setBpm(+$('#bpm').value);
$('#bHalf').onclick = () => setBpm(S.bpm / 2);
$('#bDbl').onclick = () => setBpm(S.bpm * 2);
$('#keySel').onchange = () => { pushUndo(); S.key = $('#keySel').value || null; if (typeof drawRoll === 'function') drawRoll(); };
$('#patSel').onchange = () => {
  const v = $('#patSel').value;
  if (v === '__new') newPattern(); else { S.curPat = v; }
  syncToolbar();
  if (typeof renderRack === 'function') { renderRack(); drawRoll(); }
};
$('#bUndo').onclick = undo;
$('#bRedo').onclick = redo;
$('#bAddTrack').onclick = () => {
  pushUndo();
  const n = S.tracks.filter((t) => /^Vocal/.test(t.name)).length + 1;
  S.tracks.push(newTrack('Vocal ' + n));
  refreshAll();
  lanes.scrollTop = lanes.scrollHeight;
};
$('#bZoomIn').onclick = () => zoomTo(S.pps * 1.4, posNow() * S.pps - lanes.scrollLeft);
$('#bZoomOut').onclick = () => zoomTo(S.pps / 1.4, posNow() * S.pps - lanes.scrollLeft);

/* ---------- importing ---------- */
function busy(msg) { $('#busyMsg').textContent = msg; $('#busy').classList.add('show'); }
function unbusy() { $('#busy').classList.remove('show'); }
let toastTimer = null;
function toast(msg, ms = 6000) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
async function apiJson(r) {
  let j = null;
  try { j = await r.json(); } catch (e) { /* not json */ }
  if (!r.ok) throw new Error((j && j.detail) || 'Something went wrong (' + r.status + ').');
  return j;
}

async function importYouTube() {
  const url = $('#ytUrl').value.trim();
  if (!url) { toast('Paste a YouTube link into the box first.'); return; }
  await ensureCtx();
  busy('Getting the beat. This can take 20 to 60 seconds...');
  try {
    let buf, info = null, title = 'Beat';
    if (AWAD.local) {
      const j = await apiJson(await fetch('/api/youtube', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) }));
      buf = await fetchBuffer(j.url); info = j; title = j.title;
    } else {
      const r = await pullBeat(url);
      buf = r.buf; title = r.title;
    }
    if (!info || !info.bpm) { busy('Finding the tempo and key...'); info = await analyzeAudio(buf); }
    await placeAudio(buf, info, title);
    $('#ytUrl').value = '';
  } catch (e) { toast(e.message, 9000); }
  unbusy();
}
async function importFile(f) {
  await ensureCtx();
  busy(`Loading ${f.name}...`);
  try {
    let buf;
    try { buf = await AC.decodeAudioData(await f.arrayBuffer()); } catch (e) { throw new Error(`Could not read "${f.name}". Try an MP3 or WAV file.`); }
    busy('Finding the tempo and key...');
    const info = await analyzeAudio(buf);
    await placeAudio(buf, info, f.name.replace(/\.[^.]+$/, ''));
  } catch (e) { toast(e.message, 9000); }
  unbusy();
}
async function fetchBuffer(url, opt) {
  const r = await fetch(url, opt);
  if (!r.ok) throw new Error('Download failed (' + r.status + ').');
  return AC.decodeAudioData(await r.arrayBuffer());
}
async function placeAudio(buf, j, title) {
  const id = nid('b'); addBuffer(id, buf);
  if (P) stop();
  pushUndo();
  const first = !S.tracks.some((t) => t.clips.length);
  let msg = `Added "${title}".`;
  if (j.bpm && first) { S.bpm = j.bpm; if (G) applyMaster(G); msg += ` Tempo set to ${j.bpm} BPM.`; }
  else if (j.bpm) msg += ` It is about ${j.bpm} BPM.`;
  if (j.key && (first || !S.key)) { S.key = j.key; msg += ` Key: ${j.key}.`; }
  let t = S.tracks.find((x) => x.name === 'Beat' && !x.clips.length);
  if (!t) {
    t = newTrack(title.slice(0, 24) || 'Audio');
    const vi = S.tracks.findIndex((x) => /^Vocal/.test(x.name));
    if (vi >= 0) S.tracks.splice(vi, 0, t); else S.tracks.push(t);
  }
  let start = 0, offset = 0;
  if (j.bpm && j.firstBeat > 0) {
    const bl = barLen(), fb = j.firstBeat % bl;
    if (fb < 0.15) offset = fb; else start = bl - fb;
  }
  const c = { id: nid('c'), bufs: [id], take: 0, start, offset, dur: buf.duration - offset, fadeIn: 0, fadeOut: 0.02, gain: 1, name: title };
  t.clips.push(c);
  if (first) { S.loop.start = 0; S.loop.end = barLen() * 4; S.mode = 'song'; }
  refreshAll();
  toast(msg + (j.bpm ? ' If the grid looks off from the beat, try the half or double buttons next to BPM.' : ''), 9000);
}
$('#bYt').onclick = importYouTube;
$('#ytUrl').onkeydown = (e) => { if (e.key === 'Enter') importYouTube(); };
$('#bFile').onclick = () => $('#fileIn').click();
$('#fileIn').onchange = async (e) => { for (const f of [...e.target.files]) await importFile(f); e.target.value = ''; };
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  if (e.target.closest && e.target.closest('#rack')) return;
  for (const f of [...e.dataTransfer.files]) await importFile(f);
});

/* ---------- export ---------- */
function encodeWav(chs, sr) {
  const n = chs[0].length, nc = chs.length, buf = new ArrayBuffer(44 + n * nc * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * nc * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nc, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * nc * 2, true); v.setUint16(32, nc * 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * nc * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) {
    const s = clamp(chs[c][i], -1, 1);
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2;
  }
  return buf;
}
function downloadBlob(blob, filename) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob); link.download = filename;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 60000);
}
async function encodeMp3(chs, sr) {
  const enc = new lamejs.Mp3Encoder(2, sr, 256), parts = [];
  const toI16 = (f) => { const o = new Int16Array(f.length); for (let i = 0; i < f.length; i++) { const v = clamp(f[i], -1, 1); o[i] = v < 0 ? v * 0x8000 : v * 0x7fff; } return o; };
  const L = toI16(chs[0]), R = toI16(chs[1]), block = 1152 * 16;
  for (let i = 0; i < L.length; i += block) {
    const b = enc.encodeBuffer(L.subarray(i, i + block), R.subarray(i, i + block));
    if (b.length) parts.push(new Uint8Array(b));
    if ((i / block) % 40 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  const e = enc.flush();
  if (e.length) parts.push(new Uint8Array(e));
  return new Blob(parts, { type: 'audio/mpeg' });
}
/* Renders the song (or part of it) through the full mixer. onlyTrack renders one track alone. */
async function renderMix(a, b, opt = {}) {
  await ensureSounds();
  const sr = opt.sr || 44100;
  const tail = opt.noTail ? 0 : 1.5;
  const oc = new OfflineAudioContext(2, Math.max(1, Math.ceil((b - a + tail) * sr)), sr);
  const og = buildGraph(oc, oc.destination, false);
  for (const t of S.tracks) {
    if (opt.onlyTrack ? t.id !== opt.onlyTrack : !audible(t)) continue;
    const s = getStrip(og, t);
    if (opt.onlyTrack) s.vol.gain.value = t.vol;
    for (const c of t.clips) {
      if (c.kind === 'pat') schedPatClip(og, t, c, -a, a, b, null);
      else scheduleClip(oc, s.input, c, 0, a, b, null);
    }
  }
  return oc.startRendering();
}
function masterProcess(chs, sr) {
  // loudness up to a modern level, then a look-ahead limiter at -1 dB
  let sum = 0, n = 0;
  for (const ch of chs) for (let i = 0; i < ch.length; i += 4) { sum += ch[i] * ch[i]; n++; }
  const rms = Math.sqrt(sum / Math.max(1, n));
  if (rms > 1e-5) {
    const gain = Math.min(6, dbToGain(-12) / rms);
    for (const ch of chs) for (let i = 0; i < ch.length; i++) ch[i] *= gain;
  }
  const ceil = dbToGain(-1), len = chs[0].length, look = Math.round(sr * 0.005), rel = Math.exp(-1 / (sr * 0.08));
  const need = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let pk = 0;
    for (const ch of chs) { const v = Math.abs(ch[i]); if (v > pk) pk = v; }
    need[i] = pk > ceil ? ceil / pk : 1;
  }
  const gr = new Float32Array(len);
  const att = Math.exp(-1 / (sr * 0.0015));
  let env = 1, qh = 0;
  const q = new Int32Array(len + look + 1);
  let qt = 0;
  // running minimum of the needed gain over the look-ahead window, smoothed
  for (let i = 0; i < len; i++) {
    const j = Math.min(len - 1, i + look);
    while (qt > qh && need[q[qt - 1]] >= need[j]) qt--;
    q[qt++] = j;
    while (q[qh] < i) qh++;
    const target = need[q[qh]];
    env = target < env ? env * att + (1 - att) * target : env * rel + (1 - rel) * target;
    gr[i] = Math.min(env, need[i]);
  }
  for (const ch of chs) for (let i = 0; i < len; i++) ch[i] *= gr[i];
}
async function exportSong() {
  const fmt = $('#expFmt').value, range = $('#expRange').value, name = $('#expName').value.trim() || 'My song';
  const [a, b] = range === 'loop' ? [S.loop.start, S.loop.end] : [0, songEnd()];
  if (b - a < 0.1) { toast('There is nothing to export yet.'); return; }
  $('#dExport').close();
  if (P) stop();
  busy(`Mixing your song. This takes about ${Math.max(5, Math.round((b - a) / 3.3))} seconds...`);
  try {
    const sr = 44100, out = await renderMix(a, b, { sr });
    const chs = [out.getChannelData(0), out.getChannelData(1)];
    // trim silent tail
    let end = chs[0].length;
    while (end > (b - a) * sr && Math.abs(chs[0][end - 1]) < 1e-4 && Math.abs(chs[1][end - 1]) < 1e-4) end--;
    const cut = chs.map((c) => c.slice(0, end));
    if (S.master.auto) { busy('Mastering...'); await new Promise((r) => setTimeout(r, 30)); masterProcess(cut, sr); }
    else {
      let peak = 0;
      for (const ch of cut) for (let i = 0; i < ch.length; i++) { const x = Math.abs(ch[i]); if (x > peak) peak = x; }
      if (peak > 0.98) { const k = 0.98 / peak; for (const ch of cut) for (let i = 0; i < ch.length; i++) ch[i] *= k; }
    }
    busy(fmt === 'mp3' ? 'Making the MP3...' : 'Saving...');
    await new Promise((r) => setTimeout(r, 30));
    const blob = fmt === 'mp3' ? await encodeMp3(cut, sr) : new Blob([encodeWav(cut, sr)], { type: 'audio/wav' });
    downloadBlob(blob, `${name}.${fmt}`);
    toast(`Exported "${name}.${fmt}" to your Downloads folder.`, 8000);
  } catch (e) { toast(e.message || 'Export failed.'); }
  unbusy();
}
$('#bExport').onclick = () => {
  if (!songEnd()) { toast('Add a beat, place a pattern or record something first.'); return; }
  if (S.projectName) $('#expName').value = S.projectName;
  $('#dExport').showModal();
};
$('#bExpCancel').onclick = () => $('#dExport').close();
$('#bExpGo').onclick = exportSong;

/* ---------- settings ---------- */
async function fillDevices() {
  try {
    const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    const sel = $('#micSel');
    sel.innerHTML = '<option value="">Default microphone</option>' +
      list.filter((d) => d.deviceId && d.deviceId !== 'default').map((d) => `<option value="${esc(d.deviceId)}">${esc(d.label || 'Microphone')}</option>`).join('');
    sel.value = S.deviceId || '';
  } catch (e) { /* no device access */ }
}
function updateLatInfo() {
  $('#latMs').value = S.latencyMs != null ? S.latencyMs : '';
  $('#latMs').placeholder = Math.round(autoLatency() * 1000);
  $('#latInfo').textContent = S.latencyMs != null
    ? `Using ${S.latencyMs} ms (set by you or the tap test).`
    : `Using automatic: about ${Math.round(autoLatency() * 1000)} ms. For a Bluetooth headset, run the tap test.`;
}
$('#bSettings').onclick = () => {
  $('#chkMonitor').checked = S.monitor; $('#chkNoise').checked = S.noiseClean; $('#chkRecTuned').checked = S.recTuned;
  fillDevices(); updateLatInfo(); $('#tapRes').textContent = '';
  $('#dSettings').showModal();
};
$('#bCloseSettings').onclick = () => $('#dSettings').close();
$('#micSel').onchange = async () => {
  S.deviceId = $('#micSel').value; savePrefs();
  closeMic();
  try { await ensureMic(); toast('Microphone switched.'); } catch (e) { toast('Could not open that microphone.'); }
};
$('#chkMonitor').onchange = () => { S.monitor = $('#chkMonitor').checked; savePrefs(); if (mic) mic.monitor.gain.value = S.monitor ? 1 : 0; };
$('#chkRecTuned').onchange = async () => {
  S.recTuned = $('#chkRecTuned').checked; savePrefs();
  if (mic) { closeMic(); try { await ensureMic(); } catch (e) { /* reported on record */ } }
};
$('#chkNoise').onchange = async () => {
  S.noiseClean = $('#chkNoise').checked; savePrefs();
  if (mic) { closeMic(); try { await ensureMic(); } catch (e) { /* reported on record */ } }
};
$('#latMs').onchange = () => {
  const v = $('#latMs').value.trim();
  S.latencyMs = v === '' ? null : clamp(Math.round(+v), 0, 800);
  savePrefs(); updateLatInfo();
};
$('#bLatAuto').onclick = () => { S.latencyMs = null; savePrefs(); updateLatInfo(); };
$('#bTap').onclick = tapTest;

/* ---------- keyboard ---------- */
window.addEventListener('keydown', (e) => {
  const tag = e.target.tagName, type = e.target.type;
  if ((tag === 'INPUT' && !['range', 'checkbox'].includes(type)) || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (document.querySelector('dialog[open]')) return;
  const k = e.key.toLowerCase();
  if (e.ctrlKey && k === 's') { e.preventDefault(); saveProject(); return; }
  if (e.ctrlKey && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (e.ctrlKey && k === 'y') { e.preventDefault(); redo(); return; }
  if (e.ctrlKey && k === 'd') { e.preventDefault(); dupSel(); return; }
  if (e.key === 'F6') { e.preventDefault(); toggleDock('rack'); return; }
  if (e.key === 'F7') { e.preventDefault(); toggleDock('roll'); return; }
  if (e.key === 'F9') { e.preventDefault(); toggleDock('mixer'); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (S.typePiano && !e.repeat && typeof pianoKeyDown === 'function' && pianoKeyDown(k)) { e.preventDefault(); return; }
  if (e.code === 'Space') { e.preventDefault(); if (document.activeElement) document.activeElement.blur(); if (P && P.recording) stop(); else togglePlay(); }
  else if (k === 'r') { if (P && P.recording) stop(); else startRecord(); }
  else if (k === 'l') document.querySelector('[data-tg=loop]').click();
  else if (k === 'm') document.querySelector('[data-tg=metro]').click();
  else if (k === 'p') setMode(S.mode === 'pat' ? 'song' : 'pat');
  else if (k === 's') splitSel();
  else if (k === 'delete' || k === 'backspace') { if (typeof rollDeleteSelected === 'function' && rollDeleteSelected()) return; delSel(); }
  else if (k === 'home') setPos(0);
  else if (k === '=' || k === '+') $('#bZoomIn').click();
  else if (k === '-') $('#bZoomOut').click();
});
window.addEventListener('keyup', (e) => { if (S.typePiano && typeof pianoKeyUp === 'function') pianoKeyUp(e.key.toLowerCase()); });

/* ---------- animation loop ---------- */
const mm = $('#mmeter').getContext('2d');
const tbuf = new Float32Array(1024);
let mPeak = 0, iPeak = 0;
function peakOf(an) {
  const n = Math.min(tbuf.length, an.fftSize), b = n === tbuf.length ? tbuf : tbuf.subarray(0, n);
  an.getFloatTimeDomainData(b);
  let p = 0; for (let i = 0; i < n; i++) { const v = Math.abs(b[i]); if (v > p) p = v; }
  return p;
}
function meterColor(v) { return v > 0.95 ? '#e0524a' : v > 0.7 ? '#d8c860' : '#5fb3a8'; }
function frame() {
  if (P) {
    if (!P.patMode) {
      const x = posNow() * S.pps, W = lanes.clientWidth;
      if (x > lanes.scrollLeft + W - 40 || x < lanes.scrollLeft) lanes.scrollLeft = Math.max(0, x - 60);
    }
    draw();
  }
  const p = posNow(), bl = barLen();
  $('#tBars').textContent = `${Math.floor(p / bl) + 1}.${Math.floor((p % bl) / beatLen()) + 1}`;
  const m = Math.floor(p / 60), s = p - m * 60;
  $('#tClock').textContent = `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
  if (masterAn) {
    mPeak = Math.max(peakOf(masterAn), mPeak * 0.92);
    mm.fillStyle = '#0f1113'; mm.fillRect(0, 0, 90, 10);
    mm.fillStyle = meterColor(mPeak); mm.fillRect(0, 0, Math.min(1, mPeak) * 90, 10);
  }
  const im = document.querySelector('.imeter');
  if (im && mic) {
    iPeak = Math.max(peakOf(mic.analyser), iPeak * 0.9);
    const c = im.getContext('2d'), h = Math.min(1, iPeak) * 40;
    c.fillStyle = '#0f1113'; c.fillRect(0, 0, 6, 40);
    c.fillStyle = meterColor(iPeak); c.fillRect(0, 40 - h, 6, h);
  }
  if (mic && mic.sentKey !== S.key) sendTune();
  updateTuneInfo();
  if (typeof frameDock === 'function') frameDock();
  requestAnimationFrame(frame);
}
