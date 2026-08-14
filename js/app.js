/* =========================================================
   笔记 —— 主应用
   ========================================================= */
import { newId, newLibrary, newNote, newPage, loadLibrary, saveLibrary, sanitize, findNote, findNotebook,
  saveAudioBlob, getAudioBlob, deleteAudioBlob, saveRecMeta, getRecMeta,
  saveRecTimeline, getRecTimeline, deleteRecTimeline } from './storage.js';
import { DrawingEngine, PAGE_W, PAGE_H, renderPageToCanvas, paperInfo } from './drawing.js';
import { canvasesToPdf } from './pdf.js';

const APP_VERSION = '4.12';
const $ = (s) => document.querySelector(s);
const FONT = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

const PEN_COLORS = ['#1e293b','#0f172a','#475569','#94a3b8','#ffffff','#dc2626','#ea580c','#d97706','#16a34a','#0891b2','#2563eb','#7c3aed','#db2777'];
const HL_COLORS = ['#fde047','#fef08a','#fdba74','#fca5a5','#86efac','#5eead4','#7dd3fc','#c4b5fd','#f9a8d4','#fda4af'];
const PAPER_STYLES = [ { id: 'blank', name: '空白' }, { id: 'line', name: '横线' }, { id: 'grid', name: '方格' }, { id: 'dot', name: '点阵' }, { id: 'cornell', name: '康奈尔' } ];
const PAPER_COLORS = ['white', 'cream', 'grey', 'black', 'blue', 'green'];

const state = {
  lib: null,
  tool: 'pen', color: '#1e293b', shape: 'line',
  colors: { pen: '#1e293b', highlighter: '#fde047', ballpen: '#1e293b' },
  widths: { pen: 5, highlighter: 14, eraser: 24, ballpen: 5 },
  pageIndex: 0,
  activeNoteId: null, activeNotebookId: null, activeSubjectId: null,
  collapsedSubjects: new Set(),
  auth: null,
  authAvailable: false,
  rec: { active: false, recorder: null, media: null, chunks: [], startTime: 0, timer: null, noteId: null, pageId: null, baseCount: 0, timeline: [], playingId: null, audioEl: null, playback: false, playbackTimers: [] },
  recSupported: !!(navigator.mediaDevices && window.MediaRecorder),
  searchQuery: '',
  saving: false,
  multi: { on: false, selected: new Set() }
};
let history = [];
let histIdx = -1;
let saveTimer = null;
let firstRun = false;

/* ---------------- 工具 ---------------- */
function currentNote() { return state.lib && state.activeNoteId ? state.lib.notes[state.activeNoteId] : null; }
function currentPage() { const n = currentNote(); return n ? n.pages[state.pageIndex] : null; }
function settings() {
  return {
    tool: state.tool, color: state.color, shape: state.shape,
    width: state.widths[state.tool] || 5,
    fingerDraw: !!state.lib.settings.fingerDraw,
    eraserSize: state.lib.settings.eraserSize || 24,
    eraserMode: state.lib.settings.eraserMode || 'stroke'
  };
}

/* ---------------- 引擎 ---------------- */
const engine = new DrawingEngine($('#viewCanvas'), {
  getPage: () => currentPage(),
  getPaper: () => currentNote() ? currentNote().paper : { style: 'line', color: 'white' },
  getSettings: settings,
  getFont: () => FONT,
  onStrokeDone: (st) => { recCapture('stroke', st); mutate(() => currentPage().strokes.push(st), '书写'); maybeAutoAdvance(st); },
  onShapeDone: (st) => { recCapture('stroke', st); mutate(() => currentPage().strokes.push(st), '形状'); },
  onEraseDone: (ids) => { recCapture('erase', { ids }); mutate(() => { currentPage().strokes = currentPage().strokes.filter(s => !ids.includes(s.id)); }, '擦除'); },
  onPixelEraseDone: (path, radius) => {
    const page = currentPage();
    if (!page || !path || path.length < 2) return;
    const newStrokes = pixelErase(page, path, radius);
    if (newStrokes) mutate(() => { page.strokes = newStrokes; }, '擦除');
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
  onTextTap: (w) => createTextEdit(w),
  onTwoFingerTap: () => {
    const a = state.lib.settings.twoFingerAction || 'undo';
    if (a === 'undo') undo();
    else if (a === 'redo') redo();
  }
});
let moveBefore = null;

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
  if (maxY < PAGE_H * 0.94) return;
  const note = currentNote();
  if (!note) return;
  if (state.pageIndex >= note.pages.length - 1) {
    setTimeout(() => { addPage(); toast('已自动添加新页'); }, 200);
  } else {
    setTimeout(() => switchPage(state.pageIndex + 1), 200);
  }
}

