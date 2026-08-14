/* =========================================================
   笔记 —— 绘图引擎
   - 矢量笔画（归一化坐标，分辨率无关）
   - 钢笔压力感应 / 荧光笔 / 橡皮擦 / 套索 / 文字 / 形状
   - 双指平移缩放、放大镜、页面光栅复用
   ========================================================= */
export const PAGE_W = 816;      // 逻辑页面宽 (pt)
export const PAGE_H = 1056;     // 逻辑页面高 (pt)
const RENDER_SCALE = 2;         // 页面光栅超采样
const MIN_DIST = 1.1;           // 点抽稀最小距离(世界px)
const LINE_H = 48;              // 横线行距(世界px)，荧光笔对齐用

const PAPER_INFO = {
  white:  { bg: '#fffefb',  line: 'rgba(120,160,220,.35)',  grid: 'rgba(120,160,220,.30)',  dot: 'rgba(120,160,220,.45)',  dark: false, name: '白色' },
  cream:  { bg: '#fffcf2',  line: 'rgba(190,160,120,.38)',  grid: 'rgba(190,160,120,.32)',  dot: 'rgba(190,160,120,.45)',  dark: false, name: '米黄' },
  grey:   { bg: '#f3f5f7',  line: 'rgba(110,130,160,.35)',  grid: 'rgba(110,130,160,.30)',  dot: 'rgba(110,130,160,.45)',  dark: false, name: '浅灰' },
  black:  { bg: '#000000',  line: 'rgba(255,255,255,.14)',  grid: 'rgba(255,255,255,.12)',  dot: 'rgba(255,255,255,.22)',  dark: true,  name: '黑' },
  blue:   { bg: '#eef4ff',  line: 'rgba(90,120,200,.32)',   grid: 'rgba(90,120,200,.28)',   dot: 'rgba(90,120,200,.40)',   dark: false, name: '淡蓝' },
  green:  { bg: '#f0fbf3',  line: 'rgba(80,160,110,.32)',   grid: 'rgba(80,160,110,.28)',   dot: 'rgba(80,160,110,.40)',   dark: false, name: '淡绿' }
};
export function paperInfo(color) { return PAPER_INFO[color] || PAPER_INFO.white; }

/* ================= 共享渲染函数 ================= */
export function drawPaper(ctx, style, color, w, h) {
  const info = paperInfo(color);
  ctx.fillStyle = info.bg;
  ctx.fillRect(0, 0, w, h);
  const LINE = 48, GRID = 38;
  if (style === 'line') {
    ctx.strokeStyle = info.line; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let y = LINE; y < h; y += LINE) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.stroke();
    // 左侧页边距线（更接近真实笔记本）
    ctx.strokeStyle = info.line; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(92, 0); ctx.lineTo(92, h); ctx.stroke();
  } else if (style === 'grid') {
    ctx.strokeStyle = info.grid; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let y = GRID; y < h; y += GRID) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
    for (let x = GRID; x < w; x += GRID) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    ctx.stroke();
  } else if (style === 'dot') {
    ctx.fillStyle = info.dot;
    for (let y = GRID; y < h; y += GRID) for (let x = GRID; x < w; x += GRID) {
      ctx.beginPath(); ctx.arc(x, y, 1.4, 0, 7); ctx.fill();
    }
  } else if (style === 'cornell') {
    // 康奈尔：左侧提示列 252px，底部小结区 824px
    ctx.strokeStyle = info.line; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let y = LINE; y < 824; y += LINE) { ctx.moveTo(252, y); ctx.lineTo(w, y); }
    for (let y = LINE; y < h; y += LINE) { ctx.moveTo(0, y); ctx.lineTo(252, y); }
    ctx.stroke();
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(252, 0); ctx.lineTo(252, h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, 824); ctx.lineTo(w, 824); ctx.stroke();
  }
  return info;
}

