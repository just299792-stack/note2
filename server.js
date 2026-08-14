/* =========================================================
   手记 —— 静态服务器 + 认证 API（HTTP 8080 / HTTPS 8443）
   认证功能来自 auth/server-auth 模块。
   HTTPS 用于 iPad 离线 PWA：https://<局域网IP>:8443
   ========================================================= */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { createAuth } = require('./auth/server-auth');

const ROOT = __dirname;
const HTTP_PORT = 8080;
const HTTPS_PORT = 8443;
const auth = createAuth({ dataDir: path.join(ROOT, 'data') });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.md': 'text/plain; charset=utf-8', '.note': 'application/json',
  '.notebook': 'application/json', '.cer': 'application/x-x509-ca-cert'
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  if (p === '/cert.cer') p = '/certs/server.cer';
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

const handler = async (req, res) => {
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
};

http.createServer(handler).listen(HTTP_PORT, () => console.log(`手记 HTTP  运行于 http://localhost:${HTTP_PORT}`));

// 若存在证书则同时启用 HTTPS（供 iPad 离线 PWA）
try {
  const key = fs.readFileSync(path.join(ROOT, 'certs', 'server.key'));
  const cert = fs.readFileSync(path.join(ROOT, 'certs', 'server.crt'));
  https.createServer({ key, cert }, handler).listen(HTTPS_PORT, () => {
    console.log(`手记 HTTPS 运行于 https://localhost:${HTTPS_PORT}（iPad 离线用，证书可下载 /cert.cer）`);
  });
} catch (e) {
  console.log('未找到 certs/server.key 与 server.crt，HTTPS 未启用（仅离线 PWA 需要）');
}