/* ---------------- 历史记录 ---------------- */
function pageSnapshot(page) { return JSON.stringify({ s: page.strokes, t: page.texts }); }
function restoreContent(page, json) {
  const d = JSON.parse(json);
  page.strokes = d.s; page.texts = d.t;
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
  const note = currentNote();
  if (note && touch) note.updatedAt = Date.now();
  state.saving = true;
  refreshTitleMeta();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const done = () => { state.saving = false; refreshTitleMeta(); };
    if (state.auth) api('/api/library', { method: 'PUT', body: JSON.stringify(state.lib) }).then(done).catch(done);
    else Promise.resolve(saveLibrary(state.lib)).then(done);
  }, 350);
}
async function flushSave() {
  clearTimeout(saveTimer);
  if (state.lib) await saveLibrary(state.lib);
}

/* ---------------- 打开笔记 / 页面 ---------------- */
function openNote(noteId, notebookId, subjectId, pageIndex) {
  const note = state.lib.notes[noteId];
  if (!note) return;
  if (state.multi.on) exitMulti();
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
  state.pageIndex = i;
  engine.setPage(currentPage());
  pageFade();
  engine.fitView();
  engine.invalidateRaster();
  renderPages();
  updatePageNav();
  state.lib.active.pageIndex = i;
  saveSoon();
}

function applyPagesChange() {
  engine.setPage(currentPage());
  engine.fitView();
  engine.invalidateRaster();
  renderPages();
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
}

function deletePage() {
  const note = currentNote();
  if (!note || note.pages.length <= 1) { toast('至少保留一页'); return; }
  confirmModal('删除当前页？', '这一页上的所有内容都会被删除，且无法恢复。', '删除', true, () => {
    const before = note.pages.slice();
    note.pages.splice(state.pageIndex, 1);
    const after = note.pages.slice();
    pushHistory('删除页面',
      () => { note.pages = before; afterPageArrayRestore(); },
      () => { note.pages = after; afterPageArrayRestore(); });
    state.pageIndex = Math.max(0, state.pageIndex - 1);
    afterPageArrayRestore();
  });
}

/* ---------------- 文字工具 ---------------- */
function createTextEdit(world) {
  const fontSize = 26;
  const color = state.color;
  const item = { id: newId(), x: world.x / PAGE_W, y: world.y / PAGE_H, w: 0.3, h: 0.06, text: '', fontSize, color, align: 'left' };
  const layer = $('#textLayer');
  const ta = document.createElement('textarea');
  ta.className = 'text-edit';
  const sp = engine.worldToScreen(world.x, world.y);
  const scale = engine.scale;
  ta.style.left = sp.x + 'px';
  ta.style.top = sp.y + 'px';
  ta.style.width = Math.max(120, 0.3 * PAGE_W * scale) + 'px';
  ta.style.minHeight = Math.round(fontSize * 1.4 * scale) + 'px';
  ta.style.fontSize = Math.round(fontSize * scale) + 'px';
  ta.style.color = color;
  ta.style.lineHeight = '1.3';
  ta.placeholder = '输入文字…';
  layer.appendChild(ta);
  ta.focus();
  let done = false;
  const finish = () => {
    if (done) return; done = true;
    const text = ta.value.replace(/\n+$/g, '');
    ta.remove();
    if (!text) return;
    const mctx = document.createElement('canvas').getContext('2d');
    mctx.font = `600 ${fontSize}px ${FONT}`;
    const lines = text.split('\n');
    let maxW = 0;
    for (const ln of lines) maxW = Math.max(maxW, mctx.measureText(ln).width);
    const pad = 10;
    item.text = text;
    item.w = Math.max(0.12, (maxW + pad * 2) / PAGE_W);
    item.h = (lines.length * fontSize * 1.3 + pad * 2) / PAGE_H;
    mutate(() => currentPage().texts.push(item), '文字');
  };
  ta.addEventListener('blur', finish);
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { done = true; ta.remove(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') ta.blur();
  });
}

