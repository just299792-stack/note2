/* =========================================================
   笔记 —— 数据模型 + 存储层 (IndexedDB)
   ========================================================= */

export const LIB_VERSION = 4;

let _idc = 0;
export function newId() {
  _idc = (_idc + 1) % 1000;
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + _idc.toString(36);
}

/* ---------- 初始资料库 ---------- */
export function newLibrary() {
  const subjId = newId();
  const nbId = newId();
  return {
    version: LIB_VERSION,
    settings: {
      fingerDraw: false, tool: 'ballpen', color: '#1e293b', width: 5, shape: 'line',
      penWidth: 5, hlWidth: 14, hlColor: '#fde047',
      toolbar: 'top', eraserSize: 24, eraserMode: 'stroke',
      defaultPaper: { style: 'line', color: 'white' },
      autoPage: true, twoFingerUndo: true, twoFingerAction: 'undo', threeFingerAction: 'redo', noteSort: 'updated', textSize: 26, templates: [
        { id: 'tpl-lecture', name: '听课笔记', paper: { style: 'cornell', color: 'white' }, bg: null, createdAt: 0 },
        { id: 'tpl-meeting', name: '会议记录', paper: { style: 'line', color: 'white' }, bg: null, createdAt: 0 },
        { id: 'tpl-todo', name: '待办清单', paper: { style: 'check', color: 'white' }, bg: null, createdAt: 0 },
        { id: 'tpl-daily', name: '日程计划', paper: { style: 'planner', color: 'white' }, bg: null, createdAt: 0 }
      ],
      theme: 'auto', accent: 'blue', paperZoom: 1,
      favorites: [], favoritesBar: true,
      penStyle: 'normal', ballpenStyle: 'normal',
      textPresets: [], autoBackup: true
    },
    subjects: [
      { id: subjId, name: '我的项目', notebooks: [ { id: nbId, name: '我的笔记本', noteIds: [] } ] }
    ],
    notes: {},
    active: { subjectId: subjId, notebookId: nbId, noteId: null, pageIndex: 0 }
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

/* ---------- IndexedDB ---------- */
const DB_NAME = 'note2';
const DB_VER = 3;
const STORE = 'library';
const AUDIO_STORE = 'audio';
const SNAP_STORE = 'snapshots';

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(AUDIO_STORE)) db.createObjectStore(AUDIO_STORE);
      if (!db.objectStoreNames.contains(SNAP_STORE)) db.createObjectStore(SNAP_STORE);
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

/* 从本地备份恢复（读取失败/升级异常时的兜底） */
export function loadLocalBackup() {
  try {
    const raw = localStorage.getItem('note2-backup');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed ? sanitize(parsed) : null;
  } catch (_) { return null; }
}

/* ---------- 数据清洗 / 兼容导入 ---------- */
export function sanitize(raw) {
  if (!raw || typeof raw !== 'object') return newLibrary();
  const lib = raw;
  const fromVersion = Number(lib.version) || 1;
  lib.version = LIB_VERSION;
  lib.settings = Object.assign({
    fingerDraw: false, tool: 'ballpen', color: '#1e293b', width: 5, shape: 'line',
    penWidth: 5, hlWidth: 14, hlColor: '#fde047',
    toolbar: 'top', eraserSize: 24, eraserMode: 'stroke',
    defaultPaper: { style: 'line', color: 'white' },
    autoPage: true, twoFingerUndo: true, twoFingerAction: 'undo', threeFingerAction: 'redo', noteSort: 'updated', textSize: 26, templates: [],
    theme: 'auto', accent: 'blue', paperZoom: 1,
    favorites: [], favoritesBar: true,
    penStyle: 'normal', ballpenStyle: 'normal',
    textPresets: [], autoBackup: true
  }, lib.settings || {});
  if (!lib.settings.theme) lib.settings.theme = 'auto';
  if (!lib.settings.noteSort) lib.settings.noteSort = 'updated';
  if (!lib.settings.textSize) lib.settings.textSize = 26;
  // v3 -> v4：工具栏默认改为顶部（尊重用户最新偏好）
  if (fromVersion < 4 && lib.settings.toolbar === 'left') lib.settings.toolbar = 'top';
  // 迁移：旧 twoFingerUndo 开关 -> twoFingerAction
  if (!lib.settings.twoFingerAction) {
    lib.settings.twoFingerAction = lib.settings.twoFingerUndo === false ? 'off' : 'undo';
  }
  // v1/v2 -> v3：彻底移除放大镜，补充新设置字段
  if (fromVersion < 3) {
    delete lib.settings.loupe;
    if (!lib.settings.toolbar) lib.settings.toolbar = 'left';
    if (!lib.settings.eraserSize) lib.settings.eraserSize = 24;
    if (!lib.settings.eraserMode) lib.settings.eraserMode = 'stroke';
    if (!lib.settings.defaultPaper) lib.settings.defaultPaper = { style: 'line', color: 'white' };
    if (lib.settings.autoPage === undefined) lib.settings.autoPage = true;
    if (lib.settings.twoFingerUndo === undefined) lib.settings.twoFingerUndo = true;
  }
  if (!Array.isArray(lib.subjects) || lib.subjects.length === 0) {
    const subjId = newId(); const nbId = newId();
    lib.subjects = [{ id: subjId, name: '我的项目', notebooks: [{ id: nbId, name: '导入的笔记本', noteIds: [] }] }];
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
    n.pinned = !!n.pinned;
    n.paper = Object.assign({ style: 'line', color: 'white', spacing: 'normal' }, n.paper || {});
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
    style: ['normal','pencil','brush','dashed','dotted'].includes(st.style) ? st.style : 'normal',
    color: typeof st.color === 'string' ? st.color : '#1e293b',
    width: Number(st.width) || 4,
    points: (st.points || []).map(pt => ({ x: Number(pt.x), y: Number(pt.y), p: Number(pt.p) || 1 }))
  }));
  p.texts = (p.texts || []).map(t => ({
    id: t.id || newId(), x: Number(t.x)||0, y: Number(t.y)||0, w: Number(t.w)||0.3, h: Number(t.h)||0.06,
    text: typeof t.text === 'string' ? t.text : '', fontSize: Number(t.fontSize)||24, color: t.color || '#1e293b', align: t.align || 'left',
    bold: !!t.bold, italic: !!t.italic, underline: !!t.underline
  }));
  p.images = (p.images || []).filter(im => im && typeof im.src === 'string').map(im => ({
    id: im.id || newId(), x: Number(im.x)||0, y: Number(im.y)||0, w: Number(im.w)||0.3, h: Number(im.h)||0.2,
    src: im.src, rot: Number(im.rot) || 0
  }));
  if (p.bg && typeof p.bg.src === 'string') {
    p.bg = { kind: p.bg.kind === 'pdf' ? 'pdf' : 'image', src: p.bg.src, w: Number(p.bg.w) || 816, h: Number(p.bg.h) || 1056 };
  } else delete p.bg;
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

