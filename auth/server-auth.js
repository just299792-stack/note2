/* =========================================================
   笔记账号系统 —— 可复用后端认证模块（零依赖）
   任何 Node 静态服务器都可挂载：
     const { createAuth } = require('./auth/server-auth');
     const auth = createAuth({ dataDir: __dirname + '/data' });
     // 在请求入口： if (url.pathname.startsWith('/api/')) { await auth.handle(req,res,url); return; }
   提供：注册 / 登录 / 登出 / 会话 / 按用户分库存储
   ========================================================= */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SESSION_TTL = 30 * 24 * 3600 * 1000;   // 会话 30 天
const MAX_BODY = 50 * 1024 * 1024;            // 请求体上限 50MB
const ID_RE = /^[a-f0-9]{24}$/;
const USERNAME_RE = /^[\w\u4e00-\u9fa5]{2,20}$/;

function createAuth(options = {}) {
  const dataDir = options.dataDir || path.join(process.cwd(), 'data');
  const usersDir = path.join(dataDir, 'users');
  const usersFile = path.join(dataDir, 'users.json');
  const sessionsFile = path.join(dataDir, 'sessions.json');
  const maxBody = options.maxBody || MAX_BODY;
  const sessionTtl = options.sessionTtl || SESSION_TTL;

  /* ---------- 数据层 ---------- */
  function ensureDirs() {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(usersDir, { recursive: true });
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
  function hashPassword(password, salt) { return crypto.scryptSync(password, salt, 64).toString('hex'); }
  function safeEqual(a, b) {
    const ba = Buffer.from(a), bb = Buffer.from(b);
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  }
  function userLibraryPath(userId) { return path.join(usersDir, userId, 'library.json'); }

  /* ---------- 会话 ---------- */
  function createSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const sessions = readJson(sessionsFile, {});
    sessions[tokenHash] = { userId, createdAt: Date.now(), expiresAt: Date.now() + sessionTtl };
    writeJsonAtomic(sessionsFile, sessions);
    return token;
  }
  function deleteSession(token) {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const sessions = readJson(sessionsFile, {});
    if (sessions[tokenHash]) { delete sessions[tokenHash]; writeJsonAtomic(sessionsFile, sessions); }
  }
  function authenticate(req) {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) return null;
    const token = h.slice(7).trim();
    if (!token) return null;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const sessions = readJson(sessionsFile, {});
    const s = sessions[tokenHash];
    if (!s || s.expiresAt < Date.now()) return null;
    return { userId: s.userId, token };
  }

  /* ---------- 限流 ---------- */
  const attempts = new Map();
  function rateLimited(ip) {
    const now = Date.now();
    const a = attempts.get(ip) || { count: 0, windowStart: now };
    if (now - a.windowStart > 10 * 60 * 1000) { a.count = 0; a.windowStart = now; }
    a.count++;
    attempts.set(ip, a);
    return a.count > 20;
  }

  /* ---------- 响应 / 请求体 ---------- */
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
        if (size > maxBody) { reject(new Error('body too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  /**
   * 处理认证相关 API 请求。
   * 返回 true 表示已处理；false 表示不是本模块的路由。
   */
  async function handle(req, res, url) {
    const ip = req.socket.remoteAddress || '';
    ensureDirs();
    const method = req.method;
    const p = url.pathname;

    if (p === '/api/health') { sendJson(res, 200, { ok: true, auth: true }); return true; }

    if (p === '/api/register' && method === 'POST') {
      if (rateLimited(ip)) return sendJson(res, 429, { error: '尝试过于频繁，请稍后再试' }), true;
      let data;
      try { data = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: '请求格式错误' }), true; }
      const username = String(data.username || '').trim();
      const password = String(data.password || '');
      if (!USERNAME_RE.test(username)) return sendJson(res, 400, { error: '用户名需为 2-20 位字母/数字/下划线/中文' }), true;
      if (password.length < 6 || password.length > 128) return sendJson(res, 400, { error: '密码长度需为 6-128 位' }), true;
      const users = readJson(usersFile, {});
      const dup = Object.values(users).some(u => u.username.toLowerCase() === username.toLowerCase());
      if (dup) return sendJson(res, 409, { error: '该用户名已被注册' }), true;
      const id = newId();
      const salt = crypto.randomBytes(16).toString('hex');
      users[id] = { id, username, salt, hash: hashPassword(password, salt), createdAt: Date.now() };
      writeJsonAtomic(usersFile, users);
      fs.mkdirSync(path.join(usersDir, id), { recursive: true });
      const token = createSession(id);
      return sendJson(res, 200, { token, user: { id, username } }), true;
    }

    if (p === '/api/login' && method === 'POST') {
      if (rateLimited(ip)) return sendJson(res, 429, { error: '尝试过于频繁，请稍后再试' }), true;
      let data;
      try { data = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: '请求格式错误' }), true; }
      const username = String(data.username || '').trim();
      const password = String(data.password || '');
      const users = readJson(usersFile, {});
      const user = Object.values(users).find(u => u.username.toLowerCase() === username.toLowerCase());
      if (!user || !safeEqual(hashPassword(password, user.salt), user.hash)) {
        return sendJson(res, 401, { error: '用户名或密码错误' }), true;
      }
      const token = createSession(user.id);
      return sendJson(res, 200, { token, user: { id: user.id, username: user.username } }), true;
    }

    const auth = authenticate(req);
    if (!auth) return sendJson(res, 401, { error: '未登录或登录已过期' }), true;

    if (p === '/api/logout' && method === 'POST') {
      deleteSession(auth.token);
      return sendJson(res, 200, { ok: true }), true;
    }
    if (p === '/api/me') {
      const users = readJson(usersFile, {});
      const u = users[auth.userId];
      if (!u) return sendJson(res, 401, { error: '用户不存在' }), true;
      return sendJson(res, 200, { user: { id: u.id, username: u.username } }), true;
    }
    if (p === '/api/library' && method === 'GET') {
      let lib = readJson(userLibraryPath(auth.userId), null);
      if (lib === null) {
        // 主文件缺失（如写入中断）时回退到上一版备份，绝不让客户端拿到空库
        const bakPath = userLibraryPath(auth.userId) + '.bak';
        if (fs.existsSync(bakPath)) lib = readJson(bakPath, null);
      }
      return sendJson(res, 200, { library: lib }), true;
    }
    if (p === '/api/library' && method === 'PUT') {
      let data;
      try { data = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: '数据格式错误' }), true; }
      if (!data || typeof data !== 'object') return sendJson(res, 400, { error: '数据格式错误' }), true;
      // 原子写入 + 保留上一版为 .bak（防升级/写入异常丢数据）
      const target = userLibraryPath(auth.userId);
      const tmp = target + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      if (fs.existsSync(target)) fs.renameSync(target, target + '.bak');
      fs.renameSync(tmp, target);
      return sendJson(res, 200, { ok: true }), true;
    }

    return false;
  }

  return { handle, authenticate, usersFile, sessionsFile };
}

module.exports = { createAuth };