/* ---------------- 工具 UI ---------------- */
function bindUI() {
  // 工具按钮
  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.tool = btn.dataset.tool;
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
    $('#moreMenu').classList.toggle('hidden');
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
  $('#btnNewNote').addEventListener('click', createNote);
  const nsEl = $('#noteSearch');
  if (nsEl) nsEl.addEventListener('input', (e) => { state.searchQuery = e.target.value; renderNoteList(); });
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
  $('#moreMenu').addEventListener('click', (e) => {
    const item = e.target.closest('.menu-item[data-action]');
    if (!item) return;
    const act = item.dataset.action;
    $('#moreMenu').classList.add('hidden');
    if (act === 'export-note') exportNote();
    if (act === 'export-pdf') exportPdf();
    if (act === 'export-library') exportLibrary();
    if (act === 'import') $('#fileInput').click();
    if (act === 'add-page') addPage();
    if (act === 'duplicate-page') duplicatePage();
    if (act === 'copy-page-to') copyPageTo();
    if (act === 'delete-page') deletePage();
    if (act === 'account') { if (state.auth) logout(true); else openAuthModal('login'); }
    if (act === 'logout') logout(true);
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
    if (!e.target.closest('.tb-menu-wrap')) $('#moreMenu').classList.add('hidden');
  });
  // 快捷键
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  });
  // 页面切换快捷键
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key === 'PageDown') switchPage(state.pageIndex + 1);
    if (e.key === 'PageUp') switchPage(state.pageIndex - 1);
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
function applyTheme() {
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
    });
  }
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
        main.querySelector('.nb-icon').style.background = `linear-gradient(135deg, hsl(${hue},78%,60%), hsl(${(hue + 45) % 360},72%,52%))`;
        main.querySelector('.nb-icon').textContent = nb.name.slice(0, 1);
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
}

function updateEmptyState() {
  const el = $('#emptyState');
  if (el) el.classList.toggle('hidden', !!currentNote());
}

