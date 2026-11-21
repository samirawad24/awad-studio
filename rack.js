'use strict';
/* Awad Studio: dock panels, channel rack, piano roll, starter beats, chord helper. */

/* ---------- dock ---------- */
let dockTab = null;
function openDock(tab) {
  dockTab = tab;
  $('#dock').classList.add('open');
  document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('on', p.id === tab));
  document.querySelectorAll('.tabs [data-dock]').forEach((b) => b.classList.toggle('on', b.dataset.dock === tab));
  if (tab === 'rack') renderRack();
  if (tab === 'roll') { renderRollHead(); requestAnimationFrame(() => { centerRoll(); drawRoll(); }); }
  if (tab === 'mixer') renderMixer();
  requestAnimationFrame(draw);
}
function closeDock() {
  dockTab = null;
  $('#dock').classList.remove('open');
  document.querySelectorAll('.tabs [data-dock]').forEach((b) => b.classList.remove('on'));
  requestAnimationFrame(draw);
}
function toggleDock(tab) { if (dockTab === tab) closeDock(); else openDock(tab); }
document.querySelectorAll('.tabs [data-dock]').forEach((b) => { b.onclick = () => toggleDock(b.dataset.dock); });
(() => {
  const grip = $('#dockGrip');
  let y0 = 0, h0 = 0;
  grip.addEventListener('pointerdown', (e) => { y0 = e.clientY; h0 = $('#dock').offsetHeight; grip.setPointerCapture(e.pointerId); });
  grip.addEventListener('pointermove', (e) => {
    if (!grip.hasPointerCapture(e.pointerId)) return;
    $('#dock').style.height = clamp(h0 + (y0 - e.clientY), 160, window.innerHeight * 0.75) + 'px';
    draw(); drawRoll();
  });
})();
window.addEventListener('resize', () => drawRoll());

/* ---------- patterns and channels ---------- */
const PAT_COLORS = ['#d9a05b', '#c9718f', '#6fb0d0', '#8fbd6c', '#a98ad6', '#d47a6a', '#5dbfa6', '#cdbb5c'];
function makePattern(name, bars = 1) {
  return { id: nid('p'), name, color: PAT_COLORS[S.patterns.length % PAT_COLORS.length], bars, swing: 0, steps: {}, notes: {} };
}
function newPattern(name) {
  pushUndo();
  const p = makePattern(name || 'Pattern ' + (S.patterns.length + 1));
  S.patterns.push(p); S.curPat = p.id;
  syncToolbar(); renderRack(); drawRoll();
  return p;
}
function curPattern() {
  let p = patById(S.curPat);
  if (!p && S.patterns.length) { p = S.patterns[0]; S.curPat = p.id; }
  return p;
}
function makeChannel(kind, opt = {}) {
  const ch = { id: nid('ch'), kind, vol: 0.8, pan: 0, mute: false, note: 60, ...opt };
  if (!ch.name) ch.name = kind === 'drum' ? DRUM_LABELS[ch.sound] : kind === 'synth' ? SYNTHS[ch.preset] : 'Sample';
  if (kind === 'synth' && ch.preset === '808') ch.note = 36;
  if (kind === 'synth' && ch.preset === 'bass') ch.note = 36;
  return ch;
}
function defaultChannels() {
  return [
    makeChannel('drum', { sound: 'kick', kit: 'trap' }), makeChannel('drum', { sound: 'clap', kit: 'trap' }),
    makeChannel('drum', { sound: 'hat', kit: 'trap' }), makeChannel('drum', { sound: 'openhat', kit: 'trap' }),
    makeChannel('drum', { sound: 'snare', kit: 'trap' }), makeChannel('synth', { preset: '808' }),
    makeChannel('synth', { preset: 'keys' }),
  ];
}
const curChannel = () => S.channels.find((c) => c.id === S.curCh) || S.channels[0];
function findOrAddChannel(kind, key, kit) {
  let ch = S.channels.find((c) => c.kind === kind && (kind === 'drum' ? c.sound === key : c.preset === key));
  if (!ch) {
    ch = makeChannel(kind, kind === 'drum' ? { sound: key, kit: kit || 'trap' } : { preset: key });
    S.channels.push(ch);
  }
  return ch;
}
function audition(ch, midi, dur = 0.45) {
  ensureCtx().then(async () => {
    if (ch.kind === 'drum') await loadDrum(ch.kit, ch.sound);
    trigger(G, patRouteTrack(S.curPat), { ch: { ...ch, mute: false }, dur, midi: midi ?? (ch.note || 60), vel: 0.85, notes: true }, AC.currentTime + 0.01, dur, null);
  });
}
function setPatBars(p, bars) {
  if (bars === p.bars) return;
  pushUndo();
  const old = p.bars * 16, nw = bars * 16;
  if (bars > p.bars) {
    for (const k in p.steps) {
      const a = p.steps[k], out = [];
      for (let i = 0; i < nw; i++) out[i] = a[i % old] || 0;
      p.steps[k] = out;
    }
    for (const k in p.notes) {
      const src = p.notes[k].filter((n) => n.s < old), out = [];
      for (let r = 0; r < bars / p.bars; r++) for (const n of src) out.push({ ...n, s: n.s + r * old });
      p.notes[k] = out;
    }
  }
  p.bars = bars;
  renderRack(); drawRoll(); draw();
}
function placePatternInSong(p, bars = 8) {
  pushUndo();
  let t = S.tracks.find((x) => x.name === p.name);
  if (!t) {
    t = newTrack(p.name);
    const vi = S.tracks.findIndex((x) => /^Vocal/.test(x.name));
    if (vi >= 0) S.tracks.splice(vi, 0, t); else S.tracks.push(t);
  }
  const bl = barLen(), L = patLenSec(p);
  const end = t.clips.reduce((m, c) => Math.max(m, c.start + c.dur), 0);
  const start = Math.ceil(end / bl - 1e-6) * bl;
  const dur = Math.max(L, Math.round((bars * bl) / L) * L);
  t.clips.push({ id: nid('c'), kind: 'pat', patId: p.id, start, dur, offset: 0 });
  S.mode = 'song';
  refreshAll();
  toast(`Placed "${p.name}" in the song on its own track. Drag the right edge of the clip to make it longer.`);
}

