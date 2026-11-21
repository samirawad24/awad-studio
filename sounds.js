'use strict';
/* Awad Studio sounds: music theory, synthesized drum kits, synth instruments. */

/* ---------- music theory ---------- */
const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const ROOTS = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
const SCALES = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] };
const ALL_KEYS = [];
for (const n of NOTE_NAMES) { ALL_KEYS.push(n + ' minor'); ALL_KEYS.push(n + ' major'); }

function parseKey(k) {
  if (!k) return null;
  const [r, m] = k.split(' ');
  if (!(r in ROOTS)) return null;
  return { root: ROOTS[r], mode: m === 'major' ? 'major' : 'minor' };
}
function noteName(midi) { return NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1); }
function inScale(midi, key) {
  const k = parseKey(key);
  if (!k) return true;
  return SCALES[k.mode].includes(((midi - k.root) % 12 + 12) % 12);
}
/* diatonic chord: degree 0..6 in the key, octave base midi, sevenths optional */
function chordNotes(key, degree, base, seventh) {
  const k = parseKey(key) || { root: 0, mode: 'minor' };
  const sc = SCALES[k.mode];
  const out = [];
  const count = seventh ? 4 : 3;
  for (let i = 0; i < count; i++) {
    const d = degree + i * 2;
    const oct = Math.floor(d / 7);
    out.push(base + k.root + sc[d % 7] + oct * 12);
  }
  return out;
}
/* mood progressions as scale degrees, chosen per mode so the mood is right */
const MOODS = {
  Sad: { minor: [0, 5, 2, 6], major: [5, 3, 0, 4], seventh: false },
  Dark: { minor: [0, 3, 5, 4], major: [5, 1, 3, 4], seventh: false },
  Hype: { minor: [0, 0, 5, 6], major: [5, 5, 3, 4], seventh: false },
  Chill: { minor: [3, 6, 2, 5], major: [1, 4, 0, 5], seventh: true },
  Happy: { minor: [2, 6, 5, 6], major: [0, 4, 5, 3], seventh: false },
  Dreamy: { minor: [5, 2, 6, 0], major: [0, 3, 5, 3], seventh: true },
};

/* ---------- drum kits (all sounds are synthesized, no samples needed) ---------- */
const DRUM_SOUNDS = ['kick', 'snare', 'clap', 'hat', 'openhat', 'rim', 'perc', 'shaker', 'crash'];
const DRUM_LABELS = { kick: 'Kick', snare: 'Snare', clap: 'Clap', hat: 'Hi-hat', openhat: 'Open hat', rim: 'Rim', perc: 'Perc', shaker: 'Shaker', crash: 'Crash' };
const KITS = {
  trap: { label: 'Trap', kick: { f0: 160, f1: 48, sweep: 0.06, dec: 0.45, click: 0.5, drive: 1.6 }, snare: { tone: 190, noise: 0.8, dec: 0.18, bp: 2500 }, clap: { dec: 0.22, bp: 1300 }, hat: { dec: 0.045, hp: 8000 }, openhat: { dec: 0.32, hp: 7000 }, rim: { f: 900 }, perc: { f0: 420, f1: 300, dec: 0.18 }, shaker: { dec: 0.08 }, crash: { dec: 1.6 } },
  drill: { label: 'Drill', kick: { f0: 140, f1: 52, sweep: 0.04, dec: 0.28, click: 0.7, drive: 1.3 }, snare: { tone: 230, noise: 0.9, dec: 0.15, bp: 3200 }, clap: { dec: 0.16, bp: 1600 }, hat: { dec: 0.035, hp: 9000 }, openhat: { dec: 0.25, hp: 8000 }, rim: { f: 1100 }, perc: { f0: 600, f1: 450, dec: 0.12 }, shaker: { dec: 0.06 }, crash: { dec: 1.3 } },
  boombap: { label: 'Boom bap', kick: { f0: 120, f1: 55, sweep: 0.05, dec: 0.32, click: 0.3, drive: 1.1, lp: 4000 }, snare: { tone: 170, noise: 0.7, dec: 0.22, bp: 1800, lp: 6000 }, clap: { dec: 0.2, bp: 1100, lp: 6000 }, hat: { dec: 0.06, hp: 6000, lp: 9000 }, openhat: { dec: 0.28, hp: 5500, lp: 9000 }, rim: { f: 750 }, perc: { f0: 320, f1: 240, dec: 0.2 }, shaker: { dec: 0.09 }, crash: { dec: 1.2 } },
  reggaeton: { label: 'Reggaeton', kick: { f0: 150, f1: 50, sweep: 0.05, dec: 0.33, click: 0.6, drive: 1.4 }, snare: { tone: 210, noise: 0.85, dec: 0.14, bp: 2800 }, clap: { dec: 0.18, bp: 1500 }, hat: { dec: 0.04, hp: 8500 }, openhat: { dec: 0.22, hp: 7500 }, rim: { f: 1000 }, perc: { f0: 500, f1: 380, dec: 0.14 }, shaker: { dec: 0.07 }, crash: { dec: 1.4 } },
  rnb: { label: 'R&B', kick: { f0: 110, f1: 50, sweep: 0.06, dec: 0.4, click: 0.2, drive: 1.0, lp: 5000 }, snare: { tone: 180, noise: 0.6, dec: 0.2, bp: 2000, lp: 8000 }, clap: { dec: 0.25, bp: 1200, lp: 8000 }, hat: { dec: 0.05, hp: 7000, lp: 12000 }, openhat: { dec: 0.3, hp: 6500 }, rim: { f: 850 }, perc: { f0: 380, f1: 280, dec: 0.2 }, shaker: { dec: 0.1 }, crash: { dec: 1.5 } },
};
const drumCache = new Map();
const drumPending = new Map();