function renderNoteList() {
  const root = $('#noteList');
  root.innerHTML = '';
  const f = findNotebook(state.lib, state.activeNotebookId);
  let notes = f ? f.notebook.noteIds.map(id => state.lib.notes[id]).filter(Boolean) : [];
  const q = (state.searchQuery || '').trim().toLowerCase();
  if (q) {
    notes = notes.filter(n =>
      n.title.toLowerCase().includes(q) ||
      n.pages.some(pg => pg.texts.some(t => (t.text || '').toLowerCase().includes(q)))
    );
  }
  notes.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.updatedAt || 0) - (a.updatedAt || 0));
  if (!notes.length) {
    const empty = document.createElement('div');
    empty.className = 'note-item';
    empty.style.opacity = '.55';
    empty.textContent = '这个笔记本还没有笔记，点击右上角「＋ 笔记」新建。';
    root.appendChild(empty);
    return;
  }
  for (const note of notes) {
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
      renderPageToCanvas(cv, note.pages[0], note.paper, 90, FONT);
      coverEl.appendChild(cv);
    }
    if (note.pinned) {
      const pin = document.createElement('span');
      pin.className = 'ni-pin';
      pin.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><path d="M9 4h6v3l-1.5 2v4l2 2v2h-7v-2l2-2V9L9 7z"/><path d="M12 3v1"/></svg>';
      item.querySelector('.ni-cover').appendChild(pin);
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
    <button class="menu-item" data-act="pin"><svg viewBox="0 0 24 24" class="ic"><path d="M9 4h6v3l-1.5 2v4l2 2v2h-7v-2l2-2V9L9 7z"/></svg>${note.pinned ? '取消置顶' : '置顶'}</button>
    <button class="menu-item" data-act="multi"><svg viewBox="0 0 24 24" class="ic"><path d="M4 6h4M4 12h4M4 18h4M11 6h9M11 12h9M11 18h9"/></svg>多选</button>
    <button class="menu-item danger" data-act="del"><svg viewBox="0 0 24 24" class="ic"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>删除</button>`;
  const r = anchor.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 190)) + 'px';
  menu.style.top = (r.bottom + 4) + 'px';
  document.body.appendChild(menu);
  menu.querySelector('[data-act="rename"]').addEventListener('click', () => { menu.remove(); renameNote(note); });
  menu.querySelector('[data-act="pin"]').addEventListener('click', () => { menu.remove(); togglePin(note); });
  menu.querySelector('[data-act="multi"]').addEventListener('click', () => { menu.remove(); enterMulti(); });
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

function togglePin(note) {
  note.pinned = !note.pinned;
  saveSoon(true);
  renderNoteList();
  toast(note.pinned ? '已置顶' : '已取消置顶');
}

function createNote() {
  const d = new Date();
  const autoTitle = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const note = newNote(state.activeNotebookId || firstNotebookId(), autoTitle, state.lib.settings.defaultPaper || { style: 'line', color: 'white' });
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
    <button class="menu-item danger" data-act="del"><svg viewBox="0 0 24 24" class="ic"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>删除</button>`;
  const r = anchor.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 190)) + 'px';
  menu.style.top = (r.bottom + 4) + 'px';
  document.body.appendChild(menu);
  menu.querySelector('[data-act="rename"]').addEventListener('click', () => { menu.remove(); renameNotebook(nb); });
  menu.querySelector('[data-act="del"]').addEventListener('click', () => { menu.remove(); deleteNotebookConfirm(nb); });
  setTimeout(() => document.addEventListener('click', function h(e) { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', h); } }), 0);
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
    if (cv && note.pages[i]) renderPageToCanvas(cv, note.pages[i], note.paper, 160, FONT);
    el.classList.toggle('active', i === state.pageIndex);
  });
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
    renderPageToCanvas(cv, page, note.paper, 160, FONT);
    btn.appendChild(cv);
    const num = document.createElement('span');
    num.className = 'pt-num';
    num.textContent = i + 1;
    btn.appendChild(num);
    if (note.pages.length > 1) {
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
    list.appendChild(btn);
  });
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

