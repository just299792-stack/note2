/* =========================================================
   笔记 —— 主应用
   ========================================================= */
import { newId, newLibrary, newNote, newPage, loadLibrary, saveLibrary, loadLocalBackup, sanitize, findNote, findNotebook,
  saveAudioBlob, getAudioBlob, deleteAudioBlob, saveRecMeta, getRecMeta,
  saveRecTimeline, getRecTimeline, deleteRecTimeline,
  saveSnapshot, listSnapshots, loadSnapshot, deleteSnapshot } from './storage.js';
import { DrawingEngine, PAGE_W, PAGE_H, renderPageToCanvas, paperInfo } from './drawing.js';
import { canvasesToPdf } from './pdf.js';

const APP_VERSION = '5.50';
const $ = (s) => document.querySelector(s);
const FONT = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

/* 全局文字字体（Notability 字体选择） */
function currentFont() {
  const f = (state.lib && state.lib.settings && state.lib.settings.fontFamily) || 'system';
  if (f === 'rounded') return 'ui-rounded, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
  if (f === 'serif') return 'Georgia, "Songti SC", "STSong", "SimSun", serif';
  if (f === 'mono') return '"SF Mono", Menlo, Consolas, monospace';
  return FONT;
}


const PEN_COLORS = ['#1e293b','#0f172a','#475569','#94a3b8','#ffffff','#dc2626','#ea580c','#d97706','#16a34a','#0891b2','#2563eb','#7c3aed','#db2777'];
const HL_COLORS = ['#fde047','#fef08a','#fdba74','#fca5a5','#86efac','#5eead4','#7dd3fc','#c4b5fd','#f9a8d4','#fda4af'];
const PAPER_STYLES = [ { id: 'blank', name: '空白' }, { id: 'line', name: '横线' }, { id: 'grid', name: '方格' }, { id: 'dot', name: '点阵' }, { id: 'cornell', name: '康奈尔' } ];
const PAPER_COLORS = ['white', 'cream', 'grey', 'black', 'blue', 'green'];
const ACCENTS = { blue: '#2563eb', purple: '#7c3aed', pink: '#db2777', green: '#16a34a', orange: '#ea580c', slate: '#475569' };

const state = {
  lib: null,
  tool: 'ballpen', color: '#1e293b', shape: 'line',
  colors: { pen: '#1e293b', highlighter: '#fde047', ballpen: '#1e293b' },
  widths: { pen: 5, highlighter: 14, eraser: 24, ballpen: 5 },
  styles: { pen: 'normal', ballpen: 'normal' },
  pageIndex: 0,
  activeNoteId: null, activeNotebookId: null, activeSubjectId: null,
  collapsedSubjects: new Set(),
  auth: null,
  authAvailable: false,
  rec: { active: false, recorder: null, media: null, chunks: [], startTime: 0, timer: null, noteId: null, pageId: null, baseCount: 0, timeline: [], playingId: null, audioEl: null, playback: false, playbackTimers: [], speed: 1 },
  recSupported: !!(navigator.mediaDevices && window.MediaRecorder),
  searchQuery: '',
  prevTool: null,
  noteSort: 'updated',
  tagFilter: null,
  showRecent: false,
  saving: false,
  multi: { on: false, selected: new Set() }
};
let history = [];
let histIdx = -1;
let saveTimer = null;

/* ---------------- 工具 ---------------- */
function currentNote() { return state.lib && state.activeNoteId ? state.lib.notes[state.activeNoteId] : null; }
function currentPage() { const n = currentNote(); return n ? n.pages[state.pageIndex] : null; }
function pageW() { const p = currentPage(); return (p && p.pageW) || PAGE_W; }
function pageH() { const p = currentPage(); return (p && p.pageH) || PAGE_H; }
function settings() {
  return {
    tool: state.tool, color: state.color, shape: state.shape,
    width: state.widths[state.tool] || 5,
    style: state.styles[state.tool] || 'normal',
    fingerDraw: !!state.lib.settings.fingerDraw,
    eraserSize: state.lib.settings.eraserSize || 24,
    eraserMode: state.lib.settings.eraserMode || 'stroke'
  };
}

/* ---------------- 引擎 ---------------- */
let twoFingerTurnLock = 0;
let fitScaleRef = 0;
let _zoomSaveTimer = 0;
const engine = new DrawingEngine($('#viewCanvas'), {
  getPage: () => currentPage(),
  getPaper: () => currentNote() ? currentNote().paper : { style: 'line', color: 'white' },
  getPageSize: () => { const n = currentNote(); return { w: (n && n.pageW) || PAGE_W, h: (n && n.pageH) || PAGE_H }; },
  getSettings: settings,
  getFont: () => currentFont(),
  onStrokeDone: (st, holdMs) => {
    const hold = holdMs || 0;
    if (hold >= 250 && (st.tool === 'pen' || st.tool === 'ballpen') && tryRecognizeShape(st)) return;
    recCapture('stroke', st);
    mutate(() => currentPage().strokes.push(st), '书写');
    maybeAutoAdvance(st);
  },
  onDwellCheck: (st) => {
    if (st.tool !== 'pen' && st.tool !== 'ballpen') return false;
    return tryRecognizeShape(st);
  },
  onShapeDone: (st) => { recCapture('stroke', st); mutate(() => currentPage().strokes.push(st), '形状'); },
  onEraseDone: (ids) => {
    recCapture('erase', { ids });
    mutate(() => { currentPage().strokes = currentPage().strokes.filter(s => !ids.includes(s.id)); }, '擦除');
    switchBackFromEraser();
  },
  onPixelEraseDone: (path, radius) => {
    const page = currentPage();
    if (!page || !path || path.length < 2) return;
    const newStrokes = pixelErase(page, path, radius);
    if (newStrokes) { mutate(() => { page.strokes = newStrokes; }, '擦除'); switchBackFromEraser(); }
  },
  onLassoMoveStart: () => { moveBefore = pageSnapshot(currentPage()); },
  onPageContentChanged: () => {
    const page = currentPage();
    if (!page) return;
    const after = pageSnapshot(page);
    if (moveBefore !== null && moveBefore !== after) {
      pushHistory('移动', () => restoreContent(page, moveBefore), () => restoreContent(page, after));
    }
    moveBefore = null;
    saveSoon(true);
  },
  onTextTap: (w) => {
    const page = currentPage();
    if (page) {
      const hit = page.texts.find(t =>
        w.x >= t.x * pageW() && w.x <= (t.x + t.w) * pageW() &&
        w.y >= t.y * pageH() && w.y <= (t.y + t.h) * pageH()
      );
      if (hit) { editTextItem(hit); return; }
    }
    createTextEdit(w);
  },
  onTwoFingerTap: () => {
    const a = state.lib.settings.twoFingerAction || 'undo';
    if (a === 'undo') undo();
    else if (a === 'redo') redo();
  },
  onThreeFingerTap: () => {
    // 三指轻点 = 取消撤销（重做）
    const act = state.lib.settings.threeFingerAction || 'redo';
    if (act === 'redo') redo();
  },
  onSelection: (ids) => {
    const bar = $('#selBar');
    if (bar) bar.classList.toggle('hidden', !(ids && ids.length));
    const rt = $('#selRotate');
    if (rt) rt.style.display = (ids && ids.some(id => id.startsWith('i:'))) ? '' : 'none';
  },
  onTwoFingerScroll: (dy, dx) => {
    // 双指左右滑 = 翻页；双指上下滑 = 连续滚动纸张
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 40) {
      if (Date.now() - twoFingerTurnLock < 400) return true;
      twoFingerTurnLock = Date.now();
      if (dx < 0) switchPage(state.pageIndex + 1); else switchPage(state.pageIndex - 1);
      return true;
    }
    const ph = $('#paperHolder');
    if (!ph) return false;
    const before = ph.scrollTop;
    ph.scrollTop -= dy;
    return ph.scrollTop !== before;
  },
  onZoom: (ns) => {
    // 连续纸视图：缩放时所有页面一起变宽窄（CSS --paper-zoom），引擎保持 fit
    if (!fitScaleRef) fitScaleRef = ns;
    const f = Math.max(0.5, Math.min(2.5, ns / fitScaleRef));
    document.documentElement.style.setProperty('--paper-zoom', String(f));
    if (state.lib && state.lib.settings) {
      state.lib.settings.paperZoom = Math.round(f * 100) / 100;
      clearTimeout(_zoomSaveTimer);
      _zoomSaveTimer = setTimeout(() => saveLibrary(state.lib), 800);
    }
    engine.fitView();
    fitScaleRef = engine.scale;
    engine.invalidateRaster();
  }
});
let moveBefore = null;

/* ---------------- 形状识别 ---------------- */
const SHAPE_NAMES = { line: '直线', curve: '曲线', polygon: '多边形', ellipse: '椭圆', rect: '长方形', square: '正方形', circle: '圆形' };

/* 自动识别形状：按住 250ms（不松手）或松手时都会调用 */
function tryRecognizeShape(st) {
  const det = detectShape(st.points);
  if (!det) return false;
  // 磁吸到网格：矩形/正方形/圆/椭圆对齐到 38px 网格线
  if (det.kind === 'rect' || det.kind === 'square' || det.kind === 'circle' || det.kind === 'ellipse') {
    det.points = det.points.map(pt => ({ x: Math.round(pt.x / 38) * 38, y: Math.round(pt.y / 38) * 38 }));
  }
  const shapeStroke = { id: st.id, tool: 'pen', shape: det.kind, color: st.color, width: st.width, points: det.points };
  recCapture('stroke', shapeStroke);
  mutate(() => currentPage().strokes.push(shapeStroke), '形状识别');
  toast('已识别为' + (SHAPE_NAMES[det.kind] || det.kind));
  maybeAutoAdvance(shapeStroke);
  return true;
}

function detectShape(points) {
  if (!points || points.length < 5) return null;
  const n = points.length;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
  const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
  const diag = Math.hypot(bw, bh);
  const start = points[0], end = points[n - 1];
  const closed = Math.hypot(end.x - start.x, end.y - start.y) < diag * 0.18;
  const lineFit = fitLine(points);
  if (!closed && lineFit.maxDev < diag * 0.09) {
    return { kind: 'line', points: [{ x: start.x, y: start.y }, { x: end.x, y: end.y }] };
  }
  if (closed) {
    // 长方形 / 正方形：点贴合包围盒边缘
    if (rectFitOk(points, minX, minY, bw, bh, diag)) {
      const aspect = Math.max(bw, bh) / Math.max(1, Math.min(bw, bh));
      return { kind: aspect < 1.15 ? 'square' : 'rect', points: [{ x: minX, y: minY }, { x: maxX, y: maxY }] };
    }
    const corners = rdp(points, diag * 0.08);
    if (corners.length >= 3 && corners.length <= 8 && polyFitOk(points, corners, diag)) {
      return { kind: 'polygon', points: corners };
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    let sumR = 0;
    for (const p of points) sumR += Math.hypot(p.x - cx, p.y - cy);
    const avgR = sumR / points.length;
    let maxDev = 0;
    for (const p of points) maxDev = Math.max(maxDev, Math.abs(Math.hypot(p.x - cx, p.y - cy) - avgR));
    if (maxDev < diag * 0.14) {
      const aspect = Math.max(bw, bh) / Math.max(1, Math.min(bw, bh));
      return { kind: aspect < 1.15 ? 'circle' : 'ellipse', points: [{ x: minX, y: minY }, { x: maxX, y: maxY }] };
    }
  }
  if (!closed && lineFit.maxDev < diag * 0.45) {
    return { kind: 'curve', points: points.map(p => ({ x: p.x, y: p.y })) };
  }
  return null;
}
function fitLine(points) {
  const n = points.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of points) { sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; }
  const denom = n * sxx - sx * sx;
  let a, b;
  if (Math.abs(denom) > 1e-6) { a = (n * sxy - sx * sy) / denom; b = (sy - a * sx) / n; }
  else { a = Infinity; b = sx / n; }
  let maxDev = 0;
  for (const p of points) {
    const d = a === Infinity ? Math.abs(p.x - b) : Math.abs(a * p.x - p.y + b) / Math.sqrt(a * a + 1);
    if (d > maxDev) maxDev = d;
  }
  return { maxDev };
}
function rdp(pts, eps) {
  const n = pts.length;
  if (n <= 2) return pts.slice();
  let maxD = 0, idx = 0;
  const a = pts[0], b = pts[n - 1];
  for (let i = 1; i < n - 1; i++) {
    const d = distToSeg(pts[i].x, pts[i].y, a.x, a.y, b.x, b.y);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD > eps) {
    const left = rdp(pts.slice(0, idx + 1), eps);
    const right = rdp(pts.slice(idx), eps);
    return left.slice(0, -1).concat(right);
  }
  return [pts[0], pts[n - 1]];
}
function rectFitOk(points, minX, minY, bw, bh, diag) {
  const maxX = minX + bw, maxY = minY + bh;
  let maxD = 0;
  for (const p of points) {
    const d = Math.min(Math.abs(p.y - minY), Math.abs(p.y - maxY), Math.abs(p.x - minX), Math.abs(p.x - maxX));
    if (d > maxD) maxD = d;
  }
  if (maxD >= diag * 0.10) return false;
  // 四角附近都要有点（排除圆形）
  const tol = diag * 0.085;
  const corners = [[minX, minY], [maxX, minY], [minX, maxY], [maxX, maxY]];
  for (const [cxp, cyp] of corners) {
    let ok = false;
    for (const p of points) {
      if (Math.hypot(p.x - cxp, p.y - cyp) < tol) { ok = true; break; }
    }
    if (!ok) return false;
  }
  return true;
}
function polyFitOk(points, polyPts, diag) {
  const m = polyPts.length;
  let maxD = 0;
  for (const p of points) {
    let best = Infinity;
    for (let i = 0; i < m; i++) {
      const a = polyPts[i], b = polyPts[(i + 1) % m];
      best = Math.min(best, distToSeg(p.x, p.y, a.x, a.y, b.x, b.y));
    }
    if (best > maxD) maxD = best;
  }
  return maxD < diag * 0.08;
}

/* ---------------- 像素橡皮擦 ---------------- */
function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  if (!l2) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
function pixelErase(page, path, radius) {
  const segs = [];
  for (let i = 0; i < path.length - 1; i++) segs.push([path[i], path[i + 1]]);
  let changed = false;
  const out = [];
  for (const st of page.strokes) {
    if (st.shape) {
      const [a, b] = st.points;
      if (!a || !b) { out.push(st); continue; }
      const bx = Math.min(a.x, b.x) - 12, by = Math.min(a.y, b.y) - 12;
      const bw = Math.abs(b.x - a.x) + 24, bh = Math.abs(b.y - a.y) + 24;
      const hit = segs.some(([p, q]) =>
        distToSeg(bx, by, p.x, p.y, q.x, q.y) <= radius ||
        distToSeg(bx + bw, by, p.x, p.y, q.x, q.y) <= radius ||
        distToSeg(bx, by + bh, p.x, p.y, q.x, q.y) <= radius ||
        distToSeg(bx + bw, by + bh, p.x, p.y, q.x, q.y) <= radius
      );
      if (hit) { changed = true; continue; }
      out.push(st);
      continue;
    }
    const r = radius + (st.width || 4) / 2;
    const keep = st.points.map(p => !segs.some(([a, b]) => distToSeg(p.x, p.y, a.x, a.y, b.x, b.y) <= r));
    if (keep.every(Boolean)) { out.push(st); continue; }
    changed = true;
    let run = [];
    const pushRun = () => {
      if (run.length >= 2) out.push({ id: newId(), tool: st.tool, color: st.color, width: st.width, points: run });
      run = [];
    };
    for (let i = 0; i < st.points.length; i++) {
      if (keep[i]) run.push(st.points[i]);
      else pushRun();
    }
    pushRun();
  }
  return changed ? out : null;
}

/* ---------------- 自动翻页（写到页尾时） ---------------- */
function maybeAutoAdvance(st) {
  if (state.lib.settings.autoPage === false) return;
  if (!st || st.shape) return;
  let maxY = 0;
  for (const p of st.points) maxY = Math.max(maxY, p.y);
  if (maxY < pageH() * 0.94) return;
  const note = currentNote();
  if (!note) return;
  if (state.pageIndex >= note.pages.length - 1) {
    setTimeout(() => { addPage(); toast('已自动添加新页'); }, 200);
  } else {
    setTimeout(() => switchPage(state.pageIndex + 1), 200);
  }
}

/* ---------------- 历史记录 ---------------- */
function pageSnapshot(page) { return JSON.stringify({ s: page.strokes, t: page.texts, i: page.images || [] }); }
function restoreContent(page, json) {
  const d = JSON.parse(json);
  page.strokes = d.s; page.texts = d.t; if (d.i) page.images = d.i;
  if (page === currentPage()) { engine.invalidateRaster(); refreshThumbs(); }
  saveSoon();
}
function pushHistory(label, undoFn, redoFn) {
  history.length = histIdx + 1;
  history.push({ label, undo: undoFn, redo: redoFn });
  histIdx = history.length - 1;
  updateHistoryUI();
}
function mutate(fn, label) {
  const page = currentPage();
  if (!page) return;
  const before = pageSnapshot(page);
  fn();
  const after = pageSnapshot(page);
  if (before === after) return;
  pushHistory(label, () => restoreContent(page, before), () => restoreContent(page, after));
  // 重绘页面与缩略图，确保笔迹立即显示
  engine.invalidateRaster();
  refreshThumbs();
  saveSoon(true);
}
function undo() {
  const entry = history[histIdx];
  if (!entry) return;
  entry.undo();
  histIdx--;
  updateHistoryUI();
}
function redo() {
  const entry = history[histIdx + 1];
  if (!entry) return;
  entry.redo();
  histIdx++;
  updateHistoryUI();
}
function updateHistoryUI() {
  $('#btnUndo').disabled = histIdx < 0;
  $('#btnRedo').disabled = histIdx >= history.length - 1;
}

/* ---------------- 保存 ---------------- */
function saveSoon(touch) {
  if (state.rec && state.rec.playback) return;
  const note = currentNote();
  if (note && touch) note.updatedAt = Date.now();
  state.saving = true;
  refreshTitleMeta();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const done = () => { state.saving = false; refreshTitleMeta(); };
    if (state.auth) api('/api/library', { method: 'PUT', body: JSON.stringify(state.lib) }).then(done).catch(done);
    else Promise.resolve(saveLibrary(state.lib)).then(done);
    scheduleSnapshot();
  }, 350);
}
async function flushSave() {
  clearTimeout(saveTimer);
  if (state.lib) await saveLibrary(state.lib);
}

/* ---------------- 打开笔记 / 页面 ---------------- */
function getOpenTabs() {
  const st = state.lib.settings;
  if (!Array.isArray(st.tabs)) st.tabs = [];
  return st.tabs;
}

function renderTabs() {
  const bar = $('#noteTabs');
  if (!bar) return;
  const tabs = getOpenTabs().filter(id => state.lib.notes[id]);
  if (state.lib.settings.tabs.length !== tabs.length) state.lib.settings.tabs = tabs;
  if (!tabs.length) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
  bar.classList.remove('hidden');
  bar.innerHTML = '';
  for (const id of tabs) {
    const note = state.lib.notes[id];
    const tab = document.createElement('div');
    tab.className = 'tab' + (id === state.activeNoteId ? ' active' : '');
    tab.title = note.title || '未命名笔记';
    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = note.title || '未命名笔记';
    const close = document.createElement('button');
    close.className = 'tab-close';
    close.setAttribute('aria-label', '关闭');
    close.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><path d="M6.2 6.2l11.6 11.6M17.8 6.2L6.2 17.8"/></svg>';
    close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(id); });
    tab.appendChild(title);
    tab.appendChild(close);
    tab.addEventListener('click', () => { if (state.activeNoteId !== id) openNote(id); });
    bar.appendChild(tab);
  }
  const add = document.createElement('button');
  add.className = 'tab-add';
  add.title = '打开更多笔记';
  add.setAttribute('aria-label', '打开更多笔记');
  add.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><path d="M12 5.5v13M5.5 12h13"/></svg>';
  add.addEventListener('click', openTabPicker);
  bar.appendChild(add);
}

function closeTab(id) {
  const tabs = getOpenTabs();
  const idx = tabs.indexOf(id);
  if (idx < 0) return;
  tabs.splice(idx, 1);
  if (state.activeNoteId === id) {
    const remaining = tabs.filter(x => state.lib.notes[x]);
    if (remaining.length) {
      openNote(remaining[Math.max(0, idx - 1)] || remaining[remaining.length - 1]);
    } else {
      const any = Object.keys(state.lib.notes);
      if (any.length) openNote(any[0]);
      else {
        state.activeNoteId = null;
        renderLibrary();
        engine.setPage(null);
        engine.invalidateRaster();
        updateEmptyState();
      }
    }
  }
  renderTabs();
  saveSoon();
}

function openTabPicker() {
  const notes = Object.values(state.lib.notes);
  if (!notes.length) { toast('还没有笔记'); return; }
  const { body } = modalShell('打开笔记', '<div class="tab-picker"></div>', [{ label: '取消' }]);
  const list = body.querySelector('.tab-picker');
  notes.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  for (const n of notes) {
    const row = document.createElement('div');
    row.className = 'tab-pick-row';
    const name = document.createElement('span');
    name.className = 'tab-pick-name';
    name.textContent = n.title || '未命名笔记';
    const meta = document.createElement('span');
    meta.className = 'tab-pick-meta';
    meta.textContent = n.pages.length + ' 页';
    row.appendChild(name);
    row.appendChild(meta);
    row.addEventListener('click', () => { closeModal(); openNote(n.id); });
    list.appendChild(row);
  }
}

function openNote(noteId, notebookId, subjectId, pageIndex) {
  const note = state.lib.notes[noteId];
  if (!note) return;
  if (state.multi.on) exitMulti();
  const openTabs = getOpenTabs();
  if (!openTabs.includes(noteId)) openTabs.push(noteId);
  state.activeNoteId = noteId;
  state.activeNotebookId = notebookId || note.notebookId || firstNotebookId();
  state.activeSubjectId = subjectId || findNotebook(state.lib, state.activeNotebookId)?.subject.id || state.lib.subjects[0].id;
  state.pageIndex = Math.min(pageIndex || 0, note.pages.length - 1);
  history = []; histIdx = -1; updateHistoryUI();
  $('#titleNote').textContent = note.title;
  $('#titleNote').setAttribute('contenteditable', 'false');
  engine.setPage(currentPage());
  engine.fitView();
  engine.invalidateRaster();
  renderLibrary();
  renderPages();
  renderPaperStack();
  updatePageNav();
  refreshTitleMeta();
  updatePaperUI();
  updateToolUI();
  updateColorUI();
  state.lib.active = { subjectId: state.activeSubjectId, notebookId: state.activeNotebookId, noteId, pageIndex: state.pageIndex };
  pageFade();
  stopPlayback();
  if (!$('#recPanel').classList.contains('hidden')) refreshRecList();
  updateEmptyState();
  saveSoon();
}

function pageFade() {
  const cv = document.querySelector('#viewCanvas');
  if (!cv) return;
  cv.style.transition = 'none';
  cv.style.opacity = '0';
  requestAnimationFrame(() => {
    cv.style.transition = 'opacity .18s ease';
    cv.style.opacity = '1';
  });
}

function switchPage(i) {
  const note = currentNote();
  if (!note || i < 0 || i >= note.pages.length) return;
  if (i === state.pageIndex) return;
  const dir = i > state.pageIndex ? 'right' : 'left';
  state.pageIndex = i;
  engine.setPage(currentPage());
  pageFade();
  engine.fitView();
  engine.invalidateRaster();
  renderPages();
  renderPaperStack();
  updatePageNav();
  state.lib.active.pageIndex = i;
  saveSoon();
  const ph = document.querySelector('.paper-holder');
  if (ph) {
    ph.classList.remove('turning-right', 'turning-left');
    void ph.offsetWidth;
    ph.classList.add('turning-' + dir);
    setTimeout(() => ph.classList.remove('turning-right', 'turning-left'), 340);
  }
  recPageTurn();
}

function applyPagesChange() {
  engine.setPage(currentPage());
  engine.fitView();
  engine.invalidateRaster();
  renderPages();
  renderPaperStack();
  updatePageNav();
  saveSoon(true);
}

function addPage() {
  const note = currentNote();
  if (!note) return;
  const before = note.pages.slice();
  const newP = newPage();
  note.pages.splice(state.pageIndex + 1, 0, newP);
  const after = note.pages.slice();
  pushHistory('添加页面',
    () => { note.pages = before; afterPageArrayRestore(); },
    () => { note.pages = after; afterPageArrayRestore(); });
  state.pageIndex += 1;
  applyPagesChange();
  recPageTurn();
}
function afterPageArrayRestore() {
  const note = currentNote();
  if (!note) return;
  state.pageIndex = Math.min(state.pageIndex, note.pages.length - 1);
  applyPagesChange();
}

function duplicatePage() {
  const note = currentNote();
  const src = currentPage();
  if (!note || !src) return;
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = newId();
  copy.strokes.forEach(s => s.id = newId());
  copy.texts.forEach(t => t.id = newId());
  const before = note.pages.slice();
  note.pages.splice(state.pageIndex + 1, 0, copy);
  const after = note.pages.slice();
  pushHistory('复制页面',
    () => { note.pages = before; afterPageArrayRestore(); },
    () => { note.pages = after; afterPageArrayRestore(); });
  state.pageIndex += 1;
  applyPagesChange();
  recPageTurn();
}

