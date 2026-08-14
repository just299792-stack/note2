/* =========================================================
   笔记 —— 主应用
   ========================================================= */
import { newId, newLibrary, newNote, newPage, loadLibrary, saveLibrary, sanitize, findNote, findNotebook } from './storage.js';
import { DrawingEngine, PAGE_W, PAGE_H, renderPageToCanvas, paperInfo } from './drawing.js';
import { canvasesToPdf } from './pdf.js';

const APP_VERSION = '4.1';
const $ = (s) => document.querySelector(s);
const FONT = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

const PEN_COLORS = ['#1e293b','#0f172a','#475569','#94a3b8','#ffffff','#dc2626','#ea580c','#d97706','#16a34a','#0891b2','#2563eb','#7c3aed','#db2777'];
const HL_COLORS = ['#fde047','#fef08a','#fdba74','#fca5a5','#86efac','#5eead4','#7dd3fc','#c4b5fd','#f9a8d4','#fda4af'];
const PAPER_STYLES = [ { id: 'blank', name: '空白' }, { id: 'line', name: '横线' }, { id: 'grid', name: '方格' }, { id: 'dot', name: '点阵' } ];
const PAPER_COLORS = ['white', 'cream', 'grey', 'black', 'blue', 'green'];

const state = {
  lib: null,
  tool: 'pen', color: '#1e293b', shape: 'line',
  colors: { pen: '#1e293b', highlighter: '#fde047' },
  widths: { pen: 5, highlighter: 14, eraser: 24 },
  pageIndex: 0,
  activeNoteId: null, activeNotebookId: null, activeSubjectId: null,
  collapsedSubjects: new Set(),
  auth: null,
  authAvailable: false
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
    eraserSize: state.lib.settings.eraserSize || 24
  };
}

/* ---------------- 引擎 ---------------- */
const engine = new DrawingEngine($('#viewCanvas'), {
  getPage: () => currentPage(),
  getPaper: () => currentNote() ? currentNote().paper : { style: 'line', color: 'white' },
  getSettings: settings,
  getFont: () => FONT,
  onStrokeDone: (st) => { mutate(() => currentPage().strokes.push(st), '书写'); maybeAutoAdvance(st); },
  onShapeDone: (st) => mutate(() => currentPage().strokes.push(st), '形状'),
  onEraseDone: (ids) => mutate(() => { currentPage().strokes = currentPage().strokes.filter(s => !ids.includes(s.id)); }, '擦除'),
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
  onTwoFingerTap: () => { if (state.lib.settings.twoFingerUndo !== false) undo(); }
});
let moveBefore = null;

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
  refreshTitleMeta();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (state.auth) api('/api/library', { method: 'PUT', body: JSON.stringify(state.lib) });
    else saveLibrary(state.lib);
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
  saveSoon();
}

