// proc-guardian 进程信息获取 v1.9.0
// 数据源：ps（纯数字列，不含 comm/user，避免列宽截断）+ /proc/<pid>/{comm,stat,cmdline,cwd,exe}
//
// v1.9.0 根因修复（P0-3/P0-4/P0-5/P1-6）：
//   旧实现用 `ps -eo ...,user,...,comm,args`：
//     - comm 列默认截断 15 字符 → systemd-journald 等白名单进程名匹配失效
//     - user 列默认截断 8 字符 + '+' → com.dustinky.qwenpaw → com.dus+，用户白名单失效
//     - comm 含空格时（如 "npm exec tavily"）按空白 split 字段错位
//   新实现只让 ps 输出定长数字列，进程名/用户名/内核线程标志全部从 /proc 读取。
//
// 🔴 进程名的三层真相（2026-08-22 实测）：
//   1. `ps -o comm` 列宽默认 15，会被 ps 自己截断
//   2. `/proc/<pid>/comm` 受内核 TASK_COMM_LEN=16 限制，用户态进程**同样恒截断到 15 字符**
//      实测：/proc/408/comm = "systemd-journal"（15），真名是 systemd-journald（16）
//      内核线程不受此限（内核直接设置），如 pid 427 comm 长 35 字符
//   3. 完整名唯一可靠来源 = `/proc/<pid>/exe` 的 basename（需 root，本应用 privilege run-as root）
//      实测受影响 17 个进程：systemd-journald / trim_file_monitor / network_service / ...
//   因此每个进程同时提供 comm（内核短名）和 name（尽力还原的完整名），白名单两者都匹配。

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CACHE_TTL_MS = 1500;
let cache = null;
let cacheTime = 0;

// PF_KTHREAD = 0x00200000（内核 sched.h），/proc/<pid>/stat 第 9 字段 flags
const PF_KTHREAD = 0x00200000;
// 内核 TASK_COMM_LEN=16，用户态可见 comm 最长 15 字符
const COMM_MAX_LEN = 15;

// uid -> 用户名 缓存（/etc/passwd 变动少，60s 足够）
const UID_CACHE_TTL_MS = 60_000;
let uidMap = null;
let uidMapTime = 0;

function safeReadFile(p) {
    try { return fs.readFileSync(p, 'utf8').trim(); } catch (e) { return ''; }
}

function getUidMap() {
    const now = Date.now();
    if (uidMap && (now - uidMapTime) < UID_CACHE_TTL_MS) return uidMap;
    const map = new Map();

    const feed = (raw) => {
        for (const line of String(raw).split('\n')) {
            if (!line || line.startsWith('#')) continue;
            const cols = line.split(':');
            if (cols.length < 3) continue;
            const uid = parseInt(cols[2], 10);
            if (!Number.isFinite(uid)) continue;
            if (!map.has(uid)) map.set(uid, cols[0]);
        }
    };

    // /etc/passwd：静态账号（无进程开销）
    try { feed(fs.readFileSync('/etc/passwd', 'utf8')); } catch (e) {}

    // getent passwd：补 systemd DynamicUser / LDAP / NSS 等不在 /etc/passwd 的账号
    // （实测 wsdd2 uid=61623 是 systemd Dynamic User，只有 getent 能查到）
    try {
        feed(execSync('getent passwd 2>/dev/null', { encoding: 'utf8', timeout: 3000, maxBuffer: 4 * 1024 * 1024 }));
    } catch (e) {}

    uidMap = map;
    uidMapTime = now;
    return map;
}

function userNameByUid(uid) {
    if (!Number.isFinite(uid)) return 'unknown';
    const name = getUidMap().get(uid);
    return name || String(uid);
}

/**
 * 读 /proc/<pid>/stat 的 flags 字段判定内核线程。
 * stat 格式：pid (comm) state ppid pgrp session tty tpgid flags ...
 * comm 可能含空格和括号，必须按最后一个 ') ' 切分。
 */
function readKernelFlag(pid) {
    const raw = safeReadFile(`/proc/${pid}/stat`);
    if (!raw) return null;
    const idx = raw.lastIndexOf(') ');
    if (idx < 0) return null;
    const rest = raw.slice(idx + 2).trim().split(/\s+/);
    // rest[0]=state rest[1]=ppid rest[2]=pgrp rest[3]=session rest[4]=tty rest[5]=tpgid rest[6]=flags
    const flags = parseInt(rest[6], 10);
    if (!Number.isFinite(flags)) return null;
    return (flags & PF_KTHREAD) !== 0;
}

