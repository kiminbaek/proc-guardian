// proc-guardian 风险分级 v1.9.0
const CORE_NAMES = new Set(['systemd', 'kthreadd']);
const FNOS_CORE_NAMES = new Set(['trim_app_center','trim_paneld','trim.helper']);
const SYSTEM_NAMES = new Set(['sshd','sshd-session','postgres','nginx','smbd','nmbd','rpcbind','dbus-daemon','systemd-journald','systemd-logind','systemd-udevd','cron','fcron','NetworkManager','polkitd','rsyslogd']);

/**
 * 取进程的候选名集合（v1.9.0）。
 * comm 受内核 TASK_COMM_LEN=16 限制恒 ≤15 字符，
 * SYSTEM_NAMES 里的 systemd-journald(16) 必须靠 name/exe_name 才能命中。
 */
function nameCandidates(proc) {
    if (!proc) return [];
    return [proc.comm, proc.name, proc.exe_name].filter(Boolean);
}
function hitsSet(proc, set) {
    for (const n of nameCandidates(proc)) if (set.has(n)) return n;
    return null;
}

/**
 * 内核线程判定 v1.9.0（修 P0-5）
 *
 * 旧实现两条判据在真实环境都不成立：
 *   1) /^\[.*\]$/.test(comm) —— 方括号只出现在 ps 的 args 列，comm 里没有
 *   2) !cmdline.trim() && comm.startsWith('k') —— process.js 把 cmdline 兜底成 args，永不为空
 * 实测后果：103 个 kworker 全被判成 root_user/warn 而非 kernel/deny。
 *
 * 新实现优先用 process.js 从 /proc/<pid>/stat flags 解析出的 PF_KTHREAD（权威标志），
 * 再保留字符串兜底以兼容外部直接调用 classify() 且未带 is_kernel 的场景。
 */
function isKernelThread(proc) {
    if (!proc) return false;
    // 权威来源：/proc/<pid>/stat 的 PF_KTHREAD 位（process.js 已解析）
    if (typeof proc.is_kernel === 'boolean') return proc.is_kernel;
    // 兜底 1：ps 风格的 args 被方括号包裹
    const args = (proc.args || '').trim();
    if (/^\[.*\]$/.test(args)) return true;
    // 兜底 2：comm 被方括号包裹（部分 ps 实现）
    const comm = (proc.comm || '').trim();
    if (/^\[.*\]$/.test(comm)) return true;
    // 兜底 3：无可执行文件路径且无真实命令行
    if (!proc.exe && !args) return true;
    return false;
}
function classify(proc, app, wl) {
    const reasons = [];
    if (!proc) return { category: 'unknown', risk_level: 2, risk_label: '未知进程', kill_policy: 'strict', confirm_phrase: 'STOP SYSTEM PROCESS', risk_reasons: ['进程信息缺失'] };
    const coreHit = hitsSet(proc, CORE_NAMES);
    if (proc.pid === 1 || proc.pid === 2 || coreHit) {
        reasons.push('PID 1/2 或核心内核进程');
        return { category: 'core', risk_level: 3, risk_label: '核心保护进程', kill_policy: 'deny', confirm_phrase: null, risk_reasons: reasons };
    }
    if (isKernelThread(proc)) {
        reasons.push('内核线程（/proc stat PF_KTHREAD 标志）');
        return { category: 'kernel', risk_level: 3, risk_label: '内核线程', kill_policy: 'deny', confirm_phrase: null, risk_reasons: reasons };
    }
    const fnosHit = hitsSet(proc, FNOS_CORE_NAMES);
    if (fnosHit) {
        reasons.push('飞牛核心组件进程名命中：' + fnosHit);
        return { category: 'core', risk_level: 3, risk_label: '飞牛核心组件', kill_policy: 'deny', confirm_phrase: null, risk_reasons: reasons };
    }
    if (wl && wl.protected) {
        reasons.push('命中硬保护白名单：' + (wl.reason || 'unknown'));
        return { category: 'protected', risk_level: 3, risk_label: '白名单保护进程', kill_policy: 'deny', confirm_phrase: null, risk_reasons: reasons };
    }
    if (app && app.app_id && app.app_id !== 'system') {
        reasons.push('命中 fnOS 应用归属：' + (app.app_name || app.app_id));
        if (proc.user === 'root') reasons.push('进程用户为 root，仅作为高权限提示');
        return { category: 'fnos_app', risk_level: 1, risk_label: '飞牛应用进程', kill_policy: 'warn', confirm_phrase: 'STOP APP PROCESS', risk_reasons: reasons };
    }
    const sysHit = hitsSet(proc, SYSTEM_NAMES);
    if ((app && app.app_id === 'system') || sysHit) {
        reasons.push(app && app.app_name ? '系统服务映射：' + app.app_name : '系统进程名命中：' + sysHit);
        return { category: 'system', risk_level: 2, risk_label: '系统进程', kill_policy: 'strict', confirm_phrase: 'STOP SYSTEM PROCESS', risk_reasons: reasons };
    }
    if (proc.user === 'root') {
        reasons.push('root 高权限进程；未命中核心/系统/应用硬保护');
        return { category: 'root_user', risk_level: 1, risk_label: 'root 高权限进程', kill_policy: 'warn', confirm_phrase: 'STOP ROOT PROCESS', risk_reasons: reasons };
    }
    reasons.push('普通用户进程');
    return { category: 'user', risk_level: 0, risk_label: '用户进程', kill_policy: 'normal', confirm_phrase: null, risk_reasons: reasons };
}
module.exports = { classify, isKernelThread, nameCandidates };