/* ---------- ?????????? ---------- */
export async function saveSnapshot(lib) {
  try {
    const db = await openDB();
    const snap = { id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: Date.now(), library: JSON.parse(JSON.stringify(lib)) };
    await new Promise((resolve, reject) => {
      const tx = db.transaction(SNAP_STORE, 'readwrite');
      tx.objectStore(SNAP_STORE).put(snap, snap.id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    const all = await listSnapshots();
    if (all.length > 10) {
      const rm = all.slice(10);
      const db2 = await openDB();
      await new Promise((resolve, reject) => {
        const tx = db2.transaction(SNAP_STORE, 'readwrite');
        for (const x of rm) tx.objectStore(SNAP_STORE).delete(x.id);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    }
    return snap;
  } catch (_) { return null; }
}
export async function listSnapshots() {
  try {
    const db = await openDB();
    const all = await new Promise((resolve, reject) => {
      const tx = db.transaction(SNAP_STORE, 'readonly');
      const req = tx.objectStore(SNAP_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    return all.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  } catch (_) { return []; }
}
export async function loadSnapshot(id) {
  try {
    const db = await openDB();
    const snap = await new Promise((resolve, reject) => {
      const tx = db.transaction(SNAP_STORE, 'readonly');
      const req = tx.objectStore(SNAP_STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    return snap && snap.library ? sanitize(snap.library) : null;
  } catch (_) { return null; }
}
export async function deleteSnapshot(id) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(SNAP_STORE, 'readwrite');
      tx.objectStore(SNAP_STORE).delete(id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (_) {}
}

