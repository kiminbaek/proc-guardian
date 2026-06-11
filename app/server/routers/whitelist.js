// /api/whitelist 路由
// v1.0.6 BUG 修复：schema 验证 + 原子写

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const whitelist = require('../whitelist');

const TRIM_PKGVAR = process.env.TRIM_PKGVAR || '/tmp';
const WHITELIST_FILE = path.join(TRIM_PKGVAR, 'config.json');

// === BUG #5 修复：schema 验证 ===
function validateWhitelist(data) {
    if (!data || typeof data !== 'object') {
        return { ok: false, error: 'whitelist_must_be_object' };
    }
    const errors = [];
    const fields = ['pids', 'users', 'process_names', 'cmdline_keywords', 'ports'];
    for (const f of fields) {
        if (data[f] !== undefined && !Array.isArray(data[f])) {
            errors.push(`${f} must be array`);
        }
    }
    if (errors.length) {
        return { ok: false, error: 'invalid_schema', detail: errors.join('; ') };
    }
    // 数字字段类型检查
    if (data.pids && data.pids.some(p => !Number.isInteger(p) || p < 1)) {
        return { ok: false, error: 'pids_must_be_positive_integers' };
    }
    if (data.ports && data.ports.some(p => !Number.isInteger(p) || p < 1 || p > 65535)) {
        return { ok: false, error: 'ports_must_be_1_to_65535' };
    }
    if (data.users && data.users.some(u => typeof u !== 'string' || !u.trim())) {
        return { ok: false, error: 'users_must_be_non_empty_strings' };
    }
    return { ok: true };
}

router.get('/', (req, res) => {
    try {
        const w = whitelist.load(WHITELIST_FILE);
        res.json({ ok: true, whitelist: w });
    } catch (e) {
        res.status(500).json({ ok: false, error: 'load_failed' });
    }
});

// === BUG #4 修复：原子写（先写 .tmp，再 rename）===
function atomicWriteJson(filePath, data) {
    const tmp = filePath + '.tmp.' + process.pid + '.' + Date.now();
    try {
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, filePath);
        return true;
    } catch (e) {
        // 清理 tmp
        try { fs.unlinkSync(tmp); } catch (e2) {}
        throw e;
    }
}

router.put('/', (req, res) => {
    const v = validateWhitelist(req.body);
    if (!v.ok) return res.status(400).json({ ok: false, ...v });

    try {
        // 合并：保留未提供的字段；v1.4.0 起 config.json 统一写入 { whitelist: {...} }
        const current = whitelist.load(WHITELIST_FILE);
        const merged = { ...current, ...req.body };
        atomicWriteJson(WHITELIST_FILE, { whitelist: merged });
        // 清缓存
        whitelist.clearCache();
        res.json({ ok: true, whitelist: merged });
    } catch (e) {
        res.status(500).json({ ok: false, error: 'write_failed' });
    }
});

router.post('/reload', (req, res) => {
    whitelist.clearCache();
    res.json({ ok: true, hint: 'cache cleared' });
});

module.exports = router;
