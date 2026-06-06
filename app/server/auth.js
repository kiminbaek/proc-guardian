// proc-guardian 鉴权模块 v1.0.6
// 负责：token 校验 / IP 失败计数 / 锁定逻辑

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 模块变量（getter 通过 _internal 暴露）
let tokenHash = null;       // sha256(token)  -- session_token
let tokenPlain = null;      // 明文 token -- 启动后 1h 内首次登录用
let serverStartedAt = 0;    // Date.now() 启动时间
let initMode = false;       // 启动后 1h 内 = true
let authFilePath = null;
let initModeHours = 1;      // 启动后 1h 允许明文登录

// === BUG #14 修复：10 分钟时间窗口 ===
// === BUG #38 修复：锁定 5min, 15min, 45min, 2h15min 指数退避 ===
// === BUG #15 修复：failures Map lazy 清过期（isLocked 调用时清）===
const failures = new Map();  // ip -> { count, windowStart, lockedUntil, lockoutCount }

const WINDOW_MS = 10 * 60 * 1000;   // 10 分钟时间窗口
const MAX_FAILURES = 5;              // 5 次失败锁定
const BASE_LOCKOUT_MS = 5 * 60 * 1000;  // 首次锁定 5 分钟

function hashToken(t) {
    return crypto.createHash('sha256').update(String(t)).digest('hex');
}

function isLocked(ip) {
    const f = failures.get(ip);
    if (!f) return false;
    // lazy 清过期（BUG #15）
    if (f.lockedUntil && Date.now() >= f.lockedUntil) {
        f.lockedUntil = 0;
    }
    return f.lockedUntil && Date.now() < f.lockedUntil;
}

function getLockSeconds(ip) {
    const f = failures.get(ip);
    if (!f || !f.lockedUntil) return 0;
    return Math.max(0, Math.ceil((f.lockedUntil - Date.now()) / 1000));
}

function recordFailure(ip) {
    // === BUG #14：10 分钟时间窗口 ===
    const f = failures.get(ip) || {
        count: 0,
        windowStart: Date.now(),
        lockedUntil: 0,
        lockoutCount: 0
    };

    // 窗口过期 → 重置 count
    if (Date.now() - f.windowStart > WINDOW_MS) {
        f.count = 0;
        f.windowStart = Date.now();
    }

    f.count++;

    if (f.count >= MAX_FAILURES) {
        // === BUG #38：指数退避 5min, 15min, 45min, 2h15min, 6h45min ===
        const multiplier = Math.pow(3, Math.min(f.lockoutCount, 4));
        f.lockedUntil = Date.now() + BASE_LOCKOUT_MS * multiplier;
        f.lockoutCount++;
        f.count = 0;
        f.windowStart = Date.now();
        // 记录锁定事件到 info.log（持久化）
        try {
            const LOG = path.join(path.dirname(authFilePath || '/tmp/auth.json'), 'info.log');
            fs.appendFileSync(LOG,
                `[${new Date().toISOString()}] [auth] IP ${ip} locked for ${Math.round((f.lockedUntil - Date.now()) / 1000)}s (lockout #${f.lockoutCount})\n`);
        } catch (e) {}
    }

    failures.set(ip, f);
}

function clearFailures(ip) {
    failures.delete(ip);
}

// 清理 Map：移除窗口过期且未锁定的 IP（每 10 分钟跑一次）
setInterval(() => {
    const now = Date.now();
    for (const [ip, f] of failures.entries()) {
        const expired = now - f.windowStart > WINDOW_MS * 2;
        const unlocked = !f.lockedUntil || now >= f.lockedUntil;
        if (expired && unlocked) failures.delete(ip);
    }
}, 10 * 60 * 1000).unref();

function init(authFile) {
    authFilePath = authFile;
    serverStartedAt = Date.now();

    try {
        if (fs.existsSync(authFile)) {
            const data = JSON.parse(fs.readFileSync(authFile, 'utf8'));
            tokenHash = data.token_hash || null;
            tokenPlain = data.token_plain || null;
            initModeHours = data.init_mode_hours || 1;
        }
    } catch (e) {
        // 静默失败
    }

    // 1h 内的 init mode 允许用明文 token
    initMode = (Date.now() - serverStartedAt) < initModeHours * 60 * 60 * 1000;

    // 1h 后清空明文 token
    if (!initMode && tokenPlain) {
        tokenPlain = null;
        try {
            // 重写 auth.json 不带 token_plain
            if (tokenHash) {
                fs.writeFileSync(authFile, JSON.stringify({
                    token_hash: tokenHash,
                    init_mode_hours: initModeHours,
                    initialized_at: serverStartedAt
                }, null, 2), { mode: 0o600 });
            }
        } catch (e) {}
    }
}

function isInitMode() {
    return initMode;
}

function authMiddleware(req, res, next) {
    // 登录接口不走中间件（白名单路由）
    if (req.path.startsWith('/auth/')) return next();

    const ip = req.ip || req.connection.remoteAddress || 'unknown';

    if (isLocked(ip)) {
        return res.status(429).json({
            ok: false,
            error: 'too_many_attempts',
            retry_after: getLockSeconds(ip)
        });
    }

    // 优先从 header 取，其次 query
    const provided = req.headers['x-auth-token'] || req.query.token;

    if (!provided) {
        return res.status(401).json({ ok: false, error: 'no_token' });
    }

    // session_token (hash) 直接比较（init mode 1h 后唯一方式）
    if (tokenHash && provided === tokenHash) {
        return next();
    }

    // init mode 1h 内：允许明文 token 一次性登录
    if (initMode && tokenPlain && provided === tokenPlain) {
        // 清空明文（一次性）
        tokenPlain = null;
        try {
            if (tokenHash) {
                fs.writeFileSync(authFilePath, JSON.stringify({
                    token_hash: tokenHash,
                    init_mode_hours: initModeHours,
                    initialized_at: serverStartedAt
                }, null, 2), { mode: 0o600 });
            }
        } catch (e) {}
        return next();
    }

    // 失败
    recordFailure(ip);
    return res.status(401).json({ ok: false, error: 'bad_token' });
}

// 内部状态（getter 反映 module 变量最新值，BUG #115/116 修法）
const _internal = {
    get tokenHash() { return tokenHash; },
    get tokenPlain() { return tokenPlain; },
    get initMode() { return initMode; },
    get failures() { return failures; },
    get serverStartedAt() { return serverStartedAt; }
};

module.exports = {
    init,
    authMiddleware,
    hashToken,
    isInitMode,
    isLocked,
    getLockSeconds,
    recordFailure,
    clearFailures,
    _internal
};
