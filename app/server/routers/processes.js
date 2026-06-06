// /api/processes 路由
const express = require('express');
const router = express.Router();

const procMod = require('../process');
const portsMod = require('../ports');
const wlMod = require('../whitelist');

// GET /api/processes?sort=cpu|mem|pid&order=desc|asc&search=xxx&page=1&size=200
router.get('/', (req, res) => {
    let procs = procMod.getAllProcesses();

    // 搜索（命令/用户/PID）
    const search = (req.query.search || '').toString().toLowerCase().trim();
    if (search) {
        procs = procs.filter(p =>
            String(p.pid).includes(search) ||
            (p.user && p.user.toLowerCase().includes(search)) ||
            (p.comm && p.comm.toLowerCase().includes(search)) ||
            (p.cmdline && p.cmdline.toLowerCase().includes(search)) ||
            (p.args && p.args.toLowerCase().includes(search))
        );
    }

    // 用户过滤
    if (req.query.user) {
        procs = procs.filter(p => p.user === req.query.user);
    }

    // 关联端口
    const portMap = {};   // pid -> [port]
    for (const port of portsMod.getAllListeningPorts()) {
        if (port.pid) {
            if (!portMap[port.pid]) portMap[port.pid] = [];
            portMap[port.pid].push({ port: port.port, proto: port.proto });
        }
    }

    // 标注白名单保护
    const enriched = procs.map(p => {
        const wl = wlMod.checkProcess(p);
        return {
            pid: p.pid,
            ppid: p.ppid,
            user: p.user,
            pri: p.pri,
            ni: p.ni,
            vsz: p.vsz,
            rss: p.rss,
            pcpu: p.pcpu,
            pmem: p.pmem,
            etime: p.etime,
            comm: p.comm,
            cmdline: p.cmdline,
            args: p.args,
            cwd: p.cwd,
            exe: p.exe,
            ports: portMap[p.pid] || [],
            protected: wl.protected,
            protected_reason: wl.reason
        };
    });

    // 排序
    const sort = (req.query.sort || 'cpu').toString();
    const order = (req.query.order || 'desc').toString();
    const sortField = { cpu: 'pcpu', mem: 'pmem', pid: 'pid', user: 'user', name: 'comm' }[sort] || 'pcpu';
    enriched.sort((a, b) => {
        const av = a[sortField], bv = b[sortField];
        if (typeof av === 'number' && typeof bv === 'number') {
            return order === 'asc' ? av - bv : bv - av;
        }
        return order === 'asc'
            ? String(av).localeCompare(String(bv))
            : String(bv).localeCompare(String(av));
    });

    // 分页
    const size = Math.min(1000, parseInt(req.query.size) || 200);
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const start = (page - 1) * size;
    const paged = enriched.slice(start, start + size);

    res.json({
        ok: true,
        total: enriched.length,
        page,
        size,
        processes: paged
    });
});

// GET /api/processes/:pid
router.get('/:pid', (req, res) => {
    const p = procMod.getProcessByPid(req.params.pid);
    if (!p) return res.status(404).json({ ok: false, error: 'process_not_found' });
    const wl = wlMod.checkProcess(p);
    res.json({ ok: true, process: { ...p, protected: wl.protected, protected_reason: wl.reason } });
});

// POST /api/processes/kill { pid, signal?, force?, confirm? }
router.post('/kill', (req, res) => {
    const pid = parseInt(req.body.pid, 10);
    if (!Number.isFinite(pid) || pid <= 0) {
        return res.status(400).json({ ok: false, error: 'invalid_pid' });
    }
    if (pid === 1) return res.status(403).json({ ok: false, error: 'cannot_kill_pid_1' });
    if (pid === 2) return res.status(403).json({ ok: false, error: 'cannot_kill_pid_2' });

    const proc = procMod.getProcessByPid(pid);
    if (!proc) return res.status(404).json({ ok: false, error: 'process_not_found' });

    const wl = wlMod.checkProcess(proc);
    if (wl.protected) {
        if (req.body.confirm !== 'FORCE') {
            return res.status(403).json({
                ok: false,
                error: 'whitelist_protected',
                reason: wl.reason,
                hint: '传 confirm:"FORCE" 强制结束（谨慎）'
            });
        }
    }

    const sig = (req.body.signal || 'SIGTERM').toString();
    const force = req.body.force === true;

    try {
        const result = procMod.killProcess(pid, sig, force);
        res.json({ ok: true, ...result });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// POST /api/processes/kill-by-name { name, confirm? }
// 按进程名批量杀（用于"清掉所有 mihomo"这种场景）
router.post('/kill-by-name', (req, res) => {
    const name = (req.body.name || '').toString().trim();
    if (!name) return res.status(400).json({ ok: false, error: 'no_name' });

    const all = procMod.getAllProcesses().filter(p => p.comm === name);
    if (all.length === 0) return res.json({ ok: true, killed: 0, skipped: 0 });

    const skipped = [];
    const targets = [];
    for (const p of all) {
        const wl = wlMod.checkProcess(p);
        if (wl.protected) {
            skipped.push({ pid: p.pid, reason: wl.reason });
        } else {
            targets.push(p);
        }
    }

    if (targets.length > 0 && req.body.confirm !== 'YES') {
        return res.json({
            ok: false,
            needs_confirm: true,
            targets: targets.map(p => ({ pid: p.pid, comm: p.comm, user: p.user, cmdline: p.cmdline })),
            skipped
        });
    }

    const killed = [];
    const failed = [];
    for (const p of targets) {
        try {
            procMod.killProcess(p.pid, 'SIGTERM', false);
            killed.push(p.pid);
        } catch (e) {
            failed.push({ pid: p.pid, error: e.message });
        }
    }

    // === BUG #17 修复：1s 后还活着的发 SIGKILL 兜底 ===
    if (killed.length > 0) {
        setTimeout(() => {
            for (const pid of killed) {
                try {
                    process.kill(pid, 0);  // 检查进程还在不在
                } catch (e) {
                    continue;  // 已退出
                }
                try {
                    procMod.killProcess(pid, 'SIGKILL', true);
                } catch (e) {
                    // SIGKILL 失败记日志（不强阻）
                }
            }
        }, 1000).unref();
    }

    res.json({ ok: true, killed, failed, skipped, force_kill_after_ms: 1000 });
});

module.exports = router;
