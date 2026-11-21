'use strict';
/* Awad Studio: tempo, beat phase and key detection that runs in the browser. */

function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}
function hann(n) { const w = new Float32Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n); return w; }
const interpAt = (a, x) => { const i = Math.floor(x); if (i < 0 || i + 1 >= a.length) return 0; const f = x - i; return a[i] * (1 - f) + a[i + 1] * f; };

/* Returns { bpm, firstBeat, key } like the old server analysis. */
async function analyzeAudio(buffer) {
  const sr0 = buffer.sampleRate, nch = buffer.numberOfChannels;
  const dec = Math.max(1, Math.round(sr0 / 11025)), sr = sr0 / dec;
  const used = Math.min(buffer.length, Math.floor(sr0 * 150));
  const n = Math.floor(used / dec), x = new Float32Array(n);
  for (let c = 0; c < nch; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) { let s = 0; const o = i * dec; for (let k = 0; k < dec; k++) s += d[o + k] || 0; x[i] += s / dec / nch; }
  }
  const N = 1024, hop = 256, frames = Math.max(0, Math.floor((n - N) / hop));
  if (frames < 50) return { bpm: null, firstBeat: 0, key: null };
  const fr = sr / hop, w = hann(N), re = new Float32Array(N), im = new Float32Array(N);
  const half = N / 2, prev = new Float32Array(half), flux = new Float32Array(frames), low = new Float32Array(frames);
  const lowBin = Math.round(180 / (sr / N));
  // key: bigger FFT for note resolution
  const NK = 4096, wk = hann(NK), rk = new Float32Array(NK), ik = new Float32Array(NK), chroma = new Float64Array(12);
  const kLo = Math.ceil(90 / (sr / NK)), kHi = Math.floor(2000 / (sr / NK));
  const pcOf = new Int8Array(NK / 2);
  for (let b = 0; b < NK / 2; b++) { const f = (b * sr) / NK; pcOf[b] = f > 0 ? ((Math.round(69 + 12 * Math.log2(f / 440)) % 12) + 12) % 12 : 0; }
  for (let f = 0; f < frames; f++) {
    const o = f * hop;
    for (let i = 0; i < N; i++) { re[i] = x[o + i] * w[i]; im[i] = 0; }
    fftInPlace(re, im);
    let s = 0, sl = 0;
    for (let b = 1; b < half; b++) {
      const m = Math.log1p(10 * Math.hypot(re[b], im[b]));
      const dlt = m - prev[b];
      if (dlt > 0) { s += dlt; if (b <= lowBin) sl += dlt; }
      prev[b] = m;
    }
    flux[f] = s; low[f] = sl;
    if (f % 8 === 0 && o + NK <= n) {
      for (let i = 0; i < NK; i++) { rk[i] = x[o + i] * wk[i]; ik[i] = 0; }
      fftInPlace(rk, ik);
      // each slice counts equally, so loud bass hits do not decide the key alone
      const fc = new Float64Array(12);
      for (let b = kLo; b <= kHi; b++) { const m = Math.hypot(rk[b], ik[b]); fc[pcOf[b]] += m * m; }
      const tot = fc.reduce((q, v) => q + v, 0);
      if (tot > 1e-9) for (let i = 0; i < 12; i++) chroma[i] += Math.sqrt(fc[i] / tot);
    }
    if (f % 2000 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  // remove slow trends so only hits remain
  const env = (a) => {
    const out = new Float32Array(a.length), win = Math.round(fr * 0.4);
    let acc = 0;
    for (let i = 0; i < a.length; i++) {
      acc += a[i]; if (i > win) acc -= a[i - win - 1];
      out[i] = Math.max(0, a[i] - acc / Math.min(i + 1, win + 1));
    }
    return out;
  };
  const E = env(flux), EL = env(low);
  // tempo: comb score over candidate BPMs with a gentle preference near 120
  let best = 0, bestScore = -1;
  for (let bpm = 60; bpm <= 200; bpm += 0.25) {
    const P = (60 / bpm) * fr;
    let sc = 0;
    for (let i = 0; i < frames; i += 2) {
      const e = E[i]; if (!e) continue;
      sc += e * (interpAt(E, i + P) + 0.5 * interpAt(E, i + 2 * P) + 0.5 * interpAt(E, i + 4 * P));
    }
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    sc *= prior;
    if (sc > bestScore) { bestScore = sc; best = bpm; }
  }
  // fine tune around the winner
  let fineBest = best, fineScore = -1;
  for (let bpm = best - 0.5; bpm <= best + 0.5; bpm += 0.05) {
    const P = (60 / bpm) * fr;
    let sc = 0;
    for (let i = 0; i < frames; i++) { const e = E[i]; if (e) for (let k = 1; k <= 8; k++) sc += e * interpAt(E, i + k * P); }
    if (sc > fineScore) { fineScore = sc; fineBest = bpm; }
  }
  let tempo = fineBest;
  while (tempo < 85) tempo *= 2;
  const bpm = Math.abs(tempo - Math.round(tempo)) < 0.6 ? Math.round(tempo) : Math.round(tempo * 10) / 10;
  // beat phase from the low end (kicks)
  const P = (60 / bpm) * fr;
  let bestPh = 0, phScore = -1;
  for (let ph = 0; ph < P; ph += 0.25) {
    let sc = 0;
    for (let t = ph; t < frames; t += P) sc += interpAt(EL, t) + 0.3 * interpAt(E, t);
    if (sc > phScore) { phScore = sc; bestPh = ph; }
  }
  const firstBeat = Math.max(0, (bestPh * hop + N / 2) / sr - 0.5 * hop / sr);
  // key: compare the note profile with major and minor key shapes
  const major = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const minor = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const corr = (a, b) => {
    const ma = a.reduce((s, v) => s + v, 0) / 12, mb = b.reduce((s, v) => s + v, 0) / 12;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < 12; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    return num / Math.sqrt(da * db || 1);
  };
  const score = {};
  let key = null, kBest = -2;
  for (let r = 0; r < 12; r++) {
    for (const [prof, mode] of [[major, 'major'], [minor, 'minor']]) {
      const rot = prof.map((_, i) => prof[(i - r + 12) % 12]);
      const c = corr(Array.from(chroma), rot);
      score[`${r} ${mode}`] = c;
      if (c > kBest) { kBest = c; key = `${NOTE_NAMES[r]} ${mode}`; }
    }
  }
  // same notes, so lean minor when it is close (most rap and trap beats are minor)
  const [kn, km] = key.split(' ');
  if (km === 'major') {
    const rel = (ROOTS[kn] + 9) % 12;
    if (kBest - score[`${rel} minor`] < 0.04) key = `${NOTE_NAMES[rel]} minor`;
  }
  return { bpm, firstBeat, key };
}
