// proc-guardian 入口服务 v1.9.0
// 负责：注册路由 + 启动 HTTP 服务 + 优雅退出

const express = require('express');
const path = require('path');
const fs = require('fs');
const auth = require('./auth');

const app = express();
const PORT = parseInt(process.env.PORT) || 8877;

// === BUG 修复：端口合法性验证 ===
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    console.error(`[fatal] invalid PORT=${PORT} (must be 1-65535)`);
    process.exit(1);
}

const TRIM_PKGVAR = process.env.TRIM_PKGVAR || '/tmp';
const AUTH_FILE = path.join(TRIM_PKGVAR, 'auth.json');
const LOG_FILE = path.join(TRIM_PKGVAR, 'info.log');

// === BUG #12 修复 → v1.9.0 修 P1-10：关闭 trust proxy ===
// 旧实现 app.set('trust proxy', 1) 注释写"防 X-Forwarded-For 伪造"，实际效果相反：
//   req.ip 改为取 XFF 链末位，攻击者每次换 XFF 就换一个"身份"，
//   5 次失败锁定形同虚设（实测连打 7 次不同 XFF 全部返回 bad_password 无锁定）。
// proc-guardian 是 fnOS 桌面应用：manifest 里 desktop_uidir=ui + service_port=8877，
//   浏览器 iframe 直连该端口，没有反向代理链路，也没注册统一网关。
//   因此必须关闭 trust proxy，让 req.ip 恒为真实 socket 地址，锁定才有效。
app.set('trust proxy', false);
// === BUG #10 修复：隐藏 x-powered-by 头 ===
app.disable('x-powered-by');

app.use(express.json({ limit: '256kb' }));

// 启动时读 auth.json
auth.init(AUTH_FILE);

// 登录接口（无需鉴权）
app.use('/api/auth', require('./routers/auth'));

// 全局鉴权中间件
app.use('/api', auth.authMiddleware);

// v1.9.0 修 P1-11：/api/auth/status 必须在鉴权中间件【之后】注册。
//   旧实现把它放在 routers/auth 里（鉴权之前），且 authMiddleware 又跳过 /auth/ 前缀，
//   导致无 token 直接访问就返回 {"authenticated":true} —— 硬编码的假值，
//   还顺带泄漏 server_started_at / uptime。
//   现在它走完整鉴权：无 token → 401；有效 session → 返回真实状态。
app.get('/api/auth/status', (req, res) => {
    res.json({ ok: true, authenticated: true, ...auth.getStatus() });
});

// 业务路由
app.use('/api/processes', require('./routers/processes'));
app.use('/api/ports',     require('./routers/ports'));
app.use('/api/services',  require('./routers/services'));
app.use('/api/system',    require('./routers/system'));
app.use('/api/whitelist', require('./routers/whitelist'));
app.use('/api/apps',      require('./routers/apps'));
app.use('/api/audit',     require('./routers/auditlog'));
app.use('/api/settings',  require('./routers/settings'));

// 静态文件 - JS/CSS 不强缓存，防止升级后浏览器用旧版
app.use(express.static(path.join(__dirname, '..', 'ui'), {
    setHeaders: (res, filepath) => {
        if (filepath.endsWith('.js') || filepath.endsWith('.css')) {
            res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        }
    }
}));

// === BUG #6 修复：错误处理不泄漏堆栈 ===
app.use((err, req, res, next) => {
    // 记录完整堆栈到日志
    try {
        fs.appendFileSync(LOG_FILE,
            `[${new Date().toISOString()}] [error] ${req.method} ${req.path}: ${err.stack || err}\n`);
    } catch (e) {}
    // 给客户端返通用错误（不泄漏内部信息）
    res.status(500).json({ ok: false, error: 'internal_server_error' });
});

// 404
app.use((req, res) => {
    res.status(404).json({ ok: false, error: 'not_found' });
});

const server = app.listen(PORT, '0.0.0.0', () => {
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[${ts}] proc-guardian listening on 0.0.0.0:${PORT}`);
    try {
        fs.appendFileSync(LOG_FILE,
            `[${new Date().toISOString()}] [boot] proc-guardian v1.9.0 listening on ${PORT}\n`);
    } catch (e) {}
});

function shutdown(sig) {
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[${ts}] received ${sig}, shutting down...`);
    try {
        fs.appendFileSync(LOG_FILE,
            `[${new Date().toISOString()}] [shutdown] received ${sig}\n`);
    } catch (e) {}
    server.close(() => process.exit(0));
    // 5 秒超时强退
    setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
    try { fs.appendFileSync(LOG_FILE,
        `[${new Date().toISOString()}] [crash] uncaughtException: ${err.stack || err}\n`); } catch (e) {}
    console.error('uncaughtException:', err);
    process.exit(1);
});