function clearPage() {
  confirmModal('清空当前页？', '当前页的所有笔迹与文字都会被删除。', '清空', true, () => {
    mutate(() => { currentPage().strokes = []; currentPage().texts = []; currentPage().images = []; }, '清空页面');
    toast('已清空当前页');
  });
}

function deletePageAt(i) {
  const note = currentNote();
  if (!note || note.pages.length <= 1) { toast('至少保留一页'); return; }
  confirmModal('删除第 ' + (i + 1) + ' 页？', '这一页上的所有内容都会被删除，且无法恢复。', '删除', true, () => {
    const before = note.pages.slice();
    note.pages.splice(i, 1);
    const after = note.pages.slice();
    pushHistory('删除页面',
      () => { note.pages = before; afterPageArrayRestore(); },
      () => { note.pages = after; afterPageArrayRestore(); });
    if (state.pageIndex >= i) state.pageIndex = Math.max(0, state.pageIndex - 1);
    afterPageArrayRestore();
  });
}

function deletePage() { deletePageAt(state.pageIndex); }

function clearBlankPages() {
  const note = currentNote();
  if (!note) return;
  const blank = [];
  note.pages.forEach((p, idx) => {
    if (!p.strokes.length && !p.texts.length && !(p.images && p.images.length) && !p.bg) blank.push(idx);
  });
  if (!blank.length) { toast('没有空白页'); return; }
  if (note.pages.length - blank.length < 1) { toast('至少保留一页'); return; }
  confirmModal('删除 ' + blank.length + ' 个空白页？', '空白页（无笔迹、文字、图片或背景）将被删除，且无法恢复。', '删除', true, () => {
    const before = note.pages.slice();
    const delSet = new Set(blank);
    note.pages = note.pages.filter((p, idx) => !delSet.has(idx));
    const after = note.pages.slice();
    pushHistory('删除空白页',
      () => { note.pages = before; afterPageArrayRestore(); },
      () => { note.pages = after; afterPageArrayRestore(); });
    let removedBefore = 0;
    for (const idx of blank) if (idx < state.pageIndex) removedBefore++;
    state.pageIndex = Math.max(0, Math.min(state.pageIndex - removedBefore, note.pages.length - 1));
    afterPageArrayRestore();
    toast('已删除 ' + blank.length + ' 个空白页');
  });
}

/* ---------------- 文字工具 ---------------- */
/* ??????? */
function attachTextStyleBar(ta, item) {
  const layer = $('#textLayer');
  const bar = document.createElement('div');
  bar.className = 'text-style-bar';
  const render = () => {
    bar.innerHTML = '';
    bar.style.left = ta.style.left;
    bar.style.top = (parseFloat(ta.style.top) - 40) + 'px';
    const sync = () => {
      ta.style.fontSize = Math.round(item.fontSize * engine.scale) + 'px';
      ta.style.fontWeight = item.bold ? '700' : '400';
      ta.style.fontStyle = item.italic ? 'italic' : 'normal';
      ta.style.textDecoration = item.underline ? 'underline' : 'none';
      ta.style.color = item.color;
    };
    sync();
    const mk = (label, cls, fn) => {
      const b = document.createElement('button');
      b.className = 'ts-btn ' + cls;
      b.textContent = label;
      b.addEventListener('click', fn);
      bar.appendChild(b);
      return b;
    };
    ensureTextPresets();
    (state.lib.settings.textPresets || []).forEach(pr => {
      mk(pr.name, 'ts-preset', () => {
        item.fontSize = pr.fontSize; item.bold = !!pr.bold; item.italic = !!pr.italic; item.underline = !!pr.underline;
        render();
      });
    });
    mk('B', item.bold ? 'active' : '', () => { item.bold = !item.bold; render(); });
    mk('I', item.italic ? 'active' : '', () => { item.italic = !item.italic; render(); });
    mk('U', item.underline ? 'active' : '', () => { item.underline = !item.underline; render(); });
    [18, 26, 34].forEach(v => mk(v + 'px', 'ts-size ' + (item.fontSize === v ? 'active' : ''), () => { item.fontSize = v; render(); }));
    ['#1e293b', '#dc2626', '#2563eb', '#16a34a', '#db2777'].forEach(c => {
      const b = mk('', 'ts-color ' + (item.color === c ? 'active' : ''), () => { item.color = c; render(); });
      b.style.background = c;
    });
    ['#fde047', '#fca5a5', '#86efac', '#7dd3fc', '#c4b5fd', ''].forEach(hc => {
      const b = mk(hc ? '' : '×', 'ts-color hl ' + ((item.hl || '') === hc ? 'active' : ''), () => { item.hl = hc || null; render(); });
      if (hc) b.style.background = hc; else b.title = '清除高亮';
    });
    [['left', '左'], ['center', '中'], ['right', '右']].forEach(([v, l]) => mk(l, 'ts-align ' + (item.align === v ? 'active' : ''), () => { item.align = v; render(); }));
  };
  render();
  layer.appendChild(bar);
  return bar;
}

function createTextEdit(world) {
  const fontSize = state.lib.settings.textSize || 26;
  const color = state.color;
  const pres = (state.lib.settings.textPresets && state.lib.settings.textPresets[1]) || {};
  const item = { id: newId(), x: world.x / pageW(), y: world.y / pageH(), w: 0.3, h: 0.06, text: '', fontSize, color, align: 'left', bold: !!pres.bold, italic: !!pres.italic, underline: !!pres.underline, hl: null };
  const layer = $('#textLayer');
  const ta = document.createElement('textarea');
  ta.className = 'text-edit';
  const sp = engine.worldToScreen(world.x, world.y);
  const scale = engine.scale;
  ta.style.left = sp.x + 'px';
  ta.style.top = sp.y + 'px';
  ta.style.width = Math.max(120, 0.3 * pageW() * scale) + 'px';
  ta.style.minHeight = Math.round(fontSize * 1.4 * scale) + 'px';
  ta.style.fontSize = Math.round(fontSize * scale) + 'px';
  ta.style.color = color;
  ta.style.lineHeight = '1.3';
  ta.placeholder = '输入文字…';
  layer.appendChild(ta);
  const styleBar = attachTextStyleBar(ta, item);
  ta.focus();
  let done = false;
  const finish = () => {
    if (done) return; done = true;
    const text = ta.value.replace(/\n+$/g, '');
    ta.remove();
    if (styleBar) styleBar.remove();
    if (!text) return;
    const mctx = document.createElement('canvas').getContext('2d');
    mctx.font = `600 ${fontSize}px ${FONT}`;
    const lines = text.split('\n');
    let maxW = 0;
    for (const ln of lines) maxW = Math.max(maxW, mctx.measureText(ln).width);
    const pad = 10;
    item.text = text;
    item.w = Math.max(0.12, (maxW + pad * 2) / pageW());
    item.h = (lines.length * fontSize * 1.3 + pad * 2) / pageH();
    mutate(() => currentPage().texts.push(item), '文字');
  };
  ta.addEventListener('blur', finish);
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { done = true; ta.remove(); if (styleBar) styleBar.remove(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') ta.blur();
  });
}

/* ---------------- 文字再次编辑 ---------------- */
function editTextItem(item) {
  const layer = $('#textLayer');
  const ta = document.createElement('textarea');
  ta.className = 'text-edit';
  const sp = engine.worldToScreen(item.x * pageW(), item.y * pageH());
  const scale = engine.scale;
  ta.style.left = sp.x + 'px';
  ta.style.top = sp.y + 'px';
  ta.style.width = Math.max(120, item.w * pageW() * scale) + 'px';
  ta.style.minHeight = Math.round(item.h * pageH() * scale) + 'px';
  ta.style.fontSize = Math.round(item.fontSize * scale) + 'px';
  ta.style.color = item.color;
  ta.value = item.text;
  layer.appendChild(ta);
  const styleBar = attachTextStyleBar(ta, item);
  ta.focus();
  let done = false;
  const finish = () => {
    if (done) return; done = true;
    const text = ta.value.replace(/\n+$/g, '');
    ta.remove();
    if (styleBar) styleBar.remove();
    const page = currentPage();
    if (!page) return;
    if (!text) {
      mutate(() => { page.texts = page.texts.filter(t => t.id !== item.id); }, '删除文字');
      return;
    }
    const mctx = document.createElement('canvas').getContext('2d');
    mctx.font = `600 ${item.fontSize}px ${FONT}`;
    const lines = text.split('\n');
    let maxW = 0;
    for (const ln of lines) maxW = Math.max(maxW, mctx.measureText(ln).width);
    const pad = 10;
    mutate(() => {
      item.text = text;
      item.w = Math.max(0.12, (maxW + pad * 2) / pageW());
      item.h = (lines.length * item.fontSize * 1.3 + pad * 2) / pageH();
    }, '编辑文字');
  };
  ta.addEventListener('blur', finish);
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { done = true; ta.remove(); if (styleBar) styleBar.remove(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') ta.blur();
  });
}

/* ---------------- 工具 UI ---------------- */
function bindUI() {
  // 工具按钮
  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.addEventListener('dblclick', () => {
      if (btn.dataset.tool === 'eraser' || btn.dataset.tool === 'pixelEraser') clearPage();
    });
    btn.addEventListener('click', () => {
      const newTool = btn.dataset.tool;
      if (newTool === 'eraser' || newTool === 'pixelEraser') state.prevTool = state.tool;
      else state.prevTool = null;
      state.tool = newTool;
      if (!state.colors[state.tool]) state.colors[state.tool] = state.tool === 'highlighter' ? '#fde047' : '#1e293b';
      state.color = state.colors[state.tool];
      updateToolUI();
      updateColorUI();
      if (state.tool === 'shape') { $('#colorPop').classList.remove('hidden'); }
      else $('#colorPop').classList.add('hidden');
    });
  });
  // 颜色/粗细
  $('#btnColor').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#colorPop').classList.toggle('hidden');
    updateColorUI();
  });
  $('#widthSlider').addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    state.widths[state.tool] = v;
    if (state.tool === 'pen') state.lib.settings.penWidth = v;
    else if (state.tool === 'highlighter') state.lib.settings.hlWidth = v;
    else if (state.tool === 'ballpen') state.lib.settings.ballpenWidth = v;
    $('#widthValue').textContent = Math.round(v);
    saveLibrary(state.lib);
  });
  document.querySelectorAll('.shape-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.shape = btn.dataset.shape;
      document.querySelectorAll('.shape-btn').forEach(b => b.classList.toggle('active', b === btn));
    });
  });
  // 撤销 / 重做
  $('#btnUndo').addEventListener('click', undo);
  $('#btnRedo').addEventListener('click', redo);
  // 顶栏按钮
  $('#btnLibrary').addEventListener('click', () => {
    if (window.matchMedia('(min-width: 821px)').matches) document.body.classList.toggle('no-library');
    else $('#library').classList.toggle('hidden-mobile');
    engine.resize();
  });
  $('#btnPages').addEventListener('click', () => {
    if (window.matchMedia('(min-width: 821px)').matches) document.body.classList.toggle('no-pages');
    else $('#pagesPanel').classList.toggle('hidden-mobile');
    engine.resize();
  });
  $('#btnMore').addEventListener('click', (e) => {
    e.stopPropagation();
    renderSettings();
    $('#settingsPanel').classList.remove('hidden');
  });
  // 录音
  $('#btnRec').addEventListener('click', (e) => {
    e.stopPropagation();
    const panel = $('#recPanel');
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) refreshRecList();
  });
  $('#recClose').addEventListener('click', () => { $('#recPanel').classList.add('hidden'); stopPlayback(); });
  $('#recToggle').addEventListener('click', toggleRecording);
  $('#btnRec').classList.toggle('hidden', !state.recSupported);
  $('#btnNewNote').addEventListener('click', openNewNoteMenu);
  const rcBtn = $('#btnRecent');
  if (rcBtn) rcBtn.addEventListener('click', () => {
    state.showRecent = !state.showRecent;
    rcBtn.classList.toggle('active', state.showRecent);
    renderNoteList();
  });
  const nsEl = $('#noteSearch');
  if (nsEl) nsEl.addEventListener('input', (e) => { state.searchQuery = e.target.value; renderNoteList(); });
  if (nsEl) nsEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = document.querySelector('#noteList .note-item[data-note]');
      if (first) first.click();
    } else if (e.key === 'Escape') {
      nsEl.value = '';
      state.searchQuery = '';
      renderNoteList();
    }
  });
  const enEl = $('#btnEmptyNew');
  if (enEl) enEl.addEventListener('click', createNote);
  const mmEl = $('#multiMove'); if (mmEl) mmEl.addEventListener('click', moveSelectedNotes);
  const mdEl = $('#multiDelete'); if (mdEl) mdEl.addEventListener('click', deleteSelectedNotes);
  const mcEl = $('#multiCancel'); if (mcEl) mcEl.addEventListener('click', exitMulti);
  $('#btnNewSubject').addEventListener('click', () => promptModal('新建项目', '', '项目名称', '创建', (name) => {
    if (!name) return;
    state.lib.subjects.push({ id: newId(), name, notebooks: [] });
    saveLibrary(state.lib);
    renderLibrary();
    toast('已创建项目');
  }));
  $('#btnNewNotebook').addEventListener('click', () => promptModal('新建笔记本', '', '笔记本名称', '创建', (name) => {
    if (!name) return;
    const subj = findActiveSubject();
    if (!subj) { toast('请先创建项目'); return; }
    subj.notebooks.push({ id: newId(), name, noteIds: [] });
    saveLibrary(state.lib);
    renderLibrary();
    toast('已创建笔记本');
  }));
  // 菜单
  $('#settingsPanel').addEventListener('click', (e) => {
    const item = e.target.closest('.menu-item[data-action]');
    if (!item) return;
    const act = item.dataset.action;
    $('#settingsPanel').classList.add('hidden');
    if (act === 'export-note') exportNote();
    if (act === 'export-pdf') exportPdf();
    if (act === 'export-page-png') exportPagePng();
    if (act === 'export-library') exportLibrary();
    if (act === 'import') $('#fileInput').click();
    if (act === 'import-pdf') $('#pdfInput').click();
    if (act === 'insert-image') $('#imageInput').click();
    if (act === 'insert-camera') $('#cameraInput').click();
    if (act === 'scan-docs') openScanner();
    if (act === 'present') presentMode();
    if (act === 'save-template') promptModal('保存当前页为模板', '', '模板名称', '保存', (nm) => { if (nm) saveCurrentAsTemplate(nm); });
    if (act === 'templates') openTemplateManager();
    if (act === 'new-from-template') openTemplateManager();
    if (act === 'read-aloud') toggleReadAloud();
    if (act === 'find-in-note') findInNote();
    if (act === 'outline') outlineNote();
    if (act === 'insert-attach') $('#attachInput').click();
    if (act === 'attachments') manageAttachments();
    if (act === 'summarize') summarizeNote();
    if (act === 'insert-template-page') pickTemplateAndInsert();
    if (act === 'apply-template') pickTemplateAndApply();
    if (act === 'stats') noteStats();
    if (act === 'export-text') exportNoteText();
    if (act === 'export-rtf') exportNoteRtf();
    if (act === 'snapshots') openSnapshots();
    if (act === 'text-presets') openTextPresets();
    if (act === 'add-page') addPage();
    if (act === 'duplicate-page') duplicatePage();
    if (act === 'copy-page-to') copyPageTo();
    if (act === 'delete-page') deletePage();
    if (act === 'clear-blank-pages') clearBlankPages();
    if (act === 'clear-page') clearPage();
    if (act === 'account') { if (state.auth) logout(true); else openAuthModal('login'); }
    if (act === 'logout') logout(true);
    if (act === 'reset-settings') resetSettings();
    if (act === 'about') aboutModal();
  });
  $('#optFinger').addEventListener('change', (e) => { state.lib.settings.fingerDraw = e.target.checked; saveLibrary(state.lib); });
  const o2f = $('#optTwoFinger'); if (o2f) o2f.addEventListener('change', (e) => { state.lib.settings.twoFingerUndo = e.target.checked; saveLibrary(state.lib); });
  const oap = $('#optAutoPage'); if (oap) oap.addEventListener('change', (e) => { state.lib.settings.autoPage = e.target.checked; saveLibrary(state.lib); });
  window.addEventListener('resize', applyToolbarLayout);
  // 页面导航
  $('#btnPrevPage').addEventListener('click', () => switchPage(state.pageIndex - 1));
  $('#btnNextPage').addEventListener('click', () => switchPage(state.pageIndex + 1));
  $('#btnAddPage').addEventListener('click', addPage);
  // 导入
  $('#fileInput').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (file) await handleImport(file);
  });
  // 标题编辑（双击）
  const titleEl = $('#titleNote');
  titleEl.addEventListener('dblclick', () => {
    titleEl.setAttribute('contenteditable', 'true');
    titleEl.focus();
    const sel = window.getSelection();
    sel.selectAllChildren(titleEl);
  });
  titleEl.addEventListener('blur', () => {
    titleEl.setAttribute('contenteditable', 'false');
    const note = currentNote();
    if (note && titleEl.textContent.trim()) {
      note.title = titleEl.textContent.trim();
      saveSoon(true);
      renderLibrary();
    } else if (note) titleEl.textContent = note.title;
  });
  titleEl.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') titleEl.blur();
  });
  // 关闭弹层
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#colorPop')) $('#colorPop').classList.add('hidden');
  });
  // 快捷键
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    if ((e.key === 'Delete' || e.key === 'Backspace') && engine.getSelectionIds().length) { e.preventDefault(); deleteSelection(); }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c' && engine.getSelectionIds().length) { e.preventDefault(); copySelection(); }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteSelection(); }
  });
  // 页面切换快捷键
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key === 'PageDown') switchPage(state.pageIndex + 1);
    if (e.key === 'PageUp') switchPage(state.pageIndex - 1);
  });
  // 导出快捷键（⌘/Ctrl + E 导出笔记，+P 导出 PDF，+Shift+P 导出当前页图片）
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (!(e.metaKey || e.ctrlKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'e' && !e.shiftKey) { e.preventDefault(); exportNote(); }
    else if (k === 'f') { e.preventDefault(); findInNote(); }
    else if (k === 'n') { e.preventDefault(); createNote(); }
    else if (k === 'd') { e.preventDefault(); duplicatePage(); }
    else if (k === 'g') { e.preventDefault(); outlineNote(); }
    else if (k === 'p' && e.shiftKey) { e.preventDefault(); exportPagePng(); }
    else if (k === 'p') { e.preventDefault(); exportPdf(); }
  });
  window.addEventListener('beforeunload', () => flushSave());
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });
  // 触控板返回手势兼容
  window.addEventListener('popstate', () => {});
  // 账户 / 登录
  $('#btnUser').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#userMenu').classList.toggle('hidden');
  });
  $('#userMenu').addEventListener('click', (e) => {
    const item = e.target.closest('[data-auth-action]');
    if (!item) return;
    $('#userMenu').classList.add('hidden');
    if (item.dataset.authAction === 'login') openAuthModal('login');
    if (item.dataset.authAction === 'logout') logout(true);
  });
  document.querySelectorAll('.auth-tab').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach(x => x.classList.toggle('active', x === b));
    $('#authSubmit').textContent = b.dataset.tab === 'login' ? '登录' : '注册并登录';
    $('#authError').classList.add('hidden');
  }));
  const authEnter = (e) => { if (e.key === 'Enter') submitAuth(); };
  $('#authUsername').addEventListener('keydown', authEnter);
  $('#authPassword').addEventListener('keydown', authEnter);
  $('#authSubmit').addEventListener('click', submitAuth);
  $('#authModal').addEventListener('click', (e) => { if (e.target === $('#authModal')) closeAuthModal(); });
}

function updateToolUI() {
  document.querySelectorAll('.tool-btn').forEach(b => b.classList.toggle('active', b.dataset.tool === state.tool));
  $('#shapeRow').classList.toggle('hidden', state.tool !== 'shape');
  document.querySelectorAll('.shape-btn').forEach(b => b.classList.toggle('active', b.dataset.shape === state.shape));
}

function updateColorUI() {
  const isHl = state.tool === 'highlighter';
  const palette = isHl ? HL_COLORS : PEN_COLORS;
  const dot = $('#colorDot');
  dot.style.background = state.color;
  const box = $('#colorSwatches');
  box.innerHTML = '';
  for (const c of palette) {
    const sw = document.createElement('button');
    sw.className = 'swatch' + (c === state.color ? ' active' : '');
    sw.style.background = c;
    if (c === '#ffffff') sw.style.boxShadow = 'inset 0 0 0 1.5px rgba(0,0,0,.18)';
    if (c === state.color) sw.innerHTML = '<svg viewBox="0 0 24 24" class="check ic"><path d="M5 12l5 5 9-10"/></svg>';
    sw.addEventListener('click', () => {
      state.colors[state.tool] = c;
      state.color = c;
      if (state.tool === 'highlighter') state.lib.settings.hlColor = c;
      else if (state.tool === 'ballpen') state.lib.settings.ballpenColor = c;
      else state.lib.settings.color = c;
      saveLibrary(state.lib);
      updateColorUI();
    });
    box.appendChild(sw);
  }
  const w = state.widths[state.tool] || 5;
  $('#widthSlider').value = w;
  $('#widthValue').textContent = Math.round(w);
  renderStyleRow();
}

function updatePageNav() {
  const n = currentNote();
  $('#pageIndicator').textContent = n ? `${state.pageIndex + 1} / ${n.pages.length}` : '0 / 0';
}

function refreshTitleMeta() {
  const n = currentNote();
  if (!n) return;
  const pages = n.pages.length;
  const d = new Date(n.updatedAt);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  $('#titleMeta').textContent = `${pages} 页 · ${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}` + (state.saving ? ' · 保存中…' : '');
}

const PAGE_SIZES = { standard: { w: 816, h: 1056, name: '标准' }, wide: { w: 1056, h: 816, name: '宽版' } };
function applyDefaultPageSize(note) {
  const key = state.lib.settings.defaultPageSize === 'wide' ? 'wide' : 'standard';
  const sz = PAGE_SIZES[key];
  note.pageW = sz.w; note.pageH = sz.h;
}
function setPageSize(size) {
  const note = currentNote();
  if (!note) return;
  const target = PAGE_SIZES[size] || PAGE_SIZES.standard;
  const fromW = note.pageW || PAGE_W, fromH = note.pageH || PAGE_H;
  state.lib.settings.defaultPageSize = size;
  if (fromW === target.w && fromH === target.h) { saveSoon(); renderSettings(); return; }
  const sx = target.w / fromW, sy = target.h / fromH;
  for (const p of note.pages) {
    for (const st of p.strokes) for (const pt of st.points) { pt.x *= sx; pt.y *= sy; }
    for (const t of p.texts) { t.x *= sx; t.y *= sy; t.w *= sx; t.h *= sy; }
    for (const im of (p.images || [])) { im.x *= sx; im.y *= sy; im.w *= sx; im.h *= sy; }
  }
  note.pageW = target.w; note.pageH = target.h;
  engine.setPage(currentPage());
  engine.fitView();
  engine.invalidateRaster();
  renderPaperStack();
  renderPages();
  renderLibrary();
  updatePaperUI();
  renderSettings();
  saveSoon(true);
  toast('已切换纸张大小：' + target.name);
}

function toggleMarkupMode(on) {
  state.lib.settings.markup = !!on;
  document.body.classList.toggle('markup-mode', !!on);
  renderPaperStack();
  engine.resize();
  saveLibrary(state.lib);
}

function updatePaperUI() {
  const note = currentNote();
  if (!note) return;
  const styles = $('#paperStyles');
  styles.innerHTML = '';
  for (const st of PAPER_STYLES) {
    const b = document.createElement('button');
    b.className = 'paper-style' + (note.paper.style === st.id ? ' active' : '');
    b.title = st.name;
    if (st.id !== 'blank') { const cls = st.id === 'line' ? 'lines' : st.id === 'grid' ? 'grid' : st.id === 'cornell' ? 'cornell' : 'dots'; b.innerHTML = `<div class="${cls}"></div>`; }
    b.addEventListener('click', () => setPaper(st.id, note.paper.color));
    styles.appendChild(b);
  }
  const colors = $('#paperColors');
  colors.innerHTML = '';
  for (const c of PAPER_COLORS) {
    const sw = document.createElement('button');
    sw.className = 'paper-color' + (note.paper.color === c ? ' active' : '');
    const info = paperInfo(c);
    sw.style.background = info.bg;
    sw.style.borderColor = c === 'white' ? 'rgba(0,0,0,.2)' : 'transparent';
    sw.title = info.name;
    sw.addEventListener('click', () => setPaper(note.paper.style, c));
    colors.appendChild(sw);
  }
}

/* ---------------- 设置面板与工具栏布局 ---------------- */
function applyAccent() {
  const name = (state.lib.settings.accent || 'blue');
  const color = ACCENTS[name] || ACCENTS.blue;
  const soft = hexToRgba(color, 0.12);
  document.documentElement.style.setProperty('--accent', color);
  document.documentElement.style.setProperty('--accent-soft', soft);
}
function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
}

function applyTheme() {
  applyAccent();
  const t = state.lib.settings.theme || 'auto';
  document.body.classList.toggle('theme-dark', t === 'dark');
  document.body.classList.toggle('theme-light', t === 'light');
}