/**
 * 还原完整进程名（修 P0-3 的真正根因）。
 * comm 达到 15 字符上限时说明可能被内核截断，用 exe basename 补全；
 * 若 exe basename 以 comm 开头则采信（避免 "npm exec tavily" → "node" 这类误替换）。
 */
function resolveFullName(comm, exe) {
    if (!comm) return exe ? path.basename(exe) : '';
    if (comm.length < COMM_MAX_LEN || !exe) return comm;
    const base = path.basename(exe);
    if (base && base.length > comm.length && base.startsWith(comm)) return base;
    return comm;
}

function getAllProcesses() {
    const now = Date.now();
    if (cache && (now - cacheTime) < CACHE_TTL_MS) return cache;

    // 只取定长数字列：PID PPID UID PRI NI VSZ RSS %CPU %MEM ETIME
    // 不取 user/comm/args —— 这些一律从 /proc 读，避免 ps 列宽截断和空格错位
    let psOut = '';
    try {
        psOut = execSync(
            'ps -eo pid,ppid,uid,pri,ni,vsz,rss,pcpu,pmem,etime --no-headers',
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
        const parts = line.trim().split(/\s+/);
        if (parts.length < 10) continue;
        const [pid, ppid, uid, pri, ni, vsz, rss, pcpu, pmem, etime] = parts;

        const pidN = parseInt(pid, 10);
        if (!Number.isFinite(pidN)) continue;
        const uidN = parseInt(uid, 10);

        // 内核短名（用户态恒 ≤15 字符；内核线程可更长）
        const comm = safeReadFile(`/proc/${pidN}/comm`);

        // /proc 增强：cmdline / cwd / exe
        let cmdline = '';
        let cwd = '';
        let exe = '';
        try {
            cmdline = safeReadFile(`/proc/${pidN}/cmdline`).replace(/\0/g, ' ').trim();
            try { cwd = fs.readlinkSync(`/proc/${pidN}/cwd`); } catch (e) {}
            try { exe = fs.readlinkSync(`/proc/${pidN}/exe`); } catch (e) {}
        } catch (e) {}

        // 内核线程判定：优先 PF_KTHREAD，读不到时用「无 cmdline 且无 exe」兜底
        let isKernel = readKernelFlag(pidN);
        if (isKernel === null) isKernel = (!cmdline && !exe);

        // args 语义与 ps 对齐：用户进程 = 完整命令行；内核线程 = [comm]
        const args = cmdline || (comm ? `[${comm}]` : '');

        // 进程可能在 ps 与 /proc 读取之间退出，无任何标识时跳过（无法判定风险）
        if (!comm && !cmdline) continue;

        const finalComm = comm || (cmdline.split(/\s+/)[0] || '');
        const fullName = resolveFullName(finalComm, exe);

        procs.push({
            pid: pidN,
            ppid: parseInt(ppid, 10) || 0,
            uid: Number.isFinite(uidN) ? uidN : -1,
            user: userNameByUid(uidN),
            pri: parseInt(pri, 10) || 0,
            ni: parseInt(ni, 10) || 0,
            vsz: parseInt(vsz, 10) || 0,
            rss: parseInt(rss, 10) || 0,
            pcpu: parseFloat(pcpu) || 0,
            pmem: parseFloat(pmem) || 0,
            etime,
            comm: finalComm,          // 内核短名（≤15，兼容旧行为）
            name: fullName,           // 尽力还原的完整名（白名单/展示优先用）
            exe_name: exe ? path.basename(exe) : '',
            args,
            cmdline: cmdline || args,
            cwd,
            exe,
            is_kernel: !!isKernel
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
    const nPid = Number(pid);
    if (nPid === 1) throw new Error('cannot_kill_pid_1');
    if (nPid === 2) throw new Error('cannot_kill_pid_2');
    if (!Number.isInteger(nPid) || nPid < 1) {
        throw new Error('invalid_pid');
    }

    // === BUG #48 修复：先检查进程存在不存在 ===
    if (!existsPid(nPid)) {
        throw new Error('process_not_found');
    }

    const sig = force ? 'SIGKILL' : signal;
    try {
        process.kill(nPid, sig);
        return { ok: true, pid: nPid, signal: sig };
    } catch (e) {
        throw new Error(`kill_failed: ${e.code || e.message}`);
    }
}

function existsPid(pid) {
    // signal 0 不发信号，只检查权限/存在
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e.code === 'EPERM';  // EPERM 表示存在但没权限
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