function switchPage(i) {
  const note = currentNote();
  if (!note || i < 0 || i >= note.pages.length) return;
  state.pageIndex = i;
  engine.setPage(currentPage());
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
    });
  });
  // 颜色/粗细
  $('#btnColor').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#colorPop').classList.toggle('hidden');
    updateColorUI();
  });
  $('#widthSlider').addEventListener('input', (e) => {
    state.widths[state.tool] = parseFloat(e.target.value);
    $('#widthValue').textContent = Math.round(parseFloat(e.target.value));
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
  $('#btnNewNote').addEventListener('click', createNote);
  $('#btnNewSubject').addEventListener('click', () => promptModal('新建科目', '', '科目名称', '创建', (name) => {
    if (!name) return;
    state.lib.subjects.push({ id: newId(), name, notebooks: [] });
    saveLibrary(state.lib);
    renderLibrary();
    toast('已创建科目');
  }));
  $('#btnNewNotebook').addEventListener('click', () => promptModal('新建笔记本', '', '笔记本名称', '创建', (name) => {
    if (!name) return;
    const subj = findActiveSubject();
    if (!subj) { toast('请先创建科目'); return; }
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
      state.lib.settings.color = c;
      if (state.tool === 'highlighter') state.lib.settings.hlColor = c;
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
  $('#titleMeta').textContent = `${pages} 页 · ${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
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
    if (st.id !== 'blank') b.innerHTML = `<div class="${st.id === 'line' ? 'lines' : st.id === 'grid' ? 'grid' : 'dots'}"></div>`;
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
function applyToolbarLayout() {
  const want = state.lib.settings.toolbar || 'left';
  const eff = (want === 'top' || window.innerWidth <= 820) ? 'top' : want;
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
    wrap.appendChild(head);
    if (!state.collapsedSubjects.has(subj.id)) {
      const nbs = document.createElement('div');
      nbs.className = 'notebooks';
      let nbi = 0;
      for (const nb of subj.notebooks) {
        const b = document.createElement('button');
        b.className = 'notebook' + (nb.id === state.activeNotebookId ? ' active' : '');
        b.innerHTML = `<span class="nb-icon"></span><span class="nb-name"></span>`;
        const hue = (nbi++ * 47) % 360;
        b.querySelector('.nb-icon').style.background = `linear-gradient(135deg, hsl(${hue},78%,60%), hsl(${(hue + 45) % 360},72%,52%))`;
        b.querySelector('.nb-icon').textContent = nb.name.slice(0, 1);
        b.querySelector('.nb-name').textContent = nb.name;
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          state.activeSubjectId = subj.id;
          state.activeNotebookId = nb.id;
          renderLibrary();
          renderNoteList();
        });
        nbs.appendChild(b);
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

function renderNoteList() {
  const root = $('#noteList');
  root.innerHTML = '';
  const f = findNotebook(state.lib, state.activeNotebookId);
  const notes = f ? f.notebook.noteIds.map(id => state.lib.notes[id]).filter(Boolean) : [];
  notes.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (!notes.length) {
    const empty = document.createElement('div');
    empty.className = 'note-item';
    empty.style.opacity = '.55';
    empty.textContent = '这个笔记本还没有笔记，点击右上角「＋ 笔记」新建。';
    root.appendChild(empty);
    return;
  }
  for (const note of notes) {
    const b = document.createElement('button');
    b.className = 'note-item' + (note.id === state.activeNoteId ? ' active' : '');
    const d = new Date(note.updatedAt || note.createdAt);
    const cov = paperInfo(note.paper.color);
    b.innerHTML = `<span class="ni-cover"></span><span class="ni-text"><span class="ni-title"></span><span class="ni-meta"></span></span>`;
    b.querySelector('.ni-cover').style.background = cov.bg;
    b.querySelector('.ni-title').textContent = note.title;
    b.querySelector('.ni-meta').textContent = `${note.pages.length} 页 · ${d.getMonth() + 1}/${d.getDate()}`;
    b.addEventListener('click', () => {
      openNote(note.id);
      if (window.innerWidth <= 820) $('#library').classList.add('hidden-mobile');
    });
    root.appendChild(b);
  }
}

function createNote() {
  const note = newNote(state.activeNotebookId || firstNotebookId(), '未命名笔记', state.lib.settings.defaultPaper || { style: 'line', color: 'white' });
  state.lib.notes[note.id] = note;
  let nb = findNotebook(state.lib, note.notebookId);
  if (!nb) {
    const subj = findActiveSubject() || state.lib.subjects[0];
    if (!subj) { toast('请先创建科目'); return; }
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
    btn.addEventListener('click', () => switchPage(i));
    list.appendChild(btn);
  });
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
      · 笔记本 / 科目组织，页面管理<br>
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
  state.tool = lib.settings.tool || 'pen';
  state.shape = lib.settings.shape || 'line';
  if (state.colors[state.tool]) state.color = state.colors[state.tool];
  state.widths.pen = lib.settings.penWidth || 5;
  state.widths.highlighter = lib.settings.hlWidth || 14;
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
  state.tool = lib.settings.tool || 'pen';
  state.shape = lib.settings.shape || 'line';
  if (state.colors[state.tool]) state.color = state.colors[state.tool];
  state.widths.pen = lib.settings.penWidth || 5;
  state.widths.highlighter = lib.settings.hlWidth || 14;

  bindUI();
  updateToolUI();
  updateColorUI();
  const ofEl = $('#optFinger'); if (ofEl) ofEl.checked = !!lib.settings.fingerDraw;
  const o2El = $('#optTwoFinger'); if (o2El) o2El.checked = lib.settings.twoFingerUndo !== false;
  const oaEl = $('#optAutoPage'); if (oaEl) oaEl.checked = lib.settings.autoPage !== false;
  renderSettings();
  applyToolbarLayout();

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
  window.__note2 = { state, engine, addPage, duplicatePage, deletePage, openNote, switchPage, setPaper, exportNote, exportPdf, handleImport };
  window.__addPage = addPage;
  window.__duplicatePage = duplicatePage;
}

init();
