function applyToolbarLayout() {
  const want = state.lib.settings.toolbar || 'left';
  const eff = (want === 'top' || window.innerWidth < 560) ? 'top' : want;
  document.body.classList.remove('toolbar-top', 'toolbar-left', 'toolbar-bottom');
  document.body.classList.add('toolbar-' + eff);
  // 顶栏带 backdrop-filter，会破坏内部 fixed 定位；左侧/底部布局把工具组移到 body 下
  const tg = document.getElementById('toolGroup');
  const tbTools = document.querySelector('.tb-tools');
  const tbActions = document.querySelector('.tb-actions');
  if (!tg || !tbTools || !tbActions) return;
  if (eff === 'top') {
    if (tg.parentElement !== tbTools) tbTools.insertBefore(tg, tbActions);
  } else {
    if (tg.parentElement !== document.body) document.body.appendChild(tg);
  }
  engine.refreshRect();
}

function renderSettings() {
  const st = state.lib.settings;
  // 钢笔默认色
  const penBox = $('#penColors');
  if (penBox) {
    penBox.innerHTML = '';
    PEN_COLORS.forEach(c => {
      const sw = document.createElement('button');
      sw.className = 'swatch' + (state.colors.pen === c ? ' active' : '');
      sw.style.background = c;
      sw.addEventListener('click', () => {
        state.colors.pen = c;
        if (state.tool === 'pen') { state.color = c; st.color = c; updateColorUI(); }
        st.penColor = c;
        saveLibrary(state.lib);
        renderSettings();
      });
      penBox.appendChild(sw);
    });
  }
  // 荧光笔默认色
  const hlBox = $('#hlColors');
  if (hlBox) {
    hlBox.innerHTML = '';
    HL_COLORS.forEach(c => {
      const sw = document.createElement('button');
      sw.className = 'swatch' + (state.colors.highlighter === c ? ' active' : '');
      sw.style.background = c;
      sw.addEventListener('click', () => {
        state.colors.highlighter = c;
        if (state.tool === 'highlighter') { state.color = c; st.hlColor = c; updateColorUI(); }
        st.hlColor = c;
        saveLibrary(state.lib);
        renderSettings();
      });
      hlBox.appendChild(sw);
    });
  }
  // 橡皮模式
  const emEl = $('#eraserMode');
  if (emEl) {
    emEl.innerHTML = '';
    [['stroke', '整笔'], ['pixel', '像素']].forEach(([v, label]) => {
      const b = document.createElement('button');
      b.className = (st.eraserMode || 'stroke') === v ? 'active' : '';
      b.textContent = label;
      b.addEventListener('click', () => { st.eraserMode = v; saveLibrary(state.lib); renderSettings(); });
      emEl.appendChild(b);
    });
  }
  // 文字字号
  const tsEl = $('#textSizeRow');
  if (tsEl) {
    tsEl.innerHTML = '';
    [[18, '小'], [26, '中'], [34, '大']].forEach(([v, label]) => {
      const b = document.createElement('button');
      b.className = (st.textSize || 26) === v ? 'active' : '';
      b.textContent = label;
      b.addEventListener('click', () => { st.textSize = v; saveLibrary(state.lib); renderSettings(); });
      tsEl.appendChild(b);
    });
  }
  // 圆珠笔默认色
  const bpBox = $('#ballpenColors');
  if (bpBox) {
    bpBox.innerHTML = '';
    PEN_COLORS.forEach(c => {
      const sw = document.createElement('button');
      sw.className = 'swatch' + (state.colors.ballpen === c ? ' active' : '');
      sw.style.background = c;
      sw.addEventListener('click', () => {
        state.colors.ballpen = c;
        if (state.tool === 'ballpen') { state.color = c; st.ballpenColor = c; updateColorUI(); }
        st.ballpenColor = c;
        saveLibrary(state.lib);
        renderSettings();
      });
      bpBox.appendChild(sw);
    });
  }
  // 橡皮擦大小
  const erBox = $('#eraserSizes');
  if (erBox) {
    erBox.innerHTML = '';
    [[16, '小'], [26, '中'], [36, '大']].forEach(([v, label]) => {
      const b = document.createElement('button');
      b.className = st.eraserSize === v ? 'active' : '';
      b.textContent = label;
      b.addEventListener('click', () => { st.eraserSize = v; saveLibrary(state.lib); renderSettings(); });
      erBox.appendChild(b);
    });
  }
  // 新笔记默认纸张
  const dp = $('#defaultPaperRow');
  if (dp) {
    dp.innerHTML = '';
    const dPaper = st.defaultPaper || { style: 'line', color: 'white' };
    const row = document.createElement('div');
    row.className = 'paper-row';
    PAPER_STYLES.forEach(ps => {
      const b = document.createElement('button');
      b.className = 'paper-style' + (dPaper.style === ps.id ? ' active' : '');
      b.title = ps.name;
      if (ps.id !== 'blank') b.innerHTML = `<div class="${ps.id === 'line' ? 'lines' : ps.id === 'grid' ? 'grid' : 'dots'}"></div>`;
      b.addEventListener('click', () => { st.defaultPaper = { style: ps.id, color: dPaper.color }; saveLibrary(state.lib); renderSettings(); });
      row.appendChild(b);
    });
    dp.appendChild(row);
    const colors = document.createElement('div');
    colors.className = 'paper-colors';
    PAPER_COLORS.forEach(c => {
      const sw = document.createElement('button');
      sw.className = 'paper-color' + (dPaper.color === c ? ' active' : '');
      const info = paperInfo(c);
      sw.style.background = info.bg;
      sw.title = info.name;
      sw.addEventListener('click', () => { st.defaultPaper = { style: dPaper.style, color: c }; saveLibrary(state.lib); renderSettings(); });
      colors.appendChild(sw);
    });
    dp.appendChild(colors);
  }
  // 朗读速度
  const ttsRow = $('#ttsRateRow');
  if (ttsRow) {
    ttsRow.innerHTML = '';
    [[0.75, '慢'], [1, '正常'], [1.25, '快'], [1.5, '快上加快']].forEach(([v, label]) => {
      const b = document.createElement('button');
      b.className = (st.ttsRate || 1) === v ? 'active' : '';
      b.textContent = label;
      b.addEventListener('click', () => { st.ttsRate = v; saveLibrary(state.lib); renderSettings(); });
      ttsRow.appendChild(b);
    });
  }
  // 文字字体
  const fontRow = $('#fontFamilyRow');
  if (fontRow) {
    fontRow.innerHTML = '';
    [['system', '系统'], ['rounded', '圆体'], ['serif', '衬线'], ['mono', '等宽']].forEach(([v, label]) => {
      const b = document.createElement('button');
      b.className = (st.fontFamily || 'system') === v ? 'active' : '';
      b.textContent = label;
      b.addEventListener('click', () => { st.fontFamily = v; saveLibrary(state.lib); applySettingsFromLib(state.lib); engine.invalidateRaster(); renderPaperStack(); refreshThumbs(); renderSettings(); });
      fontRow.appendChild(b);
    });
  }
  // 背景透明度（当前页有背景时）
  const bgRow = $('#bgAlphaRow');
  if (bgRow) {
    const page = currentPage();
    const hasBg = !!(page && page.bg && page.bg.src);
    bgRow.style.display = hasBg ? '' : 'none';
    const slider = $('#bgAlpha');
    if (slider && hasBg) {
      slider.value = String(page.bg.alpha != null ? page.bg.alpha : 1);
      slider.oninput = () => {
        page.bg.alpha = Number(slider.value);
        engine.invalidateRaster();
        renderPaperStack();
        saveSoon(true);
      };
    }
  }
  // 本地存储占用
  const stRow = $('#storageRow');
  if (stRow) {
    const infoEl = stRow.querySelector('.storage-info');
    if (infoEl && navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(r => {
        const mb = ((r && r.usage) || 0) / 1024 / 1024;
        infoEl.textContent = mb.toFixed(1) + ' MB';
      }).catch(() => {});
    }
  }
  // 当前笔记行距
  const spRow = $('#spacingRow');
  if (spRow && currentNote()) {
    spRow.innerHTML = '';
    const cur = currentNote().paper.spacing || 'normal';
    [['tight', '紧'], ['normal', '标准'], ['wide', '宽']].forEach(([v, label]) => {
      const b = document.createElement('button');
      b.className = cur === v ? 'active' : '';
      b.textContent = label;
      b.addEventListener('click', () => { setSpacing(v); renderSettings(); });
      spRow.appendChild(b);
    });
  }
  // 工具条位置
  const pos = $('#toolbarPos');
  if (pos) {
    pos.innerHTML = '';
    [['top', '顶部'], ['left', '左侧'], ['bottom', '底部']].forEach(([v, label]) => {
      const b = document.createElement('button');
      b.className = st.toolbar === v ? 'active' : '';
      b.textContent = label;
      b.addEventListener('click', () => { st.toolbar = v; saveLibrary(state.lib); applyToolbarLayout(); renderSettings(); });
      pos.appendChild(b);
    });
  }
  // 纸张大小（当前笔记）
  const psz = $('#pageSizeRow');
  if (psz) {
    psz.innerHTML = '';
    const note = currentNote();
    const cur = note ? ((note.pageW || PAGE_W) > (note.pageH || PAGE_H) ? 'wide' : 'standard') : (st.defaultPageSize || 'standard');
    [['standard', '标准'], ['wide', '宽版']].forEach(([v, label]) => {
      const b = document.createElement('button');
      b.className = cur === v ? 'active' : '';
      b.textContent = label;
      b.addEventListener('click', () => setPageSize(v));
      psz.appendChild(b);
    });
  }
  // 双指轻点手势
  const tfRow = $('#twoFingerRow');
  if (tfRow) {
    tfRow.innerHTML = '';
    [['undo', '撤销'], ['redo', '重做'], ['off', '关闭']].forEach(([v, label]) => {
      const b = document.createElement('button');
      b.className = (st.twoFingerAction || 'undo') === v ? 'active' : '';
      b.textContent = label;
      b.addEventListener('click', () => {
        st.twoFingerAction = v;
        st.twoFingerUndo = v !== 'off';
        saveLibrary(state.lib);
        renderSettings();
      });
      tfRow.appendChild(b);
    });
  }
  // 三指轻点手势
  const thrRow = $('#threeFingerRow');
  if (thrRow) {
    thrRow.innerHTML = '';
    [['redo', '重做'], ['off', '关闭']].forEach(([v, label]) => {
      const b = document.createElement('button');
      b.className = (st.threeFingerAction || 'redo') === v ? 'active' : '';
      b.textContent = label;
      b.addEventListener('click', () => {
        st.threeFingerAction = v;
        saveLibrary(state.lib);
        renderSettings();
      });
      thrRow.appendChild(b);
    });
  }
  // 外观主题
  const themeEl = $('#themeRow');
  if (themeEl) {
    themeEl.innerHTML = '';
    [['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']].forEach(([v, label]) => {
      const b = document.createElement('button');
      b.className = (st.theme || 'auto') === v ? 'active' : '';
      b.textContent = label;
      b.addEventListener('click', () => { st.theme = v; saveLibrary(state.lib); applyTheme(); renderSettings(); });
      themeEl.appendChild(b);
  // 主题色
  const acRow = $('#accentRow');
  if (acRow) {
    acRow.innerHTML = '';
    Object.keys(ACCENTS).forEach(k => {
      const b = document.createElement('button');
      b.className = 'accent-dot' + ((st.accent || 'blue') === k ? ' active' : '');
      b.style.background = ACCENTS[k];
      b.title = k;
      b.addEventListener('click', () => { st.accent = k; saveLibrary(state.lib); applyAccent(); renderSettings(); });
      acRow.appendChild(b);
    });
  }
    });
  }
  // ????
  const psRow = $('#penStyleRow');
  if (psRow) {
    psRow.innerHTML = '';
    PEN_STYLES.forEach(v => {
      const b = document.createElement('button');
      b.className = (st.penStyle || 'normal') === v ? 'active' : '';
      b.textContent = STYLE_NAMES[v];
      b.addEventListener('click', () => { st.penStyle = v; st.ballpenStyle = v; state.styles.pen = v; state.styles.ballpen = v; saveLibrary(state.lib); renderSettings(); });
      psRow.appendChild(b);
    });
  }
  const oFav = $('#optFavBar'); if (oFav) oFav.checked = st.favoritesBar !== false;
  const oBak = $('#optAutoBackup'); if (oBak) oBak.checked = st.autoBackup !== false;
  const oMarkup = $('#optMarkup'); if (oMarkup) oMarkup.checked = st.markup === true;
  const av = $('#appVersion'); if (av) av.textContent = APP_VERSION;
}

function setSpacing(spacing) {
  const note = currentNote();
  if (!note) return;
  const before = note.paper.spacing || 'normal';
  note.paper = Object.assign({}, note.paper, { spacing });
  if ((before) === spacing) return;
  const apply = () => {
    engine.invalidateRaster();
    renderPaperStack();
    refreshThumbs();
    renderSettings();
  };
  pushHistory('行距', () => { note.paper = Object.assign({}, note.paper, { spacing: before }); apply(); saveSoon(); }, () => { note.paper = Object.assign({}, note.paper, { spacing }); apply(); saveSoon(); });
  apply();
  saveSoon(true);
}

function setPaper(style, color) {
  const note = currentNote();
  if (!note) return;
  const before = JSON.stringify(note.paper);
  note.paper = { style, color };
  const after = JSON.stringify(note.paper);
  if (before === after) return;
  const apply = () => {
    engine.invalidateRaster();
    refreshThumbs();
    updatePaperUI();
    // 深色纸自动换浅色笔
    const info = paperInfo(note.paper.color);
    if (info.dark && PEN_COLORS.includes(state.color) && ['#1e293b','#0f172a','#475569','#2563eb','#7c3aed','#dc2626'].includes(state.color)) {
      state.color = '#f8fafc';
      state.colors[state.tool] = state.color;
      updateColorUI();
    }
  };
  pushHistory('更换纸张',
    () => { note.paper = JSON.parse(before); apply(); saveSoon(); },
    () => { note.paper = JSON.parse(after); apply(); saveSoon(); });
  apply();
  saveSoon(true);
}

/* ---------------- 资料库 UI ---------------- */
function findActiveSubject() {
  return state.lib.subjects.find(s => s.id === state.activeSubjectId) || state.lib.subjects[0] || null;
}
function firstNotebookId() {
  for (const s of state.lib.subjects) if (s.notebooks.length) return s.notebooks[0].id;
  return null;
}

function renderLibrary() {
  const subjRoot = $('#subjectList');
  subjRoot.innerHTML = '';
  for (const subj of state.lib.subjects) {
    const wrap = document.createElement('div');
    wrap.className = 'subject';
    const row = document.createElement('div');
    row.className = 'subject-row';
    const head = document.createElement('button');
    head.className = 'subject-head' + (state.collapsedSubjects.has(subj.id) ? '' : ' open');
    const total = subj.notebooks.reduce((a, nb) => a + nb.noteIds.length, 0);
    head.innerHTML = `
      <svg viewBox="0 0 24 24" class="ic chev"><path d="M9 6l6 6-6 6"/></svg>
      <span class="subj-name"></span><span class="subj-count"></span>`;
    head.querySelector('.subj-name').textContent = subj.name;
    head.querySelector('.subj-count').textContent = total;
    head.addEventListener('click', () => {
      if (state.collapsedSubjects.has(subj.id)) state.collapsedSubjects.delete(subj.id);
      else state.collapsedSubjects.add(subj.id);
      renderLibrary();
    });
    row.appendChild(head);
    const more = document.createElement('button');
    more.className = 'nb-more subject-more';
    more.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>';
    more.addEventListener('click', (e) => { e.stopPropagation(); subjectActions(subj, more); });
    row.appendChild(more);
    wrap.appendChild(row);
    if (!state.collapsedSubjects.has(subj.id)) {
      const nbs = document.createElement('div');
      nbs.className = 'notebooks';
      let nbi = 0;
      for (const nb of subj.notebooks) {
        const wrapNb = document.createElement('div');
        wrapNb.className = 'notebook' + (nb.id === state.activeNotebookId ? ' active' : '');
        const main = document.createElement('button');
        main.className = 'nb-main';
        main.innerHTML = `<span class="nb-icon"></span><span class="nb-name"></span>`;
        const hue = (nbi++ * 47) % 360;
        main.querySelector('.nb-icon').style.background = nb.color || `linear-gradient(135deg, hsl(${hue},78%,60%), hsl(${(hue + 45) % 360},72%,52%))`;
        main.querySelector('.nb-icon').textContent = nb.emoji || nb.name.slice(0, 1);
        main.querySelector('.nb-name').textContent = nb.name;
        main.addEventListener('click', (e) => {
          e.stopPropagation();
          if (state.multi.on) exitMulti();
          state.activeSubjectId = subj.id;
          state.activeNotebookId = nb.id;
          renderLibrary();
          renderNoteList();
        });
        wrapNb.appendChild(main);
        const more = document.createElement('button');
        more.className = 'nb-more';
        more.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>';
        more.addEventListener('click', (e) => { e.stopPropagation(); notebookActions(nb, more); });
        wrapNb.appendChild(more);
        nbs.appendChild(wrapNb);
      }
      if (!subj.notebooks.length) {
        const empty = document.createElement('div');
        empty.className = 'note-item';
        empty.style.opacity = '.6';
        empty.textContent = '暂无笔记本';
        nbs.appendChild(empty);
      }
      wrap.appendChild(nbs);
    }
    subjRoot.appendChild(wrap);
  }
  renderNoteList();
  updateEmptyState();
  renderTabs();
}

function updateEmptyState() {
  const el = $('#emptyState');
  if (el) el.classList.toggle('hidden', !!currentNote());
}

function dateLabel(ts) {
  const d = new Date(ts || 0); const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86400000;
  if (ts >= startToday) return '今天';
  if (ts >= startToday - day) return '昨天';
  if (ts >= startToday - 7 * day) return '本周';
  return '更早';
}

function renderNoteSortUI() {
  const seg = $('#noteSort');
  if (!seg) return;
  const cur = state.noteSort || 'updated';
  seg.innerHTML = '';
  [['updated', '最近'], ['created', '创建'], ['title', '标题']].forEach(([v, label]) => {
    const b = document.createElement('button');
    b.className = cur === v ? 'active' : '';
    b.textContent = label;
    b.addEventListener('click', () => {
      state.noteSort = v;
      state.lib.settings.noteSort = v;
      saveLibrary(state.lib);
      renderNoteList();
    });
    seg.appendChild(b);
  });
}

function highlightMatch(text, q) {
  if (!q) return escapeHtml(text);
  const esc = escapeHtml(text);
  const low = esc.toLowerCase();
  const ql = q.toLowerCase();
  let out = '', i = 0;
  while (i < esc.length) {
    const j = low.indexOf(ql, i);
    if (j < 0) { out += esc.slice(i); break; }
    out += esc.slice(i, j) + '<mark>' + esc.slice(j, j + q.length) + '</mark>';
    i = j + q.length;
  }
  return out;
}

function renderGlobalSearch(q) {
  const root = $('#noteList');
  root.innerHTML = '';
  const results = [];
  for (const s of state.lib.subjects) {
    for (const nb of s.notebooks) {
      for (const id of nb.noteIds) {
        const n = state.lib.notes[id];
        if (!n) continue;
        const titleHit = n.title.toLowerCase().includes(q);
        let pageHit = -1, snippet = '';
        (n.pages || []).forEach((p, i) => {
          if (pageHit >= 0) return;
          for (const t of p.texts || []) {
            const tx = (t.text || '').toLowerCase();
            if (tx.includes(q)) {
              pageHit = i;
              const idx = tx.indexOf(q);
              snippet = t.text.slice(Math.max(0, idx - 12), idx + q.length + 18);
              return;
            }
          }
        });
        if (titleHit || pageHit >= 0) results.push({ note: n, subject: s, notebook: nb, page: Math.max(0, pageHit), snippet });
      }
    }
  }
  if (!results.length) {
    const empty = document.createElement('div');
    empty.className = 'note-item';
    empty.style.opacity = '.55';
    empty.textContent = '没有找到与「' + q + '」相关的笔记';
    root.appendChild(empty);
    return;
  }
  const head = document.createElement('div');
  head.className = 'note-group-head';
  head.textContent = '全局搜索结果 · ' + results.length;
  root.appendChild(head);
  results.forEach(r => {
    const item = document.createElement('div');
    item.className = 'note-item';
    item.innerHTML = `<div class="ni-title">${highlightMatch(r.note.title, q)}</div><div class="ni-meta">${escapeHtml(r.subject.name)} / ${escapeHtml(r.notebook.name)}${r.page >= 0 ? ' · 第' + (r.page + 1) + '页' : ''}</div>${r.snippet ? `<div class="ni-snippet">…${highlightMatch(r.snippet, q)}…</div>` : ''}`;
    item.dataset.note = r.note.id;
    item.dataset.nb = r.notebook.id;
    item.addEventListener('click', () => openNote(r.note.id, r.notebook.id, r.subject.id, r.page >= 0 ? r.page : 0));
    root.appendChild(item);
  });
}
function renderTagFilter() {
  const el = $('#tagFilter');
  if (!el) return;
  el.innerHTML = '';
  const mk = (color, label, all) => {
    const b = document.createElement('button');
    b.className = 'tf-dot' + (all ? ' all' : '') + (state.tagFilter === color ? ' active' : '');
    if (color) b.style.background = color;
    b.title = label;
    b.addEventListener('click', () => { state.tagFilter = state.tagFilter === color ? null : color; renderNoteList(); });
    el.appendChild(b);
  };
  mk(null, '全部', true);
  TAG_COLORS.forEach(c => mk(c, c, false));
}

function renderRecentNotes() {
  const root = $('#noteList');
  root.innerHTML = '';
  const all = [];
  for (const s of state.lib.subjects) for (const nb of s.notebooks) for (const id of nb.noteIds) {
    const n = state.lib.notes[id];
    if (n) all.push({ note: n, subject: s, notebook: nb });
  }
  all.sort((a, b) => (b.note.updatedAt || 0) - (a.note.updatedAt || 0));
  const recent = all.slice(0, 15);
  if (!recent.length) {
    const empty = document.createElement('div');
    empty.className = 'note-item';
    empty.style.opacity = '.55';
    empty.textContent = '还没有笔记';
    root.appendChild(empty);
    return;
  }
  const head = document.createElement('div');
  head.className = 'note-group-head';
  head.textContent = '最近笔记';
  root.appendChild(head);
  recent.forEach(r => {
    const d = new Date(r.note.updatedAt || r.note.createdAt);
    const item = document.createElement('div');
    item.className = 'note-item' + (r.note.id === state.activeNoteId ? ' active' : '');
    item.innerHTML = '<span class="ni-cover"></span><span class="ni-text"><span class="ni-title"></span><span class="ni-meta"></span></span>';
    const coverEl = item.querySelector('.ni-cover');
    coverEl.style.background = paperInfo(r.note.paper.color).bg;
    if (r.note.pages && r.note.pages[0]) {
      const cv = document.createElement('canvas');
      renderPageToCanvas(cv, r.note.pages[0], r.note.paper, 90, currentFont(), r.note.pageW, r.note.pageH);
      coverEl.appendChild(cv);
    }
    if (r.note.colorTag) {
      const tag = document.createElement('span');
      tag.className = 'ni-tag';
      tag.style.background = r.note.colorTag;
      item.querySelector('.ni-text').insertBefore(tag, item.querySelector('.ni-title'));
    }
    item.querySelector('.ni-title').textContent = r.note.title;
    item.querySelector('.ni-meta').textContent = r.note.pages.length + ' 页 · ' + r.subject.name + ' / ' + r.notebook.name + ' · ' + (d.getMonth() + 1) + '/' + d.getDate();
    item.addEventListener('click', () => {
      openNote(r.note.id, r.notebook.id, r.subject.id);
      state.showRecent = false;
      const b = $('#btnRecent'); if (b) b.classList.remove('active');
    });
    root.appendChild(item);
  });
}

