// Captures raw mic samples with exact frame positions so takes line up with the beat.
class AwadRec extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.buf = new Float32Array(4096);
    this.n = 0;
    this.frame = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'start') { this.on = true; this.n = 0; }
      else if (e.data === 'stop') {
        if (this.on) this.flush();
        this.on = false;
        this.port.postMessage({ type: 'done' });
      }
    };
  }
  flush() {
    if (this.n > 0) {
      this.port.postMessage({ type: 'data', frame: this.frame, data: this.buf.slice(0, this.n) });
      this.n = 0;
    }
  }
  process(inputs) {
    if (!this.on) return true;
    const ch = inputs[0] && inputs[0][0];
    const len = ch ? ch.length : 128;
    if (this.n === 0) this.frame = currentFrame;
    for (let i = 0; i < len; i++) {
      this.buf[this.n++] = ch ? ch[i] : 0;
      if (this.n === this.buf.length) { this.flush(); this.frame = currentFrame + i + 1; }
    }
    return true;
  }
}
registerProcessor('awad-rec', AwadRec);

// Live auto-tune: YIN pitch detection + low-latency two-tap delay-line pitch shifter.
class AwadTune extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.mode = 'off';
    this.allowed = new Array(12).fill(true);
    this.N = 8192; this.buf = new Float32Array(this.N); this.w = 0;
    this.win = Math.round(sampleRate * 0.035);
    this.p = 0.5; this.ratio = 1; this.target = 1; this.lastNote = null;
    this.k = 1 - Math.exp(-1 / (0.003 * sampleRate));
    // analysis runs at half the sample rate to save CPU
    this.dsr = sampleRate / 2; this.A = 1024; this.abuf = new Float32Array(this.A); this.aw = 0;
    this.dec = 0; this.decPrev = 0; this.hop = 0;
    this.W = Math.round(this.dsr * 0.018);
    this.maxLag = Math.min(this.A - this.W - 2, Math.floor(this.dsr / 70));
    this.minLag = Math.max(2, Math.floor(this.dsr / 1000));
    this.d = new Float32Array(this.maxLag + 2);
    this.lin = new Float32Array(this.W + this.maxLag + 2);
    const apply = (m) => {
      if (m.allowed) this.allowed = m.allowed;
      if (m.mode) {
        this.mode = m.mode;
        this.k = 1 - Math.exp(-1 / ((m.mode === 'hard' ? 0.003 : 0.06) * sampleRate));
      }
    };
    if (options && options.processorOptions) apply(options.processorOptions);
    this.port.onmessage = (e) => apply(e.data);
  }
  detect() {
    const W = this.W, L = W + this.maxLag + 1, x = this.lin, A = this.A;
    const start = (this.aw - L + A * 4) % A;
    for (let i = 0; i < L; i++) x[i] = this.abuf[(start + i) % A];
    let e = 0;
    for (let i = 0; i < W; i++) e += x[i] * x[i];
    this.lastE = e / W;
    if (e / W < 2e-5) return 0;
    const d = this.d;
    let run = 0;
    d[0] = 1;
    for (let tau = 1; tau <= this.maxLag; tau++) {
      let s = 0;
      for (let j = 0; j < W; j++) { const df = x[j] - x[j + tau]; s += df * df; }
      run += s;
      d[tau] = run > 0 ? (s * tau) / run : 1;
    }
    let best = -1;
    for (let tau = this.minLag; tau < this.maxLag; tau++) {
      if (d[tau] < 0.15) {
        while (tau + 1 < this.maxLag && d[tau + 1] < d[tau]) tau++;
        best = tau; break;
      }
    }
    if (best < 1) return 0;
    const a = d[best - 1], b = d[best], c = d[best + 1], den = a - 2 * b + c;
    const shift = den ? (0.5 * (a - c)) / den : 0;
    return this.dsr / (best + shift);
  }
  updateTarget() {
    this.updateNote();
    this.statN = (this.statN || 0) + 1;
    if (this.statN % 18 === 0) {
      this.port.postMessage({ type: 'pitch', midi: this.lastMidi, note: this.lastNote, level: this.lastE || 0, ratio: this.ratio });
    }
  }
  updateNote() {
    const f = this.detect();
    this.lastMidi = f > 0 ? 69 + 12 * Math.log2(f / 440) : null;
    if (f <= 0) { this.target = 1; this.lastNote = null; return; }
    const midi = 69 + 12 * Math.log2(f / 440);
    let note = null;
    if (this.lastNote != null && Math.abs(this.lastNote - midi) < 0.65) note = this.lastNote;
    else {
      let bd = 99;
      for (let c = Math.round(midi) - 2; c <= Math.round(midi) + 2; c++) {
        if (!this.allowed[((c % 12) + 12) % 12]) continue;
        const dd = Math.abs(c - midi);
        if (dd < bd) { bd = dd; note = c; }
      }
    }
    if (note == null) { this.target = 1; return; }
    this.lastNote = note;
    let semis = note - midi;
    if (this.mode === 'natural') semis *= 0.75;
    this.target = Math.pow(2, semis / 12);
  }
  read(d) {
    let pos = this.w - d;
    while (pos < 0) pos += this.N;
    const i = Math.floor(pos), f = pos - i, a = this.buf[i], b = this.buf[(i + 1) % this.N];
    return a + (b - a) * f;
  }
  process(inputs, outputs) {
    const inp = inputs[0] && inputs[0][0], out = outputs[0] && outputs[0][0];
    if (!out) return true;
    if (!inp) { out.fill(0); return true; }
    if (this.mode === 'off') { out.set(inp); return true; }
    for (let i = 0; i < inp.length; i++) {
      const s = inp[i];
      this.buf[this.w] = s;
      if (this.dec) { this.abuf[this.aw] = (s + this.decPrev) * 0.5; this.aw = (this.aw + 1) % this.A; this.dec = 0; }
      else { this.decPrev = s; this.dec = 1; }
      if (++this.hop >= 256) { this.hop = 0; this.updateTarget(); }
      this.ratio += (this.target - this.ratio) * this.k;
      const r = this.ratio;
      if (Math.abs(1 - r) < 0.0015) this.p += (0.5 - this.p) * 0.0002; // settle on one clean tap
      else this.p += (1 - r) / this.win;
      if (this.p >= 1) this.p -= 1; else if (this.p < 0) this.p += 1;
      const p2 = this.p >= 0.5 ? this.p - 0.5 : this.p + 0.5;
      const g1 = 1 - Math.abs(2 * this.p - 1), g2 = 1 - Math.abs(2 * p2 - 1);
      out[i] = g1 * this.read(this.p * this.win + 2) + g2 * this.read(p2 * this.win + 2);
      this.w = (this.w + 1) % this.N;
    }
    return true;
  }
}
registerProcessor('awad-tune', AwadTune);