/* ---------- channel rack UI ---------- */
let paint = null;
function renderRack() {
  const el = $('#rack');
  if (!el.classList.contains('on')) return;
  const p = curPattern();
  const kit = (S.channels.find((c) => c.kind === 'drum') || { kit: 'trap' }).kit;
  const addOpts = '<option value="">+ Add sound</option><optgroup label="Drums">' +
    DRUM_SOUNDS.map((s) => `<option value="drum:${s}">${DRUM_LABELS[s]}</option>`).join('') +
    '</optgroup><optgroup label="Instruments">' +
    Object.entries(SYNTHS).map(([k, v]) => `<option value="synth:${k}">${v}</option>`).join('') +
    '</optgroup><option value="sample">Sample from a file...</option>';
  el.innerHTML = `
    <div class="phead">
      <span class="ttl">Channel rack</span>
      ${p ? `<input type="text" id="rkName" value="${esc(p.name)}" spellcheck="false" title="Pattern name" style="width:130px">
      <label title="How long the pattern is before it repeats">Length <select id="rkBars">${[1, 2, 4, 8].map((b) => `<option value="${b}" ${b === p.bars ? 'selected' : ''}>${b} bar${b > 1 ? 's' : ''}</option>`).join('')}</select></label>
      <label title="Pushes every second step a little late for a bouncy, human feel">Swing <input type="range" id="rkSwing" min="0" max="100" value="${Math.round((p.swing || 0) * 100)}" style="width:80px"></label>` : ''}
      <label title="Changes the sound of every drum at once">Kit <select id="rkKit">${Object.entries(KITS).map(([k, v]) => `<option value="${k}" ${k === kit ? 'selected' : ''}>${v.label}</option>`).join('')}</select></label>
      <select id="rkAdd" title="Add another drum or instrument">${addOpts}</select>
      <span class="fill"></span>
      <button id="rkNew" title="Start a new empty pattern">New pattern</button>
      ${p ? `<button id="rkClone" title="Copy this pattern so you can make a variation">Copy</button>
      <button id="rkClear" title="Remove every step and note from this pattern">Clear</button>
      <button id="rkDelPat" title="Delete this pattern and remove it from the song">Delete</button>
      <button id="rkPlace" class="primary" title="Put this pattern in the song for 8 bars">Add to song</button>` : ''}
    </div>
    <div class="rk-body" id="rkBody"></div>`;
  const body = $('#rkBody');
  if (!p) {
    body.innerHTML = '<div class="rk-empty">No pattern yet. Click New pattern, or Starter beat at the top to get a full beat made for you.</div>';
  } else {
    const total = p.bars * 16;
    body.innerHTML = S.channels.map((ch) => {
      const hasNotes = chHasNotes(p, ch);
      const steps = p.steps[ch.id] || [];
      let grid;
      if (hasNotes) {
        grid = `<canvas class="rk-prev" data-ch="${ch.id}" width="${total * 22}" height="24" style="width:${total * 22 + Math.floor(total / 4) * 2}px" title="This sound plays notes from the piano roll. Click to edit them."></canvas>`;
      } else {
        grid = '<div class="rk-steps">' + Array.from({ length: total }, (_, i) => {
          const v = steps[i] || 0;
          const alt = Math.floor(i / 4) % 2 === 1;
          return `<div class="st${v ? ' on' : ''}${alt ? ' alt' : ''}${i && i % 4 === 0 ? ' gap' : ''}" data-ch="${ch.id}" data-i="${i}">${v > 1 ? `<i>${v}x</i>` : ''}</div>`;
        }).join('') + '</div>';
      }
      const sndOpts = ch.kind === 'drum'
        ? DRUM_SOUNDS.map((s) => `<option value="${s}" ${s === ch.sound ? 'selected' : ''}>${DRUM_LABELS[s]}</option>`).join('')
        : ch.kind === 'synth'
          ? Object.entries(SYNTHS).map(([k, v]) => `<option value="${k}" ${k === ch.preset ? 'selected' : ''}>${v}</option>`).join('')
          : '<option>Sample</option>';
      return `<div class="rk-row${ch.id === S.curCh ? ' cur' : ''}" data-row="${ch.id}">
        <button class="rk-led${ch.mute ? ' off' : ''}" data-act="mute" title="Turn this sound on or off"></button>
        <button class="rk-name" data-act="sel" title="Click to select and hear it. Double-click to rename.">${esc(ch.name)}</button>
        <select class="rk-snd" data-act="snd" title="Change the sound" style="width:104px;height:24px;font-size:12px">${sndOpts}</select>
        <input type="range" min="0" max="1.2" step="0.01" value="${ch.vol}" data-act="vol" title="Volume">
        <input type="range" min="-1" max="1" step="0.01" value="${ch.pan}" data-act="pan" title="Left or right">
        <button data-act="roll" title="Open in the piano roll to write notes" style="height:24px;padding:0 6px;font-size:11px">Notes</button>
        ${grid}
        <button class="rk-del" data-act="del" title="Remove this sound">&times;</button>
      </div>`;
    }).join('') + '<div class="rk-empty" style="padding-top:8px">Click a box to add a hit. Right-click a box for a fast roll (2x, 3x, 4x), great on hi-hats. Drag across boxes to paint.</div>';
    body.querySelectorAll('.rk-prev').forEach((c) => drawRackPreview(c, p));
  }
  bindRack(p);
}
function drawRackPreview(c, p) {
  const ch = S.channels.find((x) => x.id === c.dataset.ch), g = c.getContext('2d'), notes = p.notes[ch.id] || [];
  g.fillStyle = '#22262b'; g.fillRect(0, 0, c.width, c.height);
  let lo = 127, hi = 0;
  for (const n of notes) { lo = Math.min(lo, n.p); hi = Math.max(hi, n.p); }
  g.fillStyle = p.color;
  for (const n of notes) {
    const y = hi === lo ? 10 : 20 - ((n.p - lo) / (hi - lo)) * 17;
    g.fillRect(n.s * 22, y, Math.max(3, n.l * 22 - 2), 3);
  }
}
function bindRack(p) {
  const el = $('#rack');
  const on = (id, ev, fn) => { const x = el.querySelector('#' + id); if (x) x[ev] = fn; };
  on('rkNew', 'onclick', () => newPattern());
  on('rkName', 'onchange', (e) => { pushUndo(); p.name = e.target.value.trim() || p.name; syncToolbar(); draw(); });
  on('rkBars', 'onchange', (e) => setPatBars(p, +e.target.value));
  on('rkSwing', 'onpointerdown', () => pushUndo());
  on('rkSwing', 'oninput', (e) => { p.swing = +e.target.value / 100; draw(); });
  on('rkKit', 'onchange', (e) => {
    pushUndo();
    for (const c of S.channels) if (c.kind === 'drum') c.kit = e.target.value;
    ensureSounds(); toast(`Kit changed to ${KITS[e.target.value].label}.`);
  });
  on('rkAdd', 'onchange', async (e) => {
    const v = e.target.value; e.target.value = '';
    if (!v) return;
    if (v === 'sample') { pickSample(); return; }
    pushUndo();
    const [kind, key] = v.split(':');
    const kit = (S.channels.find((c) => c.kind === 'drum') || { kit: 'trap' }).kit;
    const ch = makeChannel(kind, kind === 'drum' ? { sound: key, kit } : { preset: key });
    S.channels.push(ch); S.curCh = ch.id;
    ensureSounds(); renderRack(); audition(ch);
  });
  on('rkClone', 'onclick', () => {
    pushUndo();
    const c = JSON.parse(JSON.stringify(p));
    c.id = nid('p'); c.name = p.name + ' copy'; c.color = PAT_COLORS[S.patterns.length % PAT_COLORS.length];
    S.patterns.push(c); S.curPat = c.id;
    syncToolbar(); renderRack(); drawRoll();
    toast('Copied. Change this one to make a variation, like a hook with more hi-hats.');
  });
  on('rkClear', 'onclick', () => { pushUndo(); p.steps = {}; p.notes = {}; renderRack(); drawRoll(); draw(); });
  on('rkDelPat', 'onclick', () => {
    pushUndo();
    S.patterns = S.patterns.filter((x) => x !== p);
    for (const t of S.tracks) t.clips = t.clips.filter((c) => !(c.kind === 'pat' && c.patId === p.id));
    S.curPat = S.patterns[0] ? S.patterns[0].id : null;
    refreshAll();
    toast('Pattern deleted. Press Ctrl+Z to bring it back.');
  });
  on('rkPlace', 'onclick', () => placePatternInSong(p));
  const body = $('#rkBody');
  if (!p) return;
  body.oncontextmenu = (e) => { if (e.target.closest('.st')) e.preventDefault(); };
  body.onpointerdown = (e) => {
    const st = e.target.closest('.st');
    if (!st) return;
    e.preventDefault();
    const ch = S.channels.find((c) => c.id === st.dataset.ch), i = +st.dataset.i;
    pushUndo();
    const arr = p.steps[ch.id] || (p.steps[ch.id] = []);
    const v = arr[i] || 0;
    let nv;
    if (e.button === 2) nv = v === 0 || v === 1 ? 2 : v === 4 ? 1 : v + 1;
    else nv = v ? 0 : 1;
    paint = { ch: ch.id, val: nv };
    setStep(p, ch, i, nv, st);
    if (nv) audition(ch);
  };
  body.onpointerover = (e) => {
    if (!paint || !(e.buttons & 3)) { paint = null; return; }
    const st = e.target.closest('.st');
    if (!st || st.dataset.ch !== paint.ch) return;
    const ch = S.channels.find((c) => c.id === paint.ch);
    setStep(p, ch, +st.dataset.i, paint.val, st);
  };
  window.addEventListener('pointerup', () => { paint = null; }, { once: true });
  body.querySelectorAll('.rk-row').forEach((row) => {
    const ch = S.channels.find((c) => c.id === row.dataset.row);
    row.querySelector('[data-act=mute]').onclick = () => { ch.mute = !ch.mute; S.dirty = true; renderRack(); };
    const nameBtn = row.querySelector('[data-act=sel]');
    nameBtn.onclick = () => { S.curCh = ch.id; body.querySelectorAll('.rk-row').forEach((r) => r.classList.toggle('cur', r === row)); audition(ch); };
    nameBtn.ondblclick = () => {
      const inp = document.createElement('input');
      inp.type = 'text'; inp.value = ch.name; inp.className = 'rk-name'; inp.style.cssText = 'height:24px';
      nameBtn.replaceWith(inp); inp.focus(); inp.select();
      const done = () => { if (inp.value.trim() && inp.value.trim() !== ch.name) { pushUndo(); ch.name = inp.value.trim(); } renderRack(); };
      inp.onblur = done; inp.onkeydown = (e) => { if (e.key === 'Enter') inp.blur(); };
    };
    row.querySelector('[data-act=snd]').onchange = (e) => {
      pushUndo();
      const v = e.target.value;
      const wasDefault = ch.name === (ch.kind === 'drum' ? DRUM_LABELS[ch.sound] : SYNTHS[ch.preset]);
      if (ch.kind === 'drum') ch.sound = v; else if (ch.kind === 'synth') { ch.preset = v; ch.note = v === '808' || v === 'bass' ? 36 : 60; }
      if (wasDefault) ch.name = ch.kind === 'drum' ? DRUM_LABELS[v] : SYNTHS[v];
      ensureSounds(); renderRack(); audition(ch);
    };
    const vol = row.querySelector('[data-act=vol]'), pan = row.querySelector('[data-act=pan]');
    vol.oninput = () => { ch.vol = +vol.value; S.dirty = true; applyChans(); };
    pan.oninput = () => { ch.pan = +pan.value; S.dirty = true; applyChans(); };
    row.querySelector('[data-act=roll]').onclick = () => { S.curCh = ch.id; openDock('roll'); };
    const prev = row.querySelector('.rk-prev');
    if (prev) prev.onclick = () => { S.curCh = ch.id; openDock('roll'); };
    row.querySelector('[data-act=del]').onclick = () => {
      pushUndo();
      S.channels = S.channels.filter((c) => c !== ch);
      for (const pp of S.patterns) { delete pp.steps[ch.id]; delete pp.notes[ch.id]; }
      renderRack(); draw();
      toast('Sound removed. Press Ctrl+Z to bring it back.');
    };
  });
}
function setStep(p, ch, i, v, el) {
  const arr = p.steps[ch.id] || (p.steps[ch.id] = []);
  arr[i] = v;
  el.classList.toggle('on', !!v);
  el.innerHTML = v > 1 ? `<i>${v}x</i>` : '';
  draw();
}
function pickSample() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'audio/*';
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    await ensureCtx();
    busy('Loading the sample...');
    try {
      let buf;
      try { buf = await AC.decodeAudioData(await f.arrayBuffer()); } catch (e) { throw new Error('Could not read that file. Try an MP3 or WAV.'); }
      const id = nid('s'); addBuffer(id, buf);
      pushUndo();
      const ch = makeChannel('sample', { bufId: id, name: f.name.replace(/\.[^.]+$/, '').slice(0, 20) });
      S.channels.push(ch); S.curCh = ch.id;
      renderRack(); audition(ch);
    } catch (e) { toast(e.message); }
    unbusy();
  };
  inp.click();
}

