// /api/processes 路由
// v1.1.0：应用名 + 端口 + 父子进程 + 风险分级
// v1.9.0 修 P1-8：应用归属统一走 appresolve 公共模块，列表与 kill 判定一致

const express = require('express');
const router = express.Router();

const procMod = require('../process');
const portsMod = require('../ports');
const wlMod = require('../whitelist');
const appnames = require('../appnames');
const appresolve = require('../appresolve');
const risk = require('../risk');
const audit = require('../audit');

// GET /api/processes?sort=cpu|mem|pid&order=desc|asc&search=xxx&page=1&size=200
router.get('/', (req, res) => {
    let procs = procMod.getAllProcesses();
    const allProcs = procs;
    const resolver = appresolve.createResolver(allProcs);
    const byPidAll = resolver.byPid;
    const appForAll = (proc) => resolver.resolve(proc);

    // 搜索（命令/用户/PID/应用名/完整进程名）
    const search = (req.query.search || '').toString().toLowerCase().trim();
    if (search) {
        procs = procs.filter(p => {
            const app = appForAll(p);
            return String(p.pid).includes(search) ||
                (p.user && p.user.toLowerCase().includes(search)) ||
                (p.comm && p.comm.toLowerCase().includes(search)) ||
                (p.name && p.name.toLowerCase().includes(search)) ||
                (p.exe_name && p.exe_name.toLowerCase().includes(search)) ||
                (p.cmdline && p.cmdline.toLowerCase().includes(search)) ||
                (p.args && p.args.toLowerCase().includes(search)) ||
                (app && app.app_name && app.app_name.toLowerCase().includes(search)) ||
                (app && app.app_id && app.app_id.toLowerCase().includes(search));
        });
    }

    // 用户过滤
    if (req.query.user) {
        procs = procs.filter(p => p.user === req.query.user);
    }

    // 关联端口（展开全部字段）
    const portMap = {};   // pid -> [port]
    for (const port of portsMod.getAllListeningPorts()) {
        if (port.pid) {
            if (!portMap[port.pid]) portMap[port.pid] = [];
            portMap[port.pid].push({
                port: port.port,
                proto: port.proto,
                state: port.state,
                address: port.address,
                process_name: port.process_name,
                fds: port.fds
            });
        }
    }

    const byPid = new Map(procs.map(x => [x.pid, x]));
    const childMap = {};
    for (const cp of procs) {
        if (!childMap[cp.ppid]) childMap[cp.ppid] = [];
        childMap[cp.ppid].push(cp);
    }

    // 标注白名单保护 + 应用名 + 父子进程 + 风险
    const enriched = procs.map(p => {
        const wl = wlMod.checkProcess(p);
        const app = appForAll(p);
        const parent = byPid.get(p.ppid) || null;
        const children = childMap[p.pid] || [];
        const rk = risk.classify(p, app, wl);
        return {
            pid: p.pid,
            ppid: p.ppid,
            parent_name: parent ? (parent.name || parent.comm) : null,
            child_count: children.length,
            children: children.slice(0, 20).map(c => ({ pid: c.pid, comm: c.comm, name: c.name, user: c.user, pcpu: c.pcpu, pmem: c.pmem })),
            user: p.user,
            uid: p.uid,
            pri: p.pri,
            ni: p.ni,
            vsz: p.vsz,
            rss: p.rss,
            pcpu: p.pcpu,
            pmem: p.pmem,
            etime: p.etime,
            comm: p.comm,
            name: p.name,
            exe_name: p.exe_name,
            is_kernel: p.is_kernel,
            cmdline: p.cmdline,
            args: p.args,
            cwd: p.cwd,
            exe: p.exe,
            app_id: app ? app.app_id : null,
            app_name: app ? app.app_name : null,
            ports: portMap[p.pid] || [],
            protected: wl.protected,
            protected_reason: wl.reason,
            risk_reasons: rk.risk_reasons || [],
            ...rk
        };
    });

    const category = (req.query.category || '').toString();
    const visible = category ? enriched.filter(p => p.category === category || (category === 'high' && p.risk_level >= 2) || (category === 'with_port' && (p.ports || []).length > 0)) : enriched;

    // 排序
    const sort = (req.query.sort || 'cpu').toString();
    const order = (req.query.order || 'desc').toString();
    // v1.9.0：name 排序改按完整进程名（p.name），与界面展示一致
    const sortField = { cpu: 'pcpu', mem: 'pmem', pid: 'pid', user: 'user', name: 'name' }[sort] || 'pcpu';
    visible.sort((a, b) => {
        const av = a[sortField], bv = b[sortField];
        if (typeof av === 'number' && typeof bv === 'number') {
            return order === 'asc' ? av - bv : bv - av;
        }
        return order === 'asc'
            ? String(av).localeCompare(String(bv))
            : String(bv).localeCompare(String(av));
    });

    // 分页
    const size = Math.min(2000, parseInt(req.query.size) || 1000);
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const start = (page - 1) * size;
    const paged = visible.slice(start, start + size);

    res.json({
        ok: true,
        total: visible.length,
        page,
        size,
        processes: paged
    });
});

