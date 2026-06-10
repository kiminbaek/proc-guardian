// proc-guardian 鉴权模块 v1.1.0
// 首次注册密码 + 旧 Token 升级 + session token + 失败锁定

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let authFilePath = null;
let serverStartedAt = 0;
let authData = { version: '2.0', auth_type: 'uninitialized' };
const sessions = new Map(); // token -> { created, expires, ip }
const failures = new Map(); // ip -> { count, windowStart, lockedUntil, lockoutCount }

const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES = 5;
const BASE_LOCKOUT_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function hashToken(t) { return crypto.createHash('sha256').update(String(t)).digest('hex'); }
function now() { return Date.now(); }
function genToken(bytes = 32) { return crypto.randomBytes(bytes).toString('base64url'); }
function genSalt() { return crypto.randomBytes(16).toString('base64url'); }
function passwordHash(password, salt) {
    return crypto.scryptSync(String(password), salt, 64).toString('hex');
}
function safeEqualHex(a, b) {
    try {
        const ab = Buffer.from(String(a), 'hex');
        const bb = Buffer.from(String(b), 'hex');
        return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
    } catch (e) { return false; }
}
function writeAuth(data) {
    if (!authFilePath) throw new Error('auth_not_initialized');
    const tmp = authFilePath + '.tmp.' + process.pid + '.' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, authFilePath);
    authData = data;
}
function loadAuth() {
    if (!authFilePath || !fs.existsSync(authFilePath)) {
        authData = { version: '2.0', auth_type: 'uninitialized' };
        return;
    }
    const data = JSON.parse(fs.readFileSync(authFilePath, 'utf8'));
    if (data.auth_type === 'password' && data.password_hash && data.salt) {
        authData = data;
        return;
    }
    // 旧 Token v1.0/v1.1：保留，进入 legacy_upgrade 模式
    if (data.token_hash || data.token || data.token_plain) {
        authData = {
            version: '1.x',
            auth_type: 'legacy_token',
            token_hash: data.token_hash || (data.token ? hashToken(data.token) : null),
            token_plain: data.token_plain || data.token || null,
            migrated_from: data.version || 'unknown'
        };
        return;
    }
    authData = { version: '2.0', auth_type: 'uninitialized' };
}
function init(authFile) {
    authFilePath = authFile;
    serverStartedAt = Date.now();
    try { loadAuth(); } catch (e) { authData = { version: '2.0', auth_type: 'uninitialized', load_error: true }; }
}
function getMode() {
    if (authData.auth_type === 'password') return 'password';
    if (authData.auth_type === 'legacy_token') return 'legacy_upgrade';
    return 'setup_required';
}
function getStatus() {
    return {
        mode: getMode(),
        auth_type: authData.auth_type || 'uninitialized',
        version: authData.version || 'unknown',
        server_started_at: serverStartedAt,
        uptime_seconds: Math.floor((Date.now() - serverStartedAt) / 1000)
    };
}
function validatePassword(p) {
    if (typeof p !== 'string' || p.length < 8) return 'password_too_short';
    if (p.length > 128) return 'password_too_long';
    return null;
}
function setupPassword(password) {
    if (getMode() !== 'setup_required') throw new Error('already_initialized');
    const err = validatePassword(password); if (err) throw new Error(err);
    const salt = genSalt();
    writeAuth({ version: '2.0', auth_type: 'password', kdf: 'scrypt', salt, password_hash: passwordHash(password, salt), created_at: Date.now() });
    return true;
}
function verifyLegacyToken(token) {
    if (getMode() !== 'legacy_upgrade') return false;
    if (authData.token_plain && token === authData.token_plain) return true;
    if (authData.token_hash && hashToken(token) === authData.token_hash) return true;
    if (authData.token_hash && token === authData.token_hash) return true;
    return false;
}
function upgradeLegacyToken(token, password) {
    if (!verifyLegacyToken(token)) throw new Error('bad_legacy_token');
    const err = validatePassword(password); if (err) throw new Error(err);
    const salt = genSalt();
    writeAuth({ version: '2.0', auth_type: 'password', kdf: 'scrypt', salt, password_hash: passwordHash(password, salt), created_at: Date.now(), migrated_from: 'legacy_token' });
    return true;
}
function verifyPassword(password) {
    if (getMode() !== 'password') return false;
    return safeEqualHex(passwordHash(password, authData.salt), authData.password_hash);
}
function createSession(ip) {
    const token = genToken(32);
    sessions.set(token, { created: now(), expires: now() + SESSION_TTL_MS, ip });
    return token;
}
function verifySession(token) {
    const s = sessions.get(token);
    if (!s) return false;
    if (now() > s.expires) { sessions.delete(token); return false; }
    return true;
}
function revokeSession(token) { if (token) sessions.delete(token); }
function isLocked(ip) {
    const f = failures.get(ip); if (!f) return false;
    if (f.lockedUntil && now() >= f.lockedUntil) f.lockedUntil = 0;
    return f.lockedUntil && now() < f.lockedUntil;
}
function getLockSeconds(ip) {
    const f = failures.get(ip); if (!f || !f.lockedUntil) return 0;
    return Math.max(0, Math.ceil((f.lockedUntil - now()) / 1000));
}
function recordFailure(ip) {
    const f = failures.get(ip) || { count: 0, windowStart: now(), lockedUntil: 0, lockoutCount: 0 };
    if (now() - f.windowStart > WINDOW_MS) { f.count = 0; f.windowStart = now(); }
    f.count++;
    if (f.count >= MAX_FAILURES) {
        const multiplier = Math.pow(3, Math.min(f.lockoutCount, 4));
        f.lockedUntil = now() + BASE_LOCKOUT_MS * multiplier;
        f.lockoutCount++;
        f.count = 0;
        f.windowStart = now();
    }
    failures.set(ip, f);
}
function clearFailures(ip) { failures.delete(ip); }
setInterval(() => {
    const n = now();
    for (const [token, s] of sessions.entries()) if (n > s.expires) sessions.delete(token);
    for (const [ip, f] of failures.entries()) if ((n - f.windowStart > WINDOW_MS * 2) && (!f.lockedUntil || n >= f.lockedUntil)) failures.delete(ip);
}, 10 * 60 * 1000).unref();

function authMiddleware(req, res, next) {
    if (req.path.startsWith('/auth/')) return next();
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    if (isLocked(ip)) return res.status(429).json({ ok: false, error: 'too_many_attempts', retry_after: getLockSeconds(ip) });
    const provided = req.headers['x-auth-token'] || req.query.token;
    if (!provided) return res.status(401).json({ ok: false, error: 'no_token' });
    if (verifySession(provided)) return next();
    recordFailure(ip);
    return res.status(401).json({ ok: false, error: 'bad_session' });
}

const _internal = {
    get mode() { return getMode(); },
    get authData() { return authData; },
    get failures() { return failures; },
    get sessions() { return sessions; },
    get serverStartedAt() { return serverStartedAt; }
};
module.exports = {
    init, authMiddleware, hashToken, getStatus, getMode,
    setupPassword, upgradeLegacyToken, verifyPassword, createSession, verifySession, revokeSession,
    isLocked, getLockSeconds, recordFailure, clearFailures, _internal
};