/* ---------- current playing step ---------- */
function playingStep(p) {
  if (!P || !p) return -1;
  const st = stepSec(), total = p.bars * 16, pos = posNow();
  if (P.patMode) return S.curPat === p.id ? Math.floor(pos / st + 1e-6) % total : -1;
  for (const t of S.tracks) for (const c of t.clips) {
    if (c.kind === 'pat' && c.patId === p.id && pos >= c.start && pos < c.start + c.dur) {
      const L = patLenSec(p), rel = ((pos - (c.start - c.offset)) % L + L) % L;
      return Math.floor(rel / st + 1e-6) % total;
    }
  }
  return -1;
}
let lastStep = -2;
function frameDock() {
  if (dockTab === 'rack') {
    const s = playingStep(curPattern());
    if (s !== lastStep) {
      document.querySelectorAll('#rkBody .st.now').forEach((x) => x.classList.remove('now'));
      if (s >= 0) document.querySelectorAll(`#rkBody .st[data-i="${s}"]`).forEach((x) => x.classList.add('now'));
      lastStep = s;
    }
  } else if (dockTab === 'roll' && P) drawRoll();
  else if (dockTab === 'mixer' && typeof drawMixerMeters === 'function') drawMixerMeters();
}

/* ---------- piano roll ---------- */
const ROW = 14, KEYW = 52, LO = 24, HI = 96;
let stepPx = 24, lastLen = 4, rollDrag = null, rollSel = null, pianoOct = 60;
function rollRows() {
  const out = [];
  for (let m = HI; m >= LO; m--) if (!(S.scaleLock && S.key) || inScale(m, S.key)) out.push(m);
  return out;
}
function renderRollHead() {
  const el = $('#roll');
  if (!el.querySelector('.phead')) {
    el.innerHTML = `<div class="phead" id="rlHead"></div>
      <div class="rl-body" id="rlBody"><canvas id="rollCv"></canvas><div id="rollSpacer"></div></div>`;
    bindRoll();
  }
  const p = curPattern(), ch = curChannel();
  $('#rlHead').innerHTML = `
    <span class="ttl">Piano roll</span>
    <label>Sound <select id="rlCh">${S.channels.map((c) => `<option value="${c.id}" ${ch && c.id === ch.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
    <span style="color:var(--muted)">in ${p ? esc(p.name) : 'no pattern'}</span>
    <label title="New notes get this length">Note length <select id="rlLen">${[[1, '1/16'], [2, '1/8'], [4, '1/4 (one beat)'], [8, '1/2'], [16, '1 bar']].map(([v, l]) => `<option value="${v}" ${v === lastLen ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <button id="rlLock" class="${S.scaleLock ? 'on' : ''}" title="Shows only the notes in the song key, so every note sounds right">Scale lock${S.key ? '' : ' (pick a key)'}</button>
    <button id="rlChords" title="Pick a mood and get 4 chords that fit the key">Chords</button>
    <button id="rlType" class="${S.typePiano ? 'on' : ''}" title="Play notes with your computer keyboard: A W S E D F T G Y H U J K. Z and X change octave.">Keyboard piano</button>
    <span class="fill"></span>
    <button id="rlClear" title="Remove this sound's notes from the pattern">Clear notes</button>`;
  $('#rlCh').onchange = (e) => { S.curCh = e.target.value; drawRoll(); renderRack(); };
  $('#rlLen').onchange = (e) => { lastLen = +e.target.value; };
  $('#rlLock').onclick = () => {
    if (!S.key) { toast('Pick a key at the top first (next to BPM), then scale lock shows only the notes that fit.'); return; }
    S.scaleLock = !S.scaleLock; savePrefs(); renderRollHead(); centerRoll(); drawRoll();
  };
  $('#rlChords').onclick = openChords;
  $('#rlType').onclick = () => { S.typePiano = !S.typePiano; renderRollHead(); toast(S.typePiano ? 'Keyboard piano on: A to K play notes, Z and X change octave. Shortcuts like R are off until you turn it off.' : 'Keyboard piano off.'); };
  $('#rlClear').onclick = () => { if (!p || !ch) return; pushUndo(); p.notes[ch.id] = []; drawRoll(); renderRack(); draw(); };
}
function centerRoll() {
  const body = $('#rlBody'); if (!body) return;
  const rows = rollRows(), ch = curChannel(), p = curPattern();
  const notes = p && ch ? p.notes[ch.id] || [] : [];
  const target = notes.length ? notes[0].p : ch && (ch.preset === '808' || ch.preset === 'bass') ? 40 : 64;
  let idx = rows.findIndex((m) => m <= target);
  if (idx < 0) idx = rows.length - 1;
  body.scrollTop = idx * ROW - body.clientHeight / 2;
}
function drawRoll() {
  const body = $('#rlBody');
  if (!body || dockTab !== 'roll') return;
  const cvR = $('#rollCv'), g = cvR.getContext('2d');
  const p = curPattern(), ch = curChannel(), rows = rollRows();
  const total = p ? p.bars * 16 : 16;
  const W = body.clientWidth, Hh = body.clientHeight;
  $('#rollSpacer').style.width = KEYW + (total + 16) * stepPx + 'px';
  $('#rollSpacer').style.height = rows.length * ROW + 'px';
  fitCanvas(cvR, g, W, Hh);
  const sl = body.scrollLeft, st = body.scrollTop;
  g.fillStyle = '#15171a'; g.fillRect(0, 0, W, Hh);
  const r0 = Math.floor(st / ROW), r1 = Math.min(rows.length, Math.ceil((st + Hh) / ROW));
  for (let r = r0; r < r1; r++) {
    const m = rows[r], y = r * ROW - st, black = [1, 3, 6, 8, 10].includes(m % 12);
    g.fillStyle = black ? '#16181b' : '#1b1e22';
    if (!S.scaleLock && S.key && inScale(m, S.key)) g.fillStyle = black ? '#1d2124' : '#22272b';
    g.fillRect(KEYW, y, W, ROW);
    g.fillStyle = '#121417'; g.fillRect(KEYW, y + ROW - 1, W, 1);
  }
  for (let s = Math.floor(sl / stepPx); s * stepPx < sl + W; s++) {
    const x = KEYW + s * stepPx - sl;
    if (x < KEYW) continue;
    g.fillStyle = s % 16 === 0 ? '#3a4048' : s % 4 === 0 ? '#2b3036' : '#1f2226';
    g.fillRect(x, 0, 1, Hh);
  }
  const endX = KEYW + total * stepPx - sl;
  if (endX < W) { g.fillStyle = 'rgba(0,0,0,0.45)'; g.fillRect(Math.max(KEYW, endX), 0, W, Hh); }
  if (p) {
    const rowOf = (m) => rows.indexOf(m);
    // other sounds in the pattern, faint, to write around them
    for (const other of S.channels) {
      if (!ch || other.id === ch.id) continue;
      for (const n of p.notes[other.id] || []) {
        const r = rowOf(n.p); if (r < 0) continue;
        g.fillStyle = 'rgba(255,255,255,0.08)';
        g.fillRect(KEYW + n.s * stepPx - sl + 1, r * ROW - st + 2, n.l * stepPx - 2, ROW - 4);
      }
    }
    if (ch) for (const n of p.notes[ch.id] || []) {
      const r = rowOf(n.p), x = KEYW + n.s * stepPx - sl, y = r * ROW - st;
      if (r < 0) continue;
      g.globalAlpha = 0.55 + n.v * 0.45;
      g.fillStyle = p.color; g.fillRect(x + 1, y + 1, n.l * stepPx - 2, ROW - 2);
      g.globalAlpha = 1;
      if (n === rollSel) { g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.strokeRect(x + 1.5, y + 1.5, n.l * stepPx - 3, ROW - 3); }
      if (n.l * stepPx > 34) { g.fillStyle = '#121417'; g.font = '600 9px "Segoe UI", sans-serif'; g.fillText(noteName(n.p), x + 4, y + 10); }
    }
    const ps = playingStep(p);
    if (ps >= 0 && P) {
      const pos = P.patMode ? (posNow() / stepSec()) % total : ps;
      g.fillStyle = '#e8eaed'; g.fillRect(KEYW + pos * stepPx - sl, 0, 1.5, Hh);
    }
  }
  // keyboard
  for (let r = r0; r < r1; r++) {
    const m = rows[r], y = r * ROW - st, black = [1, 3, 6, 8, 10].includes(m % 12);
    g.fillStyle = black ? '#2a2e34' : '#d8dbe0'; g.fillRect(0, y, KEYW, ROW - 1);
    if (m % 12 === 0 || S.scaleLock) {
      g.fillStyle = black ? '#d8dbe0' : '#121417'; g.font = '9px "Segoe UI", sans-serif';
      g.fillText(noteName(m), 4, y + 10);
    }
  }
  g.fillStyle = '#2b3036'; g.fillRect(KEYW - 1, 0, 1, Hh);
  if (!ch) { g.fillStyle = '#7d848d'; g.font = '13px "Segoe UI"'; g.fillText('Add a sound in the Channel rack first.', KEYW + 20, 30); }
  else if (p && !(p.notes[ch.id] || []).length) {
    g.fillStyle = '#7d848d'; g.font = '13px "Segoe UI", sans-serif';
    g.fillText(`Click anywhere on the grid to add a note for ${ch.name}. Drag notes to move them, drag the right edge to make them longer, right-click to delete.`, KEYW + 16, 22);
  }
}
function rollHit(e) {
  const body = $('#rlBody'), r = $('#rollCv').getBoundingClientRect();
  const vx = e.clientX - r.left, vy = e.clientY - r.top;
  const rows = rollRows();
  const row = Math.floor((vy + body.scrollTop) / ROW);
  return { vx, vy, step: (vx - KEYW + body.scrollLeft) / stepPx, row, midi: rows[clamp(row, 0, rows.length - 1)] };
}
function noteAt(h) {
  const p = curPattern(), ch = curChannel();
  if (!p || !ch) return null;
  const notes = p.notes[ch.id] || [];
  for (let i = notes.length - 1; i >= 0; i--) {
    const n = notes[i];
    if (n.p === h.midi && h.step >= n.s && h.step < n.s + n.l) return n;
  }
  return null;
}
function bindRoll() {
  const body = $('#rlBody'), c = $('#rollCv');
  body.addEventListener('scroll', drawRoll);
  body.addEventListener('wheel', (e) => {
    if (e.ctrlKey) { e.preventDefault(); stepPx = clamp(stepPx * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 8, 80); drawRoll(); }
  }, { passive: false });
  c.addEventListener('contextmenu', (e) => e.preventDefault());
  c.addEventListener('pointerdown', (e) => {
    const p = curPattern(), ch = curChannel();
    if (!p || !ch) return;
    const h = rollHit(e);
    if (h.vx < KEYW) { audition(ch, h.midi); return; }
    c.setPointerCapture(e.pointerId);
    if (e.button === 2) {
      pushUndo();
      rollDrag = { mode: 'erase' };
      const n = noteAt(h);
      if (n) { p.notes[ch.id] = p.notes[ch.id].filter((x) => x !== n); drawRoll(); }
      return;
    }
    if (h.step < 0 || h.step >= p.bars * 16) return;
    pushUndo();
    let n = noteAt(h), mode = 'move';
    if (n) {
      const xr = KEYW + (n.s + n.l) * stepPx - body.scrollLeft;
      if (xr - h.vx < 7) mode = 'size';
    } else {
      const arr = p.notes[ch.id] || (p.notes[ch.id] = []);
      n = { p: h.midi, s: Math.floor(h.step), l: lastLen, v: 0.8 };
      if (n.s + n.l > p.bars * 16) n.l = p.bars * 16 - n.s;
      arr.push(n);
    }
    rollSel = n;
    audition(ch, n.p, Math.min(0.6, n.l * stepSec()));
    rollDrag = { mode, n, orig: { ...n }, step0: h.step, lastP: n.p };
    drawRoll();
  });
  c.addEventListener('pointermove', (e) => {
    const h = rollHit(e);
    if (!rollDrag) {
      const n = h.vx >= KEYW ? noteAt(h) : null;
      if (n) { const xr = KEYW + (n.s + n.l) * stepPx - body.scrollLeft; c.style.cursor = xr - h.vx < 7 ? 'ew-resize' : 'grab'; }
      else c.style.cursor = h.vx < KEYW ? 'pointer' : 'crosshair';
      return;
    }
    const p = curPattern(), ch = curChannel(), total = p.bars * 16;
    if (rollDrag.mode === 'erase') {
      const n = noteAt(h);
      if (n) { p.notes[ch.id] = p.notes[ch.id].filter((x) => x !== n); drawRoll(); }
      return;
    }
    const { n, orig } = rollDrag, d = Math.round(h.step - rollDrag.step0);
    if (rollDrag.mode === 'move') {
      n.s = clamp(orig.s + d, 0, total - n.l);
      n.p = h.midi;
      if (n.p !== rollDrag.lastP) { rollDrag.lastP = n.p; audition(ch, n.p, 0.25); }
    } else {
      n.l = clamp(orig.l + d, 1, total - n.s);
      lastLen = n.l;
    }
    drawRoll();
  });
  c.addEventListener('pointerup', () => {
    if (!rollDrag) return;
    rollDrag = null;
    renderRack(); draw();
  });
}
function rollDeleteSelected() {
  if (dockTab !== 'roll' || !rollSel) return false;
  const p = curPattern(), ch = curChannel();
  if (!p || !ch || !(p.notes[ch.id] || []).includes(rollSel)) return false;
  pushUndo();
  p.notes[ch.id] = p.notes[ch.id].filter((x) => x !== rollSel);
  rollSel = null; drawRoll(); renderRack(); draw();
  return true;
}

/* ---------- keyboard piano ---------- */
const PIANO_KEYS = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15 };
function pianoKeyDown(k) {
  if (k === 'z') { pianoOct = Math.max(24, pianoOct - 12); toast('Octave ' + (pianoOct / 12 - 1)); return true; }
  if (k === 'x') { pianoOct = Math.min(96, pianoOct + 12); toast('Octave ' + (pianoOct / 12 - 1)); return true; }
  if (!(k in PIANO_KEYS)) return false;
  const ch = curChannel();
  if (ch) audition(ch, pianoOct + PIANO_KEYS[k], 0.6);
  return true;
}
function pianoKeyUp() { /* notes are one-shots */ }

/* ---------- chord helper ---------- */
function openChords() {
  const box = $('#moodChoices');
  const desc = { Sad: 'Emotional, heartbreak', Dark: 'Tense, street', Hype: 'Energy, turn up', Chill: 'Smooth, late night', Happy: 'Bright, feel good', Dreamy: 'Floaty, melodic' };
  box.innerHTML = Object.keys(MOODS).map((m) => `<button data-mood="${m}"><b>${m}</b><small>${desc[m]}</small></button>`).join('');
  box.querySelectorAll('button').forEach((b) => { b.onclick = () => { $('#dChords').close(); insertChords(b.dataset.mood, $('#chkChord808').checked); }; });
  $('#dChords').showModal();
}
$('#bChordsCancel').onclick = () => $('#dChords').close();
function chordProgression(mood, key) {
  const k = parseKey(key) || { mode: 'minor' };
  const md = MOODS[mood];
  return { degs: md[k.mode], seventh: md.seventh };
}
function insertChords(mood, with808) {
  let p = curPattern();
  pushUndo();
  if (!S.key) { S.key = 'C minor'; syncToolbar(); toast('No key was set, so the song is now in C minor. Change it at the top any time.'); }
  if (!p) { p = makePattern('Melody', 4); S.patterns.push(p); S.curPat = p.id; }
  if (p.bars < 4) {
    const keepBars = p.bars;
    p.bars = keepBars; // expand without undo duplication
    const old = keepBars * 16;
    for (const k in p.steps) { const a = p.steps[k], out = []; for (let i = 0; i < 64; i++) out[i] = a[i % old] || 0; p.steps[k] = out; }
    for (const k in p.notes) { const src = p.notes[k], out = []; for (let r = 0; r < 4 / keepBars; r++) for (const n of src) out.push({ ...n, s: n.s + r * old }); p.notes[k] = out; }
    p.bars = 4;
  }
  let ch = curChannel();
  if (!ch || ch.kind !== 'synth' || ch.preset === '808' || ch.preset === 'bass') ch = findOrAddChannel('synth', 'keys');
  const { degs, seventh } = chordProgression(mood, S.key);
  const notes = [];
  degs.forEach((d, i) => { for (const m of chordNotes(S.key, d, 48, seventh)) notes.push({ p: m, s: i * 16, l: 16, v: 0.7 }); });
  p.notes[ch.id] = notes;
  if (with808) {
    const b = findOrAddChannel('synth', '808');
    const bn = [];
    degs.forEach((d, i) => {
      const root = chordNotes(S.key, d, 36, false)[0];
      bn.push({ p: root, s: i * 16, l: 6, v: 0.9 }, { p: root, s: i * 16 + 10, l: 5, v: 0.8 });
    });
    p.notes[b.id] = bn;
  }
  S.curCh = ch.id;
  syncToolbar(); renderRack(); renderRollHead(); drawRoll(); draw();
  toast(`${mood} chords added to ${ch.name}${with808 ? ' with an 808 under them' : ''}. Press P then Space to hear the pattern.`);
}

/* ---------- starter beats ---------- */
const GENRES = {
  trap: {
    label: 'Trap', desc: '140 BPM, hard 808s, hi-hat rolls', bpm: 140, kit: 'trap', mood: 'Dark', swing: 0,
    drums: { kick: 'x.....x...x.....x.........x..x..', clap: '........x...............x.......', hat: 'x.x.x.x.x.x.x3x.x.x.x.x.x.x4x.x.', openhat: '..............................x.' },
    bass: '808', bassHits: [[0, 6], [10, 5]], melody: 'bell', melodyStyle: 'arp',
  },
  drill: {
    label: 'Drill', desc: '142 BPM, sliding 808s, bouncy hats', bpm: 142, kit: 'drill', mood: 'Dark', swing: 0,
    drums: { kick: 'x.........x.......x.......x.....', snare: '........x...............x.....x.', hat: 'x..x..x...x..x..x..x..x...x.x...', perc: '......x.......x.......x.........' },
    bass: '808', bassHits: [[0, 8], [10, 6]], melody: 'strings', melodyStyle: 'pad',
  },
  boombap: {
    label: 'Boom bap', desc: '90 BPM, dusty drums, jazzy keys', bpm: 90, kit: 'boombap', mood: 'Chill', swing: 0.35,
    drums: { kick: 'x......x..x.....x.x....x........', snare: '....x.......x.......x.......x...', hat: 'x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.', openhat: '..............................x.' },
    bass: 'bass', bassHits: [[0, 4], [7, 2], [10, 4]], melody: 'keys', melodyStyle: 'stabs',
  },
  reggaeton: {
    label: 'Reggaeton', desc: '95 BPM, dembow rhythm, plucks', bpm: 95, kit: 'reggaeton', mood: 'Sad', swing: 0,
    drums: { kick: 'x...x...x...x...x...x...x...x...', snare: '...x..x....x..x....x..x....x..x.', hat: 'x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.', rim: '..x.....x.x.......x.....x.x.....' },
    bass: '808', bassHits: [[0, 3], [4, 3], [8, 3], [12, 3]], melody: 'pluck', melodyStyle: 'offbeat',
  },
  rnb: {
    label: 'R&B', desc: '72 BPM, smooth keys, soft drums', bpm: 72, kit: 'rnb', mood: 'Chill', swing: 0.2,
    drums: { kick: 'x......x..x.....x.........x..x..', snare: '....x.......x.......x.......x...', hat: 'x.x.x.x.x.x.x.x2x.x.x.x.x.x.x.x2', shaker: '..x...x...x...x...x...x...x...x.' },
    bass: '808', bassHits: [[0, 7], [10, 5]], melody: 'keys', melodyStyle: 'pad',
  },
};
function openStarter() {
  $('#starterChoices').innerHTML = Object.entries(GENRES).map(([k, gn]) => `<button data-g="${k}"><b>${gn.label}</b><small>${gn.desc}</small></button>`).join('');
  $('#starterKey').innerHTML = ALL_KEYS.map((k) => `<option>${k}</option>`).join('');
  $('#starterKey').value = S.key || 'C minor';
  $('#starterChoices').querySelectorAll('button').forEach((b) => {
    b.onclick = () => { $('#dStarter').close(); makeStarter(b.dataset.g, $('#starterKey').value); };
  });
  $('#dStarter').showModal();
}
$('#bStarter').onclick = openStarter;
$('#bStarterCancel').onclick = () => $('#dStarter').close();

async function makeStarter(gk, key) {
  const gn = GENRES[gk];
  if (P) stop();
  const hasAudio = S.tracks.some((t) => t.clips.some((c) => c.kind !== 'pat'));
  if (!hasAudio && S.bpm !== gn.bpm) setBpm(gn.bpm);
  pushUndo();
  S.key = key;
  // drums
  for (const c of S.channels) if (c.kind === 'drum') c.kit = gn.kit;
  const drums = makePattern(gn.label + ' Drums', 2);
  drums.swing = gn.swing;
  for (const [snd, pat] of Object.entries(gn.drums)) {
    const ch = findOrAddChannel('drum', snd, gn.kit);
    drums.steps[ch.id] = [...pat].map((c) => (c === '.' ? 0 : c === 'x' ? 1 : +c));
  }
  const { degs, seventh } = chordProgression(gn.mood, key);
  // 808 / bass
  const bass = makePattern(gn.label + ' 808', 4);
  const bch = findOrAddChannel('synth', gn.bass);
  bass.notes[bch.id] = [];
  degs.forEach((d, i) => {
    const root = chordNotes(key, d, 36, false)[0];
    for (const [s, l] of gn.bassHits) bass.notes[bch.id].push({ p: root, s: i * 16 + s, l, v: 0.9 });
  });
  // melody
  const mel = makePattern(gn.label + ' Melody', 4);
  mel.swing = gn.swing;
  const mch = findOrAddChannel('synth', gn.melody);
  const mn = [];
  degs.forEach((d, i) => {
    const ch3 = chordNotes(key, d, 60, seventh), b = i * 16;
    if (gn.melodyStyle === 'arp') {
      const seq = [0, 1, 2, 1, 0, 1, 2, 3].map((j) => (j < ch3.length ? ch3[j] : ch3[0] + 12));
      seq.forEach((m, j) => mn.push({ p: m, s: b + j * 2, l: 2, v: j % 2 ? 0.6 : 0.8 }));
    } else if (gn.melodyStyle === 'stabs') {
      for (const m of ch3) { mn.push({ p: m - 12, s: b, l: 6, v: 0.75 }); mn.push({ p: m - 12, s: b + 10, l: 4, v: 0.6 }); }
    } else if (gn.melodyStyle === 'offbeat') {
      for (const s of [2, 6, 10, 14]) for (const m of ch3) mn.push({ p: m, s: b + s, l: 2, v: 0.65 });
    } else {
      for (const m of ch3) mn.push({ p: m - 12, s: b, l: 16, v: 0.65 });
    }
  });
  mel.notes[mch.id] = mn;
  for (const p of [drums, bass, mel]) { p.color = PAT_COLORS[S.patterns.length % PAT_COLORS.length]; S.patterns.push(p); }
  S.curPat = drums.id;
  // place on tracks, 8 bars
  const bl = barLen();
  const roles = [['Drums', drums], ['808', bass], ['Melody', mel]];
  let start = 0;
  for (const [name] of roles) {
    const t = S.tracks.find((x) => x.name === name);
    if (t) start = Math.max(start, Math.ceil(t.clips.reduce((m, c) => Math.max(m, c.start + c.dur), 0) / bl - 1e-6) * bl);
  }
  for (const [name, p] of roles) {
    let t = S.tracks.find((x) => x.name === name);
    if (!t) {
      t = newTrack(name);
      if (name === '808') t.fx = { ...t.fx, ...FX_PRESETS['808 warm'], preset: '808 warm' };
      if (name === 'Drums') t.fx = { ...t.fx, ...FX_PRESETS['Drums punch'], preset: 'Drums punch' };
      if (name === 'Melody') t.fx = { ...t.fx, ...FX_PRESETS['Melody wide'], preset: 'Melody wide' };
      const vi = S.tracks.findIndex((x) => /^Vocal/.test(x.name));
      if (vi >= 0) S.tracks.splice(vi, 0, t); else S.tracks.push(t);
    }
    t.clips.push({ id: nid('c'), kind: 'pat', patId: p.id, start, dur: bl * 8, offset: 0 });
  }
  S.tracks = S.tracks.filter((t) => !(t.name === 'Beat' && !t.clips.length));
  S.loop.start = start; S.loop.end = start + bl * 8;
  S.mode = 'song'; S.pos = start;
  await ensureCtx();
  refreshAll();
  openDock('rack');
  toast(`${gn.label} starter beat ready in ${key}. Press Space to hear it. Click boxes in the Channel rack to change the drums.${hasAudio ? ' The tempo was kept because the song has audio in it.' : ''}`, 9000);
}
