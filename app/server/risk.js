// proc-guardian 风险分级 v1.2.0
const CORE_NAMES = new Set(['systemd', 'kthreadd']);
const FNOS_CORE_NAMES = new Set(['trim_app_center','trim_paneld','trim.helper']);
const SYSTEM_NAMES = new Set(['sshd','sshd-session','postgres','nginx','smbd','nmbd','rpcbind','dbus-daemon','systemd-journald','systemd-logind','systemd-udevd','cron','fcron','NetworkManager','polkitd','rsyslogd']);
function isKernelThread(proc) {
    const comm = proc && proc.comm || '';
    const cmd = proc && proc.cmdline || '';
    return /^\[.*\]$/.test(comm) || (!cmd.trim() && comm.startsWith('k'));
}
function classify(proc, app, wl) {
    const reasons = [];
    if (!proc) return { category: 'unknown', risk_level: 2, risk_label: '未知进程', kill_policy: 'strict', confirm_phrase: 'STOP SYSTEM PROCESS', risk_reasons: ['进程信息缺失'] };
    if (proc.pid === 1 || proc.pid === 2 || CORE_NAMES.has(proc.comm)) {
        reasons.push('PID 1/2 或核心内核进程');
        return { category: 'core', risk_level: 3, risk_label: '核心保护进程', kill_policy: 'deny', confirm_phrase: null, risk_reasons: reasons };
    }
    if (isKernelThread(proc)) {
        reasons.push('内核线程或无用户态命令行');
        return { category: 'kernel', risk_level: 3, risk_label: '内核线程', kill_policy: 'deny', confirm_phrase: null, risk_reasons: reasons };
    }
    if (FNOS_CORE_NAMES.has(proc.comm)) {
        reasons.push('飞牛核心组件进程名命中：' + proc.comm);
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
    if ((app && app.app_id === 'system') || SYSTEM_NAMES.has(proc.comm)) {
        reasons.push(app && app.app_name ? '系统服务映射：' + app.app_name : '系统进程名命中：' + proc.comm);
        return { category: 'system', risk_level: 2, risk_label: '系统进程', kill_policy: 'strict', confirm_phrase: 'STOP SYSTEM PROCESS', risk_reasons: reasons };
    }
    if (proc.user === 'root') {
        reasons.push('root 高权限进程；未命中核心/系统/应用硬保护');
        return { category: 'root_user', risk_level: 1, risk_label: 'root 高权限进程', kill_policy: 'warn', confirm_phrase: 'STOP ROOT PROCESS', risk_reasons: reasons };
    }
    reasons.push('普通用户进程');
    return { category: 'user', risk_level: 0, risk_label: '用户进程', kill_policy: 'normal', confirm_phrase: null, risk_reasons: reasons };
}
module.exports = { classify, isKernelThread };
