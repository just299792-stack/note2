/* =========================================================
   手记 —— 静态服务器 + 用户认证 API（零依赖）
   - 注册 / 登录 / 登出 / 会话
   - 按用户分库存储笔记 (data/users/<id>/library.json)
   - 密码 scrypt 加盐哈希，会话令牌 SHA-256 存储
   ========================================================= */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const USERS_DIR = path.join(DATA_DIR, 'users');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const SESSION_TTL = 30 * 24 * 3600 * 1000;   // 30 天
const MAX_BODY = 50 * 1024 * 1024;            // 请求体上限 50MB

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.md': 'text/plain; charset=utf-8', '.note': 'application/json',
  '.notebook': 'application/json'
};

/* ---------------- 数据层（同步 + 原子写，个人应用规模足够） ---------------- */
function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(USERS_DIR, { recursive: true });
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
function newId() { return crypto.randomBytes(12).toString('hex'); }
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function safeEqual(a, b) {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
function userLibraryPath(userId) { return path.join(USERS_DIR, userId, 'library.json'); }
const ID_RE = /^[a-f0-9]{24}$/;
const USERNAME_RE = /^[\w\u4e00-\u9fa5]{2,20}$/;

/* ---------------- 认证 ---------------- */
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const sessions = readJson(SESSIONS_FILE, {});
  sessions[tokenHash] = { userId, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL };
  writeJsonAtomic(SESSIONS_FILE, sessions);
  return token;
}
function deleteSession(token) {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const sessions = readJson(SESSIONS_FILE, {});
  if (sessions[tokenHash]) { delete sessions[tokenHash]; writeJsonAtomic(SESSIONS_FILE, sessions); }
}
function authenticate(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return null;
  const token = h.slice(7).trim();
  if (!token) return null;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const sessions = readJson(SESSIONS_FILE, {});
  const s = sessions[tokenHash];
  if (!s || s.expiresAt < Date.now()) return null;
  return { userId: s.userId, token };
}

/* ---------------- 限流（每 IP 简单计数） ---------------- */
const attempts = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const a = attempts.get(ip) || { count: 0, windowStart: now };
  if (now - a.windowStart > 10 * 60 * 1000) { a.count = 0; a.windowStart = now; }
  a.count++;
  attempts.set(ip, a);
  return a.count > 20;
}

/* ---------------- API 处理 ---------------- */
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  const ip = req.socket.remoteAddress || '';
  ensureDirs();

  // 健康检查
  if (url.pathname === '/api/health') { return sendJson(res, 200, { ok: true, auth: true }); }

  const method = req.method;

  // 注册
  if (url.pathname === '/api/register' && method === 'POST') {
    if (rateLimited(ip)) return sendJson(res, 429, { error: '尝试过于频繁，请稍后再试' });
    let data;
    try { data = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: '请求格式错误' }); }
    const username = String(data.username || '').trim();
    const password = String(data.password || '');
    if (!USERNAME_RE.test(username)) return sendJson(res, 400, { error: '用户名需为 2-20 位字母/数字/下划线/中文' });
    if (password.length < 6 || password.length > 128) return sendJson(res, 400, { error: '密码长度需为 6-128 位' });
    const users = readJson(USERS_FILE, {});
    const dup = Object.values(users).some(u => u.username.toLowerCase() === username.toLowerCase());
    if (dup) return sendJson(res, 409, { error: '该用户名已被注册' });
    const id = newId();
    const salt = crypto.randomBytes(16).toString('hex');
    users[id] = { id, username, salt, hash: hashPassword(password, salt), createdAt: Date.now() };
    writeJsonAtomic(USERS_FILE, users);
    fs.mkdirSync(path.join(USERS_DIR, id), { recursive: true });
    const token = createSession(id);
    return sendJson(res, 200, { token, user: { id, username } });
  }

  // 登录
  if (url.pathname === '/api/login' && method === 'POST') {
    if (rateLimited(ip)) return sendJson(res, 429, { error: '尝试过于频繁，请稍后再试' });
    let data;
    try { data = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: '请求格式错误' }); }
    const username = String(data.username || '').trim();
    const password = String(data.password || '');
    const users = readJson(USERS_FILE, {});
    const user = Object.values(users).find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!user || !safeEqual(hashPassword(password, user.salt), user.hash)) {
      return sendJson(res, 401, { error: '用户名或密码错误' });
    }
    const token = createSession(user.id);
    return sendJson(res, 200, { token, user: { id: user.id, username: user.username } });
  }

  // 以下接口需要认证
  const auth = authenticate(req);
  if (!auth) return sendJson(res, 401, { error: '未登录或登录已过期' });

  if (url.pathname === '/api/logout' && method === 'POST') {
    deleteSession(auth.token);
    return sendJson(res, 200, { ok: true });
  }
  if (url.pathname === '/api/me') {
    const users = readJson(USERS_FILE, {});
    const u = users[auth.userId];
    if (!u) return sendJson(res, 401, { error: '用户不存在' });
    return sendJson(res, 200, { user: { id: u.id, username: u.username } });
  }
  if (url.pathname === '/api/library' && method === 'GET') {
    const lib = readJson(userLibraryPath(auth.userId), null);
    return sendJson(res, 200, { library: lib });
  }
  if (url.pathname === '/api/library' && method === 'PUT') {
    let data;
    try { data = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: '数据格式错误' }); }
    if (!data || typeof data !== 'object') return sendJson(res, 400, { error: '数据格式错误' });
    writeJsonAtomic(userLibraryPath(auth.userId), data);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: '接口不存在' });
}

/* ---------------- 静态文件 ---------------- */
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, path.normalize(p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': p.endsWith('.html') ? 'no-cache' : 'no-cache'
    });
    res.end(data);
  });
}

/* ---------------- 入口 ---------------- */
http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); res.end(); return; }
  if (url.pathname.startsWith('/api/')) {
    try { await handleApi(req, res, url); }
    catch (e) { console.error('API error:', e); if (!res.writableEnded) sendJson(res, 500, { error: '服务器内部错误' }); }
    return;
  }
  serveStatic(req, res, url);
}).listen(8080, () => console.log('手记运行于 http://localhost:8080（含用户系统）'));
