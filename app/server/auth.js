// proc-guardian 鉴权模块
// 启动时从 auth.json 读 token，支持多次失败锁定（5 次/5 分钟）

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let AUTH_FILE = null;
let CONFIG_FILE = null;
let tokenHash = null;
let tokenPlain = null;   // 仅用于首次启动的 "init 模式"（用户从日志抄过来登录）
let initMode = false;
const failures = new Map();   // ip -> { count, lockedUntil }

function init(authFile, configFile) {
    AUTH_FILE = authFile;
    CONFIG_FILE = configFile || path.join(path.dirname(authFile), 'config.json');
    if (!fs.existsSync(authFile)) {
        console.error('auth.json not found, refusing to start');
        process.exit(1);
    }
    const data = JSON.parse(fs.readFileSync(authFile, 'utf8'));
    const t = data.token;
    if (!t) {
        console.error('auth.json missing token');
        process.exit(1);
    }
    tokenPlain = t;
    tokenHash = hashToken(t);
    // init mode: 启动后 1 小时内首次登录可用明文 token
    // 之后必须用前端本地存着的 "tokenHash" 走 HASH 比对（防止日志泄漏）
    initMode = true;
    setTimeout(() => { initMode = false; }, 3600 * 1000);
}

function hashToken(t) {
    return crypto.createHash('sha256').update(t).digest('hex');
}

function isLocked(ip) {
    const f = failures.get(ip);
    if (!f) return false;
    if (f.lockedUntil && Date.now() < f.lockedUntil) return true;
    return false;
}

function recordFailure(ip) {
    const f = failures.get(ip) || { count: 0, lockedUntil: 0 };
    f.count++;
    const maxFailures = 5;
    const lockoutMs = 5 * 60 * 1000;
    if (f.count >= maxFailures) {
        f.lockedUntil = Date.now() + lockoutMs;
        f.count = 0;
    }
    failures.set(ip, f);
}

function clearFailures(ip) {
    failures.delete(ip);
}

function getLockSeconds(ip) {
    const f = failures.get(ip);
    if (!f || !f.lockedUntil) return 0;
    return Math.max(0, Math.ceil((f.lockedUntil - Date.now()) / 1000));
}

function authMiddleware(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';

    if (isLocked(ip)) {
        return res.status(429).json({
            ok: false,
            error: 'too_many_failures',
            locked_for_seconds: getLockSeconds(ip)
        });
    }

    // token 可能在 header / body / query
    let provided = req.headers['x-auth-token']
        || (req.body && req.body.token)
        || (req.query && req.query.token);

    if (!provided) {
        return res.status(401).json({ ok: false, error: 'no_token' });
    }

    let ok = false;
    if (initMode && provided === tokenPlain) {
        // 首次启动：明文 token 比对成功 → 客户端存 hash 后走 HASH 模式
        ok = true;
        initMode = false;  // 一次性 init 模式
    } else if (provided === tokenHash) {
        // HASH 模式：客户端发 session_token（= tokenHash）直接比对，不再 hash 一次
        ok = true;
    }

    if (!ok) {
        recordFailure(ip);
        return res.status(401).json({
            ok: false,
            error: 'bad_token',
            remaining_attempts: Math.max(0, 5 - (failures.get(ip)?.count || 0))
        });
    }

    clearFailures(ip);
    next();
}

module.exports = {
    init,
    authMiddleware,
    hashToken,
    // 给 login 路由用（用 getter/setter 反映 module 变量最新值）
    _internal: {
        get tokenHash() { return tokenHash; },
        get tokenPlain() { return tokenPlain; },
        set tokenPlain(v) { tokenPlain = v; },  // login 路由清空时同步 module 变量
        get initMode() { return initMode; },
        isLocked, recordFailure, clearFailures, getLockSeconds, failures
    }
};
