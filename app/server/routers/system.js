// /api/system 路由
// v1.0.6 BUG 修复：用 Node.js os.* 原生 API 替代 cat /proc/* 命令
// v1.9.0：CPU 使用率改 /proc/stat 差值 + 2s 缓存（原本每次 spawn 3 个进程）

const express = require('express');
const router = express.Router();
const { execSync } = require('child_process');
const os = require('os');
const fs = require('fs');

function safeExec(cmd, timeout = 5000) {
    try {
        return execSync(cmd, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 }).trim();
    } catch (e) {
        return '';
    }
}

// === BUG #7/#24/#25 修复：用 os.* 原生 API ===
// loadavg 返回字符串 "0.5 0.3 0.2"（保持前端兼容，escapeHtml 字符串）
function getLoadavgString() {
    try {
        const a = os.loadavg();
        return a.slice(0, 3).map(v => v.toFixed(2)).join(' ');
    } catch (e) {
        return '0.00 0.00 0.00';
    }
}

function getMemoryInfo() {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    // v1.0.8 修：读 /proc/meminfo 的 MemAvailable（比 free 更准确）
    let available = free;
    try {
        const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
        const m = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/);
        if (m) {
            available = parseInt(m[1], 10) * 1024;  // kB → bytes
        }
    } catch (e) {}
    return {
        total,        // 字节
        used,
        free,
        available,     // 真实可用（含 cache/buffer）
        percent: total > 0 ? Math.round((used / total) * 100) : 0
    };
}

function getDiskInfo() {
    const out = safeExec("df -B1 /vol3 2>/dev/null | tail -1");
    if (!out) {
        return { filesystem: 'unknown', total: 0, used: 0, avail: 0, percent: '0%' };
    }
    const parts = out.split(/\s+/);
    return {
        filesystem: parts[0] || 'unknown',
        total: parseInt(parts[1] || 0),
        used: parseInt(parts[2] || 0),
        avail: parseInt(parts[3] || 0),
        percent: parts[4] || '0%'
    };
}

// v1.9.0：CPU 使用率改用 /proc/stat 差值计算 + 2s 缓存
//
// 旧实现每次 spawn `top -bn1 | grep | head`（3 个进程），而 /api/system 被前端
// 5 秒轮询、dashboard 还会并发调一次，等于每 5 秒起 6 个短命进程。
// 讽刺的是本应用自己就是进程管家，反而在制造进程噪音。
// /proc/stat 是纯文件读，零进程开销，且差值法比 top 单帧快照更准。
const CPU_CACHE_TTL_MS = 2000;
let cpuCache = { value: 0, at: 0 };
let cpuPrev = null;   // { total, idle }

function readCpuStat() {
    try {
        const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
        // cpu  user nice system idle iowait irq softirq steal guest guest_nice
        const f = line.trim().split(/\s+/).slice(1).map(Number);
        if (f.length < 5 || f.some(n => !Number.isFinite(n))) return null;
        const idle = f[3] + f[4];                       // idle + iowait
        const total = f.reduce((a, b) => a + b, 0);
        return { total, idle };
    } catch (e) {
        return null;
    }
}

function getCPUUsage() {
    const now = Date.now();
    if (cpuCache.at && (now - cpuCache.at) < CPU_CACHE_TTL_MS) return cpuCache.value;

    const cur = readCpuStat();
    if (!cur) return cpuCache.value;

    let pct = cpuCache.value;
    if (cpuPrev) {
        const dTotal = cur.total - cpuPrev.total;
        const dIdle = cur.idle - cpuPrev.idle;
        if (dTotal > 0) pct = Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 100)));
    } else {
        // 首次调用没有前值，用 os.loadavg 粗估，避免显示 0
        try {
            const cores = require('os').cpus().length || 1;
            pct = Math.max(0, Math.min(100, Math.round((require('os').loadavg()[0] / cores) * 100)));
        } catch (e) {}
    }
    cpuPrev = cur;
    cpuCache = { value: pct, at: now };
    return pct;
}

function getIps() {
    const out = safeExec("ip -4 addr show 2>/dev/null | grep -oP 'inet \\K[\\d.]+' | grep -v '^127\\.' | head -5");
    return out.split('\n').filter(Boolean);
}

function getCpuTemp() {
    // 飞牛 / NAS 设备通常没有标准温感接口，兜底返 N/A
    const out = safeExec("cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null | head -1");
    if (!out) return null;
    const t = parseInt(out);
    return Number.isFinite(t) ? Math.round(t / 1000) : null;
}

router.get('/', (req, res) => {
    try {
        const cpus = os.cpus() || [];
        const cpuInfo = {
            count: cpus.length,
            model: (cpus[0] && cpus[0].model) || 'unknown',
            usage: getCPUUsage()
        };

        const memInfo = getMemoryInfo();
        const diskInfo = getDiskInfo();

        res.json({
            ok: true,
            timestamp: Date.now(),
            uptime_seconds: os.uptime(),         // 秒（os.uptime 原生）
            loadavg: getLoadavgString(),          // 字符串（前端兼容）
            cpu: cpuInfo,
            memory: memInfo,
            disk: diskInfo,
            hostname: os.hostname(),
            ips: getIps(),
            cpu_temp_c: getCpuTemp(),
            node: {
                version: process.version,
                platform: process.platform,
                arch: process.arch,
                uptime: process.uptime()
            }
        });
    } catch (e) {
        res.status(500).json({ ok: false, error: 'system_query_failed' });
    }
});

module.exports = router;
