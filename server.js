/* =========================================================
   手记 —— 静态服务器（认证功能来自 auth/server-auth 模块）
   任何项目接入：把本项目当作模板，或复制 auth/ 并参考此文件。
   ========================================================= */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createAuth } = require('./auth/server-auth');

const ROOT = __dirname;
const auth = createAuth({ dataDir: path.join(ROOT, 'data') });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.md': 'text/plain; charset=utf-8', '.note': 'application/json',
  '.notebook': 'application/json'
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, path.normalize(p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); res.end(); return; }
  if (url.pathname.startsWith('/api/')) {
    try {
      const handled = await auth.handle(req, res, url);
      if (!handled) sendJson(res, 404, { error: '接口不存在' });
    } catch (e) {
      console.error('API error:', e);
      if (!res.writableEnded) sendJson(res, 500, { error: '服务器内部错误' });
    }
    return;
  }
  serveStatic(req, res, url);
}).listen(8080, () => console.log('手记运行于 http://localhost:8080（含账号系统）'));
