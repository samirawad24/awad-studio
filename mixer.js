'use strict';
/* Awad Studio mixer: strips, effects, presets, auto mix, master. */

const FX_PRESETS = {
  'none': { hp: 20, lp: 20000, low: 0, mid: 0, high: 0, sat: 0, comp: 0, rev: 0, dly: 0, dbl: 0 },
  'Clean vocal': { hp: 100, lp: 20000, low: -1, mid: 1, high: 3, sat: 0, comp: 0.5, rev: 0.15, dly: 0, dbl: 0 },
  'Trap vocal': { hp: 120, lp: 20000, low: -1, mid: 1, high: 4, sat: 0.1, comp: 0.7, rev: 0.22, dly: 0.18, dbl: 0.2 },
  'Radio vocal': { hp: 450, lp: 4200, low: 0, mid: 4, high: 0, sat: 0.3, comp: 0.8, rev: 0.05, dly: 0, dbl: 0 },
  'Doubled vocal': { hp: 100, lp: 20000, low: -1, mid: 1, high: 3, sat: 0, comp: 0.55, rev: 0.18, dly: 0, dbl: 0.8 },
  'Ad-libs': { hp: 220, lp: 20000, low: -2, mid: 2, high: 3, sat: 0.1, comp: 0.6, rev: 0.3, dly: 0.3, dbl: 0.3 },
  'Beat': { hp: 20, lp: 20000, low: 0, mid: -1, high: 0, sat: 0, comp: 0.15, rev: 0, dly: 0, dbl: 0 },
  'Drums punch': { hp: 30, lp: 20000, low: 2, mid: 0, high: 2, sat: 0.1, comp: 0.45, rev: 0.05, dly: 0, dbl: 0 },
  '808 warm': { hp: 25, lp: 20000, low: 2, mid: 0, high: 0, sat: 0.35, comp: 0.3, rev: 0, dly: 0, dbl: 0 },
  'Melody wide': { hp: 150, lp: 20000, low: -2, mid: 0, high: 1, sat: 0, comp: 0.2, rev: 0.25, dly: 0.1, dbl: 0.5 },
};
const PRESET_TIPS = {
  'Clean vocal': 'Clear and upfront, a little room sound.',
  'Trap vocal': 'Bright and tight with echo and space. Pair it with Auto-tune on the take.',
  'Radio vocal': 'Thin phone-speaker sound. Good for intros and ad-libs.',
  'Doubled vocal': 'Sounds like two takes stacked, wide in the headphones.',
  'Ad-libs': 'Pushed back with lots of echo so they sit behind the main vocal.',
};
const FX_ROWS = [
  ['hp', 'Low cut', 20, 600, 1, (v) => (v <= 21 ? 'off' : Math.round(v) + ' Hz'), 'Removes rumble and low mud under this sound. Raise it on vocals.'],
  ['low', 'Bass', -12, 12, 0.5, (v) => (v > 0 ? '+' : '') + v + ' dB', 'More or less low end.'],
  ['mid', 'Middle', -12, 12, 0.5, (v) => (v > 0 ? '+' : '') + v + ' dB', 'Body and presence. Cut it if things sound boxy.'],
  ['high', 'Treble', -12, 12, 0.5, (v) => (v > 0 ? '+' : '') + v + ' dB', 'Brightness and air. Boost a little on vocals.'],
  ['comp', 'Compress', 0, 1, 0.01, (v) => Math.round(v * 100) + '%', 'Evens out loud and quiet parts so it sits steady in the mix.'],
  ['sat', 'Warmth', 0, 1, 0.01, (v) => Math.round(v * 100) + '%', 'Adds grit and warmth. Great on 808s.'],
  ['rev', 'Reverb', 0, 1, 0.01, (v) => Math.round(v * 100) + '%', 'Room sound. A little goes a long way.'],
  ['dly', 'Echo', 0, 1, 0.01, (v) => Math.round(v * 100) + '%', 'Repeats in time with the beat.'],
  ['dbl', 'Double', 0, 1, 0.01, (v) => Math.round(v * 100) + '%', 'Makes it wider, like two takes stacked.'],
];
let mixSel = null;

