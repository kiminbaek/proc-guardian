// /api/whitelist 路由 - 读 / 写 / 重置白名单
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

const wlMod = require('../whitelist');

const TRIM_PKGVAR = process.env.TRIM_PKGVAR || '/tmp';
const CONFIG_FILE = path.join(TRIM_PKGVAR, 'config.json');

// GET /api/whitelist
router.get('/', (req, res) => {
    const cfg = wlMod.readConfig();
    res.json({ ok: true, whitelist: cfg.whitelist || {} });
});

// PUT /api/whitelist  整体替换（合并到现有 config.json）
router.put('/', (req, res) => {
    const newWl = req.body;
    if (!newWl || typeof newWl !== 'object') {
        return res.status(400).json({ ok: false, error: 'invalid_body' });
    }

    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) {}

    // 保留其他段（ui、auth），只覆盖 whitelist
    cfg.whitelist = {
        pids: Array.isArray(newWl.pids) ? newWl.pids : [],
        users: Array.isArray(newWl.users) ? newWl.users : [],
        process_names: Array.isArray(newWl.process_names) ? newWl.process_names : [],
        cmdline_keywords: Array.isArray(newWl.cmdline_keywords) ? newWl.cmdline_keywords : [],
        ports: Array.isArray(newWl.ports) ? newWl.ports : []
    };

    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
        fs.chmodSync(CONFIG_FILE, 0o600);
        wlMod.clearCache();
        res.json({ ok: true, whitelist: cfg.whitelist });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// POST /api/whitelist/check  检查某进程是否被保护（不实际操作）
// { pid } 或 { user, comm, cmdline }
router.post('/check', (req, res) => {
    const proc = {
        pid: parseInt(req.body.pid, 10) || 0,
        user: req.body.user || '',
        comm: req.body.comm || '',
        cmdline: req.body.cmdline || ''
    };
    const result = wlMod.checkProcess(proc);
    res.json({ ok: true, ...result });
});

module.exports = router;