async function exportPdf() {
  const note = currentNote();
  if (!note) return;
  toast('正在生成 PDF…');
  await new Promise(r => setTimeout(r, 30));
  const canvases = note.pages.map(page => {
    const cv = document.createElement('canvas');
    renderPageToCanvas(cv, page, note.paper, 1224, FONT);
    return cv;
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
    // 新账号：从欢迎笔记开始（本机笔记可通过「导出/导入 .notebook」迁移，避免账号间串数据）
    state.lib = newLibrary();
    firstRun = true;
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
  state.color = lib.settings.color || '#1e293b';
  state.colors.pen = lib.settings.color || '#1e293b';
  state.colors.highlighter = lib.settings.hlColor || '#fde047';
  state.colors.ballpen = lib.settings.ballpenColor || '#1e293b';
  state.tool = lib.settings.tool || 'pen';
  state.shape = lib.settings.shape || 'line';
  if (state.colors[state.tool]) state.color = state.colors[state.tool];
  state.widths.pen = lib.settings.penWidth || 5;
  state.widths.highlighter = lib.settings.hlWidth || 14;
  state.widths.ballpen = lib.settings.ballpenWidth || 5;
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
  if (!r.active || !r.noteId || !r.pageId) return;
  const page = currentPage();
  if (!page || page.id !== r.pageId) return;
  r.timeline.push({
    t: Date.now() - r.startTime,
    type,
    data: type === 'stroke' ? JSON.parse(JSON.stringify(data)) : data
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
      <span class="rec-name">${escapeHtml(item.name)}</span>
      <span class="rec-dur">${fmtTime(item.duration)}</span>
      <button class="rec-del" data-del="${escapeHtml(item.id)}" aria-label="删除"><svg viewBox="0 0 24 24" class="ic"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>`;
    row.querySelector('.rec-play').addEventListener('click', () => playRecording(item));
    row.querySelector('.rec-del').addEventListener('click', () => deleteRecording(item));
    listEl.appendChild(row);
  }
}

async function playRecording(item) {
  const note = currentNote();
  if (!note) return;
  if (state.rec.active) { toast('请先停止录音'); return; }
  const blob = await getAudioBlob('audio:' + note.id + ':' + item.id);
  if (!blob) { toast('音频文件不存在'); return; }
  stopPlayback();
  const timeline = await getRecTimeline(note.id, item.id);
  const page = currentPage();
  // 笔迹回放：克隆当前页，去掉时间线里会被重放的笔画，按时间逐笔重现
  if (timeline.length && page) {
    const tlIds = new Set(timeline.filter(e => e.type === 'stroke').map(e => e.data && e.data.id).filter(Boolean));
    const clone = {
      id: page.id,
      strokes: page.strokes.filter(s => !tlIds.has(s.id)).map(s => JSON.parse(JSON.stringify(s))),
      texts: JSON.parse(JSON.stringify(page.texts))
    };
    state.rec.playback = true;
    engine.playbackLock = true;
    engine.setPage(clone);
    engine.invalidateRaster();
    const maxT = Math.max(0, ...timeline.map(e => e.t));
    for (const ev of timeline) {
      state.rec.playbackTimers.push(setTimeout(() => {
        if (!state.rec.playback || !engine.page) return;
        const c = engine.page;
        if (ev.type === 'stroke') {
          if (!c.strokes.some(s => s.id === ev.data.id)) c.strokes.push(JSON.parse(JSON.stringify(ev.data)));
        } else if (ev.type === 'erase') {
          c.strokes = c.strokes.filter(s => !ev.data.ids.includes(s.id));
        }
        engine.invalidateRaster();
      }, ev.t));
    }
    state.rec.playbackTimers.push(setTimeout(() => { if (state.rec.playback) stopPlayback(); }, maxT + 1500));
  }
  const url = URL.createObjectURL(blob);
  const audio = document.createElement('audio');
  audio.src = url;
  audio.play().catch(() => {});
  state.rec.audioEl = audio;
  state.rec.playingId = item.id;
  audio.onended = () => { try { URL.revokeObjectURL(url); } catch (_) {} if (state.rec.playback) stopPlayback(); };
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
  let lib = await loadLibrary();
  if (!lib) { lib = newLibrary(); firstRun = true; await saveLibrary(lib); }
  state.lib = lib;
  state.color = lib.settings.color || '#1e293b';
  state.colors.pen = lib.settings.color || '#1e293b';
  state.colors.highlighter = lib.settings.hlColor || '#fde047';
  state.colors.ballpen = lib.settings.ballpenColor || '#1e293b';
  state.tool = lib.settings.tool || 'pen';
  state.shape = lib.settings.shape || 'line';
  if (state.colors[state.tool]) state.color = state.colors[state.tool];
  state.widths.pen = lib.settings.penWidth || 5;
  state.widths.highlighter = lib.settings.hlWidth || 14;
  state.widths.ballpen = lib.settings.ballpenWidth || 5;

  bindUI();
  updateToolUI();
  updateColorUI();
  const ofEl = $('#optFinger'); if (ofEl) ofEl.checked = !!lib.settings.fingerDraw;
  const o2El = $('#optTwoFinger'); if (o2El) o2El.checked = lib.settings.twoFingerUndo !== false;
  const oaEl = $('#optAutoPage'); if (oaEl) oaEl.checked = lib.settings.autoPage !== false;
  renderSettings();
  applyToolbarLayout();
  applyTheme();

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
  } else {
    renderLibrary();
  }
  engine.setPage(currentPage());
  engine.fitView();
  engine.invalidateRaster();
  registerSW();

  if (firstRun) {
    setTimeout(() => {
      toast('欢迎使用「笔记」！用 Apple Pencil 或鼠标书写 ✍️');
    }, 600);
  }
  // 记录首启
  try { if (!localStorage.getItem('note2-seen')) { localStorage.setItem('note2-seen', '1'); } } catch (_) {}
  // 调试句柄（供测试/排查使用）
  window.__note2 = { state, engine, addPage, duplicatePage, deletePage, openNote, switchPage, setPaper, exportNote, exportPdf, handleImport,
    rec: { toggleRecording, stopRecording, playRecording, stopPlayback, refreshRecList } };
  window.__addPage = addPage;
  window.__duplicatePage = duplicatePage;
}

init();


















































