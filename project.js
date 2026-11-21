'use strict';
/* Awad Studio: projects (save, open, autosave), song layout, auto-tune, tooltips, startup. */

/* ---------- projects (saved in this browser) ---------- */
function stamp() {
  const d = new Date(), z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}${z(d.getMinutes())}`;
}
let saving = false;
async function saveProject(silent = false) {
  if (saving) return;
  if (!S.projectName) { S.projectName = ($('#projName').value.trim()) || 'Untitled ' + stamp(); $('#projName').value = S.projectName; }
  saving = true;
  if (!silent) busy('Saving...');
  try {
    await storeSave(S.projectName);
    S.dirty = false;
    if (!silent) toast(`Saved "${S.projectName}" in this browser. Use Open > Download project file to back it up or send it to a friend.`, 7000);
  } catch (e) { if (!silent) toast('Save failed: ' + e.message); }
  saving = false;
  if (!silent) unbusy();
}
function applyProjectData(j, name) {
  Object.assign(S, {
    bpm: j.bpm, key: j.key, tracks: j.tracks, loop: j.loop, channels: j.channels, patterns: j.patterns,
    curPat: j.curPat, curCh: j.curCh, markers: j.markers || [], master: j.master || { vol: 1, auto: false },
    mode: j.mode || 'song', projectName: name || j.name || '', sel: null, pos: 0, dirty: false,
  });
  for (const t of S.tracks) t.fx = { ...FX_DEFAULT, ...(t.fx || {}) };
  undoStack.length = 0; redoStack.length = 0;
  refreshAll();
  S.dirty = false;
}
async function loadProject(name) {
  if (P) stop();
  busy('Opening ' + name + '...');
  try {
    await ensureCtx();
    applyProjectData(await storeLoad(name), name);
    toast(`Opened "${S.projectName}".`);
  } catch (e) { toast('Could not open it: ' + e.message); }
  unbusy();
}
async function loadServerProject(name) {
  if (P) stop();
  busy('Opening ' + name + '...');
  try {
    const j = await apiJson(await fetch('/api/project?name=' + encodeURIComponent(name)));
    await ensureCtx();
    for (const [id, url] of Object.entries(j.bufSrc || {})) if (!buffers.has(id)) addBuffer(id, await fetchBuffer(url));
    applyProjectData(j, name);
    S.dirty = true;
    toast(`Opened "${S.projectName}" from this PC. It now saves in the browser too.`);
  } catch (e) { toast('Could not open it: ' + e.message); }
  unbusy();
}
function newProject() {
  if (P) stop();
  Object.assign(S, {
    bpm: 120, key: null, tracks: [newTrack('Beat'), newTrack('Vocal 1')], channels: defaultChannels(),
    patterns: [], markers: [], master: { vol: 1, auto: false }, mode: 'song', projectName: '', sel: null, pos: 0, dirty: false,
  });
  const p = makePattern('Pattern 1');
  S.patterns = [p]; S.curPat = p.id; S.curCh = S.channels[0].id;
  S.loop = { on: false, start: 0, end: barLen() * 4 };
  undoStack.length = 0; redoStack.length = 0;
  refreshAll();
}
let discardArmed = false;
async function openProjects() {
  discardArmed = false;
  $('#bNewProj').textContent = 'New empty project';
  let list = [];
  try { list = await storeList(); } catch (e) { toast('This browser is blocking storage, so projects cannot be saved here.'); }
  let html = list.length
    ? list.map((p) => `<div class="prow"><button data-name="${esc(p.name)}"><span>${esc(p.name)}</span><small>${esc(new Date(p.modified).toLocaleString())}</small></button><button class="pdel" data-del="${esc(p.name)}" title="Delete this project">&times;</button></div>`).join('')
    : '<small style="color:var(--muted)">No saved projects yet. Your song saves itself every minute once you start.</small>';
  if (AWAD.local) {
    try {
      const old = await (await fetch('/api/projects')).json();
      if (old.length) html += '<div style="color:var(--muted);margin:10px 0 4px">Saved on this PC (older versions)</div>' + old.map((p) => `<button data-server="${esc(p.name)}"><span>${esc(p.name)}</span><small>${esc(p.modified)}</small></button>`).join('');
    } catch (e) { /* server list optional */ }
  }
  $('#projList').innerHTML = html;
  $('#projList').querySelectorAll('[data-name]').forEach((b) => { b.onclick = () => { $('#dOpen').close(); loadProject(b.dataset.name); }; });
  $('#projList').querySelectorAll('[data-server]').forEach((b) => { b.onclick = () => { $('#dOpen').close(); loadServerProject(b.dataset.server); }; });
  $('#projList').querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Delete?'; b.classList.add('armed'); return; }
      await storeDelete(b.dataset.del); openProjects();
    };
  });
  if (!$('#dOpen').open) $('#dOpen').showModal();
}
$('#bOpen').onclick = openProjects;
$('#bOpenCancel').onclick = () => $('#dOpen').close();
$('#bNewProj').onclick = () => {
  if (S.dirty && !discardArmed) {
    discardArmed = true;
    $('#bNewProj').textContent = 'Not saved yet. Click again to start fresh anyway';
    return;
  }
  $('#dOpen').close(); newProject();
};
$('#bExportProj').onclick = async () => {
  if (!S.tracks.some((t) => t.clips.length) && !S.patterns.some((p) => Object.keys(p.steps).length || Object.keys(p.notes).length)) { toast('There is nothing in this project yet.'); return; }
  busy('Packing the project...');
  try { downloadBlob(await exportProjectFile(), `${S.projectName || 'My song'}.awad`); toast('Project file downloaded. Send it to a friend and they can open it with Open > Open project file.', 8000); }
  catch (e) { toast(e.message); }
  unbusy();
};
$('#bImportProj').onclick = () => {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.awad';
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    $('#dOpen').close();
    if (P) stop();
    busy('Opening ' + f.name + '...');
    try { await ensureCtx(); applyProjectData(await importProjectFile(f), f.name.replace(/\.awad$/i, '')); S.dirty = true; toast(`Opened "${S.projectName}".`); }
    catch (e) { toast('Could not open that file: ' + e.message); }
    unbusy();
  };
  inp.click();
};
$('#bSave').onclick = () => saveProject();
$('#projName').onchange = () => { S.projectName = $('#projName').value.trim(); if (S.projectName) saveProject(); };
setInterval(() => {
  if (S.dirty && !curRec && !(P && P.recording) && S.tracks.some((t) => t.clips.length)) saveProject(true);
}, 60000);

/* ---------- YouTube beat puller (runs on the host's PC) ---------- */
const CODE_KEY = 'awadstudio.code';
function getCode() { try { return localStorage.getItem(CODE_KEY) || ''; } catch (e) { return ''; } }
function setCode(c) { try { if (c) localStorage.setItem(CODE_KEY, c); else localStorage.removeItem(CODE_KEY); } catch (e) { /* storage off */ } }
function askCode() {
  return new Promise((res) => {
    const d = $('#dCode');
    $('#codeIn').value = '';
    $('#bCodeOk').onclick = () => { d.close(); res($('#codeIn').value.trim()); };
    $('#bCodeCancel').onclick = () => { d.close(); res(''); };
    $('#codeIn').onkeydown = (e) => { if (e.key === 'Enter') $('#bCodeOk').click(); };
    d.showModal();
  });
}
async function pullBeat(url) {
  if (!AWAD.puller) throw new Error('The YouTube beat puller is not set up yet. Add the beat as an MP3 file for now.');
  let code = getCode();
  if (!code) { unbusy(); code = await askCode(); busy('Getting the beat. This can take 20 to 60 seconds...'); }
  if (!code) throw new Error('You need the friend code to pull beats from YouTube. You can still add beats as MP3 files.');
  let r;
  try {
    r = await fetch(AWAD.puller.replace(/\/$/, '') + '/pull', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': '1' },
      body: JSON.stringify({ url, code }),
    });
  } catch (e) { throw new Error('The YouTube beat puller is offline right now. Add the beat as an MP3 file instead, or try later.'); }
  if (r.status === 401) { setCode(''); throw new Error('That friend code did not work. Click Get beat again to enter it.'); }
  if (!r.ok) {
    let m = 'The beat puller is offline right now. Add the beat as an MP3 file instead, or try later.';
    try { const j = await r.json(); if (j.detail) m = j.detail; } catch (e) { /* not json */ }
    throw new Error(m);
  }
  setCode(code);
  const title = decodeURIComponent(r.headers.get('X-Title') || 'Beat');
  busy('Loading the beat...');
  const buf = await AC.decodeAudioData(await r.arrayBuffer());
  return { buf, title };
}

/* ---------- song layout ---------- */
const LAYOUTS = {
  rap: { label: 'Rap song', desc: 'Intro, Hook, Verse, Hook, Verse, Hook, Outro', parts: [['Intro', 4], ['Hook', 8], ['Verse', 16], ['Hook', 8], ['Verse', 16], ['Hook', 8], ['Outro', 4]] },
  short: { label: 'Short song', desc: 'For TikTok and Reels: Hook, Verse, Hook', parts: [['Intro', 2], ['Hook', 8], ['Verse', 8], ['Hook', 8]] },
  melodic: { label: 'Melodic or R&B', desc: 'Verses with pre-hooks, plus a bridge', parts: [['Intro', 4], ['Verse', 8], ['Pre-hook', 4], ['Hook', 8], ['Verse', 8], ['Pre-hook', 4], ['Hook', 8], ['Bridge', 4], ['Hook', 8], ['Outro', 4]] },
  freestyle: { label: 'Freestyle', desc: 'One long verse', parts: [['Intro', 4], ['Verse', 32], ['Outro', 4]] },
};
const SECTION_ROLES = { Intro: ['melody'], Outro: ['melody'], Hook: ['drums', '808', 'melody'], Verse: ['drums', '808', 'melody'], 'Pre-hook': ['drums', 'melody'], Bridge: ['808', 'melody'] };
function openLayout() {
  $('#layoutChoices').innerHTML = Object.entries(LAYOUTS).map(([k, l]) => `<button data-l="${k}"><b>${l.label}</b><small>${l.desc}</small></button>`).join('');
  $('#layoutChoices').querySelectorAll('button').forEach((b) => { b.onclick = () => { $('#dLayout').close(); applyLayout(b.dataset.l, $('#chkArrange').checked); }; });
  $('#dLayout').showModal();
}
function applyLayout(key, arrange) {
  const l = LAYOUTS[key];
  pushUndo();
  const counts = {}, totals = {};
  for (const [n] of l.parts) totals[n] = (totals[n] || 0) + 1;
  let bar = 0;
  S.markers = l.parts.map(([n, bars]) => {
    counts[n] = (counts[n] || 0) + 1;
    const m = { name: totals[n] > 1 ? `${n} ${counts[n]}` : n, bar, bars };
    bar += bars;
    return m;
  });
  let arranged = false;
  if (arrange) {
    const patTracks = S.tracks.filter((t) => t.clips.some((c) => c.kind === 'pat'));
    if (patTracks.length) {
      const bl = barLen();
      for (const t of patTracks) {
        const patId = t.clips.find((c) => c.kind === 'pat').patId;
        const role = roleOf(t) === 'beat' ? 'melody' : roleOf(t) === 'vocal' ? 'melody' : roleOf(t);
        t.clips = t.clips.filter((c) => c.kind !== 'pat');
        for (const m of S.markers) {
          const base = m.name.replace(/ \d+$/, '');
          if (!(SECTION_ROLES[base] || []).includes(role)) continue;
          t.clips.push({ id: nid('c'), kind: 'pat', patId, start: m.bar * bl, dur: m.bars * bl, offset: 0 });
        }
      }
      arranged = true;
    }
  }
  refreshAll();
  toast(`${l.label} layout added (${bar} bars).${arranged ? ' Your patterns are arranged into it: melody alone in the intro and outro, everything in the hooks.' : ' Click a part name on the ruler to jump there.'}`, 9000);
}
$('#bLayout').onclick = openLayout;
$('#bLayoutCancel').onclick = () => $('#dLayout').close();
$('#bLayoutClear').onclick = () => { $('#dLayout').close(); pushUndo(); S.markers = []; draw(); };

/* ---------- auto-tune ---------- */
let tuneTarget = null;
function openTune(t, c) {
  tuneTarget = { t, c };
  $('#tuneKey').innerHTML = ALL_KEYS.map((k) => `<option>${k}</option>`).join('');
  $('#tuneKey').value = S.key || 'C minor';
  $('#dTune').showModal();
}
$('#bTuneCancel').onclick = () => $('#dTune').close();
$('#bTuneGo').onclick = async () => {
  $('#dTune').close();
  const { c } = tuneTarget || {};
  const b = c && bufOf(c);
  if (!b) return;
  if (b.buffer.duration > 360) { toast('That clip is too long for auto-tune. Use it on vocal takes, not full songs.'); return; }
  const key = $('#tuneKey').value, style = $('#tuneStyle').value;
  busy('Tuning your vocal. Takes a few seconds per 10 seconds of singing...');
  try {
    const src = b.buffer, mono = new Float32Array(src.length);
    for (let ch = 0; ch < src.numberOfChannels; ch++) { const d = src.getChannelData(ch); for (let i = 0; i < d.length; i++) mono[i] += d[i] / src.numberOfChannels; }
    let buf;
    if (AWAD.local) {
      const j = await apiJson(await fetch(`/api/tune?key=${encodeURIComponent(key)}&style=${style}`, { method: 'POST', body: encodeWav([mono], src.sampleRate) }));
      buf = await fetchBuffer(j.url);
    } else buf = await browserTune(mono, src.sampleRate, key, style);
    const id = nid('r'); addBuffer(id, buf);
    pushUndo();
    c.bufs.push(id); c.take = c.bufs.length - 1;
    if (!S.key) S.key = key;
    syncToolbar(); renderSel(); draw(); restartIfPlaying();
    toast(`Tuned (${style === 'hard' ? 'hard' : 'natural'}, ${key}). It is now take ${c.take + 1}. Use the Take arrows to compare with the original.`, 8000);
  } catch (e) { toast(e.message); }
  unbusy();
};

/* the same engine as Live tune, run over the whole take */
async function browserTune(mono, sr, key, style) {
  const pad = Math.round(sr * 0.035 * 0.5) + 2;
  const oc = new OfflineAudioContext(1, mono.length + pad, sr);
  await oc.audioWorklet.addModule('recorder-worklet.js');
  const b = oc.createBuffer(1, mono.length, sr); b.copyToChannel(mono, 0);
  const s = oc.createBufferSource(); s.buffer = b;
  const tn = new AudioWorkletNode(oc, 'awad-tune', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit', processorOptions: { mode: style, allowed: keyAllowed(key) } });
  s.connect(tn); tn.connect(oc.destination); s.start();
  const out = await oc.startRendering();
  const res = AC.createBuffer(1, mono.length, sr);
  res.copyToChannel(out.getChannelData(0).slice(pad, pad + mono.length), 0);
  return res;
}

/* ---------- quick tooltips ---------- */
(() => {
  const tip = $('#tip');
  let timer = null, cur = null;
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[title],[data-tip]');
    if (!el || el === cur) return;
    if (el.hasAttribute('title')) { el.dataset.tip = el.getAttribute('title'); el.removeAttribute('title'); }
    cur = el;
    clearTimeout(timer);
    tip.style.display = 'none';
    timer = setTimeout(() => {
      if (!cur || !cur.dataset.tip || !document.body.contains(cur)) return;
      tip.textContent = cur.dataset.tip;
      tip.style.display = 'block';
      const r = cur.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
      let x = clamp(r.left + r.width / 2 - tw / 2, 8, window.innerWidth - tw - 8);
      let y = r.bottom + 8;
      if (y + th > window.innerHeight - 8) y = r.top - th - 8;
      tip.style.left = x + 'px'; tip.style.top = y + 'px';
    }, 350);
  });
  document.addEventListener('mouseout', (e) => {
    if (cur && !cur.contains(e.relatedTarget)) { cur = null; clearTimeout(timer); tip.style.display = 'none'; }
  });
  document.addEventListener('pointerdown', () => { clearTimeout(timer); tip.style.display = 'none'; });
})();

/* ---------- startup ---------- */
loadPrefs();
newProject();
window.addEventListener('resize', draw);
window.addEventListener('beforeunload', (e) => {
  if (S.dirty && S.tracks.some((t) => t.clips.length)) { e.preventDefault(); e.returnValue = ''; }
});
requestAnimationFrame(frame);
