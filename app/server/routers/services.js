// /api/services 路由
const express = require('express');
const router = express.Router();

const svcMod = require('../services');

// GET /api/services
router.get('/', (req, res) => {
    const services = svcMod.getAllServices();
    res.json({ ok: true, total: services.length, services });
});

// GET /api/services/:unit/logs?lines=100
router.get('/:unit/logs', (req, res) => {
    const unit = req.params.unit;
    if (!/^[\w@.-]+\.service$/.test(unit)) {
        return res.status(400).json({ ok: false, error: 'invalid_unit_name' });
    }
    const lines = Math.min(2000, parseInt(req.query.lines) || 100);
    try {
        const logs = svcMod.getServiceLogs(unit, lines);
        res.json({ ok: true, unit, lines, logs });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// POST /api/services/action { unit, action }
router.post('/action', (req, res) => {
    const unit = (req.body.unit || '').toString();
    const action = (req.body.action || '').toString();
    if (!unit || !action) {
        return res.status(400).json({ ok: false, error: 'missing_unit_or_action' });
    }
    try {
        const result = svcMod.serviceAction(unit, action);
        svcMod.clearCache();
        res.json({ ok: true, ...result });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

module.exports = router;
