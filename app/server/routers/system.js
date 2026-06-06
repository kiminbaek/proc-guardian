// /api/system 路由
// v1.0.6 BUG 修复：用 Node.js os.* 原生 API 替代 cat /proc/* 命令

const express = require('express');
const router = express.Router();
const { execSync } = require('child_process');
const os = require('os');

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
    return {
        total,        // 字节
        used,
        free,
        available: free,  // 简化版 = free
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

function getCPUUsage() {
    // top -bn1 第一行 %Cpu
    const out = safeExec("top -bn1 | grep -E '^%?Cpu' | head -1");
    if (!out) return 0;
    const m = out.match(/([\d.]+)\s*id/);
    if (m) {
        const idle = parseFloat(m[1]);
        return Math.max(0, Math.min(100, Math.round(100 - idle)));
    }
    return 0;
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