function renderNoteList() {
  const root = $('#noteList');
  root.innerHTML = '';
  const f = findNotebook(state.lib, state.activeNotebookId);
  let notes = f ? f.notebook.noteIds.map(id => state.lib.notes[id]).filter(Boolean) : [];
  if (state.showRecent) { renderRecentNotes(); return; }
  renderTagFilter();
  if (state.tagFilter) notes = notes.filter(n => n.colorTag === state.tagFilter);
  const q = (state.searchQuery || '').trim().toLowerCase();
  if (q) { renderGlobalSearch(q); return; }
  if (q) {
    notes = notes.filter(n =>
      n.title.toLowerCase().includes(q) ||
      n.pages.some(pg => pg.texts.some(t => (t.text || '').toLowerCase().includes(q)))
    );
  }
  const sortBy = state.noteSort || 'updated';
  notes.sort((a, b) => {
    if (sortBy === 'title') return a.title.localeCompare(b.title, 'zh');
    if (sortBy === 'created') return (b.createdAt || 0) - (a.createdAt || 0);
    return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.updatedAt || 0) - (a.updatedAt || 0);
  });
  renderNoteSortUI();
  if (!notes.length) {
    const empty = document.createElement('div');
    empty.className = 'note-item';
    empty.style.opacity = '.55';
    empty.textContent = '这个笔记本还没有笔记，点击右上角「＋ 笔记」新建。';
    root.appendChild(empty);
    return;
  }
  const groups = [];
  if (sortBy === 'updated') {
    let lastLabel = null;
    for (const n of notes) {
      const label = dateLabel(n.updatedAt);
      if (label !== lastLabel) { groups.push({ head: label }); lastLabel = label; }
      groups.push({ note: n });
    }
  } else {
    for (const n of notes) groups.push({ note: n });
  }
  for (const entry of groups) {
    if (entry.head) {
      const hd = document.createElement('div');
      hd.className = 'note-group-head';
      hd.textContent = entry.head;
      root.appendChild(hd);
      continue;
    }
    const note = entry.note;
    const d = new Date(note.updatedAt || note.createdAt);
    const cov = paperInfo(note.paper.color);
    const item = document.createElement('div');
    item.className = 'note-item' + (note.id === state.activeNoteId ? ' active' : '') + (state.multi.on ? ' multi' : '');
    const sel = state.multi.on && state.multi.selected.has(note.id);
    item.innerHTML = `
      <span class="ni-check${sel ? ' on' : ''}"><svg viewBox="0 0 24 24" class="ic"><path d="M5 12l5 5 9-10"/></svg></span>
      <span class="ni-cover"></span>
      <span class="ni-text"><span class="ni-title"></span><span class="ni-meta"></span></span>
      <button class="ni-more" aria-label="更多"><svg viewBox="0 0 24 24" class="ic"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg></button>`;
    const coverEl = item.querySelector('.ni-cover');
    coverEl.style.background = cov.bg;
    if (note.pages && note.pages[0]) {
      const cv = document.createElement('canvas');
      renderPageToCanvas(cv, note.pages[0], note.paper, 90, currentFont(), note.pageW, note.pageH);
      coverEl.appendChild(cv);
    }
    if (note.pinned) {
      const pin = document.createElement('span');
      pin.className = 'ni-pin';
      pin.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><path d="M9 4h6v3l-1.5 2v4l2 2v2h-7v-2l2-2V9L9 7z"/><path d="M12 3v1"/></svg>';
      item.querySelector('.ni-cover').appendChild(pin);
    }
    if (note.colorTag) {
      const tag = document.createElement('span');
      tag.className = 'ni-tag';
      tag.style.background = note.colorTag;
      item.querySelector('.ni-text').insertBefore(tag, item.querySelector('.ni-title'));
    }
    item.querySelector('.ni-title').textContent = note.title;
    item.querySelector('.ni-meta').textContent = `${note.pages.length} 页 · ${d.getMonth() + 1}/${d.getDate()}`;
    item.addEventListener('click', (e) => {
      if (e.target.closest('.ni-more')) return;
      if (state.multi.on) { toggleSelect(note.id); return; }
      openNote(note.id);
      if (window.innerWidth <= 820) $('#library').classList.add('hidden-mobile');
    });
    item.querySelector('.ni-more').addEventListener('click', (e) => {
      e.stopPropagation();
      noteActions(note, item.querySelector('.ni-more'));
    });
    root.appendChild(item);
  }
}

function noteActions(note, anchor) {
  document.querySelectorAll('.ni-menu').forEach(m => m.remove());
  const menu = document.createElement('div');
  menu.className = 'menu ni-menu';
  menu.innerHTML = `
    <button class="menu-item" data-act="rename"><svg viewBox="0 0 24 24" class="ic"><path d="M4 20l1.2-4.2L16.5 4.5a2.1 2.1 0 0 1 3 3L8.2 18.8 4 20z"/></svg>重命名</button>
    <button class="menu-item" data-act="color"><svg viewBox="0 0 24 24" class="ic"><circle cx="12" cy="12" r="9"/></svg>封面颜色</button>
    <button class="menu-item" data-act="emoji"><svg viewBox="0 0 24 24" class="ic"><path d="M4 6h16M4 12h16M4 18h16"/></svg>封面符号</button>
    <button class="menu-item" data-act="tagcolor"><svg viewBox="0 0 24 24" class="ic"><path d="M12 3l7 4v5c0 4-3 7-7 9-4-2-7-5-7-9V7z"/></svg>标签颜色</button>
    <button class="menu-item" data-act="savetpl"><svg viewBox="0 0 24 24" class="ic"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 12h6M12 9v6"/></svg>存为模板</button>
    <button class="menu-item" data-act="pin"><svg viewBox="0 0 24 24" class="ic"><path d="M9 4h6v3l-1.5 2v4l2 2v2h-7v-2l2-2V9L9 7z"/></svg>${note.pinned ? '取消置顶' : '置顶'}</button>
    <button class="menu-item" data-act="multi"><svg viewBox="0 0 24 24" class="ic"><path d="M4 6h4M4 12h4M4 18h4M11 6h9M11 12h9M11 18h9"/></svg>多选</button>
    <button class="menu-item" data-act="copy"><svg viewBox="0 0 24 24" class="ic"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>复制笔记</button>
    <button class="menu-item danger" data-act="del"><svg viewBox="0 0 24 24" class="ic"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>删除</button>`;
  const r = anchor.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 190)) + 'px';
  menu.style.top = (r.bottom + 4) + 'px';
  document.body.appendChild(menu);
  menu.querySelector('[data-act="rename"]').addEventListener('click', () => { menu.remove(); renameNote(note); });
  menu.querySelector('[data-act="pin"]').addEventListener('click', () => { menu.remove(); togglePin(note); });
  menu.querySelector('[data-act="multi"]').addEventListener('click', () => { menu.remove(); enterMulti(); });
  menu.querySelector('[data-act="copy"]').addEventListener('click', () => { menu.remove(); duplicateNote(note); });
  menu.querySelector('[data-act="del"]').addEventListener('click', () => { menu.remove(); deleteNoteConfirm(note); });
  setTimeout(() => document.addEventListener('click', function h(e) { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', h); } }), 0);
}

function renameNote(note) {
  promptModal('重命名笔记', '', '笔记名称', '保存', (name) => {
    if (!name) return;
    note.title = name;
    if (note.id === state.activeNoteId) $('#titleNote').textContent = name;
    saveSoon(true);
    renderNoteList();
    toast('已重命名');
  });
}

function deleteNoteConfirm(note) {
  confirmModal(`删除笔记「${note.title}」？`, '删除后该笔记的所有页面与内容将无法恢复。', '删除', true, () => deleteNote(note.id));
}

function deleteNote(noteId) {
  const nb = findNotebook(state.lib, state.activeNotebookId);
  if (nb) nb.notebook.noteIds = nb.notebook.noteIds.filter(id => id !== noteId);
  delete state.lib.notes[noteId];
  const openTabs = getOpenTabs();
  const ti = openTabs.indexOf(noteId);
  if (ti >= 0) openTabs.splice(ti, 1);
  if (state.activeNoteId === noteId) {
    const remaining = nb ? nb.notebook.noteIds.map(id => state.lib.notes[id]).filter(Boolean) : [];
    if (remaining.length) {
      openNote(remaining[0].id);
    } else {
      state.activeNoteId = null;
      $('#titleNote').textContent = '未命名笔记';
      renderLibrary();
      engine.setPage(null);
      engine.invalidateRaster();
      updatePageNav();
      updateEmptyState();
    }
  }
  saveLibrary(state.lib);
  renderLibrary();
  toast('已删除笔记');
}

function switchBackFromEraser() {
  if (!state.prevTool) return;
  const t = state.prevTool;
  state.prevTool = null;
  state.tool = t;
  if (!state.colors[t]) state.colors[t] = t === 'highlighter' ? '#fde047' : '#1e293b';
  state.color = state.colors[t];
  updateToolUI();
  updateColorUI();
  $('#colorPop').classList.add('hidden');
}

function togglePin(note) {
  note.pinned = !note.pinned;
  saveSoon(true);
  renderNoteList();
  toast(note.pinned ? '已置顶' : '已取消置顶');
}

function duplicateNote(note) {
  const copy = JSON.parse(JSON.stringify(note));
  copy.id = newId();
  copy.title = note.title + ' 副本';
  copy.createdAt = Date.now();
  copy.updatedAt = Date.now();
  copy.pages.forEach(p => { p.id = newId(); p.strokes.forEach(s => s.id = newId()); p.texts.forEach(t => t.id = newId()); });
  copy.notebookId = note.notebookId;
  state.lib.notes[copy.id] = copy;
  const nb = findNotebook(state.lib, note.notebookId);
  if (nb) nb.notebook.noteIds.push(copy.id);
  saveLibrary(state.lib);
  renderNoteList();
  openNote(copy.id);
  toast('已复制笔记');
}

function createNote() {
  const d = new Date();
  const autoTitle = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const note = newNote(state.activeNotebookId || firstNotebookId(), autoTitle, state.lib.settings.defaultPaper || { style: 'line', color: 'white' });
  applyDefaultPageSize(note);
  state.lib.notes[note.id] = note;
  let nb = findNotebook(state.lib, note.notebookId);
  if (!nb) {
    const subj = findActiveSubject() || state.lib.subjects[0];
    if (!subj) { toast('请先创建项目'); return; }
    const nbObj = { id: newId(), name: '我的笔记本', noteIds: [] };
    subj.notebooks.push(nbObj);
    note.notebookId = nbObj.id;
    nb = { subject: subj, notebook: nbObj };
  }
  nb.notebook.noteIds.push(note.id);
  state.activeSubjectId = nb.subject.id;
  state.activeNotebookId = nb.notebook.id;
  saveLibrary(state.lib);
  openNote(note.id);
  renderLibrary();
  toast('已新建笔记');
}

/* ---------------- 笔记本操作 ---------------- */
function notebookActions(nb, anchor) {
  document.querySelectorAll('.ni-menu').forEach(m => m.remove());
  const menu = document.createElement('div');
  menu.className = 'menu ni-menu';
  menu.innerHTML = `
    <button class="menu-item" data-act="rename"><svg viewBox="0 0 24 24" class="ic"><path d="M4 20l1.2-4.2L16.5 4.5a2.1 2.1 0 0 1 3 3L8.2 18.8 4 20z"/></svg>重命名</button>
    <button class="menu-item" data-act="color"><svg viewBox="0 0 24 24" class="ic"><circle cx="12" cy="12" r="9"/></svg>封面颜色</button>
    <button class="menu-item" data-act="emoji"><svg viewBox="0 0 24 24" class="ic"><path d="M4 6h16M4 12h16M4 18h16"/></svg>封面符号</button>
    <button class="menu-item danger" data-act="del"><svg viewBox="0 0 24 24" class="ic"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>删除</button>`;
  const r = anchor.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 190)) + 'px';
  menu.style.top = (r.bottom + 4) + 'px';
  document.body.appendChild(menu);
  menu.querySelector('[data-act="rename"]').addEventListener('click', () => { menu.remove(); renameNotebook(nb); });
  menu.querySelector('[data-act="color"]').addEventListener('click', () => { menu.remove(); notebookColor(nb); });
  menu.querySelector('[data-act="emoji"]').addEventListener('click', () => { menu.remove(); noteEmoji(nb); });
  menu.querySelector('[data-act="tagcolor"]').addEventListener('click', () => { menu.remove(); noteTagColor(note); });
  menu.querySelector('[data-act="savetpl"]').addEventListener('click', () => { menu.remove(); promptModal('保存当前页为模板', '', '模板名称', '保存', (nm) => { if (nm) saveCurrentAsTemplate(nm); }); });
  menu.querySelector('[data-act="del"]').addEventListener('click', () => { menu.remove(); deleteNotebookConfirm(nb); });
  setTimeout(() => document.addEventListener('click', function h(e) { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', h); } }), 0);
}

function notebookColor(nb) {
  const colors = ['#38bdf8', '#6366f1', '#a78bfa', '#f472b6', '#34d399', '#fbbf24', '#fb7185', '#94a3b8'];
  const body = `<div class="nb-colors">${colors.map(c => `<button class="nb-color" data-c="${c}" style="background:${c}"></button>`).join('')}</div>`;
  modalShell('封面颜色', body, [{ label: '取消' }]);
  const mask = document.querySelector('#modalRoot .modal-mask');
  if (!mask) return;
  mask.querySelectorAll('.nb-color').forEach(b => b.addEventListener('click', () => {
    nb.color = b.dataset.c;
    saveLibrary(state.lib);
    renderLibrary();
    toast('已设置封面颜色');
  }));
}
function renameNotebook(nb) {
  promptModal('重命名笔记本', '', '笔记本名称', '保存', (name) => {
    if (!name) return;
    nb.name = name;
    saveLibrary(state.lib);
    renderLibrary();
    toast('已重命名');
  });
}

function deleteNotebookConfirm(nb) {
  const count = nb.noteIds.length;
  confirmModal(`删除笔记本「${nb.name}」？`, count ? `该笔记本下的 ${count} 篇笔记也会被一并删除，无法恢复。` : '该笔记本将被删除。', '删除', true, () => deleteNotebook(nb));
}

function deleteNotebook(nb) {
  for (const s of state.lib.subjects) {
    const idx = s.notebooks.findIndex(x => x.id === nb.id);
    if (idx >= 0) { s.notebooks.splice(idx, 1); break; }
  }
  nb.noteIds.forEach(id => delete state.lib.notes[id]);
  if (state.activeNotebookId === nb.id) {
    const first = state.lib.subjects.reduce((acc, s) => acc || s.notebooks[0] || null, null);
    if (first) {
      state.activeNotebookId = first.id;
      const notes = first.noteIds.map(id => state.lib.notes[id]).filter(Boolean);
      if (notes.length) openNote(notes[0].id);
      else { state.activeNoteId = null; renderLibrary(); engine.setPage(null); engine.invalidateRaster(); updatePageNav(); updateEmptyState(); }
    } else {
      state.activeNotebookId = null;
      state.activeNoteId = null;
      renderLibrary();
      engine.setPage(null);
      engine.invalidateRaster();
      updatePageNav();
      updateEmptyState();
    }
  }
  saveLibrary(state.lib);
  renderLibrary();
  toast('已删除笔记本');
}

/* ---------------- 笔记多选 ---------------- */
function enterMulti() {
  state.multi.on = true;
  state.multi.selected.clear();
  renderNoteList();
  renderMultiBar();
}
function exitMulti() {
  state.multi.on = false;
  state.multi.selected.clear();
  renderNoteList();
  renderMultiBar();
}
function toggleSelect(id) {
  if (state.multi.selected.has(id)) state.multi.selected.delete(id);
  else state.multi.selected.add(id);
  renderNoteList();
  renderMultiBar();
}
function renderMultiBar() {
  const bar = $('#multiBar');
  if (!bar) return;
  bar.classList.toggle('hidden', !state.multi.on);
  const c = $('#multiCount');
  if (c) c.textContent = '已选 ' + state.multi.selected.size;
}
function moveSelectedNotes() {
  if (!state.multi.selected.size) { toast('请先选择笔记'); return; }
  const nbs = [];
  for (const s of state.lib.subjects) for (const nb of s.notebooks) nbs.push(nb);
  if (nbs.length <= 1) { toast('没有其他笔记本可移动'); return; }
  const { body } = modalShell('移动到…', '<div class="copy-list"></div>', [{ label: '取消' }]);
  const list = body.querySelector('.copy-list');
  for (const nb of nbs) {
    const b = document.createElement('button');
    b.className = 'menu-item';
    b.textContent = nb.name;
    b.addEventListener('click', () => {
      closeModal();
      const ids = [...state.multi.selected];
      for (const id of ids) {
        const note = state.lib.notes[id];
        if (!note) continue;
        for (const s of state.lib.subjects) for (const nb2 of s.notebooks) {
          const i = nb2.noteIds.indexOf(id);
          if (i >= 0) nb2.noteIds.splice(i, 1);
        }
        note.notebookId = nb.id;
        nb.noteIds.push(id);
      }
      saveLibrary(state.lib);
      exitMulti();
      renderLibrary();
      toast('已移动 ' + ids.length + ' 篇笔记');
    });
    list.appendChild(b);
  }
}
function deleteSelectedNotes() {
  if (!state.multi.selected.size) { toast('请先选择笔记'); return; }
  const count = state.multi.selected.size;
  confirmModal(`删除选中的 ${count} 篇笔记？`, '删除后无法恢复。', '删除', true, () => {
    const ids = [...state.multi.selected];
    for (const id of ids) {
      for (const s of state.lib.subjects) for (const nb of s.notebooks) {
        const i = nb.noteIds.indexOf(id);
        if (i >= 0) nb.noteIds.splice(i, 1);
      }
      delete state.lib.notes[id];
    }
    if (state.activeNoteId && ids.includes(state.activeNoteId)) {
      const f = findNotebook(state.lib, state.activeNotebookId);
      const remaining = f ? f.notebook.noteIds.map(id => state.lib.notes[id]).filter(Boolean) : [];
      if (remaining.length) openNote(remaining[0].id);
      else { state.activeNoteId = null; renderLibrary(); engine.setPage(null); engine.invalidateRaster(); updatePageNav(); updateEmptyState(); }
    }
    exitMulti();
    renderLibrary();
    toast('已删除 ' + ids.length + ' 篇笔记');
  });
}

/* ---------------- 项目操作 ---------------- */
function subjectActions(subj, anchor) {
  document.querySelectorAll('.ni-menu').forEach(m => m.remove());
  const menu = document.createElement('div');
  menu.className = 'menu ni-menu';
  menu.innerHTML = `
    <button class="menu-item" data-act="rename"><svg viewBox="0 0 24 24" class="ic"><path d="M4 20l1.2-4.2L16.5 4.5a2.1 2.1 0 0 1 3 3L8.2 18.8 4 20z"/></svg>重命名</button>
    <button class="menu-item" data-act="color"><svg viewBox="0 0 24 24" class="ic"><circle cx="12" cy="12" r="9"/></svg>封面颜色</button>
    <button class="menu-item" data-act="emoji"><svg viewBox="0 0 24 24" class="ic"><path d="M4 6h16M4 12h16M4 18h16"/></svg>封面符号</button>
    <button class="menu-item danger" data-act="del"><svg viewBox="0 0 24 24" class="ic"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>删除</button>`;
  const r = anchor.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 190)) + 'px';
  menu.style.top = (r.bottom + 4) + 'px';
  document.body.appendChild(menu);
  menu.querySelector('[data-act="rename"]').addEventListener('click', () => { menu.remove(); renameSubject(subj); });
  menu.querySelector('[data-act="del"]').addEventListener('click', () => { menu.remove(); deleteSubjectConfirm(subj); });
  setTimeout(() => document.addEventListener('click', function h(e) { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', h); } }), 0);
}

function renameSubject(subj) {
  promptModal('重命名项目', '', '项目名称', '保存', (name) => {
    if (!name) return;
    subj.name = name;
    saveLibrary(state.lib);
    renderLibrary();
    toast('已重命名');
  });
}

function deleteSubjectConfirm(subj) {
  const nbCount = subj.notebooks.length;
  const noteCount = subj.notebooks.reduce((a, nb) => a + nb.noteIds.length, 0);
  confirmModal(`删除项目「${subj.name}」？`, noteCount ? `该项目下的 ${nbCount} 个笔记本和 ${noteCount} 篇笔记都会一并删除，无法恢复。` : '该项目将被删除。', '删除', true, () => deleteSubject(subj));
}

function deleteSubject(subj) {
  const idx = state.lib.subjects.findIndex(s => s.id === subj.id);
  if (idx < 0) return;
  state.lib.subjects.splice(idx, 1);
  subj.notebooks.forEach(nb => nb.noteIds.forEach(id => delete state.lib.notes[id]));
  if (state.activeSubjectId === subj.id) {
    const first = state.lib.subjects[0];
    if (first && first.notebooks.length) {
      state.activeSubjectId = first.id;
      state.activeNotebookId = first.notebooks[0].id;
      const notes = first.notebooks[0].noteIds.map(id => state.lib.notes[id]).filter(Boolean);
      if (notes.length) openNote(notes[0].id);
      else { state.activeNoteId = null; renderLibrary(); engine.setPage(null); engine.invalidateRaster(); updatePageNav(); updateEmptyState(); }
    } else {
      state.activeSubjectId = state.lib.subjects[0] ? state.lib.subjects[0].id : null;
      state.activeNotebookId = null;
      state.activeNoteId = null;
      renderLibrary();
      engine.setPage(null);
      engine.invalidateRaster();
      updatePageNav();
      updateEmptyState();
    }
  }
  saveLibrary(state.lib);
  renderLibrary();
  toast('已删除项目');
}

/* ---------------- 复制页到其他笔记 ---------------- */
function copyPageTo() {
  const src = currentNote();
  const srcPage = currentPage();
  if (!src || !srcPage) return;
  const targets = [];
  for (const s of state.lib.subjects) for (const nb of s.notebooks) for (const id of nb.noteIds) {
    const n = state.lib.notes[id];
    if (n && n.id !== src.id) targets.push(n);
  }
  if (!targets.length) { toast('没有其他笔记可复制'); return; }
  const { body } = modalShell('复制当前页到…', '<div class="copy-list"></div>', [{ label: '取消' }]);
  const list = body.querySelector('.copy-list');
  for (const n of targets) {
    const b = document.createElement('button');
    b.className = 'menu-item';
    b.textContent = n.title;
    b.addEventListener('click', () => {
      closeModal();
      const copy = JSON.parse(JSON.stringify(srcPage));
      copy.id = newId();
      copy.strokes.forEach(s => s.id = newId());
      copy.texts.forEach(t => t.id = newId());
      n.pages.push(copy);
      n.updatedAt = Date.now();
      saveLibrary(state.lib);
      toast('已复制到「' + n.title + '」');
    });
    list.appendChild(b);
  }
}

/* ---------------- 页面缩略图 ---------------- */
function refreshThumbs() {
  const note = currentNote();
  if (!note) return;
  const list = $('#pagesList');
  [...list.children].forEach((el, i) => {
    const cv = el.querySelector('canvas');
    if (cv && note.pages[i]) renderPageToCanvas(cv, note.pages[i], note.paper, 160, currentFont(), note.pageW, note.pageH);
    el.classList.toggle('active', i === state.pageIndex);
  });
}

/* 连续纸张视图：所有页纵向连成一列，中间一条分割线，可连续滑动 */
let _vcCache = null, _tlCache = null;
function renderPaperStack(keepScroll) {
  const note = currentNote();
  const holder = $('#paperHolder');
  if (!holder) return;
  if (!_vcCache) _vcCache = document.getElementById('viewCanvas');
  if (!_tlCache) _tlCache = document.getElementById('textLayer');
  let stack = $('#paperStack');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'paperStack';
    stack.className = 'paper-stack';
    holder.insertBefore(stack, holder.firstChild);
  }
  stack.innerHTML = '';
  if (!note) { stack.style.display = 'none'; return; }
  stack.style.display = 'flex';
  note.pages.forEach((page, i) => {
    const slot = document.createElement('div');
    slot.className = 'paper-slot' + (i === state.pageIndex ? ' current' : '');
    slot.dataset.i = String(i);
    slot.style.aspectRatio = ((note.pageW || PAGE_W) + ' / ' + (note.pageH || PAGE_H));
    if (i === state.pageIndex) {
      if (_vcCache && _vcCache.parentElement !== slot) slot.appendChild(_vcCache);
      if (_tlCache && _tlCache.parentElement !== slot) slot.appendChild(_tlCache);
      const num = document.createElement('span');
      num.className = 'paper-slot-num';
      num.textContent = i + 1;
      slot.appendChild(num);
    } else {
      if (Math.abs(i - state.pageIndex) <= 2) {
        const cv = document.createElement('canvas');
        renderPageToCanvas(cv, page, note.paper, 640, currentFont(), note.pageW, note.pageH);
        slot.appendChild(cv);
      } else {
        slot.classList.add('placeholder');
        const num = document.createElement('span');
        num.className = 'paper-slot-num';
        num.textContent = i + 1;
        slot.appendChild(num);
      }
      slot.addEventListener('click', () => { if (i !== state.pageIndex && currentNote()) switchPage(i); });
    }
    stack.appendChild(slot);
  });
  if (!keepScroll) {
    requestAnimationFrame(() => {
      const cur = stack.querySelector('.paper-slot.current');
      if (cur) {
        const target = cur.offsetTop - holder.clientHeight / 2 + cur.clientHeight / 2;
        holder.scrollTop = Math.max(0, target);
      }
    });
  }
}

function renderPages() {
  const note = currentNote();
  const list = $('#pagesList');
  list.innerHTML = '';
  if (!note) return;
  note.pages.forEach((page, i) => {
    const btn = document.createElement('button');
    btn.className = 'page-thumb' + (i === state.pageIndex ? ' active' : '');
    const cv = document.createElement('canvas');
    renderPageToCanvas(cv, page, note.paper, 160, currentFont(), note.pageW, note.pageH);
    btn.appendChild(cv);
    const num = document.createElement('span');
    num.className = 'pt-num';
    num.textContent = i + 1;
    btn.appendChild(num);
    if (note.pages.length > 1) {
      const d = document.createElement('button');
      d.className = 'pt-del';
      d.title = '删除此页';
      d.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><path d="M6.2 6.2l11.6 11.6M17.8 6.2L6.2 17.8"/></svg>';
      d.addEventListener('click', (e) => { e.stopPropagation(); deletePageAt(i); });
      btn.appendChild(d);
      if (i > 0) {
        const mL = document.createElement('button');
        mL.className = 'pt-move left';
        mL.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><path d="M15 6l-6 6 6 6"/></svg>';
        mL.addEventListener('click', (e) => { e.stopPropagation(); movePage(i, -1); });
        btn.appendChild(mL);
      }
      if (i < note.pages.length - 1) {
        const mR = document.createElement('button');
        mR.className = 'pt-move right';
        mR.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><path d="M9 6l6 6-6 6"/></svg>';
        mR.addEventListener('click', (e) => { e.stopPropagation(); movePage(i, 1); });
        btn.appendChild(mR);
      }
    }
    btn.addEventListener('click', () => switchPage(i));
    // 拖拽排序
    let dragState = null;
    btn.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (state.multi.on) return;
      if (e.target.closest('.pt-move') || e.target.closest('.pt-del')) return;
      e.preventDefault();
      const r = btn.getBoundingClientRect();
      const ghost = btn.cloneNode(true);
      ghost.className = 'page-thumb ghost';
      ghost.style.position = 'fixed';
      ghost.style.width = r.width + 'px';
      ghost.style.left = r.left + 'px';
      ghost.style.top = r.top + 'px';
      ghost.style.zIndex = 999;
      ghost.style.margin = '0';
      document.body.appendChild(ghost);
      btn.classList.add('dragging');
      dragState = { from: i, y0: e.clientY, ghost, id: e.pointerId, startTop: r.top, target: i };
      try { btn.setPointerCapture(e.pointerId); } catch (_) {}
    });
    btn.addEventListener('pointermove', (e) => {
      if (!dragState || dragState.id !== e.pointerId) return;
      const dy = e.clientY - dragState.y0;
      dragState.ghost.style.top = (dragState.startTop + dy) + 'px';
      const lr = list.getBoundingClientRect();
      const thumbH = btn.offsetHeight + 10;
      const target = Math.max(0, Math.min(note.pages.length - 1, Math.round((e.clientY - lr.top) / thumbH)));
      dragState.target = target;
    });
    const endDrag = () => {
      if (!dragState) return;
      const from = dragState.from, target = dragState.target;
      if (dragState.ghost) dragState.ghost.remove();
      btn.classList.remove('dragging');
      dragState = null;
      if (from !== target) reorderPage(from, target);
    };
    btn.addEventListener('pointerup', endDrag);
    btn.addEventListener('pointercancel', endDrag);
    list.appendChild(btn);
  });
}

function reorderPage(from, to) {
  const note = currentNote();
  if (!note || from === to || to < 0 || to >= note.pages.length) return;
  const before = note.pages.slice();
  const arr = note.pages.slice();
  const [p] = arr.splice(from, 1);
  arr.splice(to, 0, p);
  pushHistory('移动页面',
    () => { note.pages = before; afterPageArrayRestore(); },
    () => { note.pages = arr; afterPageArrayRestore(); });
  note.pages = arr;
  state.pageIndex = to;
  applyPagesChange();
}

function movePage(from, dir) {
  const note = currentNote();
  if (!note) return;
  const to = from + dir;
  if (to < 0 || to >= note.pages.length) return;
  const before = note.pages.slice();
  const arr = note.pages.slice();
  const [p] = arr.splice(from, 1);
  arr.splice(to, 0, p);
  pushHistory('移动页面',
    () => { note.pages = before; afterPageArrayRestore(); },
    () => { note.pages = arr; afterPageArrayRestore(); });
  note.pages = arr;
  state.pageIndex = to;
  applyPagesChange();
}

/* ---------------- 导出 / 导入 / 分享 ---------------- */
function safeName(name) { return (name || '笔记').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60); }

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function shareOrDownload(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      toast('已分享');
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
  }
  download(blob, filename);
  toast('已下载');
}

