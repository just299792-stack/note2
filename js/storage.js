/* =========================================================
   笔记 —— 数据模型 + 存储层 (IndexedDB)
   ========================================================= */
import { PAGE_W, PAGE_H } from './drawing.js';

export const LIB_VERSION = 3;

let _idc = 0;
export function newId() {
  _idc = (_idc + 1) % 1000;
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + _idc.toString(36);
}

/* ---------- 初始资料库 ---------- */
export function newLibrary() {
  const subjId = newId();
  const nbId = newId();
  const note = newNote(nbId, '欢迎使用笔记 ✍️');
  note.paper = { style: 'line', color: 'white' };
  const p = note.pages[0];
  p.strokes = demoStrokes();
  p.texts = [
    { id: newId(), x: 0.10, y: 0.08, w: 0.62, h: 0.09, text: '欢迎使用「笔记」', fontSize: 42, color: '#1e293b', align: 'left' },
    { id: newId(), x: 0.10, y: 0.16, w: 0.8, h: 0.07, text: '像 Notability 一样书写、整理、导出你的笔记。', fontSize: 24, color: '#64748b', align: 'left' }
  ];
  return {
    version: LIB_VERSION,
    settings: {
      fingerDraw: false, tool: 'pen', color: '#1e293b', width: 5, shape: 'line',
      penWidth: 5, hlWidth: 14, hlColor: '#fde047',
      toolbar: 'left', eraserSize: 24,
      defaultPaper: { style: 'line', color: 'white' },
      autoPage: true, twoFingerUndo: true
    },
    subjects: [
      { id: subjId, name: '我的科目', notebooks: [ { id: nbId, name: '我的笔记本', noteIds: [note.id] } ] }
    ],
    notes: { [note.id]: note },
    active: { subjectId: subjId, notebookId: nbId, noteId: note.id, pageIndex: 0 }
  };
}

export function newNote(notebookId, title, paper) {
  const now = Date.now();
  return {
    id: newId(), notebookId, title: title || '未命名笔记',
    createdAt: now, updatedAt: now,
    paper: paper || { style: 'line', color: 'white' },
    pages: [ newPage() ]
  };
}

export function newPage() {
  return { id: newId(), strokes: [], texts: [] };
}

/* ---------- 示例笔画 ---------- */
function demoStrokes() {
  const mk = (tool, color, width, pts) => ({ id: newId(), tool, color, width, points: pts });
  const pts = (xs) => xs.map(([x, y, p]) => ({ x: x * PAGE_W, y: y * PAGE_H, p: p ?? 1 }));
  return [
    mk('pen', '#1e293b', 5, pts([
      [0.10, 0.34],[0.115,0.345],[0.13,0.35],[0.15,0.356],[0.17,0.362],[0.19,0.368],[0.21,0.372],[0.24,0.376],
      [0.27,0.38],[0.30,0.383],[0.33,0.385],[0.36,0.386],[0.39,0.387],[0.42,0.388],[0.45,0.388],[0.48,0.387],
      [0.51,0.386],[0.54,0.384],[0.57,0.382],[0.60,0.379],[0.63,0.375],[0.66,0.371],[0.69,0.366],[0.72,0.36]
    ])),
    mk('highlighter', '#fbbf24', 16, pts([
      [0.10, 0.47],[0.14,0.472],[0.18,0.474],[0.22,0.475],[0.27,0.476],[0.33,0.477],[0.39,0.477],[0.46,0.476],
      [0.53,0.475],[0.60,0.474],[0.68,0.472],[0.76,0.47]
    ])),
    mk('pen', '#2563eb', 5, pts([
      [0.10, 0.58],[0.115,0.575],[0.13,0.57],[0.15,0.562],[0.17,0.552],[0.19,0.542],[0.21,0.532],[0.24,0.52],
      [0.27,0.508],[0.30,0.497],[0.33,0.487],[0.36,0.478],[0.39,0.47],[0.42,0.463],[0.45,0.457],[0.48,0.452],
      [0.51,0.448],[0.54,0.445],[0.57,0.443],[0.60,0.442],[0.63,0.442],[0.66,0.443],[0.69,0.445],[0.72,0.448],
      [0.75,0.452],[0.78,0.457],[0.81,0.463]
    ])),
    mk('pen', '#dc2626', 4, pts([
      [0.10, 0.70],[0.115,0.695],[0.13,0.688],[0.15,0.68],[0.17,0.67],[0.19,0.66],[0.21,0.648],[0.24,0.634],
      [0.27,0.62],[0.30,0.606],[0.33,0.594],[0.36,0.584],[0.39,0.576],[0.42,0.57],[0.45,0.566],[0.48,0.563],
      [0.51,0.562],[0.54,0.562],[0.57,0.564],[0.60,0.567],[0.63,0.572],[0.66,0.578],[0.69,0.585],[0.72,0.594]
    ]))
  ];
}