// GET /api/processes/:pid
router.get('/:pid', (req, res) => {
    const all = procMod.getAllProcesses();
    const p = all.find(x => x.pid === Number(req.params.pid)) || null;
    if (!p) return res.status(404).json({ ok: false, error: 'process_not_found' });
    const wl = wlMod.checkProcess(p);
    // v1.9.0：与列表接口共用 appresolve，避免详情页/列表页归属不一致
    const app = appresolve.resolveOne(p, all);
    const parent = all.find(x => x.pid === p.ppid) || null;
    const children = all.filter(x => x.ppid === p.pid).map(c => ({ pid: c.pid, comm: c.comm, name: c.name, user: c.user, pcpu: c.pcpu, pmem: c.pmem, cmdline: c.cmdline }));
    const ports = portsMod.getAllListeningPorts().filter(pt => pt.pid === p.pid || (pt.fds || []).some(fd => fd.pid === p.pid));
    const rk = risk.classify(p, app, wl);
    res.json({
        ok: true,
        process: {
            ...p,
            parent_name: parent ? (parent.name || parent.comm) : null,
            children,
            child_count: children.length,
            ports,
            app_id: app ? app.app_id : null,
            app_name: app ? app.app_name : null,
            protected: wl.protected,
            protected_reason: wl.reason,
            risk_reasons: rk.risk_reasons || [],
            ...rk
        }
    });
});

// POST /api/processes/kill { pid, signal?, force?, confirm? }
router.post('/kill', (req, res) => {
    const pid = parseInt(req.body.pid, 10);
    if (!Number.isFinite(pid) || pid <= 0) {
        return res.status(400).json({ ok: false, error: 'invalid_pid' });
    }
    const all = procMod.getAllProcesses();
    const proc = all.find(x => x.pid === pid) || null;
    if (!proc) return res.status(404).json({ ok: false, error: 'process_not_found' });

    const wl = wlMod.checkProcess(proc);

    // v1.9.0 修 P1-8：与列表接口用同一套归属解析（含父进程继承），
    // 否则同一进程列表判 fnos_app/warn、kill 判 user/normal，保护会被降级。
    const app = appresolve.resolveOne(proc, all);
    const rk = risk.classify(proc, app, wl);
    if (rk.kill_policy === 'deny') {
        audit.append('kill_denied', { ...audit.fromReq(req), pid, comm: proc.comm, category: rk.category, risk_level: rk.risk_level });
        return res.status(403).json({ ok: false, error: 'kill_denied', risk: rk });
    }
    if (rk.confirm_phrase && req.body.confirm_phrase !== rk.confirm_phrase) {
        return res.status(403).json({ ok: false, error: 'strict_confirm_required', risk: rk, confirm_phrase: rk.confirm_phrase });
    }

    const sig = (req.body.signal || 'SIGTERM').toString();
    const force = req.body.force === true;

    try {
        const result = procMod.killProcess(pid, sig, force);
        // M8 修复：kill 后清除进程缓存，避免刷新看到"僵尸"
        procMod.clearCache();
        portsMod.clearCache();
        audit.append('kill_process', { ...audit.fromReq(req), pid, comm: proc.comm, signal: sig, force, category: rk.category, risk_level: rk.risk_level, result: 'success' });
        res.json({ ok: true, risk: rk, ...result });
    } catch (e) {
        audit.append('kill_process', { ...audit.fromReq(req), pid, error: e.message, result: 'failed' });
        res.status(500).json({ ok: false, error: e.message });
    }
});

// POST /api/processes/kill-by-name { name, confirm? }
router.post('/kill-by-name', (req, res) => {
    const name = (req.body.name || '').toString().trim();
    if (!name) return res.status(400).json({ ok: false, error: 'no_name' });

    // v1.9.0：进程名匹配三候选（comm 短名 / name 完整名 / exe basename），
    // 与白名单同一套语义，避免长进程名（>15 字符）匹配不上（P0-3 同源）
    const allProcs = procMod.getAllProcesses();
    const all = allProcs.filter(p => p.comm === name || p.name === name || p.exe_name === name);
    if (all.length === 0) return res.json({ ok: true, killed: 0, skipped: 0 });

    const resolver = appresolve.createResolver(allProcs);

    const skipped = [];
    const targets = [];
    // v1.9.0 修「warn 级批量杀无短语确认」：warn 级需带对应 confirm_phrase 才放行
    const phrase = (req.body.confirm_phrase || '').toString();
    for (const p of all) {
        const wl = wlMod.checkProcess(p);
        // S2 修复：加入风险分级检查，deny/strict 策略的进程不能被批量杀
        const app = resolver.resolve(p);
        const rk = risk.classify(p, app, wl);
        if (wl.protected || rk.kill_policy === 'deny') {
            skipped.push({ pid: p.pid, reason: wl.reason || rk.risk_label });
        } else if (rk.kill_policy === 'strict') {
            skipped.push({ pid: p.pid, reason: `高危进程：${rk.risk_label}（需单独确认）` });
        } else if (rk.kill_policy === 'warn' && rk.confirm_phrase && phrase !== rk.confirm_phrase) {
            skipped.push({ pid: p.pid, reason: `${rk.risk_label}：需输入确认短语「${rk.confirm_phrase}」`, confirm_phrase: rk.confirm_phrase });
        } else {
            targets.push(p);
        }
    }

    if (targets.length > 0 && req.body.confirm !== 'YES') {
        return res.json({
            ok: false,
            needs_confirm: true,
            targets: targets.map(p => ({ pid: p.pid, comm: p.comm, name: p.name, user: p.user, cmdline: p.cmdline })),
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

    if (killed.length > 0) {
        // M8 同源：批量杀后也要清缓存，否则刷新看到"僵尸"
        procMod.clearCache();
        portsMod.clearCache();
        audit.append('kill_by_name', { ...audit.fromReq(req), name, killed: killed.length, skipped: skipped.length, failed: failed.length });
        setTimeout(() => {
            for (const pid of killed) {
                try {
                    process.kill(pid, 0);
                } catch (e) {
                    continue;
                }
                try {
                    procMod.killProcess(pid, 'SIGKILL', true);
                } catch (e) {}
            }
            procMod.clearCache();
        }, 1000).unref();
    }

    res.json({ ok: true, killed, failed, skipped, force_kill_after_ms: 1000 });
});

module.exports = router;