export function wrapText(ctx, text, maxW) {
  if (!text) return [];
  const words = text.split(/(\s+)/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur + w;
    if (ctx.measureText(test).width > maxW && cur) { lines.push(cur); cur = w.trimStart(); }
    else cur = test;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

export function drawTextItem(ctx, t, font, w, h) {
  ctx.save();
  ctx.fillStyle = t.color;
  ctx.font = `600 ${t.fontSize}px ${font}`;
  ctx.textBaseline = 'top';
  const lines = wrapText(ctx, t.text, t.w * w);
  let y = t.y * h;
  const lh = t.fontSize * 1.25;
  for (const ln of lines) {
    let x = t.x * w;
    if (t.align === 'center') x += (t.w * w - ctx.measureText(ln).width) / 2;
    else if (t.align === 'right') x += t.w * w - ctx.measureText(ln).width;
    ctx.fillText(ln, x, y);
    y += lh;
  }
  ctx.restore();
}

export function drawStroke(ctx, st, info, font) {
  if (!st.points || (!st.points.length || st.points.length < 2) && !st.shape) return;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (st.shape) { drawShape(ctx, st); ctx.restore(); return; }
  if (st.tool === 'highlighter') {
    ctx.globalAlpha = 0.45;
    ctx.globalCompositeOperation = info.dark ? 'source-over' : 'multiply';
    ctx.strokeStyle = st.color;
    ctx.lineWidth = st.width * 2.2;
    const pts = st.points;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i], q = pts[i - 1];
      ctx.lineTo((q.x + p.x) / 2, (q.y + p.y) / 2);
      if (i === pts.length - 1) ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.restore();
    return;
  }
  if (st.tool === 'ballpen') {
    // 圆珠笔：均匀圆润描边（无笔锋，圆头圆角）
    const pts = st.points;
    ctx.strokeStyle = st.color;
    ctx.lineWidth = Math.max(1.4, st.width);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    ctx.stroke();
    ctx.restore();
    return;
  }
  // 钢笔：平滑描边 + 起收笔锋（细→粗→细）+ 圆头圆角
  const pts = st.points;
  const n = pts.length;
  let sumP = 0;
  for (let i = 0; i < n; i++) sumP += pts[i].p || 1;
  const avgP = Math.max(0.3, Math.min(1, sumP / n));
  const baseW = Math.max(1.6, st.width * (0.45 + 0.55 * avgP));
  const taper = (t) => {
    if (t < 0.12) return 0.35 + 0.65 * (t / 0.12);
    if (t > 0.88) return 0.35 + 0.65 * ((1 - t) / 0.12);
    return 1;
  };
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const t = (i + 0.5) / (n - 1);
    const w = baseW * taper(t) * (0.8 + 0.2 * (((a.p || 1) + (b.p || 1)) / 2));
    ctx.strokeStyle = st.color;
    ctx.lineWidth = Math.max(0.8, w);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.restore();
}

export function drawShape(ctx, st) {
  const [a, b] = st.points;
  if (!a || !b) return;
  ctx.strokeStyle = st.color;
  ctx.lineWidth = st.width;
  const x1 = a.x, y1 = a.y, x2 = b.x, y2 = b.y;
  ctx.beginPath();
  if (st.shape === 'line' || st.shape === 'arrow') {
    ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    if (st.shape === 'arrow') {
      const ang = Math.atan2(y2 - y1, x2 - x1);
      const len = Math.min(26, Math.hypot(x2 - x1, y2 - y1) * 0.3);
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - len * Math.cos(ang - 0.5), y2 - len * Math.sin(ang - 0.5));
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - len * Math.cos(ang + 0.5), y2 - len * Math.sin(ang + 0.5));
      ctx.stroke();
    }
  } else if (st.shape === 'rect' || st.shape === 'square') {
    ctx.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    ctx.stroke();
  } else if (st.shape === 'ellipse') {
    ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, 7);
    ctx.stroke();
  } else if (st.shape === 'circle') {
    const rx = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1)) / 2;
    ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, rx, rx, 0, 0, 7);
    ctx.stroke();
  } else if (st.shape === 'polygon') {
    const pts = st.points;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.stroke();
  } else if (st.shape === 'curve') {
    const pts = st.points;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    ctx.stroke();
  }
}