async function exportNote() {
  const note = currentNote();
  if (!note) return;
  const data = { format: 'note2', version: 1, type: 'note', exportedAt: new Date().toISOString(), note };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  await shareOrDownload(blob, safeName(note.title) + '.note');
}

async function exportPagePng() {
  const note = currentNote();
  if (!note || !currentPage()) return;
  const cv = document.createElement('canvas');
  renderPageToCanvas(cv, currentPage(), note.paper, 1224, currentFont(), note.pageW, note.pageH);
  const blob = await new Promise(res => cv.toBlob(res, 'image/png'));
  if (!blob) { toast('导出失败'); return; }
  await shareOrDownload(blob, safeName(note.title) + '-第' + (state.pageIndex + 1) + '页.png');
}

function withPdfHeader(cv, title, idx, total) {
  const h = 96;
  const out = document.createElement('canvas');
  out.width = cv.width; out.height = cv.height + h;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, h);
  ctx.strokeStyle = 'rgba(15,23,42,.12)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, h - 2); ctx.lineTo(out.width, h - 2); ctx.stroke();
  ctx.fillStyle = '#475569';
  ctx.font = '600 30px ' + currentFont();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(String(title || '').slice(0, 60), 36, h / 2);
  ctx.textAlign = 'right';
  ctx.fillText((idx + 1) + ' / ' + total, out.width - 36, h / 2);
  ctx.textAlign = 'left';
  ctx.drawImage(cv, 0, h);
  return out;
}

async function exportPdf() {
  const note = currentNote();
  if (!note) return;
  toast('正在生成 PDF…');
  await new Promise(r => setTimeout(r, 30));
  const total = note.pages.length;
  const canvases = note.pages.map((page, i) => {
    const cv = document.createElement('canvas');
    renderPageToCanvas(cv, page, note.paper, 1224, currentFont(), note.pageW, note.pageH);
    return withPdfHeader(cv, note.title, i, total);
  });
  const blob = canvasesToPdf(canvases, { title: note.title });
  await shareOrDownload(blob, safeName(note.title) + '.pdf');
}

async function exportLibrary() {
  const data = { format: 'note2', version: 1, type: 'library', exportedAt: new Date().toISOString(), library: state.lib };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  await shareOrDownload(blob, '笔记资料库.notebook');
}

async function handleImport(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    let notes = [];
    if (data && data.format === 'note2' && data.type === 'note' && data.note) notes = [data.note];
    else if (data && data.format === 'note2' && data.type === 'library' && data.library && data.library.notes) notes = Object.values(data.library.notes);
    if (!notes.length) { toast('无法识别的笔记文件'); return; }
    // 重新生成 id 防止冲突
    const fresh = notes.map(cloneNoteWithNewIds);
    const subj = { id: newId(), name: '导入的笔记 · ' + new Date().toLocaleDateString('zh-CN'), notebooks: [] };
    const nb = { id: newId(), name: file.name.replace(/\.[^.]+$/, ''), noteIds: [] };
    for (const n of fresh) {
      n.notebookId = nb.id;
      state.lib.notes[n.id] = n;
      nb.noteIds.push(n.id);
    }
    subj.notebooks.push(nb);
    state.lib.subjects.push(subj);
    state.lib = sanitize(state.lib);
    await saveLibrary(state.lib);
    openNote(fresh[0].id);
    renderLibrary();
    toast(`已导入 ${fresh.length} 个笔记`);
  } catch (err) {
    console.error(err);
    toast('导入失败：文件格式不正确');
  }
}

function cloneNoteWithNewIds(note) {
  const c = JSON.parse(JSON.stringify(note));
  c.id = newId();
  c.notebookId = null;
  c.pages.forEach(p => {
    p.id = newId();
    p.strokes.forEach(s => s.id = newId());
    p.texts.forEach(t => t.id = newId());
  });
  return c;
}

/* ---------------- v4.26：收藏 / 笔型 / 图片 / PDF / 波形 / 文字样式 / 演示 / 备份 ---------------- */
const PEN_STYLES = ['normal', 'pencil', 'brush', 'dashed', 'dotted'];
const STYLE_NAMES = { normal: '钢笔', pencil: '铅笔', brush: '画笔', dashed: '虚线', dotted: '点线' };

/* ---- 收藏工具条 ---- */
function favoriteKey(f) { return f.tool + ':' + f.color + ':' + (f.width || '') + ':' + (f.style || 'normal') + ':' + (f.eraserSize || ''); }
function renderFavorites() {
  const bar = $('#favoritesBar');
  const list = $('#favList');
  if (!bar || !list) return;
  const favs = state.lib.settings.favorites || [];
  bar.classList.toggle('hidden', !state.lib.settings.favoritesBar || !favs.length);
  list.innerHTML = '';
  favs.forEach((f, idx) => {
    const active = f.tool === state.tool && f.color === state.color && (f.style || 'normal') === (state.styles[f.tool] || 'normal');
    const b = document.createElement('button');
    b.className = 'fav-chip' + (active ? ' active' : '');
    b.title = STYLE_NAMES[f.style || 'normal'] + ' · ' + (f.color || '');
    b.innerHTML = `<span class="fav-dot" style="background:${f.color}"></span><span class="fav-tool">${f.tool === 'highlighter' ? '荧光' : f.tool === 'ballpen' ? '圆珠' : f.tool === 'eraser' ? '橡皮' : f.tool === 'pixelEraser' ? '像素擦' : '钢笔'}</span>`;
    b.addEventListener('click', () => {
      if (state.favEdit) {
        state.lib.settings.favorites.splice(idx, 1);
        saveLibrary(state.lib);
        renderFavorites();
        toast('已移除收藏');
        return;
      }
      applyFavorite(f);
    });
    list.appendChild(b);
  });
  const ed = $('#favEdit');
  if (ed) ed.classList.toggle('active', !!state.favEdit);
}
function applyFavorite(f) {
  state.tool = f.tool;
  state.color = f.color;
  if (!state.colors[f.tool]) state.colors[f.tool] = f.color;
  state.colors[f.tool] = f.color;
  if (f.width) state.widths[f.tool] = f.width;
  if (f.style) state.styles[f.tool] = f.style;
  if (f.eraserSize && (f.tool === 'eraser' || f.tool === 'pixelEraser')) state.lib.settings.eraserSize = f.eraserSize;
  $('#colorPop').classList.add('hidden');
  updateToolUI();
  updateColorUI();
  saveLibrary(state.lib);
}
function addFavorite() {
  const st = state.lib.settings;
  const favs = st.favorites || (st.favorites = []);
  const f = { tool: state.tool, color: state.color, width: state.widths[state.tool] || 5, style: state.styles[state.tool] || 'normal' };
  if (state.tool === 'eraser' || state.tool === 'pixelEraser') f.eraserSize = st.eraserSize || 26;
  if (favs.some(x => favoriteKey(x) === favoriteKey(f))) { toast('已在收藏中'); return; }
  if (favs.length >= 8) { toast('最多收藏 8 个'); return; }
  favs.push(f);
  saveLibrary(state.lib);
  renderFavorites();
  toast('已收藏当前工具');
}
function toggleFavEdit() {
  state.favEdit = !state.favEdit;
  document.body.classList.toggle('fav-editing', !!state.favEdit);
  renderFavorites();
}

/* ---- 笔型选择 ---- */
function renderStyleRow() {
  const row = $('#styleRow');
  if (!row) return;
  const isPen = state.tool === 'pen' || state.tool === 'ballpen';
  row.classList.toggle('hidden', !isPen);
  if (!isPen) return;
  row.innerHTML = '';
  PEN_STYLES.forEach(v => {
    const b = document.createElement('button');
    b.className = 'style-btn' + ((state.styles[state.tool] || 'normal') === v ? ' active' : '');
    b.textContent = STYLE_NAMES[v];
    b.addEventListener('click', () => {
      state.styles[state.tool] = v;
      if (state.tool === 'pen') state.lib.settings.penStyle = v;
      else state.lib.settings.ballpenStyle = v;
      saveLibrary(state.lib);
      renderStyleRow();
      renderFavorites();
    });
    row.appendChild(b);
  });
}

/* ---- 插入图片 / 拍照 ---- */
function readFileAsDataURL(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(file);
  });
}
async function insertImage(file, source) {
  if (!file || !currentPage()) { toast('请先打开一个笔记'); return; }
  try {
    const src = await readFileAsDataURL(file);
    const page = currentPage();
    const item = { id: newId(), x: 0.28, y: 0.25, w: 0.44, h: 0.3, src, rot: 0 };
    mutate(() => { page.images = page.images || []; page.images.push(item); }, '插入图片');
    engine.invalidateRaster();
    refreshThumbs();
    saveSoon(true);
    toast(source === 'camera' ? '已插入照片' : '已插入图片');
  } catch (_) { toast('图片读取失败'); }
}

/* ---- 扫描文档（Notability 风格：拍照/相册 -> 多页笔记） ---- */
let scanItems = [];
let scanCtx = null;

function downscaleDataURL(src, maxDim) {
  return new Promise((resolve) => {
    const dim = maxDim || 1400;
    const img = new Image();
    img.onload = () => {
      let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
      if (Math.max(w, h) > dim) {
        const k = dim / Math.max(w, h);
        w = Math.round(w * k); h = Math.round(h * k);
      }
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      try { resolve(cv.toDataURL('image/jpeg', 0.82)); } catch (_) { resolve(src); }
    };
    img.onerror = () => resolve(src);
    img.src = src;
  });
}

function openScanner() {
  scanItems = [];
  const { body, btnRow } = modalShell('扫描文档',
    '<div class="scan-tip">拍照或从相册选择，可多张连拍；完成后生成一篇多页笔记。</div>' +
    '<div class="scan-actions"><button class="m-btn primary" id="scanCamera">拍照</button><button class="m-btn ghost" id="scanGallery">从相册选择…</button></div>' +
    '<div class="scan-list"></div>' +
    '<input type="file" id="scanCamInput" accept="image/*" capture="environment" hidden>' +
    '<input type="file" id="scanGalInput" accept="image/*" multiple hidden>',
    [{ label: '取消' }, { label: '完成', primary: true, action: finishScan }]);
  const list = body.querySelector('.scan-list');
  const finishBtn = btnRow.querySelector('.m-btn.primary');
  scanCtx = { list, finishBtn };
  body.querySelector('#scanCamera').addEventListener('click', () => body.querySelector('#scanCamInput').click());
  body.querySelector('#scanGallery').addEventListener('click', () => body.querySelector('#scanGalInput').click());
  const onFiles = async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    for (const f of files) await addScanFile(f);
  };
  body.querySelector('#scanCamInput').addEventListener('change', onFiles);
  body.querySelector('#scanGalInput').addEventListener('change', onFiles);
  renderScanList();
}

async function addScanFile(file) {
  if (!file || !(file.type || '').startsWith('image/')) { toast('请选择图片'); return; }
  const src = await readFileAsDataURL(file);
  const small = await downscaleDataURL(src);
  scanItems.push({ src: small, name: file.name || ('扫描 ' + (scanItems.length + 1)) });
  renderScanList();
}

function renderScanList() {
  const ctx = scanCtx;
  if (!ctx) return;
  ctx.list.innerHTML = '';
  if (!scanItems.length) {
    ctx.list.innerHTML = '<div class="scan-empty">还没有页面，先拍照或选图</div>';
  }
  scanItems.forEach((it, idx) => {
    const row = document.createElement('div');
    row.className = 'scan-item';
    const thumb = document.createElement('img');
    thumb.src = it.src;
    const meta = document.createElement('span');
    meta.className = 'scan-meta';
    meta.textContent = '第 ' + (idx + 1) + ' 页';
    const del = document.createElement('button');
    del.className = 'scan-del';
    del.setAttribute('aria-label', '删除');
    del.textContent = '✕';
    del.addEventListener('click', () => { scanItems.splice(idx, 1); renderScanList(); });
    row.appendChild(thumb); row.appendChild(meta); row.appendChild(del);
    ctx.list.appendChild(row);
  });
  ctx.finishBtn.textContent = '完成 (' + scanItems.length + ' 页)';
}

async function finishScan() {
  if (!scanItems.length) { toast('还没有扫描页面'); return; }
  let notebookId = currentNote() ? currentNote().notebookId : firstNotebookId();
  let nb = notebookId ? findNotebook(state.lib, notebookId) : null;
  if (!nb) {
    let subj = null;
    try { subj = findActiveSubject(); } catch (_) {}
    subj = subj || state.lib.subjects[0];
    if (!subj) { toast('请先创建项目/笔记本'); return; }
    const nbObj = { id: newId(), name: '我的笔记本', noteIds: [] };
    subj.notebooks.push(nbObj);
    notebookId = nbObj.id;
    nb = { subject: subj, notebook: nbObj };
  }
  const d = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  const title = '扫描 · ' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  const note = newNote(notebookId, title, { style: 'blank', color: 'white' });
  note.pages = scanItems.map(it => {
    const p = newPage();
    p.images = [];
    p.bg = { src: it.src, alpha: 1 };
    return p;
  });
  state.lib.notes[note.id] = note;
  nb.notebook.noteIds.push(note.id);
  await saveLibrary(state.lib);
  closeModal();
  scanItems = [];
  scanCtx = null;
  openNote(note.id);
  toast('已生成 ' + note.pages.length + ' 页扫描笔记');
}

/* ---- PDF 导入标注 ---- */
async function importPdf(file) {
  if (!file) return;
  if (!window.pdfjsLib) { toast('PDF 组件未加载，请刷新后重试'); return; }
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';
  toast('正在解析 PDF…');
  try {
    const buf = await file.arrayBuffer();
    const doc = await window.pdfjsLib.getDocument({ data: buf }).promise;
    const maxPages = Math.min(doc.numPages, 60);
    let rStart = 1, rEnd = maxPages;
    if (maxPages > 1) {
      rStart = await new Promise((resolve) => {
        modalShell('导入页范围', '<input id="pdfRange" class="pdf-range" value="1-' + maxPages + '" placeholder="如 1-20 或全部">', [
          { label: '取消', action: (mask) => { closeModal(); resolve(1); } },
          { label: '导入', primary: true, action: (mask) => {
            const v = (document.querySelector('#pdfRange') || {}).value || '';
            const parts = v.split('-').map(x => parseInt(x, 10));
            let a = 1, b = maxPages;
            if (parts.length === 2 && parts[0] > 0 && parts[1] >= parts[0]) { a = parts[0]; b = Math.min(parts[1], maxPages); }
            else if (parts.length === 1 && parts[0] > 0) { a = b = Math.min(parts[0], maxPages); }
            closeModal();
            resolve(a);
            window.__pdfRangeEnd = b;
          } }
        ]);
      });
      rEnd = window.__pdfRangeEnd || maxPages;
      delete window.__pdfRangeEnd;
    }
    const pages = [];
    const totalImp = rEnd - rStart + 1;
    for (let i = rStart; i <= rEnd; i++) {
      if ((i - rStart) % 5 === 0) toast('正在导入 ' + (i - rStart + 1) + '/' + totalImp + ' 页…');
      const pdfPage = await doc.getPage(i);
      const base = pdfPage.getViewport({ scale: 1 });
      const targetW = Math.min(1400, Math.round(base.width * 1.5));
      const scale = targetW / base.width;
      const vp = pdfPage.getViewport({ scale });
      const cv = document.createElement('canvas');
      cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
      await pdfPage.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
      const src = cv.toDataURL('image/jpeg', 0.82);
      pages.push({ id: newId(), strokes: [], texts: [], images: [], bg: { kind: 'pdf', src, w: cv.width, h: cv.height } });
    }
    const subj = { id: newId(), name: '导入的 PDF · ' + new Date().toLocaleDateString('zh-CN'), notebooks: [] };
    const nb = { id: newId(), name: file.name.replace(/\.[^.]+$/, ''), noteIds: [] };
    const note = { id: newId(), notebookId: nb.id, title: file.name.replace(/\.[^.]+$/, ''), createdAt: Date.now(), updatedAt: Date.now(), paper: { style: 'blank', color: 'white' }, pages };
    state.lib.notes[note.id] = note;
    nb.noteIds.push(note.id);
    subj.notebooks.push(nb);
    state.lib.subjects.push(subj);
    state.lib = sanitize(state.lib);
    await saveLibrary(state.lib);
    openNote(note.id);
    renderLibrary();
    toast('已导入 PDF：' + maxPages + ' 页');
  } catch (err) {
    console.error(err);
    toast('PDF 导入失败');
  }
}

/* ---- 录音波形 ---- */
const waveCache = new Map();
async function buildWave(id, blob) {
  try {
    const buf = await blob.arrayBuffer();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const audio = await ctx.decodeAudioData(buf);
    const data = audio.getChannelData(0);
    const bars = 64;
    const peaks = [];
    const step = Math.max(1, Math.floor(data.length / bars));
    for (let i = 0; i < bars; i++) {
      let m = 0;
      for (let j = i * step; j < Math.min((i + 1) * step, data.length); j++) m = Math.max(m, Math.abs(data[j]));
      peaks.push(Math.max(0.05, Math.min(1, m * 2.2)));
    }
    waveCache.set(id, { peaks, dur: audio.duration });
    try { ctx.close(); } catch (_) {}
    return waveCache.get(id);
  } catch (_) { return null; }
}
function drawWave(canvas, peaks, progress) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 120, h = canvas.clientHeight || 28;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const n = peaks.length;
  const bw = w / n;
  for (let i = 0; i < n; i++) {
    const ph = Math.max(2, peaks[i] * (h - 4));
    const x = i * bw + bw * 0.15, ww = bw * 0.7;
    ctx.fillStyle = progress !== null && i / n <= progress ? 'rgba(37,99,235,.9)' : 'rgba(120,130,150,.45)';
    ctx.beginPath();
    ctx.rect(x, (h - ph) / 2, ww, ph);
    ctx.fill();
  }
}

/* ---- 文字样式预设 ---- */
function ensureTextPresets() {
  const st = state.lib.settings;
  if (!st.textPresets || !st.textPresets.length) {
    st.textPresets = [
      { name: '标题', fontSize: 34, bold: true, italic: false, underline: false },
      { name: '正文', fontSize: 26, bold: false, italic: false, underline: false },
      { name: '小字', fontSize: 18, bold: false, italic: false, underline: false }
    ];
  }
}
function openTextPresets() {
  ensureTextPresets();
  const st = state.lib.settings;
  const body = st.textPresets.map((p, i) => `
    <div class="pres-row">
      <input class="pres-name" data-i="${i}" data-k="name" value="${escapeHtml(p.name)}" placeholder="名称">
      <select data-i="${i}" data-k="fontSize">
        ${[18, 26, 34].map(v => `<option value="${v}" ${p.fontSize === v ? 'selected' : ''}>${v}px</option>`).join('')}
      </select>
      <label class="pres-chk"><input type="checkbox" data-i="${i}" data-k="bold" ${p.bold ? 'checked' : ''}> 加粗</label>
    </div>`).join('');
  modalShell('文字样式预设', body, [
    { label: '取消' },
    { label: '保存', primary: true, action: (mask) => {
      mask.querySelectorAll('.pres-row').forEach(row => {
        const i = Number(row.querySelector('[data-k="name"]').dataset.i);
        const p = st.textPresets[i];
        if (!p) return;
        p.name = row.querySelector('[data-k="name"]').value.trim() || p.name;
        p.fontSize = Number(row.querySelector('[data-k="fontSize"]').value);
        p.bold = row.querySelector('[data-k="bold"]').checked;
      });
      saveLibrary(state.lib);
      closeModal();
      toast('文字预设已保存');
    }}
  ]);
}

/* ---- 演示模式 ---- */
let presDrawOn = false;
let presCur = null;
let presStrokes = [];
let presColor = 'rgba(250,204,21,.55)';
let presPlaying = false;
let presTimer = null;
let presClockTimer = null;
let presStart = 0;
const PRES_COLORS = { yellow: 'rgba(250,204,21,.55)', red: 'rgba(239,68,68,.5)', green: 'rgba(34,197,94,.5)', blue: 'rgba(59,130,246,.5)', white: 'rgba(255,255,255,.6)' };
function renderPresMark() {
  const mk = $('#presMark');
  const cv = $('#presCanvas');
  if (!mk || !cv) return;
  const r = cv.getBoundingClientRect();
  mk.width = Math.round(r.width);
  mk.height = Math.round(r.height);
  const ctx = mk.getContext('2d');
  ctx.clearRect(0, 0, mk.width, mk.height);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = presColor;
  ctx.lineWidth = 14;
  const drawOne = (pts) => { if (!pts || pts.length < 2) return; ctx.beginPath(); pts.forEach((p, i) => { i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); }); ctx.stroke(); };
  presStrokes.forEach(drawOne);
  if (presCur) drawOne(presCur);
}