function noiseBuffer(ac, sec) {
  const b = ac.createBuffer(1, Math.ceil(ac.sampleRate * sec), ac.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}
function envGain(ac, t, peak, dec, attack = 0.001) {
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + dec);
  return g;
}
function driveCurve(amount) {
  const n = 1024, c = new Float32Array(n), k = amount;
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(x * k) / Math.tanh(k); }
  return c;
}

function buildDrum(oc, kitName, sound) {
  const kit = KITS[kitName] || KITS.trap, p = kit[sound], t = 0.005;
  let out = oc.createGain();
  out.gain.value = 0.68;
  if (p && p.lp) { const lp = oc.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = p.lp; out.connect(lp); lp.connect(oc.destination); }
  else out.connect(oc.destination);
  const noise = (sec) => { const s = oc.createBufferSource(); s.buffer = noiseBuffer(oc, sec); return s; };
  if (sound === 'kick') {
    const o = oc.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(p.f0, t); o.frequency.exponentialRampToValueAtTime(p.f1, t + p.sweep);
    const g = envGain(oc, t, 1, p.dec);
    const ws = oc.createWaveShaper(); ws.curve = driveCurve(p.drive);
    o.connect(g); g.connect(ws); ws.connect(out); o.start(t); o.stop(t + p.dec + 0.05);
    const n = noise(0.02), ng = envGain(oc, t, p.click * 0.5, 0.012), hp = oc.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 1500; n.connect(hp); hp.connect(ng); ng.connect(out); n.start(t);
  } else if (sound === 'snare') {
    const o = oc.createOscillator(); o.type = 'triangle';
    o.frequency.setValueAtTime(p.tone * 1.4, t); o.frequency.exponentialRampToValueAtTime(p.tone, t + 0.03);
    const og = envGain(oc, t, 0.7, p.dec * 0.6); o.connect(og); og.connect(out); o.start(t); o.stop(t + p.dec);
    const n = noise(p.dec + 0.05), bp = oc.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = p.bp; bp.Q.value = 0.7;
    const ng = envGain(oc, t, p.noise, p.dec); n.connect(bp); bp.connect(ng); ng.connect(out); n.start(t);
  } else if (sound === 'clap') {
    const bp = oc.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = p.bp; bp.Q.value = 0.9; bp.connect(out);
    [0, 0.011, 0.022].forEach((d, i) => {
      const n = noise(0.03), g = envGain(oc, t + d, 0.8, i === 2 ? p.dec : 0.012);
      n.connect(g); g.connect(bp); n.start(t + d);
    });
    const tail = noise(p.dec + 0.1), tg = envGain(oc, t + 0.022, 0.5, p.dec); tail.connect(tg); tg.connect(bp); tail.start(t + 0.022);
  } else if (sound === 'hat' || sound === 'openhat' || sound === 'shaker' || sound === 'crash') {
    const hp = oc.createBiquadFilter(); hp.type = 'highpass';
    hp.frequency.value = sound === 'shaker' ? 5000 : sound === 'crash' ? 4000 : p.hp;
    const n = noise(p.dec + 0.1);
    const g = envGain(oc, t, sound === 'crash' ? 0.5 : 0.6, p.dec, sound === 'shaker' ? 0.02 : 0.001);
    n.connect(hp); hp.connect(g); g.connect(out); n.start(t);
    if (sound !== 'shaker') {
      // metallic partials
      [1, 1.47, 1.62, 2.1].forEach((r) => {
        const o = oc.createOscillator(); o.type = 'square'; o.frequency.value = 3200 * r;
        const og = envGain(oc, t, 0.06, p.dec * 0.8); const h2 = oc.createBiquadFilter(); h2.type = 'highpass'; h2.frequency.value = 7000;
        o.connect(h2); h2.connect(og); og.connect(out); o.start(t); o.stop(t + p.dec + 0.05);
      });
    }
  } else if (sound === 'rim') {
    const o = oc.createOscillator(); o.type = 'square'; o.frequency.value = p.f;
    const bp = oc.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = p.f * 1.5;
    const g = envGain(oc, t, 0.6, 0.04); o.connect(bp); bp.connect(g); g.connect(out); o.start(t); o.stop(t + 0.08);
  } else if (sound === 'perc') {
    const o = oc.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(p.f0, t); o.frequency.exponentialRampToValueAtTime(p.f1, t + 0.05);
    const g = envGain(oc, t, 0.8, p.dec); o.connect(g); g.connect(out); o.start(t); o.stop(t + p.dec + 0.05);
  }
}
function drumKey(kit, sound) { return kit + ':' + sound; }
function loadDrum(kit, sound) {
  const k = drumKey(kit, sound);
  if (drumCache.has(k)) return Promise.resolve(drumCache.get(k));
  if (drumPending.has(k)) return drumPending.get(k);
  const len = sound === 'crash' ? 2 : 0.8;
  const oc = new OfflineAudioContext(1, Math.ceil(44100 * len), 44100);
  buildDrum(oc, kit, sound);
  const pr = oc.startRendering().then((b) => { drumCache.set(k, b); drumPending.delete(k); return b; });
  drumPending.set(k, pr);
  return pr;
}