/** 把一页渲染到指定画布（用于缩略图 / PDF） */
export function renderPageToCanvas(canvas, page, paper, targetW, font) {
  const rs = targetW / PAGE_W;
  canvas.width = Math.round(PAGE_W * rs);
  canvas.height = Math.round(PAGE_H * rs);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(rs, 0, 0, rs, 0, 0);
  const info = drawPaper(ctx, paper.style, paper.color, PAGE_W, PAGE_H);
  for (const st of page.strokes) drawStroke(ctx, st, info, font);
  for (const t of page.texts) drawTextItem(ctx, t, font, PAGE_W, PAGE_H);
  return canvas;
}

/* ================= 引擎 ================= */
export class DrawingEngine {
  constructor(canvas, callbacks) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cb = callbacks;
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.raster = document.createElement('canvas');
    this.rctx = this.raster.getContext('2d');
    this.scale = 0.6; this.ox = 0; this.oy = 0;
    this.dirtyRaster = true; this.dirtyView = true;
    this.page = null;
    this.pointers = new Map();
    this.gesture = null;
    this.panning = false;
    this.currentStroke = null;
    this.curShape = null;
    this.lassoPath = null;
    this.eraseIds = new Set();
    this.erasePath = null;
    this.lastMoveTs = 0;
    this.selection = null;
    this.playbackLock = false;
    this._raf = 0;
    this._rect = null;

