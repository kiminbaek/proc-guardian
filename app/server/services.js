// proc-guardian systemd 服务管理
// v1.0.6 BUG 修复：timeout 缩到 5s + list-units 失败不 cache + 错误信息完整

const { execSync } = require('child_process');

const CACHE_TTL_MS = 2000;
let cache = null;
let cacheTime = 0;

// === BUG #30 修复：timeout 10000 -> 5000ms（fail fast）===
function execSystemctl(args, timeout = 5000) {
    try {
        return execSync(`systemctl ${args}`, { encoding: 'utf8', timeout });
    } catch (e) {
        // === BUG #28 修复：完整错误信息（stdout + stderr）===
        const stdout = e.stdout ? e.stdout.toString() : '';
        const stderr = e.stderr ? e.stderr.toString() : '';
        // 把 stderr 拼到 stdout（不丢失信息）
        return (stdout + (stderr ? '\n' + stderr : '')).trim();
    }
}

function parseListUnits(out) {
    const lines = out.split('\n');
    const result = [];
    let inBody = false;
    for (const line of lines) {
        if (line.startsWith('UNIT ')) { inBody = true; continue; }
        if (!inBody) continue;
        if (!line.trim()) continue;
        const parts = line.trim().split(/\s{2,}/);
        if (parts.length < 4) continue;
        const [unit, load, active, sub, ...descParts] = parts;
        const pidMatch = unit.match(/\.service$/);
        result.push({
            unit,
            load,
            active,
            sub,
            description: descParts.join(' '),
            is_service: !!pidMatch
        });
    }
    return result;
}

function getAllServices() {
    const now = Date.now();
    if (cache && (now - cacheTime) < CACHE_TTL_MS) return cache;

    const out = execSystemctl('list-units --type=service --all --no-pager');
    const services = parseListUnits(out);

    // === BUG #29 修复：list-units 失败/空时返旧 cache，不更新 cacheTime（让下次重试）===
    if (services.length === 0) {
        return cache || [];
    }

    // 拿 main pid（只对 active 状态）
    for (const s of services) {
        if (s.active === 'active' && s.sub === 'running') {
            try {
                const propOut = execSystemctl(`show ${s.unit} --property=MainPID --no-pager`, 3000);
                const m = propOut.match(/MainPID=(\d+)/);
                if (m && m[1] !== '0') s.main_pid = parseInt(m[1], 10);
            } catch (e) {}
        }
    }

    cache = services;
    cacheTime = now;
    return cache;
}

function serviceAction(unit, action) {
    const allowed = ['start', 'stop', 'restart', 'disable', 'enable'];
    if (!allowed.includes(action)) throw new Error(`invalid_action: ${action}`);
    if (!/^[\w@.-]+\.service$/.test(unit)) throw new Error(`invalid_unit_name: ${unit}`);
    try {
        const out = execSync(`systemctl ${action} ${unit}`, { encoding: 'utf8', timeout: 15000 });
        return { ok: true, unit, action, output: out.trim() };
    } catch (e) {
        const stderr = e.stderr ? e.stderr.toString() : '';
        const stdout = e.stdout ? e.stdout.toString() : '';
        throw new Error(`systemctl_${action}_failed: ${stderr || stdout || e.message}`);
    }
}

function getServiceLogs(unit, lines = 100) {
    if (!/^[\w@.-]+\.service$/.test(unit)) throw new Error(`invalid_unit_name: ${unit}`);
    try {
        const out = execSync(
            `journalctl -u ${unit} -n ${lines} --no-pager -o short 2>/dev/null`,
            { encoding: 'utf8', timeout: 10000 }
        );
        return out;
    } catch (e) {
        return e.stdout ? e.stdout.toString() : '';
    }
}

function clearCache() {
    cache = null;
    cacheTime = 0;
}

// === 兼容旧 API（routers/services.js 用了 listUnits + getStatus）===
async function listUnits() {
    const services = getAllServices();
    return { services, total: services.length };
}

async function getStatus(unit) {
    if (!/^[\w@.-]+\.service$/.test(unit)) throw new Error(`invalid_unit_name: ${unit}`);
    const out = execSystemctl(`is-active ${unit}`, 3000);
    return out.trim() || 'unknown';
}

async function action(unit, actionName) {
    return serviceAction(unit, actionName);
}

module.exports = {
    getAllServices,
    serviceAction,
    getServiceLogs,
    clearCache,
    listUnits,
    getStatus,
    action
};
