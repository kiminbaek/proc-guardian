// /api/auth 路由 v1.1.0
const express = require('express');
const router = express.Router();
const auth = require('../auth');
const audit = require('../audit');

function ip(req) { return req.ip || req.connection.remoteAddress || 'unknown'; }

router.get('/mode', (req, res) => res.json({ ok: true, ...auth.getStatus() }));

router.post('/setup', (req, res) => {
    const remote = ip(req);
    try {
        auth.setupPassword((req.body || {}).password || '');
        audit.append('auth_setup', { ...audit.fromReq(req), result: 'success' });
        const session_token = auth.createSession(remote);
        res.json({ ok: true, session_token, mode: auth.getMode() });
    } catch (e) {
        audit.append('auth_setup', { ...audit.fromReq(req), result: 'failed', error: e.message });
        res.status(400).json({ ok: false, error: e.message });
    }
});

router.post('/upgrade', (req, res) => {
    const remote = ip(req);
    if (auth.isLocked(remote)) return res.status(429).json({ ok: false, error: 'too_many_attempts', retry_after: auth.getLockSeconds(remote) });
    try {
        auth.upgradeLegacyToken((req.body || {}).token || '', (req.body || {}).password || '');
        auth.clearFailures(remote);
        audit.append('auth_upgrade', { ...audit.fromReq(req), result: 'success' });
        const session_token = auth.createSession(remote);
        res.json({ ok: true, session_token, mode: auth.getMode() });
    } catch (e) {
        auth.recordFailure(remote);
        audit.append('auth_upgrade', { ...audit.fromReq(req), result: 'failed', error: e.message });
        res.status(401).json({ ok: false, error: e.message });
    }
});

router.post('/login', (req, res) => {
    const remote = ip(req);
    if (auth.isLocked(remote)) return res.status(429).json({ ok: false, error: 'too_many_attempts', retry_after: auth.getLockSeconds(remote) });
    const password = (req.body || {}).password || (req.body || {}).token || '';
    if (!password) return res.status(400).json({ ok: false, error: 'no_password' });
    if (auth.verifyPassword(password)) {
        auth.clearFailures(remote);
        const session_token = auth.createSession(remote);
        audit.append('auth_login', { ...audit.fromReq(req), result: 'success' });
        return res.json({ ok: true, session_token, mode: auth.getMode() });
    }
    auth.recordFailure(remote);
    audit.append('auth_login', { ...audit.fromReq(req), result: 'failed' });
    const locked = auth.isLocked(remote);
    res.status(401).json({ ok: false, error: locked ? 'too_many_attempts' : 'bad_password', retry_after: locked ? auth.getLockSeconds(remote) : 0 });
});

router.post('/logout', (req, res) => {
    const token = req.headers['x-auth-token'] || (req.body || {}).token;
    auth.revokeSession(token);
    audit.append('auth_logout', { ...audit.fromReq(req), result: 'success' });
    res.json({ ok: true });
});

router.get('/status', (req, res) => res.json({ ok: true, authenticated: true, ...auth.getStatus() }));

module.exports = router;
