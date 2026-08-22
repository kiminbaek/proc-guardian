// /api/whitelist 路由
// v1.0.6 BUG 修复：schema 验证 + 原子写
// v1.9.0 修 P0-1：写回时保留 config.json 的 version/ui/auth 等非 whitelist 段
//        —— 旧实现写 { whitelist: merged } 覆盖整个文件，
//           cmd/main 的 ensure_default_config 检查到缺 ui/auth 字段就备份旧文件
//           并重新生成默认配置 → 用户自定义白名单在下次重启后全部丢失。

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const whitelist = require('../whitelist');

const TRIM_PKGVAR = process.env.TRIM_PKGVAR || '/tmp';
const WHITELIST_FILE = path.join(TRIM_PKGVAR, 'config.json');

// cmd/main ensure_default_config 会检查这些顶层段是否存在，缺失即重置整份配置。
// 写回时若原文件缺这些段（老版本残留），补上默认值，避免重启被重置。
const CONFIG_DEFAULT_SECTIONS = {
    version: '1.0',
    ui: {
        refresh_interval_ms: 3000,
        page_size: 200,
        default_sort: 'cpu'
    },
    auth: {
        max_failures: 5,
        lockout_minutes: 5
    }
};

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
        // v1.9.0 修 P0-1：读整份 config.json，只替换 whitelist 段，其余原样保留
        const full = whitelist.readFullConfig(WHITELIST_FILE) || {};
        const current = whitelist.load(WHITELIST_FILE);
        const merged = { ...current, ...req.body };

        const out = { ...CONFIG_DEFAULT_SECTIONS, ...full, whitelist: merged };
        atomicWriteJson(WHITELIST_FILE, out);
        // 清缓存
        whitelist.clearCache();
        res.json({ ok: true, whitelist: merged });
    } catch (e) {
        res.status(500).json({ ok: false, error: 'write_failed' });
    }
});

router.post('/check', (req, res) => {
    const pid = parseInt(req.body.pid, 10);
    if (!Number.isFinite(pid) || pid < 1) {
        return res.status(400).json({ ok: false, error: 'invalid_pid' });
    }
    const procMod = require('../process');
    const proc = procMod.getProcessByPid(pid);
    if (!proc) return res.status(404).json({ ok: false, error: 'process_not_found' });
    const wl = whitelist.checkProcess(proc);
    res.json({ ok: true, pid, protected: wl.protected, reason: wl.reason });
});

router.post('/reload', (req, res) => {
    whitelist.clearCache();
    res.json({ ok: true, hint: 'cache cleared' });
});

module.exports = router;
