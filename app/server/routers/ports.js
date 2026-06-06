// /api/ports 路由
const express = require('express');
const router = express.Router();

const portsMod = require('../ports');
const wlMod = require('../whitelist');

// GET /api/ports
router.get('/', (req, res) => {
    let ports = portsMod.getAllListeningPorts();

    // 关联白名单保护
    ports = ports.map(p => {
        const wl = wlMod.checkPort(p.port);
        return { ...p, protected: wl.protected, protected_reason: wl.reason };
    });

    // 排序
    ports.sort((a, b) => a.port - b.port);

    res.json({ ok: true, total: ports.length, ports });
});

// GET /api/ports/:port   查谁占用某端口
router.get('/:port', (req, res) => {
    const port = parseInt(req.params.port, 10);
    if (!Number.isFinite(port)) return res.status(400).json({ ok: false, error: 'invalid_port' });
    const ports = portsMod.getPortByPort(port);
    if (ports.length === 0) {
        return res.json({ ok: true, port, occupied: false, listeners: [] });
    }
    res.json({ ok: true, port, occupied: true, listeners: ports });
});

module.exports = router;
