// proc-guardian 进程信息获取
// 解析 `ps` 和 `/proc/<pid>` 输出

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CACHE_TTL_MS = 1500;
let cache = null;
let cacheTime = 0;

function safeReadFile(p) {
    try { return fs.readFileSync(p, 'utf8').trim(); } catch (e) { return ''; }
}

function getAllProcesses() {
    const now = Date.now();
    if (cache && (now - cacheTime) < CACHE_TTL_MS) return cache;

    // ps 输出列：PID PPID USER PRI NI VSZ RSS %CPU %MEM ETIME COMM ARGS
    let psOut = '';
    try {
        psOut = execSync(
            'ps -eo pid,ppid,user,pri,ni,vsz,rss,pcpu,pmem,etime,comm,args --no-headers',
            { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 5000 }
        );
    } catch (e) {
        console.error('ps exec failed:', e.message);
        cache = [];
        cacheTime = now;
        return cache;
    }

    const lines = psOut.split('\n');
    const procs = [];
    for (const line of lines) {
        if (!line.trim()) continue;
        // 简单 split by whitespace（ps 输出的 ARGS 可能含空格，所以前 11 列固定）
        const parts = line.trim().split(/\s+/);
        if (parts.length < 11) continue;
        const [pid, ppid, user, pri, ni, vsz, rss, pcpu, pmem, etime, comm] = parts;
        const args = parts.slice(11).join(' ');

        const pidN = parseInt(pid, 10);
        if (!Number.isFinite(pidN)) continue;

        // /proc 增强：cmdline / cwd / exe
        let cmdline = '';
        let cwd = '';
        let exe = '';
        try {
            cmdline = safeReadFile(`/proc/${pidN}/cmdline`).replace(/\0/g, ' ').trim();
            cwd = safeReadFile(`/proc/${pidN}/cwd`);
            if (!cwd) {
                try { cwd = fs.readlinkSync(`/proc/${pidN}/cwd`); } catch (e) {}
            }
            try { exe = fs.readlinkSync(`/proc/${pidN}/exe`); } catch (e) {}
        } catch (e) {}

        procs.push({
            pid: pidN,
            ppid: parseInt(ppid, 10) || 0,
            user,
            pri: parseInt(pri, 10) || 0,
            ni: parseInt(ni, 10) || 0,
            vsz: parseInt(vsz, 10) || 0,
            rss: parseInt(rss, 10) || 0,
            pcpu: parseFloat(pcpu) || 0,
            pmem: parseFloat(pmem) || 0,
            etime,
            comm,
            args: args || comm,
            cmdline: cmdline || args || comm,
            cwd,
            exe
        });
    }

    cache = procs;
    cacheTime = now;
    return procs;
}

function getProcessByPid(pid) {
    const all = getAllProcesses();
    return all.find(p => p.pid === Number(pid)) || null;
}

function killProcess(pid, signal = 'SIGTERM', force = false) {
    if (Number(pid) === 1) throw new Error('cannot_kill_pid_1');
    if (Number(pid) === 2) throw new Error('cannot_kill_pid_2');
    const sig = force ? 'SIGKILL' : signal;
    try {
        process.kill(Number(pid), sig);
        return { ok: true, pid: Number(pid), signal: sig };
    } catch (e) {
        throw new Error(`kill_failed: ${e.code || e.message}`);
    }
}

function clearCache() {
    cache = null;
    cacheTime = 0;
}

module.exports = {
    getAllProcesses,
    getProcessByPid,
    killProcess,
    clearCache
};
