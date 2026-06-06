// /api/auth 路由
// BUG #1/#2/#3/#20 修复版 v1.0.6

const express = require('express');
const router = express.Router();
const auth = require('../auth');

// 通过 getter 获取最新 module 变量（避免 ES6 简写求值时机错）
const _i = () => auth._internal;

router.post('/login', (req, res) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';

    // 锁定检查
    if (auth.isLocked(ip)) {
        return res.status(429).json({
            ok: false,
            error: 'too_many_attempts',
            retry_after: auth.getLockSeconds(ip)
        });
    }

    const { token: provided } = req.body || {};
    if (!provided) {
        auth.recordFailure(ip);
        return res.status(400).json({ ok: false, error: 'no_token' });
    }

    const internal = _i();

    // === BUG #1 修复：协议统一 ===
    // init mode 1h 内 + 明文 token 匹配 → 一次性登录
    if (internal.initMode && internal.tokenPlain && provided === internal.tokenPlain) {
        auth.clearFailures(ip);
        return res.json({
            ok: true,
            session_token: internal.tokenHash,  // 返 hash 作为 session_token
            init_mode: true,
            hint: 'store session_token, never store plain token'
        });
    }

    // session_token (hash) 验证：直接比较（BUG #1 修复）
    if (internal.tokenHash && provided === internal.tokenHash) {
        auth.clearFailures(ip);
        return res.json({
            ok: true,
            session_token: internal.tokenHash
        });
    }

    // 失败
    auth.recordFailure(ip);
    const locked = auth.isLocked(ip);
    return res.status(401).json({
        ok: false,
        error: locked ? 'too_many_attempts' : 'bad_token',
        retry_after: locked ? auth.getLockSeconds(ip) : 0
    });
});

// 登出（BUG #20：新增端点，简单版不持久化黑名单）
router.post('/logout', (req, res) => {
    // 当前实现：让前端清 localStorage / sessionStorage
    // 完整版需要 token 黑名单 + 持久化（v1.0.7+）
    res.json({ ok: true, hint: 'frontend should clear stored token' });
});

router.get('/status', (req, res) => {
    const internal = _i();
    res.json({
        ok: true,
        authenticated: true,  // 已通过 authMiddleware
        init_mode: internal.initMode,
        server_started_at: internal.serverStartedAt,
        uptime_seconds: Math.floor((Date.now() - internal.serverStartedAt) / 1000)
    });
});

module.exports = router;