function presentMode() {
  const note = currentNote();
  if (!note) { toast('请先打开一个笔记'); return; }
  $('#presMode').classList.remove('hidden');
  presStart = Date.now();
  clearInterval(presClockTimer);
  presClockTimer = setInterval(updatePresClock, 1000);
  updatePresClock();
  renderPresPage();
}
function updatePresClock() {
  const el = $('#presClock');
  if (!el) return;
  const s = Math.floor((Date.now() - presStart) / 1000);
  el.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function renderPresPage() {
  const note = currentNote();
  if (!note) return;
  const stage = $('#presStage');
  const cv = $('#presCanvas');
  const ww = window.innerWidth * 0.94, wh = window.innerHeight * 0.9;
  const ratio = pageW() / pageH();
  let w = ww, h = w / ratio;
  if (h > wh) { h = wh; w = h * ratio; }
  w = Math.round(w); h = Math.round(h);
  stage.style.width = w + 'px';
  stage.style.height = h + 'px';
  cv.style.width = w + 'px';
  cv.style.height = h + 'px';
  renderPageToCanvas(cv, currentPage(), note.paper, Math.round(w * 1.5), currentFont(), note.pageW, note.pageH);
  const lz = $('#presLaser');
  if (lz) { lz.width = w; lz.height = h; const lc = lz.getContext('2d'); lc.clearRect(0, 0, w, h); }
  presStrokes = []; presCur = null; renderPresMark();
  $('#presLabel').textContent = (state.pageIndex + 1) + ' / ' + note.pages.length;
  const pf = $('#presProgressFill');
  if (pf) pf.style.width = Math.round(((state.pageIndex + 1) / note.pages.length) * 100) + '%';
}
function drawLaser(e) {
  const cv = $('#presCanvas');
  const lz = $('#presLaser');
  if (!cv || !lz) return;
  const r = cv.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const dpr = window.devicePixelRatio || 1;
  if (lz.width !== Math.round(r.width * dpr) || lz.height !== Math.round(r.height * dpr)) { lz.width = Math.round(r.width * dpr); lz.height = Math.round(r.height * dpr); }
  const ctx = lz.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, r.width, r.height);
  const g = ctx.createRadialGradient(x, y, 2, x, y, 26);
  g.addColorStop(0, 'rgba(239,68,68,.95)');
  g.addColorStop(0.5, 'rgba(239,68,68,.5)');
  g.addColorStop(1, 'rgba(239,68,68,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, 26, 0, 7); ctx.fill();
}
function clearLaser() {
  const lz = $('#presLaser');
  if (!lz) return;
  const ctx = lz.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, lz.width, lz.height);
}
function exitPresent() {
  $('#presMode').classList.add('hidden');
  presStrokes = []; presCur = null; presDrawOn = false; presPlaying = false;
  clearInterval(presClockTimer); clearTimeout(presTimer);
  const pb = $('#presPen'); if (pb) pb.classList.remove('active');
  const pp = $('#presPlay'); if (pp) pp.textContent = '▶';
}
function togglePresPlay() {
  const note = currentNote();
  if (!note) return;
  presPlaying = !presPlaying;
  const pp = $('#presPlay');
  if (pp) pp.textContent = presPlaying ? '⏸' : '▶';
  if (presPlaying) presAdvance();
  else clearTimeout(presTimer);
}
function presAdvance() {
  if (!presPlaying) return;
  const note = currentNote();
  if (!note) return;
  clearTimeout(presTimer);
  if (state.pageIndex < note.pages.length - 1) {
    switchPage(state.pageIndex + 1);
    renderPresPage();
    presTimer = setTimeout(presAdvance, 5000);
  } else {
    presPlaying = false;
    const pp = $('#presPlay'); if (pp) pp.textContent = '▶';
  }
}
function setPresColor(key) {
  presColor = PRES_COLORS[key] || presColor;
  document.querySelectorAll('#presColors .pres-swatch').forEach(b => b.classList.toggle('active', b.dataset.c === key));
  renderPresMark();
}

/* ---- 自动备份快照 ---- */
let snapTimer = null;
function scheduleSnapshot(immediate) {
  clearTimeout(snapTimer);
  snapTimer = setTimeout(async () => {
    if (state.lib && state.lib.settings.autoBackup === false) return;
    await saveSnapshot(state.lib);
  }, immediate ? 2500 : 45000);
}
async function openSnapshots() {
  const list = await listSnapshots();
  if (!list.length) { toast('还没有备份快照'); return; }
  const body = list.map(s => `
    <div class="snap-row">
      <span class="snap-info">${new Date(s.ts).toLocaleString('zh-CN')} · ${s.library ? Object.keys(s.library.notes).length : 0} 篇笔记</span>
      <button class="mini-btn" data-restore="${s.id}">恢复</button>
      <button class="mini-btn danger" data-del="${s.id}">删除</button>
    </div>`).join('');
  modalShell('备份快照（最近 10 份）', body, [{ label: '关闭' }]);
  const mask = document.querySelector('#modalRoot .modal-mask');
  if (!mask) return;
  mask.querySelectorAll('[data-restore]').forEach(b => b.addEventListener('click', async () => {
    const lib = await loadSnapshot(b.dataset.restore);
    if (!lib) { toast('快照不可用'); return; }
    confirmModal('恢复此快照？', '当前资料库将被快照内容替换（当前内容会先自动备份一份）。', '恢复', true, async () => {
      await saveSnapshot(state.lib);
      state.lib = lib;
      applySettingsFromLib(lib);
      await saveLibrary(state.lib);
      renderLibrary();
      bootstrapUI();
      toast('已恢复备份快照');
    });
  }));
  mask.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    await deleteSnapshot(b.dataset.del);
    openSnapshots();
  }));
}

/* ---- 选中内容：删除 / 复制 / 粘贴 ---- */
let cropCtx = null;

function finishCrop() {
  if (!cropCtx) return;
  const { base, im, stage, boxEl } = cropCtx;
  const sw = stage.offsetWidth, sh = stage.offsetHeight;
  if (!sw || !sh) { toast('图片未加载'); return; }
  const sx = base.width / sw, sy = base.height / sh;
  const bx = parseFloat(boxEl.style.left) || 0, by = parseFloat(boxEl.style.top) || 0;
  const bw = parseFloat(boxEl.style.width) || sw, bh = parseFloat(boxEl.style.height) || sh;
  const cw = Math.max(2, Math.round(bw * sx)), ch = Math.max(2, Math.round(bh * sy));
  const cx = Math.max(0, Math.round(bx * sx)), cy = Math.max(0, Math.round(by * sy));
  const cv = document.createElement('canvas');
  cv.width = cw; cv.height = ch;
  cv.getContext('2d').drawImage(base, cx, cy, cw, ch, 0, 0, cw, ch);
  im.src = cv.toDataURL('image/png');
  im.rot = 0;
  im.x += (cx / base.width) * im.w;
  im.y += (cy / base.height) * im.h;
  im.w *= cw / base.width;
  im.h *= ch / base.height;
  closeModal();
  cropCtx = null;
  engine.invalidateRaster();
  renderPaperStack();
  saveSoon(true);
  toast('已裁剪图片');
}

function cropSelection() {
  const ids = engine.getSelectionIds();
  const page = currentPage();
  if (!page) return;
  const imgs = ids.filter(id => id.startsWith('i:')).map(id => page.images.find(x => x.id === id.slice(2))).filter(Boolean);
  if (!imgs.length) { toast('选中内容里没有图片'); return; }
  if (imgs.length > 1) { toast('一次只裁剪一张图片'); return; }
  const im = imgs[0];
  const img = new Image();
  img.onload = () => {
    let base = img;
    const rot = (im.rot || 0) % 360;
    if (rot) {
      const cv = document.createElement('canvas');
      const rad = rot * Math.PI / 180;
      const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
      const nw = Math.round(Math.abs(Math.cos(rad)) * w + Math.abs(Math.sin(rad)) * h);
      const nh = Math.round(Math.abs(Math.sin(rad)) * w + Math.abs(Math.cos(rad)) * h);
      cv.width = nw; cv.height = nh;
      const c = cv.getContext('2d');
      c.translate(nw / 2, nh / 2); c.rotate(rad);
      c.drawImage(img, -w / 2, -h / 2);
      base = cv;
    }
    const { body } = modalShell('裁剪图片',
      '<div class="crop-wrap"><div class="crop-stage"><img id="cropImg" alt=""><div id="cropBox" class="crop-box"><span class="crop-h nw"></span><span class="crop-h ne"></span><span class="crop-h sw"></span><span class="crop-h se"></span></div></div></div><div class="crop-tip">拖动框或四角手柄调整裁剪区域</div>',
      [{ label: '取消' }, { label: '完成', primary: true, action: finishCrop }]);
    const stage = body.querySelector('.crop-stage');
    const imgEl = body.querySelector('#cropImg');
    const boxEl = body.querySelector('#cropBox');
    imgEl.src = base.src;
    imgEl.onload = () => {
      const scale = Math.min(1, 420 / base.width);
      stage.style.width = (base.width * scale) + 'px';
      stage.style.height = (base.height * scale) + 'px';
      imgEl.style.width = (base.width * scale) + 'px';
      imgEl.style.height = (base.height * scale) + 'px';
      const pad = 24;
      boxEl.style.left = pad + 'px'; boxEl.style.top = pad + 'px';
      boxEl.style.width = Math.max(24, base.width * scale - pad * 2) + 'px';
      boxEl.style.height = Math.max(24, base.height * scale - pad * 2) + 'px';
      cropCtx = { base, im, stage, boxEl };
    };
    let mode = 'move', drag = null;
    const onDrag = (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      const sw = stage.offsetWidth, sh = stage.offsetHeight;
      let l = drag.l, t = drag.t, w = drag.w, h = drag.h;
      if (mode === 'move') { l = Math.max(0, Math.min(sw - w, drag.l + dx)); t = Math.max(0, Math.min(sh - h, drag.t + dy)); }
      else if (mode === 'se') { w = Math.max(24, Math.min(sw - l, drag.w + dx)); h = Math.max(24, Math.min(sh - t, drag.h + dy)); }
      else if (mode === 'nw') { const nl = Math.max(0, Math.min(drag.l + drag.w - 24, drag.l + dx)); const nt = Math.max(0, Math.min(drag.t + drag.h - 24, drag.t + dy)); w = drag.w + (drag.l - nl); h = drag.h + (drag.t - nt); l = nl; t = nt; }
      else if (mode === 'ne') { w = Math.max(24, Math.min(sw - l, drag.w + dx)); const nt = Math.max(0, Math.min(drag.t + drag.h - 24, drag.t + dy)); h = drag.h + (drag.t - nt); t = nt; }
      else if (mode === 'sw') { const nl = Math.max(0, Math.min(drag.l + drag.w - 24, drag.l + dx)); w = drag.w + (drag.l - nl); l = nl; h = Math.max(24, Math.min(sh - t, drag.h + dy)); }
      boxEl.style.left = l + 'px'; boxEl.style.top = t + 'px'; boxEl.style.width = w + 'px'; boxEl.style.height = h + 'px';
    };
    const endDrag = () => { drag = null; document.removeEventListener('pointermove', onDrag); document.removeEventListener('pointerup', endDrag); };
    const startDrag = (e, m) => {
      e.preventDefault(); e.stopPropagation();
      mode = m;
      drag = { x: e.clientX, y: e.clientY, l: parseFloat(boxEl.style.left), t: parseFloat(boxEl.style.top), w: parseFloat(boxEl.style.width), h: parseFloat(boxEl.style.height) };
      document.addEventListener('pointermove', onDrag);
      document.addEventListener('pointerup', endDrag);
    };
    boxEl.addEventListener('pointerdown', (e) => startDrag(e, 'move'));
    body.querySelectorAll('.crop-h').forEach(h => h.addEventListener('pointerdown', (e) => startDrag(e, h.classList[1])));
  };
  img.onerror = () => toast('图片加载失败');
  img.src = im.src;
}

function rotateSelection() {
  const ids = engine.getSelectionIds();
  if (!ids.length) return;
  const page = currentPage();
  if (!page) return;
  let rotated = false;
  for (const id of ids) {
    if (id.startsWith('i:')) {
      const im = page.images.find(x => x.id === id.slice(2));
      if (im) { im.rot = ((im.rot || 0) + 90) % 360; rotated = true; }
    }
  }
  if (!rotated) { toast('选中内容里没有图片'); return; }
  engine.invalidateRaster();
  renderPaperStack();
  saveSoon(true);
}

function deleteSelection() {
  const ids = engine.getSelectionIds();
  if (!ids.length || !currentPage()) return;
  const page = currentPage();
  const before = pageSnapshot(page);
  mutate(() => {
    page.strokes = page.strokes.filter(s => !ids.includes(s.id));
    page.texts = page.texts.filter(t => !ids.includes('t:' + t.id));
    if (page.images) page.images = page.images.filter(im => !ids.includes('i:' + im.id));
  }, '删除选中');
  engine.clearSelection();
  engine.invalidateRaster();
  saveSoon(true);
}
let clipboard = null;
function copySelection() {
  const ids = engine.getSelectionIds();
  if (!ids.length || !currentPage()) return;
  const page = currentPage();
  clipboard = {
    strokes: page.strokes.filter(s => ids.includes(s.id)).map(s => JSON.parse(JSON.stringify(s))),
    texts: page.texts.filter(t => ids.includes('t:' + t.id)).map(t => JSON.parse(JSON.stringify(t))),
    images: (page.images || []).filter(im => ids.includes('i:' + im.id)).map(im => JSON.parse(JSON.stringify(im)))
  };
  toast('已复制选中内容');
}
function pasteSelection() {
  if (!clipboard || !currentPage()) return;
  const page = currentPage();
  const dx = 0.02, dy = 0.02;
  mutate(() => {
    for (const st of clipboard.strokes) {
      const c = JSON.parse(JSON.stringify(st)); c.id = newId();
      for (const pt of c.points) { pt.x += dx * pageW(); pt.y += dy * pageH(); }
      page.strokes.push(c);
    }
    for (const t of clipboard.texts) { const c = JSON.parse(JSON.stringify(t)); c.id = newId(); c.x += dx; c.y += dy; page.texts.push(c); }
    for (const im of clipboard.images) { const c = JSON.parse(JSON.stringify(im)); c.id = newId(); c.x += dx; c.y += dy; page.images = page.images || []; page.images.push(c); }
  }, '粘贴');
  engine.invalidateRaster();
  saveSoon(true);
}

/* ---- v4.26 事件绑定 ---- */
function bindV426UI() {
  const favAdd = $('#favAdd'); if (favAdd) favAdd.addEventListener('click', addFavorite);
  const favEdit = $('#favEdit'); if (favEdit) favEdit.addEventListener('click', toggleFavEdit);
  const sCopy = $('#selCopy'); if (sCopy) sCopy.addEventListener('click', () => copySelection());
  const sRot = $('#selRotate'); if (sRot) sRot.addEventListener('click', () => rotateSelection());
  const sCrop = $('#selCrop'); if (sCrop) sCrop.addEventListener('click', () => cropSelection());
  const sDel = $('#selDel'); if (sDel) sDel.addEventListener('click', () => deleteSelection());
  const sClose = $('#selClose'); if (sClose) sClose.addEventListener('click', () => { $('#selBar').classList.add('hidden'); engine.clearSelection(); });
  const spd = $('#recSpeed');
  if (spd) spd.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-s]');
    if (!b) return;
    state.rec.speed = Number(b.dataset.s);
    spd.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
  });
  const imgIn = $('#imageInput'); if (imgIn) imgIn.addEventListener('change', async (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) await insertImage(f, 'gallery'); });
  const camIn = $('#cameraInput'); if (camIn) camIn.addEventListener('change', async (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) await insertImage(f, 'camera'); });
  const pdfIn = $('#pdfInput'); if (pdfIn) pdfIn.addEventListener('change', async (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) await importPdf(f); });
  const attIn = $('#attachInput'); if (attIn) attIn.addEventListener('change', async (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) await insertAttachment(f); });
  const oFav = $('#optFavBar'); if (oFav) oFav.addEventListener('change', (e) => { state.lib.settings.favoritesBar = e.target.checked; saveLibrary(state.lib); renderFavorites(); });
  const oBak = $('#optAutoBackup'); if (oBak) oBak.addEventListener('change', (e) => { state.lib.settings.autoBackup = e.target.checked; saveLibrary(state.lib); if (e.target.checked) scheduleSnapshot(true); });
  const oMarkup = $('#optMarkup'); if (oMarkup) oMarkup.addEventListener('change', (e) => toggleMarkupMode(e.target.checked));
  const pPrev = $('#presPrev'); if (pPrev) pPrev.addEventListener('click', () => { if (currentNote()) { switchPage(state.pageIndex - 1); renderPresPage(); } });
  const pNext = $('#presNext'); if (pNext) pNext.addEventListener('click', () => { if (currentNote()) { switchPage(state.pageIndex + 1); renderPresPage(); } });
  const pClose = $('#presClose'); if (pClose) pClose.addEventListener('click', exitPresent);
  const pPlay = $('#presPlay'); if (pPlay) pPlay.addEventListener('click', togglePresPlay);
  const pCols = $('#presColors'); if (pCols) pCols.addEventListener('click', (e) => { const sw = e.target.closest('.pres-swatch'); if (sw) setPresColor(sw.dataset.c); });
  const pCv = $('#presCanvas');
  if (pCv) {
    pCv.addEventListener('pointerdown', (e) => {
      if (!presDrawOn) return;
      const r = pCv.getBoundingClientRect();
      presCur = [{ x: e.clientX - r.left, y: e.clientY - r.top }];
      renderPresMark();
    });
    pCv.addEventListener('pointermove', (e) => {
      if (presDrawOn) {
        if (presCur) { const r = pCv.getBoundingClientRect(); presCur.push({ x: e.clientX - r.left, y: e.clientY - r.top }); renderPresMark(); }
        return;
      }
      drawLaser(e);
    });
    pCv.addEventListener('pointerup', () => { if (presCur) { presStrokes.push(presCur); presCur = null; } });
    pCv.addEventListener('pointerleave', clearLaser);
    pCv.addEventListener('click', (e) => {
      if (presDrawOn) return;
      const r = e.currentTarget.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      if (currentNote()) { if (x < 0.45) switchPage(state.pageIndex - 1); else switchPage(state.pageIndex + 1); renderPresPage(); }
    });
    pCv.addEventListener('dblclick', exitPresent);
    const pPen = $('#presPen');
    if (pPen) pPen.addEventListener('click', (e) => { e.stopPropagation(); presDrawOn = !presDrawOn; pPen.classList.toggle('active', presDrawOn); });
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#presMode') && !$('#presMode').classList.contains('hidden')) exitPresent(); });
  document.addEventListener('keydown', (e) => {
    if ($('#presMode') && !$('#presMode').classList.contains('hidden')) {
      if (e.key === 'ArrowLeft') { switchPage(state.pageIndex - 1); renderPresPage(); }
      else if (e.key === 'ArrowRight') { switchPage(state.pageIndex + 1); renderPresPage(); }
    }
  });
  window.addEventListener('pagehide', () => { if (state.lib && state.lib.settings.autoBackup !== false) saveSnapshot(state.lib); });
  // 设置面板：关闭 / 分类切换
  const sc = $('#settingsClose'); if (sc) sc.addEventListener('click', () => $('#settingsPanel').classList.add('hidden'));
  const navEl = document.querySelector('.settings-nav');
  if (navEl) navEl.addEventListener('click', (e) => {
    const b = e.target.closest('.settings-nav-item');
    if (!b) return;
    document.querySelectorAll('.settings-nav-item').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('.settings-sec').forEach(x => x.classList.toggle('active', x.id === 'sec-' + b.dataset.sec));
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#settingsPanel') && !$('#settingsPanel').classList.contains('hidden')) $('#settingsPanel').classList.add('hidden'); });
  // 连续纸张：滚动停止后吸附最近的一页为当前页
  const pHolder = $('#paperHolder');
  if (pHolder) {
    let st = null;
    pHolder.addEventListener('scroll', () => {
      clearTimeout(st);
      st = setTimeout(() => {
        const stack = $('#paperStack');
        if (!stack || !currentNote()) return;
        const slots = [...stack.querySelectorAll('.paper-slot')];
        if (!slots.length) return;
        const mid = pHolder.scrollTop + pHolder.clientHeight / 2;
        let best = slots[0], bd = Infinity;
        for (const s of slots) {
          const d = Math.abs((s.offsetTop + s.clientHeight / 2) - mid);
          if (d < bd) { bd = d; best = s; }
        }
        const idx = Number(best.dataset.i);
        if (idx !== state.pageIndex) {
          // 静默跟随：不跳转、不重定位，只在原地把最近页设为当前页
          state.pageIndex = idx;
          engine.setPage(currentPage());
          engine.invalidateRaster();
          renderPages();
          renderPaperStack(true);
          updatePageNav();
          state.lib.active.pageIndex = idx;
          saveSoon();
        }
      }, 260);
    });
  }
  // 手指在纸张左右边缘水平滑动翻页
  const ph = $('#paperHolder');
  if (ph) {
    ph.addEventListener('dragover', (e) => { e.preventDefault(); ph.classList.add('drop-target'); });
    ph.addEventListener('dragleave', () => ph.classList.remove('drop-target'));
    ph.addEventListener('drop', (e) => {
      e.preventDefault();
      ph.classList.remove('drop-target');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      if (f.type.startsWith('image/')) insertImage(f, 'gallery');
      else if (f.type === 'application/pdf' || (f.name || '').toLowerCase().endsWith('.pdf')) importPdf(f);
      else insertAttachment(f);
    });
    let swipe = null;
    ph.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      const r = ph.getBoundingClientRect();
      const x = e.clientX - r.left;
      if (x < r.width * 0.12 || x > r.width * 0.88) swipe = { id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, moved: false };
    }, true);
    ph.addEventListener('pointermove', (e) => {
      if (!swipe || swipe.id !== e.pointerId) return;
      swipe.dx = e.clientX - swipe.x0;
      swipe.dy = e.clientY - swipe.y0;
      if (Math.abs(swipe.dx) > 26 && Math.abs(swipe.dx) > Math.abs(swipe.dy) * 1.2) swipe.moved = true;
    }, true);
    ph.addEventListener('pointerup', (e) => {
      if (!swipe || swipe.id !== e.pointerId) return;
      const s = swipe;
      swipe = null;
      if (engine.pointers && engine.pointers.size > 1) return;
      if (s.moved && Math.abs(s.dx) > 70) {
        e.preventDefault();
        if (engine.currentStroke) { engine.currentStroke = null; engine.invalidateRaster(); }
        if (s.dx < 0) switchPage(state.pageIndex + 1); else switchPage(state.pageIndex - 1);
      }
    }, true);
    ph.addEventListener('pointercancel', () => { swipe = null; }, true);
    // 鼠标滚轮滚动
    ph.addEventListener('wheel', (e) => {
      e.preventDefault();
      ph.scrollTop += e.deltaY;
    }, { passive: false });
    // 单指拖动滚动：手指在纸张上直接滑（中间区域），Apple Pencil 仍书写
    let oneFinger = null;
    const fingerDrawOn = () => !!(state.lib && state.lib.settings.fingerDraw);
    ph.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch' || fingerDrawOn()) return;
      const r = ph.getBoundingClientRect();
      const x = e.clientX - r.left;
      if (x < r.width * 0.12 || x > r.width * 0.88) return;
      oneFinger = { id: e.pointerId, y0: e.clientY, st0: ph.scrollTop };
    }, true);
    ph.addEventListener('pointermove', (e) => {
      if (!oneFinger || oneFinger.id !== e.pointerId) return;
      ph.scrollTop = oneFinger.st0 - (e.clientY - oneFinger.y0);
    }, true);
    ph.addEventListener('pointerup', () => { oneFinger = null; }, true);
    ph.addEventListener('pointercancel', () => { oneFinger = null; }, true);
  }
}
/* ---------------- 朗读与导出文字（Notability 阅读/导出体验） ---------------- */
let ttsActive = false;
let ttsQueue = [];
let ttsToken = 0;
let ttsHlEl = null;

function ttsClearHighlight() {
  if (ttsHlEl && ttsHlEl.parentNode) ttsHlEl.parentNode.removeChild(ttsHlEl);
  ttsHlEl = null;
}

function ttsShowHighlight(item) {
  ttsClearHighlight();
  const layer = $('#textLayer');
  if (!layer || !item) return;
  const sp = engine.worldToScreen(item.x * pageW(), item.y * pageH());
  const scale = engine.scale;
  const el = document.createElement('div');
  el.className = 'tts-hl';
  el.style.left = sp.x + 'px';
  el.style.top = sp.y + 'px';
  el.style.width = Math.max(20, item.w * pageW() * scale) + 'px';
  el.style.height = Math.max(14, item.h * pageH() * scale) + 'px';
  layer.appendChild(el);
  ttsHlEl = el;
}

function ttsSpeakNext(tok) {
  if (tok !== ttsToken) return;
  if (!ttsQueue.length) { ttsActive = false; ttsClearHighlight(); toast('朗读完成'); return; }
  const cur = ttsQueue.shift();
  ttsShowHighlight(cur.item);
  const u = new SpeechSynthesisUtterance(cur.text);
  u.lang = 'zh-CN';
  u.rate = state.lib.settings.ttsRate || 1;
  u.onend = () => ttsSpeakNext(tok);
  u.onerror = () => ttsSpeakNext(tok);
  window.speechSynthesis.speak(u);
}

function toggleReadAloud() {
  if (ttsActive) {
    const ss = ('speechSynthesis' in window) ? window.speechSynthesis : null;
    if (ss && !ss.paused && ss.speaking) { ss.pause(); toast('已暂停朗读'); return; }
    if (ss && ss.paused) { ss.resume(); toast('继续朗读'); return; }
    ttsToken++; ttsActive = false; ttsQueue = []; ttsClearHighlight();
    if (ss) ss.cancel();
    toast('已停止朗读');
    return;
  }
  const page = currentPage();
  const items = ((page && page.texts) || []).filter(t => (t.text || '').trim());
  if (!items.length) { toast('当前页没有文字'); return; }
  if (!('speechSynthesis' in window)) { toast('此设备不支持朗读'); return; }
  ttsQueue = [];
  for (const item of items) {
    let sentences = (item.text || '').split(/(?<=[。！？；!?;])/).map(s => s.trim()).filter(Boolean);
    if (!sentences.length) sentences = [(item.text || '').trim()];
    for (const s of sentences) ttsQueue.push({ item, text: s });
  }
  if (!ttsQueue.length) { toast('当前页没有可朗读文字'); return; }
  ttsToken++;
  const tok = ttsToken;
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  ttsActive = true;
  ttsSpeakNext(tok);
  toast('正在朗读当前页…');
}

