// /api/ports 路由
// v1.0.8 新增：app_name/app_id
// v1.9.0 修 P1-8：应用归属统一走 appresolve（含父进程继承），与进程页一致

const express = require('express');
const router = express.Router();

const portsMod = require('../ports');
const wlMod = require('../whitelist');
const appnames = require('../appnames');
const appresolve = require('../appresolve');
const procMod = require('../process');

// GET /api/ports
router.get('/', (req, res) => {
    let ports = portsMod.getAllListeningPorts();
    const allProcs = procMod.getAllProcesses();
    const resolver = appresolve.createResolver(allProcs);

    // 关联白名单保护 + 应用名
    ports = ports.map(p => {
        const wl = wlMod.checkPort(p.port);
        // 通过 pid 反查进程信息 → 应用名
        const proc = p.pid ? resolver.byPid.get(p.pid) : null;
        const app = proc ? resolver.resolve(proc) : null;
        return {
            ...p,
            app_id: app ? app.app_id : null,
            app_name: app ? app.app_name : null,
            protected: wl.protected,
            protected_reason: wl.reason
        };
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
    // 加应用名
    const resolver = appresolve.createResolver();
    const enriched = ports.map(p => {
        const proc = p.pid ? resolver.byPid.get(p.pid) : null;
        const app = proc ? resolver.resolve(proc) : null;
        return { ...p, app_id: app ? app.app_id : null, app_name: app ? app.app_name : null };
    });
    res.json({ ok: true, port, occupied: true, listeners: enriched });
});

module.exports = router;
