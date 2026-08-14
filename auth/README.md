# 手记账号系统（可复用模块）

把「注册 / 密码登录 / 按用户隔离数据」做成**开箱即用**的模块，
任何 Web 项目（Node 静态服务器 + 浏览器前端）都能一键接入。
它来自「手记 Note 2」项目，已在其生产环境验证。

## 📦 包含什么

```
auth/
├── server-auth.js    后端认证模块（零依赖，Node 内置 crypto）
├── auth-client.js    前端组件（单文件、自绘界面、零依赖）
└── demo.html         完整接入演示（含数据按账号隔离示例）
```

## 🚀 三步接入

### 1. 后端（Node）

```js
// 引入并创建
const { createAuth } = require('./auth/server-auth');
const auth = createAuth({ dataDir: __dirname + '/data' });

// 在服务器请求入口，把 /api/* 交给它
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    const handled = await auth.handle(req, res, url);   // 处理注册/登录/数据接口
    if (!handled) { /* 你自己的 API 路由 */ }
    return;
  }
  /* 你的静态文件服务 */
});
```

提供的接口（全部 JSON）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 后端可用性探测 |
| POST | `/api/register` | 注册 `{username, password}` → `{token, user}` |
| POST | `/api/login` | 登录 → `{token, user}` |
| POST | `/api/logout` | 登出（带令牌） |
| GET | `/api/me` | 当前用户信息（带令牌） |
| GET | `/api/library` | 读取当前账号的数据（带令牌） |
| PUT | `/api/library` | 保存当前账号的数据（带令牌） |

> `/api/library` 是「每个账号一份」的通用存储；你也可以在 `server-auth.js`
> 基础上按需加自己的接口，认证方式一样（`Authorization: Bearer <token>`）。

### 2. 前端（任意页面）

```html
<script src="auth/auth-client.js"></script>
<script>
  Note2Auth.init({
    apiBase: '',                 // 后端前缀，默认同源
    storageKey: 'note2-auth',    // 令牌本地存储键名
    onAuthChange: (user) => {    // 登录/登出回调
      if (user) { loadUserData(user); } else { resetToLocal(); }
    }
  });
</script>
```

组件会自绘右上角「登录」按钮 + 登录/注册弹窗，自动持久化并校验会话。
**后端不可用时（如纯静态托管）自动隐藏登录，页面照常工作。**

### 3. 读取/保存当前用户的数据

```js
// 读（需登录）
const r = await fetch('/api/library', { headers: { Authorization: 'Bearer ' + Note2Auth.getToken() } });
// 写（需登录）
await fetch('/api/library', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + Note2Auth.getToken() },
  body: JSON.stringify(yourData)
});
```

## 🔒 安全与数据

- 密码 **scrypt 加盐哈希**，不存明文；登录用恒定时间比较；
- 会话令牌随机 256 位，服务端只存 SHA-256；30 天有效；
- 每个用户独立目录 `data/users/<id>/`，**账号间完全隔离**；
- 登录/注册有简单限流（每 IP 20 次/10 分钟）；
- `data/` 目录请加入 `.gitignore`，不要提交到仓库。

## 📚 完整参考实现

「手记 Note 2」项目就是本模块的生产用法：
- `server.js` —— 静态服务 + 挂载 `auth/server-auth.js`
- `js/app.js` —— 前端接入（含本地模式与登录模式切换、按用户加载/保存）

## ✏️ 在其它项目中使用

1. 把 `auth/` 文件夹复制到目标项目；
2. 按上面三步接入；
3. 你自己的业务数据（笔记、设置、任务…）通过 `/api/library` 或扩展接口存取，
   天然按账号隔离，多设备登录同一账号即可同步。
