// proc-guardian systemd 服务管理

const { execSync, exec } = require('child_process');

const CACHE_TTL_MS = 2000;
let cache = null;
let cacheTime = 0;

function execSystemctl(args, timeout = 10000) {
    try {
        return execSync(`systemctl ${args}`, { encoding: 'utf8', timeout });
    } catch (e) {
        return e.stdout ? e.stdout.toString() : '';
    }
}

function parseListUnits(out) {
    // systemctl list-units --type=service --all --no-pager
    // 格式：UNIT LOAD ACTIVE SUB DESCRIPTION
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
        // 抓 main pid
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

    // 拿 main pid
    for (const s of services) {
        if (s.active === 'active' && s.sub === 'running') {
            try {
                const propOut = execSystemctl(`show ${s.unit} --property=MainPID --no-pager`);
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
    // action: start | stop | restart | disable | enable
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

module.exports = {
    getAllServices,
    serviceAction,
    getServiceLogs,
    clearCache
};