async function exportNoteText() {
  const note = currentNote();
  if (!note) return;
  const lines = [];
  lines.push(note.title);
  lines.push('导出时间：' + new Date().toLocaleString('zh-CN'));
  lines.push('页面数：' + note.pages.length);
  lines.push('');
  note.pages.forEach((p, i) => {
    const ts = (p.texts || []).map(t => t.text).filter(Boolean);
    if (ts.length) {
      lines.push('—— 第 ' + (i + 1) + ' 页 ——');
      lines.push(ts.join('\n'));
    }
  });
  const body = lines.join('\n\n') || '（笔记中没有文字内容）';
  const blob = new Blob([body], { type: 'text/plain;charset=utf-8' });
  await shareOrDownload(blob, safeName(note.title) + '.txt');
}
async function exportNoteRtf() {
  const note = currentNote();
  if (!note) return;
  const esc = (s) => [...String(s || '')].map(ch => {
    const c = ch.charCodeAt(0);
    if (c > 127) return '\\u' + c + '?';
    if (ch === '\\') return '\\\\';
    if (ch === '{') return '\\{';
    if (ch === '}') return '\\}';
    if (ch === '\n') return '\\par ';
    return ch;
  }).join('');
  const parts = ['{\\rtf1\\ansi\\ansicpg936\\deff0', '{\\fonttbl{\\f0\\fnil\\fcharset134 Microsoft YaHei;}}', '\\f0\\fs24 '];
  parts.push('\\pard\\b\\fs36 ' + esc(note.title) + '\\b0\\par\\par ');
  note.pages.forEach((p, i) => {
    const ts = (p.texts || []).map(t => t.text).filter(Boolean);
    if (ts.length) {
      parts.push('\\pard\\fs28 ' + esc('—— 第 ' + (i + 1) + ' 页 ——') + '\\par ');
      ts.forEach(t => parts.push('\\pard\\fs24 ' + esc(t) + '\\par '));
    }
  });
  parts.push('}');
  const blob = new Blob([parts.join('\n')], { type: 'application/rtf' });
  await shareOrDownload(blob, safeName(note.title) + '.rtf');
}

/* ---------------- 模板化新建（Notability 新建流程） ---------------- */
function openNewNoteMenu() {
  const tpls = state.lib.settings.templates || [];
  const seeded = tpls.filter(t => t.id && String(t.id).startsWith('tpl-'));
  const user = tpls.filter(t => !(t.id && String(t.id).startsWith('tpl-')));
  let body = '<div class="menu-sec-title">空白</div><button class="menu-item" data-new="blank">空白笔记</button>';
  if (seeded.length) body += '<div class="menu-sec-title">内置模板</div>' + seeded.map(t => '<button class="menu-item" data-new="' + t.id + '"><span class="tpl-preview" style="background:' + paperInfo(t.paper.color).bg + '"></span>' + escapeHtml(t.name) + '</button>').join('');
  if (user.length) body += '<div class="menu-sec-title">我的模板</div>' + user.map(t => '<button class="menu-item" data-new="' + t.id + '"><span class="tpl-preview" style="background:' + paperInfo(t.paper.color).bg + '"></span>' + escapeHtml(t.name) + '</button>').join('');
  modalShell('新建笔记', body, [{ label: '取消' }]);
  const mask = document.querySelector('#modalRoot .modal-mask');
  if (!mask) return;
  mask.querySelectorAll('[data-new]').forEach(b => b.addEventListener('click', () => {
    closeModal();
    if (b.dataset.new === 'blank') createNote();
    else {
      const t = state.lib.settings.templates.find(x => x.id === b.dataset.new);
      if (t) newNoteFromTemplate(t);
    }
  }));
}

function insertTemplatePage(tpl) {
  const note = currentNote();
  if (!note) { toast('请先打开一个笔记'); return; }
  addPage();
  const p = currentPage();
  if (p && tpl.bg) p.bg = JSON.parse(JSON.stringify(tpl.bg));
  toast('已插入模板页');
}

function pickTemplateAndInsert() {
  const tpls = (state.lib.settings.templates || []).filter(t => t.bg);
  if (!tpls.length) { toast('还没有带背景的模板，可先把当前页存为模板'); return; }
  const body = tpls.map(t => `<button class="menu-item" data-tpl="${t.id}"><span class="tpl-preview" style="background:${paperInfo(t.paper.color).bg}"></span>${escapeHtml(t.name)}</button>`).join('');
  modalShell('插入模板页', body, [{ label: '取消' }]);
  const mask = document.querySelector('#modalRoot .modal-mask');
  if (mask) mask.querySelectorAll('[data-tpl]').forEach(b => b.addEventListener('click', () => {
    const t = state.lib.settings.templates.find(x => x.id === b.dataset.tpl);
    closeModal();
    if (t) insertTemplatePage(t);
  }));
}
const TAG_COLORS = ['#ef4444', '#f97316', '#facc15', '#22c55e', '#3b82f6', '#a855f7'];
/* ---------------- 标签颜色 / 笔记统计 ---------------- */
function noteTagColor(note) {
  const colors = TAG_COLORS;
  const body = '<div class="nb-colors">' + colors.map(c => '<button class="nb-color" data-c="' + c + '" style="background:' + c + '"></button>').join('') + '<button class="nb-color off" data-c="">无</button></div>';
  modalShell('标签颜色', body, [{ label: '取消' }]);
  const mask = document.querySelector('#modalRoot .modal-mask');
  if (!mask) return;
  mask.querySelectorAll('.nb-color').forEach(b => b.addEventListener('click', () => {
    note.colorTag = b.dataset.c || null;
    saveLibrary(state.lib);
    renderNoteList();
    toast('已设置标签颜色');
  }));
}

function noteStats() {
  const note = currentNote();
  if (!note) { toast('请先打开一个笔记'); return; }
  let strokes = 0, chars = 0, images = 0;
  note.pages.forEach(p => {
    strokes += (p.strokes || []).length;
    chars += (p.texts || []).reduce((s, t) => s + (t.text || '').length, 0);
    images += (p.images || []).length;
  });
  const recs = (note.attachments || []).filter(x => x.type && x.type.startsWith('audio')).length;
  modalShell('笔记统计', '<div class="stats-body">' +
    '<p>页数：' + note.pages.length + '</p>' +
    '<p>笔画：' + strokes + '</p>' +
    '<p>文字：' + chars + ' 字</p>' +
    '<p>图片：' + images + '</p>' +
    '<p>创建：' + new Date(note.createdAt).toLocaleString('zh-CN') + '</p>' +
    '<p>更新：' + new Date(note.updatedAt).toLocaleString('zh-CN') + '</p>' +
    '</div>', [{ label: '关闭' }]);
}

/* ---------------- 页内查找 / 大纲 / 封面符号（Notability 检索体验） ---------------- */
function findInNote() {
  const note = currentNote();
  if (!note) { toast('请先打开一个笔记'); return; }
  promptModal('在笔记中查找', '', '查找内容', '查找', (q) => {
    if (!q) return;
    const ql = q.toLowerCase();
    const hits = [];
    note.pages.forEach((p, i) => {
      (p.texts || []).forEach(t => {
        const tx = (t.text || '').toLowerCase();
        if (tx.includes(ql)) {
          const idx = tx.indexOf(ql);
          hits.push({ page: i, snippet: t.text.slice(Math.max(0, idx - 10), idx + q.length + 16) });
        }
      });
    });
    if (!hits.length) { toast('未找到相关内容'); return; }
    const body = hits.map(h => `<div class="find-row" data-p="${h.page}"><span class="find-page">第 ${h.page + 1} 页</span><span class="find-snippet">…${escapeHtml(h.snippet)}…</span></div>`).join('');
    modalShell('在笔记中查找 · ' + hits.length + ' 处', body, [{ label: '关闭' }]);
    const mask = document.querySelector('#modalRoot .modal-mask');
    if (mask) mask.querySelectorAll('.find-row').forEach(r => r.addEventListener('click', () => {
      closeModal();
      switchPage(Number(r.dataset.p));
    }));
  });
}

function outlineNote() {
  const note = currentNote();
  if (!note) { toast('请先打开一个笔记'); return; }
  const items = [];
  note.pages.forEach((p, i) => {
    (p.texts || []).forEach(t => {
      const len = (t.text || '').trim();
      if (len && (t.fontSize || 0) >= 26) items.push({ page: i, text: len.slice(0, 40), size: t.fontSize, lvl: (t.fontSize || 0) >= 34 ? 1 : 2 });
    });
  });
  if (!items.length) { toast('没有检测到标题（字号较大的文字）'); return; }
  const body = items.map(it => `<div class="outline-row lvl${it.lvl}" data-p="${it.page}"><span class="ol-dot"></span><span class="ol-text">${escapeHtml(it.text)}</span><span class="ol-page">第 ${it.page + 1} 页</span></div>`).join('');
  modalShell('大纲', body, [{ label: '关闭' }]);
  const mask = document.querySelector('#modalRoot .modal-mask');
  if (mask) mask.querySelectorAll('.outline-row').forEach(r => r.addEventListener('click', () => {
    closeModal();
    switchPage(Number(r.dataset.p));
  }));
}

function noteEmoji(nb) {
  const emojis = ['📘', '📗', '📕', '📙', '📓', '📔', '📒', '📚', '✏️', '📝', '🗂️', '⭐', '❤️', '🔥', '💡', '🎓'];
  const body = `<div class="nb-emojis">${emojis.map(e => `<button class="nb-emoji" data-e="${e}">${e}</button>`).join('')}</div>`;
  modalShell('封面符号', body, [{ label: '取消' }]);
  const mask = document.querySelector('#modalRoot .modal-mask');
  if (!mask) return;
  mask.querySelectorAll('.nb-emoji').forEach(b => b.addEventListener('click', () => {
    nb.emoji = b.dataset.e;
    saveLibrary(state.lib);
    renderLibrary();
    toast('已设置封面符号');
  }));
}
/* ---------------- 应用模板到当前页 ---------------- */
function pickTemplateAndApply() {
  const tpls = (state.lib.settings.templates || []).filter(t => t.bg);
  if (!tpls.length) { toast('还没有带背景的模板'); return; }
  const body = tpls.map(t => `<button class="menu-item" data-tpl="${t.id}"><span class="tpl-preview" style="background:${paperInfo(t.paper.color).bg}"></span>${escapeHtml(t.name)}</button>`).join('');
  modalShell('应用模板到当前页', body, [{ label: '取消' }]);
  const mask = document.querySelector('#modalRoot .modal-mask');
  if (mask) mask.querySelectorAll('[data-tpl]').forEach(b => b.addEventListener('click', () => {
    const t = state.lib.settings.templates.find(x => x.id === b.dataset.tpl);
    closeModal();
    if (!t) return;
    const page = currentPage();
    if (!page) return;
    if (t.bg) page.bg = JSON.parse(JSON.stringify(t.bg)); else delete page.bg;
    engine.invalidateRaster();
    renderPaperStack();
    refreshThumbs();
    saveSoon(true);
    toast('已应用模板到当前页');
  }));
}

/* ---------------- 模板中心（Notability Templates） ---------------- */
function saveCurrentAsTemplate(name) {
  const note = currentNote();
  if (!note) { toast('请先打开一个笔记'); return; }
  const st = state.lib.settings;
  const tpl = {
    id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: name || ('我的模板 ' + ((st.templates || []).length + 1)),
    paper: JSON.parse(JSON.stringify(note.paper)),
    bg: currentPage() && currentPage().bg ? JSON.parse(JSON.stringify(currentPage().bg)) : null,
    createdAt: Date.now()
  };
  st.templates = st.templates || [];
  st.templates.push(tpl);
  saveLibrary(state.lib);
  toast('已保存为模板：' + tpl.name);
}

function openTemplateManager() {
  const st = state.lib.settings;
  st.templates = st.templates || [];
  const seeded = st.templates.filter(t => t.id && String(t.id).startsWith('tpl-'));
  const user = st.templates.filter(t => !(t.id && String(t.id).startsWith('tpl-')));
  let body = '';
  if (seeded.length) {
    body += '<div class="menu-sec-title">内置模板</div>' + seeded.map(t => {
      const info = paperInfo(t.paper.color);
      return '<div class="tpl-row"><span class="tpl-preview" style="background:' + info.bg + '"><span class="tpl-name">' + escapeHtml(t.name) + '</span></span><button class="mini-btn primary" data-use="' + t.id + '">用此模板新建</button></div>';
    }).join('');
  }
  body += '<div class="menu-sec-title">我的模板</div>';
  if (!user.length) body += '<div class="tpl-empty">还没有自定义模板：把当前页存成模板（纸张+背景），之后可一键复用。</div>';
  else body += user.map((t, i) => {
    const info = paperInfo(t.paper.color);
    return '<div class="tpl-row" data-i="' + i + '">' +
      '<span class="tpl-preview" style="background:' + info.bg + '"><span class="tpl-name">' + escapeHtml(t.name) + '</span></span>' +
      '<button class="mini-btn primary" data-use="' + t.id + '">用此模板新建</button>' +
      '<button class="mini-btn" data-ren="' + t.id + '">重命名</button>' +
      '<button class="mini-btn danger" data-del="' + t.id + '">删除</button>' +
      '</div>';
  }).join('');
  modalShell('模板中心', body, [{ label: '关闭' }]);
  const mask = document.querySelector('#modalRoot .modal-mask');
  if (!mask) return;
  mask.querySelectorAll('[data-use]').forEach(b => b.addEventListener('click', () => {
    const t = st.templates.find(x => x.id === b.dataset.use);
    if (!t) return;
    closeModal();
    newNoteFromTemplate(t);
  }));
  mask.querySelectorAll('[data-ren]').forEach(b => b.addEventListener('click', () => {
    const t = st.templates.find(x => x.id === b.dataset.ren);
    if (!t) return;
    promptModal('重命名模板', t.name, '模板名称', '保存', (name) => {
      if (!name) return;
      t.name = name;
      saveLibrary(state.lib);
      openTemplateManager();
    });
  }));
  mask.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
    const t = st.templates.find(x => x.id === b.dataset.del);
    if (!t) return;
    st.templates = st.templates.filter(x => x.id !== t.id);
    saveLibrary(state.lib);
    openTemplateManager();
  }));
}

