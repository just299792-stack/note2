/* =========================================================
   手记账号系统 —— 可复用前端组件（零依赖，单文件）
   任何网页引入即可：
     <script src="auth/auth-client.js"></script>
     <script>
       Note2Auth.init({
         apiBase: '',                       // 后端地址前缀（默认同源）
         storageKey: 'note2-auth',          // 本地保存的键名
         onAuthChange: (user) => { ... }    // 登录/登出时回调
       });
     </script>
   组件会：自绘「登录」按钮与弹窗、封装注册/登录/登出/会话、
   自动校验并持久化令牌；后端不可用时自动隐藏。
   ========================================================= */
(function (global) {
  'use strict';

  const DEFAULTS = {
    apiBase: '',
    storageKey: 'note2-auth',
    buttonPosition: 'top-right',
    onAuthChange: null
  };

  let cfg = {};
  let token = null;
  let user = null;
  let available = false;
  const listeners = new Set();

  /* ---------- 样式 ---------- */
  const STYLE = [
    '.note2auth-btn{position:fixed;top:14px;right:14px;z-index:99990;display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border:1px solid rgba(127,127,127,.3);border-radius:999px;background:rgba(255,255,255,.85);backdrop-filter:blur(8px);box-shadow:0 2px 12px rgba(0,0,0,.12);font:600 13px -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#1f2937;cursor:pointer}',
    '.note2auth-btn:hover{background:#fff}',
    '.note2auth-mask{position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:100000;display:flex;align-items:center;justify-content:center}',
    '.note2auth-box{width:min(360px,92vw);background:#fff;border-radius:16px;padding:20px;box-shadow:0 20px 60px rgba(0,0,0,.3);font:14px -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#1f2937}',
    '.note2auth-tabs{display:flex;gap:4px;background:#f3f4f6;padding:4px;border-radius:10px;margin-bottom:14px}',
    '.note2auth-tab{flex:1;padding:8px 0;border:0;border-radius:8px;background:transparent;font:600 14px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:#6b7280;cursor:pointer}',
    '.note2auth-tab.active{background:#fff;color:#2563eb;box-shadow:0 1px 4px rgba(0,0,0,.1)}',
    '.note2auth-field{width:100%;box-sizing:border-box;margin-bottom:10px;padding:11px 12px;border:1px solid #d1d5db;border-radius:10px;font:15px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;outline:none}',
    '.note2auth-field:focus{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.15)}',
    '.note2auth-err{display:none;font-size:13px;color:#dc2626;background:rgba(220,38,38,.08);border:1px solid rgba(220,38,38,.25);padding:8px 12px;border-radius:8px;margin-bottom:10px}',
    '.note2auth-err.show{display:block}',
    '.note2auth-submit{width:100%;padding:11px 0;border:0;border-radius:10px;background:#2563eb;color:#fff;font:600 15px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;cursor:pointer}',
    '.note2auth-submit:hover{filter:brightness(1.08)}',
    '.note2auth-tip{font-size:12px;color:#9ca3af;line-height:1.6;margin:10px 0 0}',
    '.note2auth-menu{position:fixed;top:54px;right:14px;z-index:99995;min-width:200px;background:#fff;border:1px solid rgba(127,127,127,.25);border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.2);padding:6px;font:14px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:#1f2937}',
    '.note2auth-menu .n2a-uname{padding:8px 12px;font-weight:600;border-bottom:1px solid #f3f4f6;margin-bottom:4px}',
    '.note2auth-menu button{display:block;width:100%;text-align:left;padding:9px 12px;border:0;border-radius:8px;background:transparent;font:14px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:#1f2937;cursor:pointer}',
    '.note2auth-menu button:hover{background:#eff6ff}'
  ].join('\n');

  const HTML = [
    '<div class="note2auth-btn" id="n2aBtn" style="display:none"><span id="n2aBtnText">登录</span></div>',
    '<div class="note2auth-menu" id="n2aMenu" style="display:none">',
    '  <div class="n2a-uname" id="n2aUname"></div>',
    '  <button id="n2aLogout">退出登录</button>',
    '</div>',
    '<div class="note2auth-mask" id="n2aMask" style="display:none">',
    '  <div class="note2auth-box">',
    '    <div class="note2auth-tabs"><button class="note2auth-tab active" data-tab="login">登录</button><button class="note2auth-tab" data-tab="register">注册</button></div>',
    '    <div class="note2auth-err" id="n2aErr"></div>',
    '    <input class="note2auth-field" id="n2aUser" placeholder="用户名（2-20 位）" autocomplete="username">',
    '    <input class="note2auth-field" id="n2aPass" type="password" placeholder="密码（至少 6 位）" autocomplete="current-password">',
    '    <button class="note2auth-submit" id="n2aSubmit">登录</button>',
    '    <p class="note2auth-tip">登录后数据按账号分别保存，可在多设备间同步。</p>',
    '  </div>',
    '</div>'
  ].join('\n');

  /* ---------- 工具 ---------- */
  function api(path, opts) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, (opts && opts.headers) || {});
    if (token) headers.Authorization = 'Bearer ' + token;
    return fetch(cfg.apiBase + path, Object.assign({}, opts, { headers }))
      .then(async (res) => {
        let data = null;
        try { data = await res.json(); } catch (_) {}
        if (res.status === 401 && path !== '/api/login' && path !== '/api/register') { setAuth(null, null); }
        return Object.assign({ ok: res.ok, status: res.status }, data || {});
      })
      .catch(() => ({ ok: false, status: 0, networkError: true }));
  }
  function loadStored() { try { const raw = localStorage.getItem(cfg.storageKey); return raw ? JSON.parse(raw) : null; } catch (_) { return null; } }
  function persist() {
    try {
      if (token && user) localStorage.setItem(cfg.storageKey, JSON.stringify({ token, user }));
      else localStorage.removeItem(cfg.storageKey);
    } catch (_) {}
  }
  function emit() { if (cfg.onAuthChange) cfg.onAuthChange(user); listeners.forEach((fn) => fn(user)); }
  function setAuth(u, t) { token = t || null; user = u || null; persist(); emit(); render(); }

  /* ---------- 界面 ---------- */
  let el = {};
  function q(id) { return document.getElementById(id); }
  function render() {
    if (!el.btn) return;
    if (!available) { el.btn.style.display = 'none'; el.menu.style.display = 'none'; return; }
    el.btn.style.display = 'inline-flex';
    el.btnText.textContent = user ? user.username : '登录';
  }
  function openModal(tab) {
    el.err.classList.remove('show');
    el.tabLogin.classList.toggle('active', tab === 'login');
    el.tabReg.classList.toggle('active', tab === 'register');
    el.submit.textContent = tab === 'login' ? '登录' : '注册并登录';
    el.user.value = ''; el.pass.value = '';
    el.mask.style.display = 'flex';
    setTimeout(() => el.user.focus(), 50);
  }
  function closeModal() { el.mask.style.display = 'none'; }
  async function submit() {
    const username = el.user.value.trim();
    const password = el.pass.value;
    const tab = el.tabReg.classList.contains('active') ? 'register' : 'login';
    el.err.classList.remove('show');
    if (!username) { el.err.textContent = '请输入用户名'; el.err.classList.add('show'); return; }
    if (password.length < 6) { el.err.textContent = '密码至少 6 位'; el.err.classList.add('show'); return; }
    const r = await api('/api/' + tab, { method: 'POST', body: JSON.stringify({ username, password }) });
    if (!r.ok) { el.err.textContent = r.error || '网络错误'; el.err.classList.add('show'); return; }
    setAuth(r.user, r.token);
    closeModal();
  }
  async function logout() {
    if (token) api('/api/logout', { method: 'POST' });
    setAuth(null, null);
  }

  function inject() {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);
    const wrap = document.createElement('div');
    wrap.innerHTML = HTML;
    document.body.appendChild(wrap);
    el = {
      btn: q('n2aBtn'), btnText: q('n2aBtnText'), menu: q('n2aMenu'), uname: q('n2aUname'),
      mask: q('n2aMask'), err: q('n2aErr'), user: q('n2aUser'), pass: q('n2aPass'),
      submit: q('n2aSubmit'), tabLogin: document.querySelector('.note2auth-tab[data-tab="login"]'),
      tabReg: document.querySelector('.note2auth-tab[data-tab="register"]'), logoutBtn: q('n2aLogout')
    };
    el.btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (user) { el.uname.textContent = '已登录：' + user.username; el.menu.style.display = el.menu.style.display === 'block' ? 'none' : 'block'; }
      else openModal('login');
    });
    el.logoutBtn.addEventListener('click', () => { el.menu.style.display = 'none'; logout(); });
    el.tabLogin.addEventListener('click', () => { el.tabLogin.classList.add('active'); el.tabReg.classList.remove('active'); el.submit.textContent = '登录'; el.err.classList.remove('show'); });
    el.tabReg.addEventListener('click', () => { el.tabReg.classList.add('active'); el.tabLogin.classList.remove('active'); el.submit.textContent = '注册并登录'; el.err.classList.remove('show'); });
    el.submit.addEventListener('click', submit);
    el.pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    el.mask.addEventListener('click', (e) => { if (e.target === el.mask) closeModal(); });
    document.addEventListener('click', (e) => { if (!e.target.closest('.note2auth-btn') && !e.target.closest('.note2auth-menu')) el.menu.style.display = 'none'; });
  }

  /* ---------- 初始化 ---------- */
  function init(opts) {
    cfg = Object.assign({}, DEFAULTS, opts || {});
    inject();
    render();
    return api('/api/health').then((h) => {
      available = !!(h.ok && h.status === 200);
      if (!available) { render(); return null; }
      const stored = loadStored();
      if (stored && stored.token) {
        token = stored.token; user = stored.user || null;
        return api('/api/me').then((me) => {
          if (me.ok && me.user) { user = me.user; persist(); }
          else { token = null; user = null; persist(); }
          render(); emit();
          return user;
        });
      }
      render();
      return null;
    });
  }

  global.Note2Auth = {
    init,
    login: (u, p) => api('/api/login', { method: 'POST', body: JSON.stringify({ username: u, password: p }) }).then((r) => { if (r.ok) setAuth(r.user, r.token); return r; }),
    register: (u, p) => api('/api/register', { method: 'POST', body: JSON.stringify({ username: u, password: p }) }).then((r) => { if (r.ok) setAuth(r.user, r.token); return r; }),
    logout,
    getUser: () => user,
    getToken: () => token,
    isAvailable: () => available,
    onAuthChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); }
  };
})(window);
