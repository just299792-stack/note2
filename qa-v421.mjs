import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const prof = mkdtempSync(path.join(os.tmpdir(), 'edge-cdp-'));
const port = 9332;
const proc = spawn(EDGE, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-extensions','--window-size=1200,900',`--user-data-dir=${prof}`,`--remote-debugging-port=${port}`,'about:blank'], { stdio: 'ignore', windowsHide: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url, t = 50) { for (let i = 0; i < t; i++) { try { const r = await fetch(url); if (r.ok) return await r.json(); } catch {} await sleep(400); } throw new Error('no cdp'); }
let target = null;
for (let i = 0; i < 50 && !target; i++) { const ts = await getJson(`http://127.0.0.1:${port}/json`); target = ts.find((t) => t.type === 'page'); if (!target) await sleep(300); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
let msgId = 0; const pending = new Map(); const events = [];
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method) events.push(m); };
const send = (method, params = {}) => new Promise((resolve) => { const id = ++msgId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
await new Promise((r) => { ws.onopen = r; });
await send('Runtime.enable');
const evaluate = async (expr, aw = false) => { const m = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: aw }); if (m.result.exceptionDetails) return { error: m.result.exceptionDetails.exception?.description || m.result.exceptionDetails.text }; return m.result.result.value; };
await send('Page.navigate', { url: 'http://192.168.1.12:8080/' });
await sleep(5000);
const out = JSON.parse(await evaluate(`(async () => {
  const res = {};
  res.defaultToolbar = window.__note2.state.lib.settings.toolbar;
  res.pixelBtn = !!document.querySelector('[data-tool="pixelEraser"]');
  const e = window.__note2.engine; const cv = document.querySelector('#viewCanvas'); const r = cv.getBoundingClientRect();
  const w = e.worldToScreen(0.2*816, 0.2*1056); const x0 = r.left + w.x, y0 = r.top + w.y;
  const pe = (t,i,px,py,id) => cv.dispatchEvent(new PointerEvent(t, { pointerId: id, pointerType: 'pen', clientX: px, clientY: py, pressure: 0.8, button: 0, buttons: 1, bubbles: true, cancelable: true }));
  // 1) 直线 + 停顿 -> line
  const pts = []; for (let i=0;i<=24;i++) pts.push([x0 + i*5, y0]);
  for (let i=0;i<pts.length;i++) pe(i===0?'pointerdown':'pointermove', i, pts[i][0], pts[i][1], 401);
  await new Promise(r => setTimeout(r, 600));
  pe('pointerup', 0, pts[24][0], pts[24][1], 401);
  await new Promise(r => setTimeout(r, 300));
  const st1 = e.page.strokes[e.page.strokes.length-1];
  res.line = st1.shape === 'line';
  // 2) 圆 + 停顿 -> ellipse/polygon
  const cx = x0 + 300, cy = y0 + 200;
  const circ = []; for (let i=0;i<=24;i++) { const a = i/24*Math.PI*2; circ.push([cx + Math.cos(a)*90, cy + Math.sin(a)*90]); }
  for (let i=0;i<circ.length;i++) pe(i===0?'pointerdown':'pointermove', i, circ[i][0], circ[i][1], 402);
  await new Promise(r => setTimeout(r, 600));
  pe('pointerup', 0, circ[24][0], circ[24][1], 402);
  await new Promise(r => setTimeout(r, 300));
  const st2 = e.page.strokes[e.page.strokes.length-1];
  res.circle = st2.shape === 'ellipse' || st2.shape === 'polygon';
  // 3) 快速画（无停顿）-> 保持手写
  const pts3 = []; for (let i=0;i<=15;i++) pts3.push([x0 + i*4, y0 + 300]);
  for (let i=0;i<pts3.length;i++) pe(i===0?'pointerdown':'pointermove', i, pts3[i][0], pts3[i][1], 403);
  pe('pointerup', 0, pts3[15][0], pts3[15][1], 403);
  await new Promise(r => setTimeout(r, 200));
  const st3 = e.page.strokes[e.page.strokes.length-1];
  res.freehand = !st3.shape && st3.tool === 'pen';
  // 4) 像素橡皮按钮可擦
  document.querySelector('[data-tool="pixelEraser"]').click();
  const w2 = e.worldToScreen(0.45*816, 0.2*1056); const ex = r.left + w2.x, ey = r.top + w2.y;
  const before = e.page.strokes.length;
  const ep = (t,i,px,py,id) => cv.dispatchEvent(new PointerEvent(t, { pointerId: id, pointerType: 'pen', clientX: px, clientY: py, pressure: 1, button: 0, buttons: 1, bubbles: true, cancelable: true }));
  ep('pointerdown', 0, ex, ey-40, 404);
  for (let i=1;i<=8;i++) ep('pointermove', i, ex, ey-40+i*10, 404);
  ep('pointerup', 0, ex, ey-40+80, 404);
  await new Promise(r => setTimeout(r, 300));
  res.pixelWorked = e.page.strokes.length !== before;
  document.querySelector('[data-tool="pen"]').click();
  return JSON.stringify(res);
})()`, true));
const version = await evaluate(`fetch('/js/app.js').then(r=>r.text()).then(t => t.includes("APP_VERSION = '4.21'"))`, true);
const svgHasNote = await evaluate(`fetch('/icons/icon.svg').then(r=>r.text()).then(t => t.includes('note') && t.includes('#000000'))`, true);
const errs = events.filter((ev) => ev.method === 'Runtime.exceptionThrown').map((ev) => ev.params.exceptionDetails.exception?.description || ev.params.exceptionDetails.text);
console.log('V4.21:', JSON.stringify(out));
console.log('VERSION:', version, '| SVG-note:', svgHasNote);
console.log('ERRORS:', errs.length ? errs.join(' | ') : '(none)');
proc.kill();
try { rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
process.exit(0);
