// proc-guardian 设置持久化
// v1.4.0：设置写入 TRIM_PKGVAR/settings.json，支持导入/导出

const fs = require('fs');
const path = require('path');

const TRIM_PKGVAR = process.env.TRIM_PKGVAR || '/tmp';
const SETTINGS_FILE = path.join(TRIM_PKGVAR, 'settings.json');

const DEFAULT_SETTINGS = {
    theme: 'system',
    compact: false,
    homeTab: 'dashboard',
    cmdWidth: 'normal',
    autoRefresh: {
        processes: true,
        ports: true,
        services: true
    },
    refreshInterval: {
        processes: 3000,
        ports: 3000,
        services: 5000
    }
};

function cloneDefault() {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

function normalize(input) {
    const base = cloneDefault();
    const src = input && typeof input === 'object' ? input : {};
    const out = {
        ...base,
        ...src,
        autoRefresh: { ...base.autoRefresh, ...(src.autoRefresh || {}) },
        refreshInterval: { ...base.refreshInterval, ...(src.refreshInterval || {}) }
    };
    if (!['system', 'light', 'dark'].includes(out.theme)) out.theme = 'system';
    if (!['dashboard','apps','processes','ports','services','audit','system','whitelist','settings'].includes(out.homeTab)) out.homeTab = 'dashboard';
    if (!['normal', 'wide', 'compact'].includes(out.cmdWidth)) out.cmdWidth = 'normal';
    out.compact = !!out.compact;
    out.autoRefresh.processes = !!out.autoRefresh.processes;
    out.autoRefresh.ports = !!out.autoRefresh.ports;
    out.autoRefresh.services = !!out.autoRefresh.services;
    for (const k of ['processes','ports','services']) {
        const n = parseInt(out.refreshInterval[k], 10);
        out.refreshInterval[k] = Number.isFinite(n) ? Math.max(1000, Math.min(60000, n)) : base.refreshInterval[k];
    }
    return out;
}

function ensureDir(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function atomicWriteJson(filePath, data) {
    ensureDir(filePath);
    const tmp = filePath + '.tmp.' + process.pid + '.' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
}

function load() {
    try {
        const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
        return normalize(JSON.parse(raw));
    } catch (e) {
        return cloneDefault();
    }
}

function save(data) {
    const normalized = normalize(data);
    atomicWriteJson(SETTINGS_FILE, normalized);
    return normalized;
}

function reset() {
    const d = cloneDefault();
    atomicWriteJson(SETTINGS_FILE, d);
    return d;
}

module.exports = { DEFAULT_SETTINGS, SETTINGS_FILE, load, save, reset, normalize };