/* ---------- IndexedDB ---------- */
const DB_NAME = 'note2';
const DB_VER = 2;
const STORE = 'library';
const AUDIO_STORE = 'audio';

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(AUDIO_STORE)) db.createObjectStore(AUDIO_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

export async function loadLibrary() {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get('main');
      req.onsuccess = () => resolve(req.result ? sanitize(req.result) : null);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('IndexedDB 不可用，使用内存模式', err);
    return null;
  }
}

export async function saveLibrary(lib) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(lib, 'main');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    // 本地备用备份
    try { localStorage.setItem('note2-backup', JSON.stringify(lib)); } catch (_) {}
  } catch (err) {
    console.warn('保存失败', err);
    // 退而求其次：仅存 localStorage
    try { localStorage.setItem('note2-backup', JSON.stringify(lib)); } catch (_) {}
  }
}

/* ---------- 数据清洗 / 兼容导入 ---------- */
export function sanitize(raw) {
  if (!raw || typeof raw !== 'object') return newLibrary();
  const lib = raw;
  lib.version = LIB_VERSION;
  lib.settings = Object.assign({
    fingerDraw: false, tool: 'pen', color: '#1e293b', width: 5, shape: 'line',
    penWidth: 5, hlWidth: 14, hlColor: '#fde047',
    toolbar: 'left', eraserSize: 24,
    defaultPaper: { style: 'line', color: 'white' },
    autoPage: true, twoFingerUndo: true
  }, lib.settings || {});
  // v1/v2 -> v3：彻底移除放大镜，补充新设置字段
  if (raw.version < 3) {
    delete lib.settings.loupe;
    if (!lib.settings.toolbar) lib.settings.toolbar = 'left';
    if (!lib.settings.eraserSize) lib.settings.eraserSize = 24;
    if (!lib.settings.defaultPaper) lib.settings.defaultPaper = { style: 'line', color: 'white' };
    if (lib.settings.autoPage === undefined) lib.settings.autoPage = true;
    if (lib.settings.twoFingerUndo === undefined) lib.settings.twoFingerUndo = true;
  }
  if (!Array.isArray(lib.subjects) || lib.subjects.length === 0) {
    const subjId = newId(); const nbId = newId();
    lib.subjects = [{ id: subjId, name: '我的科目', notebooks: [{ id: nbId, name: '导入的笔记本', noteIds: [] }] }];
  }
  lib.notes = lib.notes || {};
  // 清理 subjects/notes 引用
  const known = new Set(Object.keys(lib.notes));
  for (const s of lib.subjects) {
    s.notebooks = (s.notebooks || []).filter(nb => Array.isArray(nb.noteIds));
    for (const nb of s.notebooks) {
      nb.noteIds = (nb.noteIds || []).filter(id => known.has(id));
    }
  }
  for (const id of Object.keys(lib.notes)) {
    const n = lib.notes[id];
    if (!n || typeof n !== 'object') { delete lib.notes[id]; continue; }
    n.id = n.id || id;
    n.title = typeof n.title === 'string' ? n.title : '未命名笔记';
    n.paper = Object.assign({ style: 'line', color: 'white' }, n.paper || {});
    n.pages = Array.isArray(n.pages) && n.pages.length ? n.pages : [newPage()];
    n.pages = n.pages.map(sanitizePage);
  }
  // active 兜底
  const firstNb = lib.subjects[0]?.notebooks[0];
  const firstNote = firstNb?.noteIds[0] && lib.notes[firstNb.noteIds[0]];
  lib.active = lib.active && lib.notes[lib.active.noteId]
    ? { subjectId: lib.active.subjectId, notebookId: lib.active.notebookId, noteId: lib.active.noteId, pageIndex: lib.active.pageIndex || 0 }
    : { subjectId: lib.subjects[0].id, notebookId: firstNb?.id, noteId: firstNote?.id, pageIndex: 0 };
  return lib;
}

