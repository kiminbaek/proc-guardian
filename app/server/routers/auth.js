// 登录 / 注销 / 锁定状态查询（无需鉴权）
const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const auth = require('../auth');

function tokenHash(t) {
    return crypto.createHash('sha256').update(t).digest('hex');
}

// POST /api/auth/login { token }
router.post('/login', (req, res) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const internal = auth._internal;

    if (internal.isLocked(ip)) {
        return res.status(429).json({
            ok: false,
            error: 'too_many_failures',
            locked_for_seconds: internal.getLockSeconds(ip)
        });
    }

    const provided = (req.body && req.body.token) || '';
    if (!provided) {
        return res.status(400).json({ ok: false, error: 'no_token' });
    }

    let ok = false;
    let needsHash = false;
    if (internal.tokenPlain && provided === internal.tokenPlain) {
        ok = true;
        needsHash = true;   // 首次登录，返回 hash 让前端存
        internal.tokenPlain = null;  // 一次性明文
    } else if (auth.hashToken(provided) === internal.tokenHash) {
        ok = true;
    }

    if (!ok) {
        internal.recordFailure(ip);
        // 重新查当前 ip 的失败次数（recordFailure 后 map 已更新）
        const failCount = (require('../auth')._internal.failures.get(ip)?.count) || 0;
        return res.status(401).json({
            ok: false,
            error: 'bad_token',
            remaining_attempts: Math.max(0, 5 - failCount)
        });
    }

    internal.clearFailures(ip);

    // 返回 hash 后的 token（让前端后续用 hash 调 API）
    if (needsHash) {
        res.json({ ok: true, session_token: internal.tokenHash });
    } else {
        res.json({ ok: true });
    }
});

// GET /api/auth/status
router.get('/status', (req, res) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const internal = auth._internal;
    res.json({
        ok: true,
        init_mode: internal.initMode,    // 启动后 1h 内为 true（用 initMode 不是 tokenPlain）
        locked: internal.isLocked(ip),
        locked_for_seconds: internal.getLockSeconds(ip)
    });
});

module.exports = router;
