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
    // v1.9.0 修「系统服务页永远空白」+「load/active/sub 列错位」：
    //
    //   Bug ①（页面空白）：旧判据 `line.startsWith('UNIT ')` 用来定位表头，
    //     但实测表头是 "  UNIT  LOAD  ACTIVE  SUB  DESCRIPTION"（有 2 个前导空格），
    //     永远匹配不到 → inBody 恒 false → 返回空数组 → getAllServices() 返回 []
    //     → 系统服务页从来只显示"无匹配系统服务"。浏览器实测确认。
    //
    //   Bug ②（列错位）：旧实现用 split(/\s{2,}/)（2 个以上空格分列），
    //     但 not-found 单元的输出是 "not-found inactive   dead"，
    //     load 与 active 之间只有 1 个空格 →
    //     解析成 ["not-found inactive", "dead", ...]，active/sub 全错位。
    //
    //   改法：调用侧加 `--plain --no-legend`（无标记符、无表头、无尾部图例），
    //   这里按单/多空格统一切分，前 4 列固定，其余拼成描述。
    const result = [];
    for (const raw of out.split('\n')) {
        const line = raw.replace(/\r$/, '')
            // 兜底：万一没带 --plain，剥掉行首状态标记（● ○ × ↻ * → 等）
            .replace(/^[\s\u25cf\u25cb\u00d7\u21bb\u2500*\u2192>]+/, '')
            .trim();
        if (!line) continue;
        // 兜底：跳过表头与图例行
        if (/^UNIT\s+LOAD\b/.test(line)) continue;
        if (/^(LOAD|ACTIVE|SUB)\s*=/.test(line)) continue;
        if (/^\d+\s+(loaded|units)/.test(line)) continue;
        if (/^To show all installed unit files/.test(line)) continue;

        const parts = line.split(/\s+/);
        if (parts.length < 4) continue;
        const [unit, load, active, sub] = parts;
        if (!/\.(service|socket|target|timer|mount|path)$/.test(unit)) continue;

        result.push({
            unit,
            load,
            active,
            sub,
            description: parts.slice(4).join(' ') || unit,
            is_service: /\.service$/.test(unit)
        });
    }
    return result;
}

function getAllServices() {
    const now = Date.now();
    if (cache && (now - cacheTime) < CACHE_TTL_MS) return cache;

    // v1.9.0：加 --plain --no-legend，输出无标记符/无表头/无尾部图例，解析更稳
    const out = execSystemctl('list-units --type=service --all --no-pager --plain --no-legend');
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
    const n = Math.min(2000, Math.max(1, parseInt(lines, 10) || 100));
    try {
        // unit 已通过正则白名单校验，n 已转成整数，无注入风险
        const out = execSync(
            `journalctl -u ${unit} -n ${n} --no-pager -o short 2>/dev/null`,
            { encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024 }
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