    this._pd = this.onPointerDown.bind(this);
    this._pm = this.onPointerMove.bind(this);
    this._pu = this.onPointerUp.bind(this);
    this._wh = this.onWheel.bind(this);
    this._rs = this.resize.bind(this);
    this._cx = (e) => e.preventDefault();
    this.attach();
  }

  attach() {
    const c = this.canvas;
    c.addEventListener('pointerdown', this._pd);
    c.addEventListener('pointermove', this._pm);
    c.addEventListener('pointerup', this._pu);
    c.addEventListener('pointercancel', this._pu);
    c.addEventListener('wheel', this._wh, { passive: false });
    c.addEventListener('contextmenu', this._cx);
    window.addEventListener('resize', this._rs);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', this._rs);
    this.resize();
  }

  destroy() {
    const c = this.canvas;
    c.removeEventListener('pointerdown', this._pd);
    c.removeEventListener('pointermove', this._pm);
    c.removeEventListener('pointerup', this._pu);
    c.removeEventListener('pointercancel', this._pu);
    c.removeEventListener('wheel', this._wh);
    c.removeEventListener('contextmenu', this._cx);
    window.removeEventListener('resize', this._rs);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', this._rs);
  }

  /* -------- 视图 -------- */
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this._rect = rect;
    this.cw = rect.width; this.ch = rect.height;
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
    this.fitView();
  }

  fitView() {
    const pad = 40;
    const s = Math.min((this.cw - pad * 2) / PAGE_W, (this.ch - pad * 2) / PAGE_H);
    this.scale = Math.max(0.2, Math.min(2, s));
    this.ox = (this.cw - PAGE_W * this.scale) / 2;
    this.oy = (this.ch - PAGE_H * this.scale) / 2;
    this.dirtyView = true;
  }

  zoomAt(sx, sy, factor) {
    const w = this.screenToWorld(sx, sy);
    const ns = Math.max(0.25, Math.min(4, this.scale * factor));
    this.scale = ns;
    this.ox = sx - w.x * ns;
    this.oy = sy - w.y * ns;
    this.dirtyView = true;
  }

  local(e) {
    // 每次实时读取画布位置，避免启动/布局变化后产生笔迹偏移
    const r = this.canvas.getBoundingClientRect();
    if (this._rect) { this._rect = r; }
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  screenToWorld(sx, sy) { return { x: (sx - this.ox) / this.scale, y: (sy - this.oy) / this.scale }; }
  worldToScreen(wx, wy) { return { x: wx * this.scale + this.ox, y: wy * this.scale + this.oy }; }

  /* -------- 输入 -------- */
  snapPoint(w, tool, pressure) {
    const pt = { x: w.x, y: w.y, p: pressure };
    const paper = this.cb.getPaper();
    if (tool === 'highlighter' && paper.style === 'line') {
      pt.y = Math.round(w.y / LINE_H) * LINE_H;
    }
    return pt;
  }

  onPointerDown(e) {
    if (this.pointers.size >= 2) return;
    if (this.playbackLock) return;
    try { this.canvas.setPointerCapture?.(e.pointerId); } catch (_) {}
    const L = this.local(e);
    this.pointers.set(e.pointerId, { id: e.pointerId, x: L.x, y: L.y });

    if (this.pointers.size === 2) { this.beginGesture(); return; }

    const settings = this.cb.getSettings();
    if (e.pointerType === 'mouse' && e.button === 2) { this.panning = true; return; }
    if (e.pointerType === 'touch' && !settings.fingerDraw) return;

    const w = this.screenToWorld(L.x, L.y);
    switch (settings.tool) {
      case 'pen':
      case 'ballpen':
      case 'highlighter':
        this.currentStroke = {
          id: 's' + Math.random().toString(36).slice(2, 10),
          tool: settings.tool, color: settings.color, width: settings.width,
          points: [this.snapPoint(w, settings.tool, this.pressure(e))]
        };
        break;
      case 'eraser':
      case 'pixelEraser':
        this.eraseIds = new Set();
        this.erasePath = [];
        this.lastErase = { x: w.x, y: w.y };
        this.erasePath.push({ x: w.x, y: w.y });
        if (settings.tool === 'eraser' && settings.eraserMode !== 'pixel') this.hitErase(w.x, w.y);
        break;
      case 'lasso':
        if (this.selection && this.selection.ids.length && this.pointInBox(w, this.selection.box)) {
          this.selection.moving = true;
          this.selection.offset = { dx: 0, dy: 0 };
          this.moveStart = { x: w.x, y: w.y };
        } else {
          this.lassoPath = [{ x: w.x, y: w.y }];
        }
        break;
      case 'text':
        this.textTap = { x: L.x, y: L.y, w, moved: false };
        break;
      case 'shape':
        this.curShape = { kind: settings.shape, x1: w.x, y1: w.y, x2: w.x, y2: w.y };
        break;
    }
    this.dirtyView = true;
    this.requestFrame();
  }

  onPointerMove(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const Lp = this.local(e);
    const nx = Lp.x, ny = Lp.y;

    if (this.pointers.size === 2) { p.x = nx; p.y = ny; this.updateGesture(); return; }
    if (this.gesture) return;

    if (this.panning) {
      this.ox += nx - p.x; this.oy += ny - p.y;
      this.dirtyView = true; this.requestFrame();
      p.x = nx; p.y = ny;
      return;
    }

    const settings = this.cb.getSettings();
    const w = this.screenToWorld(nx, ny);
    const pen = this.currentStroke;

    if (pen) {
      const last = pen.points[pen.points.length - 1];
      const rawP = this.pressure(e);
      const filtP = rawP * 0.4 + (last.p || 1) * 0.6;   // 压力低通滤波，去抖动
      const np = this.snapPoint(w, pen.tool, filtP);
      if (Math.hypot(np.x - last.x, np.y - last.y) >= MIN_DIST) {
        pen.points.push(np);
        this.lastMoveTs = Date.now();
        this.dirtyView = true;
      }
    } else if (settings.tool === 'eraser' || settings.tool === 'pixelEraser') {
      if (this.erasePath && Math.hypot(w.x - this.lastErase.x, w.y - this.lastErase.y) >= 6) {
        this.erasePath.push({ x: w.x, y: w.y });
      }
      this.lastErase = { x: w.x, y: w.y };
      if (settings.tool === 'eraser' && settings.eraserMode !== 'pixel') this.hitErase(w.x, w.y);
      this.dirtyView = true;
    } else if (settings.tool === 'lasso') {
      if (this.lassoPath) {
        const last = this.lassoPath[this.lassoPath.length - 1];
        if (Math.hypot(w.x - last.x, w.y - last.y) >= MIN_DIST) this.lassoPath.push({ x: w.x, y: w.y });
      } else if (this.selection && this.selection.moving) {
        this.selection.offset = { dx: w.x - this.moveStart.x, dy: w.y - this.moveStart.y };
        this.dirtyView = true;
      }
    } else if (settings.tool === 'text' && this.textTap) {
      if (Math.hypot(nx - this.textTap.x, ny - this.textTap.y) > 5) this.textTap.moved = true;
    } else if (settings.tool === 'shape' && this.curShape) {
      this.curShape.x2 = w.x; this.curShape.y2 = w.y;
      this.dirtyView = true;
    }
    p.x = nx; p.y = ny;
    this.requestFrame();
  }

  onPointerUp(e) {
    if (!this.pointers.has(e.pointerId)) return;
    const settings = this.cb.getSettings();
    const L = this.local(e);
    const w = this.screenToWorld(L.x, L.y);
    this.pointers.delete(e.pointerId);
    if (this.pointers.size >= 2) return;

    if (this.gesture) {
      const g = this.gesture;
      if (this.pointers.size === 0) {
        this.gesture = null;
        // 双指轻点 = 撤销
        if (Date.now() - g.startTime < 320 && g.maxMove < 24) {
          if (this.cb.onTwoFingerTap) this.cb.onTwoFingerTap();
        }
      }
      return;
    }
    if (this.panning) { this.panning = false; return; }

    if (this.currentStroke) {
      const st = this.currentStroke;
      this.currentStroke = null;
      if (st.points.length >= 2) this.cb.onStrokeDone(st, Date.now() - this.lastMoveTs);
      else this.dirtyView = true;
    } else if (settings.tool === 'eraser' || settings.tool === 'pixelEraser') {
      const pixelMode = settings.tool === 'pixelEraser' || settings.eraserMode === 'pixel';
      if (pixelMode) {
        const path = this.erasePath || [];
        this.erasePath = null;
        this.cb.onPixelEraseDone(path, settings.eraserSize || 24);
      } else if (this.eraseIds.size) {
        const ids = [...this.eraseIds];
        this.eraseIds = new Set();
        this.cb.onEraseDone(ids);
      } else this.dirtyView = true;
    } else if (settings.tool === 'lasso') {
      if (this.lassoPath) {
        const path = this.lassoPath;
        this.lassoPath = null;
        if (path.length >= 3) this.finishLasso(path);
        else this.dirtyView = true;
      } else if (this.selection && this.selection.moving) this.finishMove();
    } else if (settings.tool === 'text' && this.textTap && !this.textTap.moved) {
      const t = this.textTap;
      this.textTap = null;
      this.cb.onTextTap(w);
    } else if (settings.tool === 'shape' && this.curShape) {
      const sh = this.curShape;
      this.curShape = null;
      if (Math.hypot(sh.x2 - sh.x1, sh.y2 - sh.y1) > 4) {
        this.cb.onShapeDone({
          id: 's' + Math.random().toString(36).slice(2, 10),
          tool: 'pen', shape: sh.kind, color: settings.color, width: settings.width,
          points: [{ x: sh.x1, y: sh.y1 }, { x: sh.x2, y: sh.y2 }]
        });
      } else this.dirtyView = true;
    }
    this.textTap = null;
    this.requestFrame();
  }

  pressure(e) {
    if (e.pointerType === 'touch') return 1;
    if (e.pointerType === 'pen') return Math.max(0.15, Math.min(1, e.pressure || 0.6));
    return 1;
  }

  /* -------- 双指手势 -------- */
  beginGesture() {
    const [a, b] = [...this.pointers.values()];
    this.gesture = {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      scale: this.scale, ox: this.ox, oy: this.oy,
      startTime: Date.now(),
      startA: { x: a.x, y: a.y }, startB: { x: b.x, y: b.y },
      maxMove: 0
    };
    this.currentStroke = null; this.lassoPath = null; this.curShape = null; this.textTap = null;
    this.dirtyView = true;
  }

  updateGesture() {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return;
    const [a, b] = pts;
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const g = this.gesture;
    const move = Math.max(
      Math.hypot(a.x - g.startA.x, a.y - g.startA.y),
      Math.hypot(b.x - g.startB.x, b.y - g.startB.y)
    );
    if (move > g.maxMove) g.maxMove = move;
    if (dist > 0) {
      const ns = Math.max(0.25, Math.min(4, g.scale * (dist / g.dist)));
      this.scale = ns;
      const wmx = (g.mid.x - g.ox) / g.scale;
      const wmy = (g.mid.y - g.oy) / g.scale;
      this.ox = mid.x - wmx * ns;
      this.oy = mid.y - wmy * ns;
    }
    this.dirtyView = true;
    this.requestFrame();
  }

  onWheel(e) {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    if (e.ctrlKey) this.zoomAt(sx, sy, Math.exp(-e.deltaY * 0.002));
    else { this.ox -= e.deltaX; this.oy -= e.deltaY; this.dirtyView = true; }
    this.requestFrame();
  }

  /* -------- 橡皮擦 -------- */
  hitErase(x, y) {
    const radius = this.cb.getSettings().eraserSize || 26;
    const strokes = this.page.strokes;
    const last = this.lastErase || { x, y };
    const segs = Math.hypot(x - last.x, y - last.y) > 8 ? this.sampleLine(last.x, last.y, x, y, 8) : [{ x, y }];
    for (const st of strokes) {
      if (this.eraseIds.has(st.id)) continue;
      if (st.shape) {
        const box = this.shapeBox(st);
        for (const s of segs) {
          if (box && this.distToRect(s.x, s.y, box) <= radius + st.width) { this.eraseIds.add(st.id); break; }
        }
      } else {
        for (const s of segs) {
          if (this.strokeNear(st, s.x, s.y, radius + st.width / 2)) { this.eraseIds.add(st.id); break; }
        }
      }
    }
    this.dirtyView = true;
  }

  sampleLine(x1, y1, x2, y2, step) {
    const d = Math.hypot(x2 - x1, y2 - y1);
    const n = Math.max(1, Math.floor(d / step));
    const out = [];
    for (let i = 0; i <= n; i++) out.push({ x: x1 + (x2 - x1) * i / n, y: y1 + (y2 - y1) * i / n });
    return out;
  }

  strokeNear(st, x, y, r) {
    const pts = st.points;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (i < pts.length - 1) {
        if (this.distToSegment(x, y, p.x, p.y, pts[i + 1].x, pts[i + 1].y) <= r) return true;
      } else if (Math.hypot(x - p.x, y - p.y) <= r) return true;
    }
    return false;
  }

  distToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const l2 = dx * dx + dy * dy;
    if (!l2) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  /* -------- 套索 -------- */
  pointInBox(p, box) { return p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h; }

  finishLasso(path) {
    const ids = new Set();
    for (const st of this.page.strokes) {
      if (st.shape) {
        if (this.polyIntersectsBox(path, this.shapeBox(st))) ids.add(st.id);
      } else {
        for (const pt of st.points) if (this.pointInPoly(pt.x, pt.y, path)) { ids.add(st.id); break; }
      }
    }
    for (const t of this.page.texts) {
      const box = { x: t.x * PAGE_W, y: t.y * PAGE_H, w: t.w * PAGE_W, h: t.h * PAGE_H };
      if (this.polyIntersectsBox(path, box)) ids.add('t:' + t.id);
    }
    this.selection = ids.size ? { ids: [...ids], box: this.computeBox(ids), moving: false, offset: null } : null;
    this.dirtyView = true;
    this.requestFrame();
  }

  polyIntersectsBox(path, box) {
    for (const p of path) if (this.pointInBox(p, box)) return true;
    const corners = [[box.x, box.y], [box.x + box.w, box.y], [box.x + box.w, box.y + box.h], [box.x, box.y + box.h]];
    for (let i = 0; i < 4; i++) {
      const [x1, y1] = corners[i]; const [x2, y2] = corners[(i + 1) % 4];
      for (let j = 0; j < path.length; j++) {
        const a = path[j], b = path[(j + 1) % path.length];
        if (this.segIntersect(x1, y1, x2, y2, a.x, a.y, b.x, b.y)) return true;
      }
    }
    return false;
  }

  segIntersect(x1, y1, x2, y2, x3, y3, x4, y4) {
    const d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
    if (Math.abs(d) < 1e-9) return false;
    const t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d;
    const u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1;
  }

  pointInPoly(px, py, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
      if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  computeBox(ids) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of ids) {
      if (id.startsWith('t:')) {
        const t = this.page.texts.find(x => x.id === id.slice(2));
        if (!t) continue;
        minX = Math.min(minX, t.x * PAGE_W); minY = Math.min(minY, t.y * PAGE_H);
        maxX = Math.max(maxX, (t.x + t.w) * PAGE_W); maxY = Math.max(maxY, (t.y + t.h) * PAGE_H);
      } else {
        const st = this.page.strokes.find(x => x.id === id);
        if (!st) continue;
        for (const p of st.points) {
          minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
          maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
        }
      }
    }
    if (!isFinite(minX)) return { x: 0, y: 0, w: 1, h: 1 };
    return { x: minX - 8, y: minY - 8, w: maxX - minX + 16, h: maxY - minY + 16 };
  }

  shapeBox(st) {
    const [a, b] = st.points;
    if (!a || !b) return null;
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
  }

  distToRect(px, py, box) {
    const cx = Math.max(box.x, Math.min(px, box.x + box.w));
    const cy = Math.max(box.y, Math.min(py, box.y + box.h));
    return Math.hypot(px - cx, py - cy);
  }

  finishMove() {
    const sel = this.selection;
    if (!sel || !sel.moving || !sel.offset) { if (sel) sel.moving = false; return; }
    const dx = sel.offset.dx, dy = sel.offset.dy;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) { sel.moving = false; this.dirtyView = true; return; }
    for (const id of sel.ids) {
      if (id.startsWith('t:')) {
        const t = this.page.texts.find(x => x.id === id.slice(2));
        if (!t) continue;
        t.x += dx / PAGE_W; t.y += dy / PAGE_H;
      } else {
        const st = this.page.strokes.find(x => x.id === id);
        if (!st) continue;
        for (const p of st.points) { p.x += dx; p.y += dy; }
      }
    }
    sel.moving = false; sel.offset = null;
    sel.box = this.computeBox(sel.ids);
    this.cb.onPageContentChanged();
    this.dirtyRaster = true; this.dirtyView = true;
    this.requestFrame();
  }

  /* -------- 光栅渲染 -------- */
  renderPageRaster() {
    if (!this.page) { this.dirtyRaster = false; return; }
    const paper = this.cb.getPaper();
    const rs = RENDER_SCALE;
    this.raster.width = PAGE_W * rs;
    this.raster.height = PAGE_H * rs;
    const c = this.rctx;
    c.setTransform(rs, 0, 0, rs, 0, 0);
    const info = drawPaper(c, paper.style, paper.color, PAGE_W, PAGE_H);
    for (const st of this.page.strokes) drawStroke(c, st, info, this.cb.getFont());
    for (const t of this.page.texts) drawTextItem(c, t, this.cb.getFont(), PAGE_W, PAGE_H);
    this.dirtyRaster = false;
  }

  requestFrame() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.renderView(); });
  }

  renderView() {
    if (!this.page) {
      const c = this.ctx;
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      c.clearRect(0, 0, this.cw, this.ch);
      this.dirtyView = false;
      return;
    }
    if (this.dirtyRaster) this.renderPageRaster();
    const c = this.ctx;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.cw, this.ch);
    const s = this.scale;
    c.setTransform(this.dpr * s, 0, 0, this.dpr * s, this.dpr * this.ox, this.dpr * this.oy);
    c.fillStyle = 'rgba(0,0,0,.13)';
    c.fillRect(6, 8, PAGE_W, PAGE_H);
    c.drawImage(this.raster, 0, 0, PAGE_W, PAGE_H);
    this.drawLiveInk(c);
    this.drawSelection(c);
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.dirtyView = false;
  }

  drawLiveInk(c) {
    const info = paperInfo(this.cb.getPaper().color);
    if (this.currentStroke) drawStroke(c, this.currentStroke, info, this.cb.getFont());
    if (this.curShape) { c.save(); c.globalAlpha = 0.65; drawShape(c, this.curShape); c.restore(); }
    if (this.lassoPath) {
      c.save();
      c.fillStyle = 'rgba(37,99,235,.10)';
      c.strokeStyle = 'rgba(37,99,235,.75)';
      c.lineWidth = 1.6;
      c.setLineDash([6, 5]);
      c.beginPath();
      c.moveTo(this.lassoPath[0].x, this.lassoPath[0].y);
      for (let i = 1; i < this.lassoPath.length; i++) c.lineTo(this.lassoPath[i].x, this.lassoPath[i].y);
      c.closePath();
      c.fill(); c.stroke();
      c.restore();
    }
    if (this.eraseIds.size) {
      c.save();
      c.fillStyle = 'rgba(220,38,38,.15)';
      for (const id of this.eraseIds) {
        const st = this.page.strokes.find(x => x.id === id);
        if (!st) continue;
        const box = st.shape ? this.shapeBox(st) : this.strokeBox(st);
        if (box) c.fillRect(box.x, box.y, box.w, box.h);
      }
      c.restore();
    }
  }

  strokeBox(st) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of st.points) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
    if (!isFinite(minX)) return null;
    return { x: minX - 4, y: minY - 4, w: maxX - minX + 8, h: maxY - minY + 8 };
  }

  drawSelection(c) {
    const sel = this.selection;
    if (!sel || !sel.ids.length) return;
    const box = sel.box;
    let bx = box.x, by = box.y, bw = box.w, bh = box.h;
    if (sel.moving && sel.offset) { bx += sel.offset.dx; by += sel.offset.dy; }
    c.save();
    c.fillStyle = 'rgba(37,99,235,.10)';
    c.fillRect(bx, by, bw, bh);
    c.strokeStyle = 'rgba(37,99,235,.8)';
    c.lineWidth = 1.5;
    c.setLineDash([5, 4]);
    c.strokeRect(bx, by, bw, bh);
    c.setLineDash([]);
    c.fillStyle = '#2563eb';
    for (const [hx, hy] of [[bx, by], [bx + bw, by], [bx, by + bh], [bx + bw, by + bh]]) {
      c.beginPath(); c.arc(hx, hy, 5, 0, 7); c.fill();
    }
    c.restore();
  }

  /* -------- 对外 -------- */
  setPage(page) {
    this.page = page;
    this.selection = null; this.currentStroke = null; this.lassoPath = null; this.curShape = null;
    this.eraseIds = new Set(); this.textTap = null; this.erasePath = null;
    this.dirtyRaster = true; this.dirtyView = true;
    this.requestFrame();
  }

  invalidateRaster() { this.dirtyRaster = true; this.dirtyView = true; this.requestFrame(); }

  refreshRect() {
    this._rect = this.canvas.getBoundingClientRect();
    this.dirtyView = true;
    this.requestFrame();
  }

  getSelectionIds() { return this.selection ? this.selection.ids : []; }
  getSelectedBox() { return this.selection && this.selection.ids.length ? this.selection.box : null; }
  clearSelection() { this.selection = null; this.dirtyView = true; this.requestFrame(); }
}






















