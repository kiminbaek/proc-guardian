// proc-guardian 白名单校验
// API 层强制拦截：PID 1、白名单内 PID/用户/进程名/cmdline 关键字
// v1.0.6：新增 load() 函数 + 加载失败不写回默认值

const fs = require('fs');
const path = require('path');

const TRIM_PKGVAR = process.env.TRIM_PKGVAR || '/tmp';
const CONFIG_FILE = path.join(TRIM_PKGVAR, 'config.json');

let cache = null;
let cacheTime = 0;
const CACHE_TTL_MS = 5000;

const DEFAULT_WHITELIST = {
    pids: [1, 2],
    users: [],
    process_names: [],
    cmdline_keywords: [],
    ports: []
};

function readConfig() {
    const now = Date.now();
    if (cache && (now - cacheTime) < CACHE_TTL_MS) return cache;
    try {
        const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
        cache = JSON.parse(raw);
        cacheTime = now;
        return cache;
    } catch (e) {
        // 加载失败：返内存默认值（不写回 config.json）
        return { whitelist: { ...DEFAULT_WHITELIST } };
    }
}

// === BUG 修复：暴露 load 函数给 routers 调用 ===
function load(configFile) {
    const file = configFile || CONFIG_FILE;
    try {
        const raw = fs.readFileSync(file, 'utf8');
        const data = JSON.parse(raw);
        // 合并默认值（确保所有字段都存在）
        return {
            ...DEFAULT_WHITELIST,
            ...(data.whitelist || data)
        };
    } catch (e) {
        return { ...DEFAULT_WHITELIST };
    }
}

function clearCache() {
    cache = null;
    cacheTime = 0;
}

/**
 * 检查一个进程是否被白名单保护
 * @param {Object} proc { pid, user, comm, cmdline }
 * @returns {Object} { protected: bool, reason: string }
 */
function checkProcess(proc) {
    const cfg = readConfig();
    const wl = cfg.whitelist || {};

    // 1) PID 1/2 永远保护
    if (proc.pid === 1) return { protected: true, reason: 'pid_1_systemd' };
    if (proc.pid === 2) return { protected: true, reason: 'pid_2_kthreadd' };

    // 2) PID 白名单
    if (Array.isArray(wl.pids) && wl.pids.includes(proc.pid)) {
        return { protected: true, reason: `pid_in_whitelist` };
    }

    // 3) 用户白名单
    if (Array.isArray(wl.users) && wl.users.includes(proc.user)) {
        return { protected: true, reason: `user:${proc.user}` };
    }

    // 4) 进程名白名单
    if (Array.isArray(wl.process_names) && proc.comm) {
        for (const name of wl.process_names) {
            if (proc.comm === name) {
                return { protected: true, reason: `name:${name}` };
            }
        }
    }

    // 5) cmdline 关键字白名单
    if (Array.isArray(wl.cmdline_keywords) && proc.cmdline) {
        for (const kw of wl.cmdline_keywords) {
            if (proc.cmdline.includes(kw)) {
                return { protected: true, reason: `cmdline:${kw}` };
            }
        }
    }

    return { protected: false, reason: null };
}

function checkPort(port) {
    const cfg = readConfig();
    const wl = cfg.whitelist || {};
    if (Array.isArray(wl.ports) && wl.ports.includes(Number(port))) {
        return { protected: true, reason: `port_in_whitelist` };
    }
    return { protected: false, reason: null };
}

module.exports = {
    readConfig,
    load,
    clearCache,
    checkProcess,
    checkPort
};
