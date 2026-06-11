// /api/settings 路由
// v1.4.0：设置持久化、导入/导出、恢复默认

const express = require('express');
const router = express.Router();
const settings = require('../settings');

router.get('/', (req, res) => {
    try {
        res.json({ ok: true, settings: settings.load(), file: settings.SETTINGS_FILE });
    } catch (e) {
        res.status(500).json({ ok: false, error: 'load_failed' });
    }
});

router.put('/', (req, res) => {
    try {
        const saved = settings.save(req.body || {});
        res.json({ ok: true, settings: saved, file: settings.SETTINGS_FILE });
    } catch (e) {
        res.status(500).json({ ok: false, error: 'write_failed' });
    }
});

router.get('/export', (req, res) => {
    try {
        res.json({ ok: true, exported_at: new Date().toISOString(), settings: settings.load() });
    } catch (e) {
        res.status(500).json({ ok: false, error: 'export_failed' });
    }
});

router.post('/import', (req, res) => {
    try {
        const payload = req.body && req.body.settings ? req.body.settings : req.body;
        const saved = settings.save(payload || {});
        res.json({ ok: true, settings: saved, file: settings.SETTINGS_FILE });
    } catch (e) {
        res.status(400).json({ ok: false, error: 'import_failed' });
    }
});

router.post('/reset', (req, res) => {
    try {
        res.json({ ok: true, settings: settings.reset(), file: settings.SETTINGS_FILE });
    } catch (e) {
        res.status(500).json({ ok: false, error: 'reset_failed' });
    }
});

module.exports = router;