/* gentle saturation that keeps quiet parts at the same level */
function satCurve(k) {
  const n = 1024, c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(x * k) / k; }
  return c;
}

/* ---------- synth instruments ---------- */
const SYNTHS = {
  '808': '808 bass', bass: 'Bass', keys: 'Electric piano', piano: 'Piano', pad: 'Pad', pluck: 'Pluck',
  bell: 'Bell', lead: 'Lead', strings: 'Strings',
};
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

/* Plays one note. Works on live and offline contexts. Returns the sources so they can be stopped. */
function playNote(ac, dest, preset, midi, when, dur, vel) {
  const f = mtof(midi), srcs = [];
  const amp = ac.createGain(); amp.connect(dest);
  const osc = (type, freq, detune = 0) => {
    const o = ac.createOscillator(); o.type = type; o.frequency.value = freq; o.detune.value = detune; srcs.push(o); return o;
  };
  const start = (rel) => { for (const o of srcs) { o.start(when); o.stop(when + dur + rel + 0.05); } };
  const g = amp.gain, v = Math.max(0.05, vel);
  g.setValueAtTime(0.0001, when);
  if (preset === '808') {
    const o = osc('sine', f);
    o.frequency.setValueAtTime(f * 1.9, when);
    o.frequency.exponentialRampToValueAtTime(f, when + 0.045);
    const ws = ac.createWaveShaper(); ws.curve = driveCurve(1.8);
    o.connect(ws); ws.connect(amp);
    g.exponentialRampToValueAtTime(0.29 * v, when + 0.004);
    g.setTargetAtTime(0.14 * v, when + 0.05, 0.6);
    g.setTargetAtTime(0.0001, when + dur, 0.08);
    start(0.4);
  } else if (preset === 'bass') {
    const a = osc('sawtooth', f), b = osc('square', f / 2);
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 4;
    lp.frequency.setValueAtTime(1800, when); lp.frequency.exponentialRampToValueAtTime(350, when + 0.25);
    const bg = ac.createGain(); bg.gain.value = 0.5;
    a.connect(lp); b.connect(bg); bg.connect(lp); lp.connect(amp);
    g.exponentialRampToValueAtTime(0.3 * v, when + 0.005);
    g.setTargetAtTime(0.2 * v, when + 0.02, 0.15);
    g.setTargetAtTime(0.0001, when + dur, 0.05);
    start(0.3);
  } else if (preset === 'keys' || preset === 'bell') {
    const ratio = preset === 'bell' ? 3.5 : 1, depth = preset === 'bell' ? f * 2.5 : f * 1.2;
    const car = osc('sine', f), mod = osc('sine', f * ratio);
    const mg = ac.createGain();
    mg.gain.setValueAtTime(depth, when); mg.gain.exponentialRampToValueAtTime(Math.max(1, depth * 0.08), when + (preset === 'bell' ? 1.2 : 0.6));
    mod.connect(mg); mg.connect(car.frequency); car.connect(amp);
    const decay = preset === 'bell' ? 1.6 : 1.1;
    g.exponentialRampToValueAtTime(0.24 * v, when + 0.004);
    g.setTargetAtTime(0.0001, when + 0.004, decay / 3);
    g.setTargetAtTime(0.0001, when + dur, 0.12);
    start(0.5);
  } else if (preset === 'piano') {
    const parts = [[1, 0.5, 'triangle'], [2, 0.18, 'sine'], [3, 0.08, 'sine'], [4, 0.04, 'sine']];
    for (const [h, a, type] of parts) { const o = osc(type, f * h, h === 1 ? 0 : 2); const og = ac.createGain(); og.gain.value = a; o.connect(og); og.connect(amp); }
    const lp = ac.createBiquadFilter();
    g.exponentialRampToValueAtTime(0.34 * v, when + 0.003);
    g.setTargetAtTime(0.0001, when + 0.003, 0.9);
    g.setTargetAtTime(0.0001, when + dur, 0.15);
    void lp;
    start(0.6);
  } else if (preset === 'pad' || preset === 'strings') {
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = preset === 'pad' ? 1400 : 2600; lp.Q.value = 0.5;
    for (const d of [-9, 0, 9]) { const o = osc('sawtooth', f, d); o.connect(lp); }
    if (preset === 'pad') { const s = osc('sine', f / 2); const sg = ac.createGain(); sg.gain.value = 0.6; s.connect(sg); sg.connect(lp); }
    lp.connect(amp);
    const atk = preset === 'pad' ? 0.35 : 0.18;
    g.linearRampToValueAtTime(0.11 * v, when + atk);
    g.setValueAtTime(0.11 * v, when + Math.max(atk, dur));
    g.setTargetAtTime(0.0001, when + Math.max(atk, dur), 0.3);
    start(1.4);
  } else if (preset === 'pluck') {
    const a = osc('sawtooth', f), b = osc('square', f, 7);
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 2;
    lp.frequency.setValueAtTime(5000, when); lp.frequency.exponentialRampToValueAtTime(400, when + 0.25);
    a.connect(lp); b.connect(lp); lp.connect(amp);
    g.exponentialRampToValueAtTime(0.22 * v, when + 0.003);
    g.setTargetAtTime(0.0001, when + 0.003, 0.18);
    g.setTargetAtTime(0.0001, when + dur, 0.05);
    start(0.4);
  } else { // lead
    const a = osc('sawtooth', f, -6), b = osc('square', f, 6);
    const lfo = osc('sine', 5.5); const lg = ac.createGain(); lg.gain.value = 9; lfo.connect(lg); lg.connect(a.detune); lg.connect(b.detune);
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200;
    a.connect(lp); b.connect(lp); lp.connect(amp);
    g.exponentialRampToValueAtTime(0.14 * v, when + 0.01);
    g.setValueAtTime(0.14 * v, when + dur);
    g.setTargetAtTime(0.0001, when + dur, 0.08);
    start(0.4);
  }
  return srcs;
}

/* ---------- reverb impulse ---------- */
function makeImpulse(ac, sec) {
  const len = Math.ceil(ac.sampleRate * sec), b = ac.createBuffer(2, len, ac.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
  }
  return b;
}