function newNoteFromTemplate(tpl) {
  const d = new Date();
  const title = tpl.name + ' · ' + `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const note = newNote(state.activeNotebookId || firstNotebookId(), title, tpl.paper || { style: 'line', color: 'white' });
  applyDefaultPageSize(note);
  if (tpl.bg) note.pages[0].bg = JSON.parse(JSON.stringify(tpl.bg));
  if (tpl.title) {
    const ttexts = [];
    ttexts.push({ id: newId(), x: 0.12, y: 0.05, w: 0.76, h: 0.09, text: tpl.title, fontSize: tpl.titleSize || 32, color: '#1e293b', align: 'center', bold: true, italic: false, underline: false, hl: null });
    if (tpl.sub) ttexts.push({ id: newId(), x: 0.15, y: 0.165, w: 0.7, h: 0.05, text: tpl.sub, fontSize: tpl.subSize || 15, color: '#64748b', align: 'center', bold: false, italic: false, underline: false, hl: null });
    note.pages[0].texts = ttexts;
  }
  state.lib.notes[note.id] = note;
  let nb = findNotebook(state.lib, note.notebookId);
  if (!nb) {
    const subj = findActiveSubject() || state.lib.subjects[0];
    if (!subj) { toast('请先创建项目'); return; }
    const nbObj = { id: newId(), name: '我的笔记本', noteIds: [] };
    subj.notebooks.push(nbObj);
    note.notebookId = nbObj.id;
    nb = { subject: subj, notebook: nbObj };
  }
  nb.notebook.noteIds.push(note.id);
  state.activeSubjectId = nb.subject.id;
  state.activeNotebookId = nb.notebook.id;
  saveLibrary(state.lib);
  openNote(note.id);
  renderLibrary();
  toast('已用模板新建笔记');
}
/* ---------------- 附件 / 新手引导 ---------------- */
async function insertAttachment(file) {
  if (!file) return;
  const note = currentNote();
  if (!note) { toast('请先打开一个笔记'); return; }
  const attId = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await saveAudioBlob('attach:' + note.id + ':' + attId, file);
  note.attachments = note.attachments || [];
  note.attachments.push({ id: attId, name: file.name || '附件', size: file.size || 0, type: file.type || '' });
  saveLibrary(state.lib);
  toast('已添加附件：' + (file.name || '附件'));
}

function fmtSize(n) {
  if (!n) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

async function manageAttachments() {
  const note = currentNote();
  if (!note) { toast('请先打开一个笔记'); return; }
  const list = note.attachments || [];
  if (!list.length) {
    confirmModal('还没有附件', '可以在「插入附件…」里添加文件（PDF、图片、文档等），需要时再打开或分享。', '知道了');
    return;
  }
  const body = list.map(a => `<div class="att-row" data-id="${a.id}">
      <span class="att-name">${escapeHtml(a.name)}</span><span class="att-size">${fmtSize(a.size)}</span>
      <button class="mini-btn" data-open="${a.id}">打开</button>
      <button class="mini-btn danger" data-del="${a.id}">删除</button>
    </div>`).join('');
  modalShell('附件', body, [{ label: '关闭' }]);
  const mask = document.querySelector('#modalRoot .modal-mask');
  if (!mask) return;
  mask.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', async () => {
    const a = list.find(x => x.id === b.dataset.open);
    if (!a) return;
    const blob = await getAudioBlob('attach:' + note.id + ':' + a.id);
    if (!blob) { toast('附件文件不存在'); return; }
    closeModal();
    await shareOrDownload(blob, a.name);
  }));
  mask.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    const a = list.find(x => x.id === b.dataset.del);
    if (!a) return;
    await deleteAudioBlob('attach:' + note.id + ':' + a.id);
    note.attachments = note.attachments.filter(x => x.id !== a.id);
    saveLibrary(state.lib);
    manageAttachments();
  }));
}

function showWelcomeGuide() {
  try {
    if (localStorage.getItem('note2-welcomed')) return;
    localStorage.setItem('note2-welcomed', '1');
  } catch (_) {}
  modalShell('欢迎使用「笔记」', '<div class="welcome-body">' +
    '<p>✍️ 用 Apple Pencil 或手指直接书写</p>' +
    '<p>👆 单指上下滑 = 连续滚动纸张</p>' +
    '<p>🤏 双指捏合 = 整条纸一起缩放</p>' +
    '<p>👈👉 双指左右滑 / 纸边缘滑 = 翻页</p>' +
    '<p>✌️ 双指轻点 = 撤销 · 🤟 三指轻点 = 重做</p>' +
    '<p>✨ 右下角 AI 助手可结合笔记提问</p>' +
    '</div>', [{ label: '开始使用', primary: true }]);
}
/* ---------------- AI 一键总结笔记 ---------------- */
async function summarizeNote() {
  const note = currentNote();
  if (!note) { toast('请先打开一个笔记'); return; }
  const parts = [];
  note.pages.forEach((p, i) => {
    const ts = (p.texts || []).map(t => t.text).filter(Boolean);
    if (ts.length) parts.push('【第' + (i + 1) + '页】' + ts.join(' '));
  });
  const content = parts.join('\n').slice(0, 4000);
  if (!content) { toast('笔记中没有文字内容'); return; }
  toast('正在生成总结…');
  const msgs = [
    { role: 'system', content: '你是「笔记」里的 AI 学习助手。请用简洁、有条理的中文总结下面笔记的要点，控制在 300 字以内，用要点列出。' },
    { role: 'user', content }
  ];
  try {
    const res = await fetch('/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: msgs, stream: true }) });
    if (!res.ok) { const d = await res.json().catch(() => ({})); toast('总结失败：' + (d.error || res.status)); return; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', answer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const segs = buf.split('\n\n');
      buf = segs.pop();
      for (const seg of segs) {
        const line = seg.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const obj = JSON.parse(payload);
          let delta = '';
          if (typeof obj.delta === 'string') delta = obj.delta;
          else if (obj.choices && obj.choices[0] && obj.choices[0].delta && typeof obj.choices[0].delta.content === 'string') delta = obj.choices[0].delta.content;
          if (delta) answer += delta;
        } catch (_) {}
      }
    }
    modalShell('AI 总结', '<div class="ai-summary">' + escapeHtml(answer || '（未生成）').replace(/\n/g, '<br>') + '</div>', [{ label: '关闭' }]);
  } catch (e) {
    toast('总结失败：请确认服务器已启动并联网');
  }
}
/* ---------------- AI 助手（DeepSeek，经本地服务器代理） ---------------- */
let aiHistory = [];
let aiBusy = false;

function buildAIContext() {
  const note = currentNote();
  if (!note) return '（当前没有打开笔记）';
  const texts = ((currentPage() && currentPage().texts) || []).map(t => t.text).filter(Boolean).join(' ');
  return '用户当前笔记标题：' + note.title + '\n当前页文字内容：' + (texts.slice(0, 2000) || '（无）');
}

function appendAIMsg(role, text) {
  const box = $('#aiMsgs');
  const row = document.createElement('div');
  row.className = 'ai-msg ' + role;
  const b = document.createElement('div');
  b.className = 'ai-bubble';
  b.textContent = text;
  row.appendChild(b);
  if (role === 'assistant') {
    const acts = document.createElement('div');
    acts.className = 'ai-acts';
    const ins = document.createElement('button');
    ins.className = 'ai-act';
    ins.textContent = '插入笔记';
    ins.addEventListener('click', () => insertAIText(text));
    const spk = document.createElement('button');
    spk.className = 'ai-act';
    spk.textContent = '朗读';
    spk.addEventListener('click', () => speakAIText(text));
    acts.appendChild(ins);
    acts.appendChild(spk);
    row.appendChild(acts);
  }
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;
  return b;
}

function toggleAIPanel() {
  const panel = $('#aiPanel');
  const open = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !open);
  if (open) {
    if (!$('#aiMsgs').children.length) {
      appendAIMsg('assistant', '你好，我是 AI 助手。可以问我学习问题，也可以结合当前笔记提问。');
    }
    fetch('/api/ai/model').then(r => r.ok ? r.json() : null).then(d => {
      if (d && d.name) {
        const t = $('#aiTitle'); if (t) t.textContent = d.name;
        const m = $('#aiModel'); if (m && d.model) m.textContent = d.model;
      }
    }).catch(() => {});
    setTimeout(() => $('#aiInput').focus(), 120);
  }
}

function updateAISend() {
  const btn = $('#aiSend');
  if (btn) btn.disabled = aiBusy;
}

async function sendAIMessage() {
  if (aiBusy) return;
  const input = $('#aiInput');
  const text = input.value.trim();
  if (!text) return;
  aiBusy = true;
  updateAISend();
  appendAIMsg('user', text);
  input.value = '';
  const ctx = buildAIContext();
  const messages = [
    { role: 'system', content: '你是「笔记」应用里的 AI 学习助手，用简洁、有条理的中文回答。\n' + ctx },
    ...aiHistory,
    { role: 'user', content: text }
  ];
  const bubble = appendAIMsg('assistant', '…');
  try {
    const res = await fetch('/api/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, stream: true })
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      bubble.textContent = '出错了：' + (d.error || ('HTTP ' + res.status));
      return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', answer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const obj = JSON.parse(payload);
          let delta = '';
          if (typeof obj.delta === 'string') delta = obj.delta;
          else if (obj.choices && obj.choices[0] && obj.choices[0].delta && typeof obj.choices[0].delta.content === 'string') delta = obj.choices[0].delta.content;
          if (delta) { answer += delta; bubble.textContent = answer; $('#aiMsgs').scrollTop = $('#aiMsgs').scrollHeight; }
        } catch (_) {}
      }
    }
    if (!answer) bubble.textContent = '（没有收到回复）';
    aiHistory.push({ role: 'user', content: text });
    aiHistory.push({ role: 'assistant', content: answer || bubble.textContent });
    if (aiHistory.length > 20) aiHistory = aiHistory.slice(-20);
  } catch (e) {
    bubble.textContent = '网络错误：请确认电脑端服务器已启动，且已联网';
  } finally {
    aiBusy = false;
    updateAISend();
  }
}

function insertAIText(text) {
  const page = currentPage();
  if (!page) { toast('请先打开一个笔记'); return; }
  const paras = String(text || '').split(/\n+/).map(s => s.trim()).filter(Boolean);
  if (!paras.length) { toast('回答为空'); return; }
  const h = pageH();
  const fontSize = state.lib.settings.textSize || 26;
  const items = [];
  let y = 0.08;
  for (const para of paras) {
    const lines = Math.max(1, Math.ceil(para.length / 28));
    const ih = Math.max(0.05, (lines * fontSize * 1.3 + 12) / h);
    items.push({ id: newId(), x: 0.06, y, w: 0.88, h: ih, text: para, fontSize, color: '#1e293b', align: 'left', bold: false, italic: false, underline: false, hl: null });
    y += ih + 0.02;
  }
  mutate(() => { page.texts = page.texts || []; page.texts.push(...items); }, '插入 AI 回答');
  engine.invalidateRaster();
  refreshThumbs();
  saveSoon(true);
  toast('已插入 ' + items.length + ' 段文字');
}

function speakAIText(text) {
  if (!('speechSynthesis' in window)) { toast('此设备不支持朗读'); return; }
  if (window.speechSynthesis.speaking) { window.speechSynthesis.cancel(); toast('已停止朗读'); return; }
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(String(text || '').slice(0, 4000));
  u.lang = 'zh-CN';
  u.rate = state.lib.settings.ttsRate || 1;
  window.speechSynthesis.speak(u);
  toast('正在朗读回答…');
}

function bindAIUI() {
  const fab = $('#btnAI'); if (fab) fab.addEventListener('click', toggleAIPanel);
  const close = $('#aiClose'); if (close) close.addEventListener('click', () => $('#aiPanel').classList.add('hidden'));
  const send = $('#aiSend'); if (send) send.addEventListener('click', sendAIMessage);
  const input = $('#aiInput');
  if (input) input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAIMessage(); }
  });
}
/* ---------------- 弹窗 ---------------- */
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2200);
}

function modalShell(title, body, btns) {
  const root = $('#modalRoot');
  root.innerHTML = `
    <div class="modal-mask">
      <div class="modal">
        <h3></h3>
        <div class="m-body"></div>
        <div class="m-btns"></div>
      </div>
    </div>`;
  const mask = root.firstElementChild;
  const modalEl = mask.querySelector('.modal');
  modalEl.querySelector('h3').textContent = title;
  const mBody = modalEl.querySelector('.m-body');
  mBody.innerHTML = body;
  const btnRow = modalEl.querySelector('.m-btns');
  btnRow.innerHTML = '';
  btns.forEach(b => {
    const btn = document.createElement('button');
    btn.className = 'm-btn ' + (b.primary ? 'primary' : 'ghost');
    btn.textContent = b.label;
    btn.addEventListener('click', () => {
      if (b.action) b.action(mask, modalEl);
      else closeModal();
    });
    btnRow.appendChild(btn);
  });
  mask.addEventListener('click', (e) => { if (e.target === mask) closeModal(); });
  return { mask, modalEl, body: mBody, btnRow };
}
function closeModal() { $('#modalRoot').innerHTML = ''; }

function promptModal(title, desc, placeholder, confirmText, onConfirm) {
  const { modalEl, body } = modalShell(title, `<div class="m-desc"></div><input type="text" autocomplete="off">`, [
    { label: '取消' },
    { label: confirmText, primary: true, action: (mask, m) => {
      const val = m.querySelector('input').value.trim();
      closeModal();
      if (val) onConfirm(val);
    } }
  ]);
  body.querySelector('.m-desc').textContent = desc;
  const input = modalEl.querySelector('input');
  input.placeholder = placeholder;
  setTimeout(() => input.focus(), 60);
}

function confirmModal(title, desc, confirmText, danger, onConfirm) {
  modalShell(title, `<div class="m-desc"></div>`, [
    { label: '取消' },
    { label: confirmText, primary: true, action: (mask, m) => { closeModal(); onConfirm(); } }
  ]);
  const bodyEl = $('#modalRoot .m-desc');
  bodyEl.textContent = desc;
  const btn = $('#modalRoot .m-btn.primary');
  if (danger) btn.style.background = '#dc2626';
}

function aboutModal() {
  modalShell('关于「笔记」', `
    <div class="m-desc" style="line-height:1.8">
      <b>笔记</b> 是一款 Notability 风格的手写笔记应用。<br>
      · Apple Pencil 压力感应书写<br>
      · 荧光笔、橡皮擦、套索、文字、形状<br>
      · 双指缩放平移 · 放大镜<br>
      · 笔记本 / 项目组织，页面管理<br>
      · 导出 .note / PDF，通过分享或文件转移<br>
      · 离线可用，数据保存在本机<br>
      · 开源仓库：github.com/just299792-stack/note2<br>
      <br>
      资料库：${state.lib.subjects.length} 个项目 · ${state.lib.subjects.reduce((a, s) => a + s.notebooks.length, 0)} 个笔记本 · ${Object.keys(state.lib.notes).length} 篇笔记 · ${Object.values(state.lib.notes).reduce((a, n) => a + n.pages.length, 0)} 页<br>
      <br>
      版本 ${APP_VERSION} · 2026-08-14
    </div>`, [
    { label: '好的', primary: true }
  ]);
}

/* ---------------- 账户 / 认证 ---------------- */
const AUTH_KEY = 'note2-auth';

async function api(path, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
    if (state.auth && state.auth.token) headers.Authorization = 'Bearer ' + state.auth.token;
    const res = await fetch(path, Object.assign({}, options, { headers, signal: ctrl.signal }));
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (res.status === 401 && path !== '/api/login' && path !== '/api/register') {
      state.auth = null;
      try { localStorage.removeItem(AUTH_KEY); } catch (_) {}
      updateAuthUI();
    }
    clearTimeout(timer);
    return Object.assign({ ok: res.ok, status: res.status }, data || {});
  } catch (_) {
    clearTimeout(timer);
    return { ok: false, status: 0, networkError: true };
  }
}

function loadAuth() {
  try { const raw = localStorage.getItem(AUTH_KEY); return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
}
function storeAuth(auth) {
  try { localStorage.setItem(AUTH_KEY, JSON.stringify(auth)); } catch (_) {}
}

function updateAuthUI() {
  $('#btnUser').classList.toggle('hidden', !state.authAvailable);
  const loggedIn = !!state.auth;
  $('#userName').textContent = loggedIn ? state.auth.user.username : '未登录';
  $('#userSub').textContent = loggedIn ? '已登录 · 笔记已同步' : '笔记仅保存在本机';
  document.querySelector('[data-auth-action="login"]').classList.toggle('hidden', loggedIn);
  document.querySelector('[data-auth-action="logout"]').classList.toggle('hidden', !loggedIn);
}

function openAuthModal(tab) {
  $('#authError').classList.add('hidden');
  document.querySelectorAll('.auth-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('#authUsername').value = '';
  $('#authPassword').value = '';
  $('#authSubmit').textContent = tab === 'login' ? '登录' : '注册并登录';
  $('#authModal').classList.remove('hidden');
  setTimeout(() => $('#authUsername').focus(), 60);
}
function closeAuthModal() { $('#authModal').classList.add('hidden'); }

async function submitAuth() {
  const username = $('#authUsername').value.trim();
  const password = $('#authPassword').value;
  const tab = document.querySelector('.auth-tab.active').dataset.tab;
  const errEl = $('#authError');
  errEl.classList.add('hidden');
  if (!username) { errEl.textContent = '请输入用户名'; errEl.classList.remove('hidden'); return; }
  if (password.length < 6) { errEl.textContent = '密码至少 6 位'; errEl.classList.remove('hidden'); return; }
  const res = await api('/api/' + tab, { method: 'POST', body: JSON.stringify({ username, password }) });
  if (!res.ok) {
    errEl.textContent = res.error || '网络错误，请检查服务器是否运行';
    errEl.classList.remove('hidden');
    return;
  }
  state.auth = { token: res.token, user: res.user };
  storeAuth(state.auth);
  closeAuthModal();
  await loadServerLibrary();
  updateAuthUI();
  toast('已登录：' + res.user.username);
}

async function loadServerLibrary() {
  const r = await api('/api/library');
  if (r.ok && r.library) {
    state.lib = sanitize(r.library);
  } else {
    // 新账号：从空白资料库开始（本机笔记可通过「导出/导入 .notebook」迁移，避免账号间串数据）
    state.lib = newLibrary();
    await api('/api/library', { method: 'PUT', body: JSON.stringify(state.lib) });
  }
  state.lib = sanitize(state.lib);
  applySettingsFromLib(state.lib);
  bootstrapUI();
}

async function logout(showToastMsg) {
  if (state.auth) api('/api/logout', { method: 'POST' });
  state.auth = null;
  try { localStorage.removeItem(AUTH_KEY); } catch (_) {}
  const local = await loadLibrary();
  state.lib = sanitize(local || newLibrary());
  applySettingsFromLib(state.lib);
  bootstrapUI();
  updateAuthUI();
  if (showToastMsg) toast('已退出登录');
}

function applySettingsFromLib(lib) {
  if (!lib) return;
  document.body.classList.toggle('markup-mode', lib.settings.markup === true);
  state.color = lib.settings.color || '#1e293b';
  state.colors.pen = lib.settings.color || '#1e293b';
  state.colors.highlighter = lib.settings.hlColor || '#fde047';
  state.colors.ballpen = lib.settings.ballpenColor || '#1e293b';
  state.tool = lib.settings.tool || 'ballpen';
  state.shape = lib.settings.shape || 'line';
  if (state.colors[state.tool]) state.color = state.colors[state.tool];
  state.widths.pen = lib.settings.penWidth || 5;
  state.widths.highlighter = lib.settings.hlWidth || 14;
  state.widths.ballpen = lib.settings.ballpenWidth || 5;
  state.styles.pen = lib.settings.penStyle || 'normal';
  state.styles.ballpen = lib.settings.ballpenStyle || 'normal';
}

function bootstrapUI() {
  const active = state.lib.active || {};
  let note = active.noteId ? state.lib.notes[active.noteId] : null;
  if (!note) {
    for (const s of state.lib.subjects) for (const nb of s.notebooks) {
      note = nb.noteIds.length ? state.lib.notes[nb.noteIds[0]] : null;
      if (note) break;
    }
  }
  if (note) openNote(note.id, active.notebookId, active.subjectId, active.pageIndex || 0);
  else renderLibrary();
  engine.setPage(currentPage());
  engine.fitView();
  engine.invalidateRaster();
  updateEmptyState();
}

/* ---------------- 录音 ---------------- */
function fmtTime(s) {
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return m + ':' + ss;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function recCapture(type, data) {
  const r = state.rec;
  if (!r.active || !r.noteId) return;
  r.timeline.push({
    t: Date.now() - r.startTime,
    type,
    data: type === 'stroke' ? JSON.parse(JSON.stringify(data)) : data,
    pageId: currentPage() ? currentPage().id : r.pageId
  });
}

// 录音时记录翻页（Notability：录音期间翻页被记入时间线，回放自动跟随）
function recPageTurn() {
  const r = state.rec;
  if (!r.active || !r.noteId) return;
  const page = currentPage();
  r.timeline.push({
    t: Date.now() - r.startTime,
    type: 'page',
    data: { to: state.pageIndex },
    pageId: page ? page.id : r.pageId
  });
}

async function toggleRecording() {
  if (state.rec.playback) stopPlayback();
  if (state.rec.active) { stopRecording(); return; }
  if (!state.recSupported) { toast('此设备不支持录音'); return; }
  if (!currentNote()) { toast('请先打开一个笔记'); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = window.MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    state.rec.chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) state.rec.chunks.push(e.data); };
    rec.onstop = async () => {
      const blob = new Blob(state.rec.chunks, { type: rec.mimeType || 'audio/mp4' });
      state.rec.chunks = [];
      state.rec.active = false;
      clearInterval(state.rec.timer);
      state.rec.media && state.rec.media.getTracks().forEach((t) => t.stop());
      updateRecUI();
      await saveRecording(blob);
    };
    state.rec.recorder = rec;
    state.rec.media = stream;
    state.rec.noteId = currentNote().id;
    state.rec.pageId = currentPage() ? currentPage().id : null;
    state.rec.baseCount = currentPage() ? currentPage().strokes.length : 0;
    state.rec.timeline = [];
    state.rec.startTime = Date.now();
    rec.start();
    state.rec.active = true;
    state.rec.timer = setInterval(updateRecUI, 500);
    updateRecUI();
  } catch (e) {
    console.warn('录音失败', e);
    toast('无法录音：请使用 https 地址并允许麦克风权限');
  }
}

function stopRecording() {
  if (state.rec.recorder && state.rec.recorder.state !== 'inactive') state.rec.recorder.stop();
}

async function saveRecording(blob) {
  const noteId = state.rec.noteId;
  if (!noteId) return;
  const list = await getRecMeta(noteId);
  const recId = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const dur = Math.max(1, Math.round((Date.now() - state.rec.startTime) / 1000));
  list.push({ id: recId, name: '录音 ' + (list.length + 1), duration: dur, createdAt: Date.now() });
  await saveAudioBlob('audio:' + noteId + ':' + recId, blob);
  await saveRecTimeline(noteId, recId, state.rec.timeline || []);
  state.rec.timeline = [];
  await saveRecMeta(noteId, list);
  refreshRecList();
  toast('录音已保存');
}

function updateRecUI() {
  const t = $('#recTimer');
  const st = $('#recStatus');
  const el = $('#recToggle');
  if (state.rec.active) {
    t.textContent = fmtTime(Math.floor((Date.now() - state.rec.startTime) / 1000));
    st.textContent = '录音中…';
    st.classList.add('live');
    el.classList.add('recording');
  } else {
    t.textContent = '0:00';
    st.textContent = '未在录音';
    st.classList.remove('live');
    el.classList.remove('recording');
  }
}

function stopPlayback() {
  clearInterval(state.rec.waveTimer);
  state.rec.playbackTimers.forEach(clearTimeout);
  state.rec.playbackTimers = [];
  if (state.rec.audioEl) {
    try { state.rec.audioEl.pause(); } catch (_) {}
    state.rec.audioEl = null;
  }
  if (state.rec.playback) {
    state.rec.playback = false;
    engine.playbackLock = false;
    const real = currentPage();
    if (real) { engine.setPage(real); engine.invalidateRaster(); }
  }
  state.rec.playingId = null;
  const st = $('#recStatus');
  if (st) { st.textContent = '未在录音'; st.classList.remove('live'); }
}

async function refreshRecList() {
  const note = currentNote();
  const listEl = $('#recList');
  if (!note) { listEl.innerHTML = ''; return; }
  const list = await getRecMeta(note.id);
  const sumEl = $('#recSummary');
  if (sumEl) {
    const total = list.reduce((s, x) => s + (x.duration || 0), 0);
    sumEl.textContent = '共 ' + list.length + ' 段 · 总 ' + (Math.round(total / 60 * 10) / 10) + ' 分钟';
  }
  listEl.innerHTML = '';
  if (!list.length) {
    listEl.innerHTML = '<div class="rec-empty">还没有录音，点红色按钮开始</div>';
    return;
  }
  for (const item of list) {
    const row = document.createElement('div');
    row.className = 'rec-item';
    row.innerHTML = `
      <button class="rec-play" data-rec="${escapeHtml(item.id)}"><svg viewBox="0 0 24 24" class="ic"><path d="M8 5v14l11-7z"/></svg></button>
      <div class="rec-mid">
        <span class="rec-name">${escapeHtml(item.name)}</span>
        <canvas class="rec-wave" data-wave="${escapeHtml(item.id)}" width="120" height="28"></canvas>
      </div>
      <span class="rec-dur">${fmtTime(item.duration)}</span>
      <button class="rec-exp" data-exp="${escapeHtml(item.id)}" aria-label="导出"><svg viewBox="0 0 24 24" class="ic"><path d="M12 4v11M7.5 10.5L12 6l4.5 4.5M5 19h14"/></svg></button>
      <button class="rec-del" data-del="${escapeHtml(item.id)}" aria-label="删除"><svg viewBox="0 0 24 24" class="ic"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>`;
    row.querySelector('.rec-play').addEventListener('click', () => playRecording(item, 0));
    row.querySelector('.rec-exp').addEventListener('click', () => exportRecording(item));
    row.querySelector('.rec-del').addEventListener('click', () => deleteRecording(item));
    const cv = row.querySelector('.rec-wave');
    cv.addEventListener('click', (e) => {
      const wd = waveCache.get(item.id);
      if (!wd) return;
      const r = cv.getBoundingClientRect();
      const t = Math.max(0, Math.min(wd.dur, ((e.clientX - r.left) / r.width) * wd.dur));
      playRecording(item, t);
    });
    listEl.appendChild(row);
    (async () => {
      const blob = await getAudioBlob('audio:' + note.id + ':' + item.id);
      if (!blob) return;
      const wd = await buildWave(item.id, blob);
      if (wd && cv.isConnected) drawWave(cv, wd.peaks, null);
    })();
  }
}
async function playRecording(item, startSec) {
  const note = currentNote();
  if (!note) return;
  if (state.rec.active) { toast('请先停止录音'); return; }
  const blob = await getAudioBlob('audio:' + note.id + ':' + item.id);
  if (!blob) { toast('音频文件不存在'); return; }
  stopPlayback();
  const timeline = await getRecTimeline(note.id, item.id);
  const startMs = (startSec || 0) * 1000;
  const speed = state.rec.speed || 1;
  // 跨页回放：快照所有涉及页，回放中自动切页跟随，结束后恢复原页（不污染数据）
  const pageIds = new Set(timeline.map(e => e.pageId).filter(Boolean));
  const preSnap = {};
  if (timeline.length) {
    for (const pid of pageIds) {
      const p = note.pages.find(x => x.id === pid);
      if (p) preSnap[pid] = JSON.stringify(p);
    }
    state.rec.playback = true;
    engine.playbackLock = true;
    const maxT = Math.max(0, ...timeline.map(e => e.t));
    const playEvents = timeline.filter(e => e.t >= startMs);
    for (const ev of playEvents) {
      state.rec.playbackTimers.push(setTimeout(() => {
        if (!state.rec.playback) return;
        if (ev.pageId && (!engine.page || engine.page.id !== ev.pageId)) {
          const idx = note.pages.findIndex(x => x.id === ev.pageId);
          if (idx >= 0 && idx !== state.pageIndex) {
            state.pageIndex = idx;
            engine.setPage(currentPage());
            engine.invalidateRaster();
            renderPaperStack();
            updatePageNav();
          }
        }
        const c = engine.page;
        if (!c) return;
        if (ev.type === 'stroke') {
          if (!c.strokes.some(s => s.id === ev.data.id)) c.strokes.push(JSON.parse(JSON.stringify(ev.data)));
        } else if (ev.type === 'erase') {
          c.strokes = c.strokes.filter(s => !ev.data.ids.includes(s.id));
        }
        engine.invalidateRaster();
      }, (ev.t - startMs) / speed));
    }
    state.rec.playbackTimers.push(setTimeout(() => {
      if (state.rec.playback) {
        for (const pid of Object.keys(preSnap)) {
          const p = note.pages.find(x => x.id === pid);
          if (p) Object.assign(p, JSON.parse(preSnap[pid]));
        }
        stopPlayback();
      }
    }, (maxT - startMs + 500) / speed));
  }
  const url = URL.createObjectURL(blob);
  const audio = document.createElement('audio');
  audio.src = url;
  try { audio.currentTime = startSec || 0; } catch (_) {}
  try { audio.playbackRate = speed; } catch (_) {}
  audio.play().catch(() => {});
  state.rec.audioEl = audio;
  state.rec.playingId = item.id;
  state.rec.waveTimer = setInterval(() => {
    if (!state.rec.audioEl || state.rec.playingId !== item.id) return;
    const wd = waveCache.get(item.id);
    const cv = document.querySelector('[data-wave="' + item.id + '"]');
    if (wd && cv) drawWave(cv, wd.peaks, state.rec.audioEl.currentTime / wd.dur);
  }, 120);
  audio.onended = () => { clearInterval(state.rec.waveTimer); try { URL.revokeObjectURL(url); } catch (_) {} if (state.rec.playback) stopPlayback(); };
}
async function deleteRecording(item) {
  const note = currentNote();
  if (!note) return;
  const list = await getRecMeta(note.id);
  await saveRecMeta(note.id, list.filter((x) => x.id !== item.id));
  await deleteAudioBlob('audio:' + note.id + ':' + item.id);
  await deleteRecTimeline(note.id, item.id);
  if (state.rec.playingId === item.id) stopPlayback();
  refreshRecList();
  toast('已删除录音');
}

  // 导出录音音频文件（支持 iPadOS 分享/下载）
  async function exportRecording(item) {
    const note = currentNote();
    if (!note) return;
    const blob = await getAudioBlob('audio:' + note.id + ':' + item.id);
    if (!blob) { toast('音频文件不存在'); return; }
    const type = (blob.type || '').toLowerCase();
    const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
    const fname = safeName(note.title) + ' - ' + item.name + '.' + ext;
    try { await shareOrDownload(blob, fname); } catch (_) { download(blob, fname); }
  }

/* ---------------- 恢复默认设置 ---------------- */
function resetSettings() {
  confirmModal('恢复默认设置？', '将重置工具、纸张、手势等全部设置（笔记内容不受影响）。', '恢复', true, () => {
    state.lib.settings = {
      fingerDraw: false, tool: 'ballpen', color: '#1e293b', width: 5, shape: 'line',
      penWidth: 5, hlWidth: 14, hlColor: '#fde047',
      toolbar: 'top', eraserSize: 24, eraserMode: 'stroke',
      defaultPaper: { style: 'line', color: 'white' },
      autoPage: true, twoFingerUndo: true, twoFingerAction: 'undo', noteSort: 'updated', theme: 'auto', accent: 'blue', textSize: 26,
      favorites: [], favoritesBar: true, penStyle: 'normal', ballpenStyle: 'normal', textPresets: [], autoBackup: true
    };
    applySettingsFromLib(state.lib);
    applyToolbarLayout();
    applyTheme();
    updateToolUI();
    updateColorUI();
    const of = $('#optFinger'); if (of) of.checked = false;
    const o2 = $('#optTwoFinger'); if (o2) o2.checked = true;
    const oa = $('#optAutoPage'); if (oa) oa.checked = true;
    saveLibrary(state.lib);
    renderSettings();
    toast('已恢复默认设置');
  });
}

/* ---------------- 初始化 ---------------- */
function registerSW() {
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      // iOS 默认不勤检查更新：每次启动主动触发一次检查
      navigator.serviceWorker.ready.then(() => reg.update()).catch(() => {});
    }).catch(() => {});
  }
}

async function init() {
  // 1) 后端可用性 + 恢复登录（认证初始化）
  const health = await api('/api/health');
  state.authAvailable = !!(health.ok && health.status === 200);
  const saved = loadAuth();
  if (state.authAvailable && saved && saved.token) {
    // 先挂上令牌再校验，api() 才会携带 Authorization
    state.auth = { token: saved.token, user: saved.user || null };
    const me = await api('/api/me');
    if (me.ok && me.user) { state.auth = { token: saved.token, user: me.user }; storeAuth(state.auth); }
    else {
      state.auth = null;
      try { localStorage.removeItem(AUTH_KEY); } catch (_) {}
    }
  }
  // 2) 数据源：登录 -> 服务器库；未登录 -> 本机（读取失败自动从备份恢复，绝不静默覆盖）
  let lib;
  if (state.auth) {
    await loadServerLibrary();
    lib = state.lib;
  } else {
    lib = await loadLibrary();
    if (!lib) {
      const bak = loadLocalBackup();
      if (bak) { lib = bak; toast('检测到本地备份，已自动恢复数据'); }
    }
    if (!lib) { lib = newLibrary(); }
    state.lib = lib;
    applySettingsFromLib(lib);
    saveLibrary(lib);
  }

  bindUI();
  bindV426UI();
  bindAIUI();
  showWelcomeGuide();
  updateToolUI();
  updateColorUI();
  const ofEl = $('#optFinger'); if (ofEl) ofEl.checked = !!lib.settings.fingerDraw;
  const o2El = $('#optTwoFinger'); if (o2El) o2El.checked = lib.settings.twoFingerUndo !== false;
  const oaEl = $('#optAutoPage'); if (oaEl) oaEl.checked = lib.settings.autoPage !== false;
  state.noteSort = lib.settings.noteSort || 'updated';
  renderSettings();
  applyToolbarLayout();
  applyTheme();
  updateAuthUI();
  ensureTextPresets();
  renderFavorites();

  const active = lib.active || {};
  let note = active.noteId ? lib.notes[active.noteId] : null;
  if (!note) {
    for (const s of lib.subjects) for (const nb of s.notebooks) {
      note = nb.noteIds.length ? lib.notes[nb.noteIds[0]] : null;
      if (note) break;
    }
  }
  if (note) {
    openNote(note.id, active.notebookId, active.subjectId, active.pageIndex || 0);
  } else if (!Object.keys(lib.notes).length) {
    createNote();
  } else {
    renderLibrary();
  }
  engine.setPage(currentPage());
  engine.fitView();
  engine.invalidateRaster();
  requestAnimationFrame(() => { engine.refreshRect(); engine.fitView(); engine.invalidateRaster(); fitScaleRef = engine.scale; });
  setTimeout(() => { engine.refreshRect(); engine.fitView(); engine.invalidateRaster(); fitScaleRef = engine.scale; }, 150);
  registerSW();
  if (state.lib && state.lib.settings && state.lib.settings.paperZoom) {
    document.documentElement.style.setProperty('--paper-zoom', String(Math.max(0.5, Math.min(2.5, state.lib.settings.paperZoom))));
  }
  scheduleSnapshot(true);

  // 记录首启
  try { if (!localStorage.getItem('note2-seen')) { localStorage.setItem('note2-seen', '1'); } } catch (_) {}
  // 调试句柄（供测试/排查使用）
  window.__note2 = { state, engine, addPage, duplicatePage, deletePage, openNote, switchPage, setPaper, exportNote, exportPdf, handleImport,
    rec: { toggleRecording, stopRecording, playRecording, stopPlayback, refreshRecList },
    renderFavorites, insertImage, openScanner, addScanFile, importPdf, setPageSize, presentMode, openSnapshots, openTextPresets, saveSnapshot, listSnapshots, loadSnapshot, deleteSnapshot,
    buildWave, drawWave, saveAudioBlob, saveRecMeta,
    addFavorite, toggleFavEdit, deleteSelection, copySelection, pasteSelection,
    deletePageAt, clearBlankPages,
    saveCurrentAsTemplate, openTemplateManager, newNoteFromTemplate,
    applyAccent, saveRecTimeline, getRecTimeline,
    toggleReadAloud, exportNoteText, notebookColor,
    renderLibrary, setSpacing, findInNote, outlineNote, noteEmoji,
    insertAttachment, manageAttachments, showWelcomeGuide,
    summarizeNote, insertAIText, speakAIText,
    openNewNoteMenu, insertTemplatePage, pickTemplateAndInsert,
    noteTagColor, noteStats, pickTemplateAndApply, rotateSelection, cropSelection, exportNoteRtf };
  window.__addPage = addPage;
  window.__duplicatePage = duplicatePage;
}

init();




































































