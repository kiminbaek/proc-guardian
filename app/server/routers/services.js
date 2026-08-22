// /api/services 路由
// v1.0.6 BUG 修复：clearCache 移到 try 外 + 危险操作必填 confirm
// v1.9.0 修 P1-7：补 GET /:unit/logs 路由 —— 前端 api.js 一直在请求这个地址，
//        后端 services.getServiceLogs() 早已实现却没挂路由，实测返回 404，
//        UI 上「日志」按钮点了必然报 "加载失败: http_404"。

const express = require('express');
const router = express.Router();
const services = require('../services');
const audit = require('../audit');

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

// v1.9.0 修 P1-7：服务日志（前端 Api.serviceLogs 调用此地址）
// unit 名合法性由 services.getServiceLogs 内的正则校验（防命令注入）
router.get('/:unit/logs', (req, res) => {
    const unit = (req.params.unit || '').toString();
    const lines = Math.min(2000, Math.max(1, parseInt(req.query.lines, 10) || 100));
    try {
        const logs = services.getServiceLogs(unit, lines);
        res.json({ ok: true, unit, lines, logs });
    } catch (e) {
        const bad = /invalid_unit_name/.test(e.message);
        res.status(bad ? 400 : 500).json({ ok: false, error: bad ? 'invalid_unit_name' : 'logs_failed' });
    }
});

router.post('/action', async (req, res) => {
    const { action, confirm } = req.body || {};
    const name = ((req.body && (req.body.name || req.body.unit)) || '').toString().trim();

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
        audit.append('service_action', { ...audit.fromReq(req), action, name, result: 'success' });
        res.json({ ok: true, action, name, result });
    } catch (e) {
        // 失败也清缓存
        services.clearCache();
        audit.append('service_action', { ...audit.fromReq(req), action, name, result: 'failed', error: e.message });
        res.status(500).json({ ok: false, error: 'action_failed', detail: e.message });
    }
});

module.exports = router;
