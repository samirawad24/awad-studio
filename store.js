'use strict';
/* Awad Studio: projects and their audio stored in this browser (IndexedDB), plus .awad project files. */

let dbP = null;
function openDB() {
  if (!dbP) {
    dbP = new Promise((res, rej) => {
      const r = indexedDB.open('awad-studio', 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('projects'); r.result.createObjectStore('audio'); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) { /* optional */ }
  }
  return dbP;
}
async function idb(store, mode, fn) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, mode), req = fn(tx.objectStore(store));
    tx.oncomplete = () => res(req ? req.result : undefined);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error || new Error('Storage is full or blocked.'));
  });
}
const idbGet = (s, k) => idb(s, 'readonly', (st) => st.get(k));
const idbPut = (s, k, v) => idb(s, 'readwrite', (st) => st.put(v, k));
const idbDel = (s, k) => idb(s, 'readwrite', (st) => st.delete(k));
const idbAll = (s) => idb(s, 'readonly', (st) => st.getAll());
const idbKeys = (s) => idb(s, 'readonly', (st) => st.getAllKeys());

function bufferToWavBlob(b) {
  const chs = [];
  for (let c = 0; c < b.numberOfChannels; c++) chs.push(b.getChannelData(c));
  return new Blob([encodeWav(chs, b.sampleRate)], { type: 'audio/wav' });
}
async function blobToBuffer(blob) {
  await ensureCtx();
  return AC.decodeAudioData(await blob.arrayBuffer());
}
function usedBufferIds() {
  const ids = new Set();
  for (const t of S.tracks) for (const c of t.clips) if (c.bufs) c.bufs.forEach((b) => ids.add(b));
  for (const ch of S.channels) if (ch.bufId) ids.add(ch.bufId);
  return [...ids].filter((id) => buffers.has(id));
}
function projectState() {
  return {
    v: 2, name: S.projectName, bpm: S.bpm, key: S.key, tracks: S.tracks, loop: S.loop, channels: S.channels,
    patterns: S.patterns, curPat: S.curPat, curCh: S.curCh, markers: S.markers, master: S.master, mode: S.mode,
  };
}
const storedAudio = new Set();
async function storeSave(name) {
  const ids = usedBufferIds();
  if (!storedAudio.size) (await idbKeys('audio')).forEach((k) => storedAudio.add(k));
  for (const id of ids) {
    if (storedAudio.has(id)) continue;
    await idbPut('audio', id, bufferToWavBlob(buffers.get(id).buffer));
    storedAudio.add(id);
  }
  await idbPut('projects', name, { name, modified: Date.now(), data: projectState(), audio: ids });
}
async function storeList() {
  const all = await idbAll('projects');
  return all.sort((a, b) => b.modified - a.modified);
}
async function storeLoad(name) {
  const rec = await idbGet('projects', name);
  if (!rec) throw new Error('Project not found.');
  for (const id of rec.audio || []) {
    if (buffers.has(id)) continue;
    const blob = await idbGet('audio', id);
    if (blob) addBuffer(id, await blobToBuffer(blob));
  }
  return rec.data;
}
async function storeDelete(name) {
  await idbDel('projects', name);
  // drop audio no other project uses
  const keep = new Set();
  for (const p of await idbAll('projects')) (p.audio || []).forEach((id) => keep.add(id));
  for (const id of await idbKeys('audio')) if (!keep.has(id)) { await idbDel('audio', id); storedAudio.delete(id); }
}

/* .awad file: [4-byte header length][header JSON][audio blobs back to back] */
async function exportProjectFile() {
  const ids = usedBufferIds(), blobs = ids.map((id) => bufferToWavBlob(buffers.get(id).buffer));
  const header = JSON.stringify({ app: 'awad-studio', data: projectState(), audio: ids.map((id, i) => ({ id, size: blobs[i].size })) });
  const hb = new TextEncoder().encode(header), len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, hb.length, true);
  return new Blob([len, hb, ...blobs], { type: 'application/octet-stream' });
}
async function importProjectFile(file) {
  const ab = await file.arrayBuffer();
  const hl = new DataView(ab).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, 4, hl)));
  if (header.app !== 'awad-studio') throw new Error('That is not an Awad Studio project file.');
  let o = 4 + hl;
  for (const a of header.audio) {
    const blob = new Blob([new Uint8Array(ab, o, a.size)], { type: 'audio/wav' });
    o += a.size;
    if (!buffers.has(a.id)) addBuffer(a.id, await blobToBuffer(blob));
  }
  return header.data;
}
