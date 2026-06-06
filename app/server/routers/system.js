// /api/system 路由
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

router.get('/', (req, res) => {
    // uptime
    const uptime = safeExec('cat /proc/uptime').split(/\s+/)[0] || '0';
    const loadavg = safeExec('cat /proc/loadavg') || os.loadavg().join(' ');

    // memory
    const memInfo = safeExec('cat /proc/meminfo');
    const memTotal = parseInt(memInfo.match(/MemTotal:\s+(\d+)/)?.[1] || 0) * 1024;
    const memAvail = parseInt(memInfo.match(/MemAvailable:\s+(\d+)/)?.[1] || 0) * 1024;
    const memUsed = memTotal - memAvail;

    // disk
    const dfOut = safeExec("df -B1 --output=source,size,used,avail,pcent /vol3 2>/dev/null || df -B1 /vol3 2>/dev/null");
    let diskInfo = { used: 0, total: 0, percent: '0%' };
    if (dfOut) {
        const lines = dfOut.split('\n').filter(l => l.startsWith('/'));
        if (lines[0]) {
            const parts = lines[0].split(/\s+/);
            diskInfo = {
                filesystem: parts[0],
                total: parseInt(parts[1] || 0),
                used: parseInt(parts[2] || 0),
                avail: parseInt(parts[3] || 0),
                percent: parts[4] || '0%'
            };
        }
    }

    // cpu count
    const cpus = os.cpus();

    // hostname / ip
    const hostname = os.hostname();
    const ipInfo = safeExec("ip -4 addr show 2>/dev/null | grep -oP 'inet \\K[\\d.]+' | head -3");

    res.json({
        ok: true,
        uptime_seconds: parseFloat(uptime) || 0,
        loadavg: loadavg,
        cpu: {
            count: cpus.length,
            model: cpus[0]?.model || 'unknown',
            usage: safeExec("top -bn1 | grep '^%Cpu' | awk '{print $2}' | head -1")
        },
        memory: {
            total: memTotal,
            used: memUsed,
            available: memAvail,
            percent: memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : 0
        },
        disk: diskInfo,
        hostname,
        ips: ipInfo.split('\n').filter(Boolean),
        node: {
            version: process.version,
            uptime: process.uptime(),
            platform: process.platform,
            arch: process.arch
        },
        timestamp: Date.now()
    });
});

router.get('/hostname', (req, res) => {
    res.json({ ok: true, hostname: os.hostname() });
});

module.exports = router;