function applyPreset(t, name) {
  t.fx = { ...t.fx, ...FX_PRESETS[name], preset: name };
  if (G) applyStrip(G, t);
}
function renderMixer() {
  const el = $('#mixer');
  if (!el.classList.contains('on')) return;
  if (!S.tracks.find((t) => t.id === mixSel)) mixSel = S.tracks[0] ? S.tracks[0].id : null;
  const presetOpts = (cur) => Object.keys(FX_PRESETS).map((k) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${k === 'none' ? 'No preset' : k}</option>`).join('') + (FX_PRESETS[cur] ? '' : '<option selected>Custom</option>');
  el.innerHTML = `
    <div class="phead">
      <span class="ttl">Mixer</span>
      <button id="mxAuto" class="primary" title="Sets each track's volume and a fitting preset, so vocals sit on top of the beat">Auto mix</button>
      <button id="mxMaster" class="${S.master.auto ? 'on' : ''}" title="Makes the whole song louder and more finished, like a released song. Also used when you export.">Auto master: ${S.master.auto ? 'on' : 'off'}</button>
      <span class="fill"></span>
      <span style="color:var(--muted)">Click a track to change its effects.</span>
    </div>
    <div class="mx-main">
      <div class="mx-strips" id="mxStrips">
        ${S.tracks.map((t) => `
          <div class="strip${t.id === mixSel ? ' sel' : ''}" data-id="${t.id}">
            <div class="sn" style="border-color:${t.color}">${esc(t.name)}</div>
            <select data-act="preset" title="Ready-made sound for this track">${presetOpts(t.fx.preset)}</select>
            <input type="range" data-act="pan" min="-1" max="1" step="0.01" value="${t.pan}" title="Left or right. Double-click to center.">
            <div class="fz"><input type="range" class="fader" data-act="vol" min="0" max="1.5" step="0.01" value="${t.vol}" title="Volume. Double-click to reset."><canvas width="8" height="120" data-meter="${t.id}"></canvas></div>
            <div class="db">${t.vol > 0 ? (20 * Math.log10(t.vol)).toFixed(1) + ' dB' : 'off'}</div>
            <div class="ms"><button class="mute ${t.mute ? 'on' : ''}" data-act="mute">M</button><button class="solo ${t.solo ? 'on' : ''}" data-act="solo">S</button></div>
          </div>`).join('')}
        <div class="strip master" data-id="master">
          <div class="sn" style="border-color:#e8eaed">Master</div>
          <div style="font-size:11px;color:var(--muted)">Everything goes through here</div>
          <div class="fz"><input type="range" class="fader" data-act="mvol" min="0" max="1.5" step="0.01" value="${S.master.vol}" title="Overall volume"><canvas width="8" height="120" data-meter="master"></canvas></div>
          <div class="db">${(20 * Math.log10(Math.max(0.001, S.master.vol))).toFixed(1)} dB</div>
        </div>
      </div>
      <div class="mx-fx" id="mxFx"></div>
    </div>`;
  $('#mxAuto').onclick = autoMix;
  $('#mxMaster').onclick = () => {
    pushUndo(); S.master.auto = !S.master.auto; if (G) applyMaster(G); renderMixer();
    toast(S.master.auto ? 'Auto master on: the song is louder and glued together. Exports get the same treatment.' : 'Auto master off.');
  };
  el.querySelectorAll('.strip').forEach((s) => {
    const id = s.dataset.id;
    if (id === 'master') {
      const mv = s.querySelector('[data-act=mvol]');
      mv.oninput = () => { S.master.vol = +mv.value; S.dirty = true; if (G) applyMaster(G); s.querySelector('.db').textContent = (20 * Math.log10(Math.max(0.001, S.master.vol))).toFixed(1) + ' dB'; };
      mv.ondblclick = () => { S.master.vol = 1; renderMixer(); if (G) applyMaster(G); };
      return;
    }
    const t = S.tracks.find((x) => x.id === id);
    s.onclick = (e) => { if (e.target.closest('input,select,button')) return; mixSel = id; renderMixer(); };
    s.querySelector('[data-act=preset]').onchange = (e) => {
      pushUndo(); applyPreset(t, e.target.value); mixSel = id; renderMixer();
      if (PRESET_TIPS[e.target.value]) toast(e.target.value + ': ' + PRESET_TIPS[e.target.value]);
    };
    const vol = s.querySelector('[data-act=vol]'), pan = s.querySelector('[data-act=pan]');
    vol.oninput = () => { t.vol = +vol.value; S.dirty = true; updateMix(); s.querySelector('.db').textContent = t.vol > 0 ? (20 * Math.log10(t.vol)).toFixed(1) + ' dB' : 'off'; renderHeads(); };
    vol.ondblclick = () => { t.vol = 1; updateMix(); renderMixer(); renderHeads(); };
    pan.oninput = () => { t.pan = +pan.value; S.dirty = true; updateMix(); };
    pan.ondblclick = () => { t.pan = 0; updateMix(); renderMixer(); };
    s.querySelector('[data-act=mute]').onclick = () => { t.mute = !t.mute; updateMix(); renderMixer(); renderHeads(); draw(); };
    s.querySelector('[data-act=solo]').onclick = () => { t.solo = !t.solo; updateMix(); renderMixer(); renderHeads(); draw(); };
  });
  renderFx();
}
function renderFx() {
  const box = $('#mxFx'); if (!box) return;
  const t = S.tracks.find((x) => x.id === mixSel);
  if (!t) { box.innerHTML = '<small>Add a track to use effects.</small>'; return; }
  box.innerHTML = `<h3>Effects on ${esc(t.name)}</h3>` + FX_ROWS.map(([k, label, mn, mx, st, fmt, tip]) =>
    `<div class="fxrow" title="${esc(tip)}"><span>${label}</span><input type="range" data-fx="${k}" min="${mn}" max="${mx}" step="${st}" value="${t.fx[k]}"><span data-val="${k}">${fmt(t.fx[k])}</span></div>`).join('') +
    '<small>Hover a slider name to see what it does. Double-click a slider to reset it.</small>';
  box.querySelectorAll('[data-fx]').forEach((inp) => {
    const k = inp.dataset.fx, row = FX_ROWS.find((r) => r[0] === k);
    inp.onpointerdown = () => pushUndo();
    inp.oninput = () => {
      t.fx[k] = +inp.value; t.fx.preset = 'Custom';
      box.querySelector(`[data-val=${k}]`).textContent = row[5](t.fx[k]);
      if (G) { getStrip(G, t); applyStrip(G, t); }
      const sel = document.querySelector(`.strip[data-id="${t.id}"] [data-act=preset]`);
      if (sel && ![...sel.options].some((o) => o.value === 'Custom')) sel.insertAdjacentHTML('beforeend', '<option>Custom</option>');
      if (sel) sel.value = 'Custom';
    };
    inp.ondblclick = () => { t.fx[k] = FX_PRESETS.none[k]; renderFx(); if (G) applyStrip(G, t); };
  });
}
const mxBuf = new Float32Array(2048);
function drawMixerMeters() {
  if (!G) return;
  document.querySelectorAll('#mxStrips canvas[data-meter]').forEach((c) => {
    const id = c.dataset.meter;
    const an = id === 'master' ? masterAn : (G.strips.get(id) || {}).an;
    if (!an) return;
    an.getFloatTimeDomainData(mxBuf.subarray(0, an.fftSize));
    let pk = 0;
    for (let i = 0; i < an.fftSize; i++) { const v = Math.abs(mxBuf[i]); if (v > pk) pk = v; }
    c._pk = Math.max(pk, (c._pk || 0) * 0.9);
    const g = c.getContext('2d'), h = Math.min(1, c._pk) * c.height;
    g.fillStyle = '#0f1113'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = meterColor(c._pk); g.fillRect(0, c.height - h, c.width, h);
  });
}

/* ---------- auto mix ---------- */
function roleOf(t) {
  const n = t.name.toLowerCase();
  if (/vocal|vox|verse|hook|adlib|ad-lib/.test(n)) return /adlib|ad-lib/.test(n) ? 'adlib' : 'vocal';
  if (/drum|kick|hat|perc/.test(n)) return 'drums';
  if (/808|bass/.test(n)) return '808';
  if (/melod|key|pad|chord|lead|synth/.test(n)) return 'melody';
  if (t.clips.some((c) => c.kind === 'pat')) return 'melody';
  return 'beat';
}
async function autoMix() {
  const used = S.tracks.filter((t) => t.clips.length);
  if (!used.length) { toast('Add a beat or record something first, then Auto mix.'); return; }
  await ensureCtx();
  if (P) stop();
  busy('Listening to each track...');
  pushUndo();
  const ROLE = {
    vocal: { db: -17, preset: 'Clean vocal' }, adlib: { db: -22, preset: 'Ad-libs' }, beat: { db: -20, preset: 'Beat' },
    drums: { db: -21, preset: 'Drums punch' }, '808': { db: -21, preset: '808 warm' }, melody: { db: -25, preset: 'Melody wide' },
  };
  try {
    const end = Math.max(1, songEnd());
    const len = Math.min(end, 40);
    // listen to the busiest part: start from the middle of the song if it is long
    const a = end > 60 ? Math.max(0, end / 2 - 20) : 0;
    for (const t of used) {
      const role = roleOf(t), r = ROLE[role];
      if (!t.fx.preset || t.fx.preset === 'none') applyPreset(t, r.preset);
      const savedVol = t.vol; t.vol = 1;
      const buf = await renderMix(a, a + len, { onlyTrack: t.id, sr: 22050, noTail: true });
      t.vol = savedVol;
      const d = buf.getChannelData(0), d2 = buf.getChannelData(1);
      // loudness of the parts where this track actually plays
      const win = 2205, rms = [];
      for (let i = 0; i + win <= d.length; i += win) {
        let s = 0;
        for (let j = i; j < i + win; j++) s += (d[j] * d[j] + d2[j] * d2[j]) / 2;
        const v = Math.sqrt(s / win);
        if (v > 0.003) rms.push(v);
      }
      if (!rms.length) continue;
      rms.sort((x, y) => x - y);
      const level = rms[Math.floor(rms.length * 0.7)];
      const db = 20 * Math.log10(level);
      t.vol = clamp(dbToGain(r.db - db), 0.1, 1.5);
    }
    updateMix(); renderHeads(); renderMixer();
    toast('Auto mix done. Vocals are set to sit on top of the beat. Fine-tune with the faders if you want.');
  } catch (e) { toast('Auto mix failed: ' + e.message); }
  unbusy();
}
