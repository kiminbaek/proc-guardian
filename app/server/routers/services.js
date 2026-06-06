// /api/services 路由
// v1.0.6 BUG 修复：clearCache 移到 try 外 + 危险操作必填 confirm

const express = require('express');
const router = express.Router();
const { execSync } = require('child_process');
const services = require('../services');

function safeExec(cmd, timeout = 5000) {
    try {
        return execSync(cmd, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 }).trim();
    } catch (e) {
        return '';
    }
}

// === BUG #32 修复：危险操作必填 confirm ===
const DANGEROUS_ACTIONS = new Set(['start', 'stop', 'restart', 'enable', 'disable']);

router.get('/', async (req, res) => {
    try {
        const data = await services.listUnits();
        res.json({ ok: true, ...data });
    } catch (e) {
        res.status(500).json({ ok: false, error: 'list_failed' });
    }
});

router.get('/status/:name', async (req, res) => {
    try {
        const status = await services.getStatus(req.params.name);
        res.json({ ok: true, name: req.params.name, status });
    } catch (e) {
        res.status(500).json({ ok: false, error: 'status_failed' });
    }
});

router.post('/action', async (req, res) => {
    const { action, name, confirm } = req.body || {};

    if (!action || !name) {
        return res.status(400).json({ ok: false, error: 'missing_action_or_name' });
    }

    // === BUG #32 修复：危险操作必须 confirm=true ===
    if (DANGEROUS_ACTIONS.has(action) && confirm !== true) {
        return res.status(400).json({
            ok: false,
            error: 'confirm_required',
            hint: `action '${action}' requires confirm=true in body`
        });
    }

    try {
        const result = await services.action(name, action);
        // === BUG #8 修复：clearCache 移到 try 外（catch 也清）===
        services.clearCache();
        res.json({ ok: true, action, name, result });
    } catch (e) {
        // 失败也清缓存
        services.clearCache();
        res.status(500).json({ ok: false, error: 'action_failed', detail: e.message });
    }
});

module.exports = router;
