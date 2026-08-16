/* =========================================================
   笔记 —— 静态服务器 + 认证 API（HTTP 8080 / HTTPS 8443）
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

/* ---------- AI 问答代理（DeepSeek） ---------- */
function loadAiConfig() {
  try {
    return Object.assign(
      { apiKey: '', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com', mock: false },
      JSON.parse(fs.readFileSync(path.join(ROOT, 'ai-config.json'), 'utf8'))
    );
  } catch (_) { return { apiKey: '', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com', mock: false }; }
}
const aiConfig = loadAiConfig();
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > (max || 4 * 1024 * 1024)) { reject(new Error('body too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function sanitizeAiMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.slice(0, 20).map(m => ({
    role: (m.role === 'system' || m.role === 'assistant') ? m.role : 'user',
    content: String(m.content || '').slice(0, 6000)
  })).filter(m => m.content);
}
async function handleAi(req, res) {
  if (req.method === 'GET') { sendJson(res, 200, { name: aiConfig.name || 'DeepSeek', model: aiConfig.model || 'deepseek-chat' }); return; }
  if (req.method !== 'POST') { sendJson(res, 405, { error: '仅支持 POST' }); return; }
  let data;
  try { data = JSON.parse(await readBody(req)); } catch (_) { sendJson(res, 400, { error: '数据格式错误' }); return; }
  const messages = sanitizeAiMessages(data.messages);
  if (!messages.length) { sendJson(res, 400, { error: '缺少消息' }); return; }
  if (aiConfig.mock) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' });
    const last = messages[messages.length - 1].content.slice(0, 40);
    const text = '（测试模式）你好，我是 AI 助手！我收到了你的问题：' + last + '…… 配置好 DeepSeek API Key 后即可获得真实回答。';
    let i = 0;
    const timer = setInterval(() => {
      if (i >= text.length) { clearInterval(timer); res.write('data: [DONE]\n\n'); res.end(); return; }
      res.write('data: ' + JSON.stringify({ delta: text[i] }) + '\n\n');
      i++;
    }, 12);
    return;
  }
  if (!aiConfig.apiKey) { sendJson(res, 503, { error: 'AI 未配置：请在电脑端 ai-config.json 中填写 DeepSeek API Key 后重启服务器' }); return; }
  const model = String(data.model || aiConfig.model || 'deepseek-chat').slice(0, 80);
  const body = JSON.stringify({ model, messages, stream: true, temperature: 0.7 });
  const upstream = new URL(aiConfig.baseUrl + '/chat/completions');
  const upReq = https.request(upstream, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + aiConfig.apiKey,
      'Content-Length': Buffer.byteLength(body)
    },
    timeout: 60000
  }, (up) => {
    if (up.statusCode !== 200) {
      let err = '';
      up.on('data', (c) => { err += c; if (err.length > 2000) up.destroy(); });
      up.on('end', () => { if (!res.headersSent && !res.writableEnded) sendJson(res, 502, { error: 'AI 服务返回异常', detail: String(err).slice(0, 500) }); });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' });
    up.pipe(res);
  });
  upReq.on('error', () => { if (!res.writableEnded) sendJson(res, 502, { error: 'AI 服务连接失败（请检查电脑网络）' }); });
  upReq.on('timeout', () => { upReq.destroy(); if (!res.headersSent && !res.writableEnded) sendJson(res, 504, { error: 'AI 服务超时' }); });
  upReq.write(body);
  upReq.end();
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  if (p === '/cert.cer') p = '/certs/ca.cer';
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
  if (url.pathname.startsWith('/api/ai')) { await handleAi(req, res); return; }
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

http.createServer(handler).listen(HTTP_PORT, () => console.log(`笔记 HTTP  运行于 http://localhost:${HTTP_PORT}`));

// 若存在证书则同时启用 HTTPS（供 iPad 离线 PWA）
try {
  const key = fs.readFileSync(path.join(ROOT, 'certs', 'server.key'));
  const cert = fs.readFileSync(path.join(ROOT, 'certs', 'server.crt'));
  https.createServer({ key, cert }, handler).listen(HTTPS_PORT, () => {
    console.log(`笔记 HTTPS 运行于 https://localhost:${HTTPS_PORT}（iPad 离线用，证书可下载 /cert.cer）`);
  });
} catch (e) {
  console.log('未找到 certs/server.key 与 server.crt，HTTPS 未启用（仅离线 PWA 需要）');
}