function sanitizePage(p) {
  p.id = p.id || newId();
  p.strokes = (p.strokes || []).map(st => ({
    id: st.id || newId(),
    tool: st.tool === 'highlighter' ? 'highlighter' : 'pen',
    color: typeof st.color === 'string' ? st.color : '#1e293b',
    width: Number(st.width) || 4,
    points: (st.points || []).map(pt => ({ x: Number(pt.x), y: Number(pt.y), p: Number(pt.p) || 1 }))
  }));
  p.texts = (p.texts || []).map(t => ({
    id: t.id || newId(), x: Number(t.x)||0, y: Number(t.y)||0, w: Number(t.w)||0.3, h: Number(t.h)||0.06,
    text: typeof t.text === 'string' ? t.text : '', fontSize: Number(t.fontSize)||24, color: t.color || '#1e293b', align: t.align || 'left'
  }));
  return p;
}

/* ---------- 查找辅助 ---------- */
export function findNote(lib, noteId) { return lib.notes[noteId] || null; }

export function findNotebook(lib, notebookId) {
  for (const s of lib.subjects) for (const nb of s.notebooks) if (nb.id === notebookId) return { subject: s, notebook: nb };
  return null;
}

export function listNotes(lib, notebookId) {
  const f = findNotebook(lib, notebookId);
  if (!f) return [];
  return f.notebook.noteIds.map(id => lib.notes[id]).filter(Boolean);
}
/* ---------- 录音存储（本地 IndexedDB，不进库 JSON） ---------- */
export async function saveAudioBlob(key, blob) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(AUDIO_STORE, 'readwrite');
    tx.objectStore(AUDIO_STORE).put(blob, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
export async function getAudioBlob(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AUDIO_STORE, 'readonly');
    const req = tx.objectStore(AUDIO_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
export async function deleteAudioBlob(key) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(AUDIO_STORE, 'readwrite');
    tx.objectStore(AUDIO_STORE).delete(key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
export async function saveRecMeta(noteId, list) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(AUDIO_STORE, 'readwrite');
    tx.objectStore(AUDIO_STORE).put(list, 'meta:' + noteId);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
export async function getRecMeta(noteId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AUDIO_STORE, 'readonly');
    const req = tx.objectStore(AUDIO_STORE).get('meta:' + noteId);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
export async function saveRecTimeline(noteId, recId, timeline) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(AUDIO_STORE, 'readwrite');
    tx.objectStore(AUDIO_STORE).put(timeline, 'timeline:' + noteId + ':' + recId);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
export async function getRecTimeline(noteId, recId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AUDIO_STORE, 'readonly');
    const req = tx.objectStore(AUDIO_STORE).get('timeline:' + noteId + ':' + recId);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
export async function deleteRecTimeline(noteId, recId) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(AUDIO_STORE, 'readwrite');
    tx.objectStore(AUDIO_STORE).delete('timeline:' + noteId + ':' + recId);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}


