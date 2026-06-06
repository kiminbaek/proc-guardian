// proc-guardian 前端主逻辑 v1.0.0
(function() {
    'use strict';

    const $ = (id) => document.getElementById(id);

    // 状态
    const state = {
        currentTab: 'processes',
        procSort: 'cpu',
        procSearch: '',
        procUserFilter: '',
        portSearch: '',
        svcSearch: '',
        svcState: '',
        autoRefresh: { processes: true, ports: true, services: true },
        timers: {}
    };

    // ==================== 登录 ====================
    async function tryLogin(token) {
        try {
            const r = await Api.login(token);
            if (r.ok) {
                Api.setToken(r.session_token || token);
                return true;
            }
        } catch (e) {
            $('login-error').textContent = e.message === 'bad_token' ? 'Token 错误' :
                                           e.message === 'too_many_failures' ? '失败次数过多，已锁定' :
                                           ('登录失败: ' + e.message);
        }
        return false;
    }

    function bindLogin() {
        const btn = $('login-btn');
        const input = $('login-token');
        const submit = async () => {
            const t = input.value.trim();
            if (!t) { $('login-error').textContent = '请输入 Token'; return; }
            $('login-error').textContent = '';
            btn.disabled = true;
            const ok = await tryLogin(t);
            btn.disabled = false;
            if (ok) {
                $('login-page').classList.add('hidden');
                $('main-page').classList.remove('hidden');
                boot();
            }
        };
        btn.onclick = submit;
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

        const cached = Api.getToken();
        if (cached) {
            Api.authStatus()
                .then(() => {
                    $('login-page').classList.add('hidden');
                    $('main-page').classList.remove('hidden');
                    boot();
                })
                .catch(() => {
                    Api.setToken('');
                    input.focus();
                });
        } else {
            input.focus();
        }
    }

    // ==================== 主流程 ====================
    function boot() {
        bindUI();
        switchTab('processes');
        refreshAll();
        state.timers.proc = setInterval(() => {
            if (state.currentTab === 'processes' && state.autoRefresh.processes) refreshProcesses();
        }, 3000);
        state.timers.port = setInterval(() => {
            if (state.currentTab === 'ports' && state.autoRefresh.ports) refreshPorts();
        }, 3000);
        state.timers.svc = setInterval(() => {
            if (state.currentTab === 'services' && state.autoRefresh.services) refreshServices();
        }, 5000);
        state.timers.system = setInterval(() => {
            if (state.currentTab === 'system' || state.currentTab === 'processes') refreshSystemStats();
        }, 5000);
    }

    function bindUI() {
        document.querySelectorAll('.tab').forEach(t => {
            t.onclick = () => switchTab(t.dataset.tab);
        });

        $('logout-btn').onclick = async () => {
            try {
                await Api.logout();  // 服务端清缓存（未来支持黑名单）
            } catch (e) {
                // 静默失败
            }
            Api.clearToken();
            location.reload();
        };

        $('refresh-btn').onclick = () => {
            refreshAll();
            UI.toast('已刷新', 'success', 1500);
        };

        // 进程
        $('proc-search').addEventListener('input', (e) => { state.procSearch = e.target.value; refreshProcesses(); });
        $('proc-sort').addEventListener('change', (e) => { state.procSort = e.target.value; refreshProcesses(); });
        $('proc-user-filter').addEventListener('change', (e) => { state.procUserFilter = e.target.value; refreshProcesses(); });
        $('proc-auto-refresh').addEventListener('change', (e) => { state.autoRefresh.processes = e.target.checked; });

        // 端口
        $('port-search').addEventListener('input', (e) => { state.portSearch = e.target.value; refreshPorts(); });
        $('port-auto-refresh').addEventListener('change', (e) => { state.autoRefresh.ports = e.target.checked; });

        // 服务
        $('svc-search').addEventListener('input', (e) => { state.svcSearch = e.target.value; refreshServices(); });
        $('svc-state').addEventListener('change', (e) => { state.svcState = e.target.value; refreshServices(); });
        $('svc-auto-refresh').addEventListener('change', (e) => { state.autoRefresh.services = e.target.checked; });

        // 日志面板关闭
        $('svc-logs-close').onclick = () => $('svc-logs').classList.add('hidden');

        // 白名单
        $('wl-save').onclick = saveWhitelist;
        $('wl-reload').onclick = loadWhitelist;
    }

    function switchTab(name) {
        state.currentTab = name;
        document.querySelectorAll('.tab').forEach(t => {
            t.classList.toggle('active', t.dataset.tab === name);
        });
        document.querySelectorAll('.tab-content').forEach(c => {
            c.classList.toggle('hidden', c.id !== 'tab-' + name);
        });
        if (name === 'processes') refreshProcesses();
        else if (name === 'ports') refreshPorts();
        else if (name === 'services') refreshServices();
        else if (name === 'system') refreshSystem();
        else if (name === 'whitelist') loadWhitelist();
    }

    function refreshAll() {
        refreshSystemStats();
        refreshProcesses();
        refreshPorts();
    }

    // ==================== 进程 ====================
    async function refreshProcesses() {
        try {
            const params = {
                sort: state.procSort,
                order: 'desc',
                search: state.procSearch,
                user: state.procUserFilter,
                size: 200
            };
            const r = await Api.processes(params);
            $('stat-procs').textContent = r.total;
            renderProcesses(r.processes || []);
            updateUserFilter(r.processes || []);
        } catch (e) {
            if (e.status === 401) logout();
            else console.error('refreshProcesses:', e);
        }
    }

    function updateUserFilter(procs) {
        const sel = $('proc-user-filter');
        const users = new Set();
        procs.forEach(p => users.add(p.user));
        const current = sel.value;
        // 简单 diff
        const existing = Array.from(sel.options).map(o => o.value).filter(Boolean);
        const newUsers = Array.from(users).filter(u => !existing.includes(u));
        if (newUsers.length > 0) {
            newUsers.sort().forEach(u => {
                const opt = document.createElement('option');
                opt.value = u;
                opt.textContent = u;
                sel.appendChild(opt);
            });
        }
        sel.value = current;
    }

    function renderProcesses(procs) {
        const tbody = $('proc-tbody');
        if (procs.length === 0) {
            tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--text-3);padding:40px">无匹配进程</td></tr>';
            return;
        }
        const rows = procs.map(p => {
            const prot = p.protected ? 'protected' : '';
            const badge = p.protected ? `<span class="badge badge-protected" title="${UI.escapeHtml(p.protected_reason)}">🔒</span>` : '';
            const portsHtml = (p.ports || []).map(pt =>
                `<span class="badge badge-listening">${pt.proto.toUpperCase()} ${pt.port}</span>`
            ).join(' ');
            return `<tr class="${prot}">
                <td><b>${p.pid}</b> ${badge}</td>
                <td>${UI.escapeHtml(p.user)}</td>
                <td style="text-align:right">${p.pcpu.toFixed(1)}</td>
                <td style="text-align:right">${p.pmem.toFixed(1)}</td>
                <td style="text-align:right;color:var(--text-3)">${UI.fmtBytes(p.rss * 1024)}</td>
                <td style="color:var(--text-3)">${UI.escapeHtml(p.etime)}</td>
                <td class="col-cmd" title="${UI.escapeHtml(p.cmdline)}"><span class="cmd-text">${UI.escapeCmd(p.cmdline)}</span></td>
                <td>${portsHtml}</td>
                <td>
                    <button class="action-btn kill" data-pid="${p.pid}" data-cmd="${UI.escapeHtml(p.comm)}" data-protected="${p.protected}">结束</button>
                </td>
            </tr>`;
        }).join('');
        tbody.innerHTML = rows;

        tbody.querySelectorAll('.action-btn.kill').forEach(btn => {
            btn.onclick = () => killProcessHandler(btn);
        });
    }

    async function killProcessHandler(btn) {
        const pid = btn.dataset.pid;
        const cmd = btn.dataset.cmd;
        const isProtected = btn.dataset.protected === 'true';
        let confirmBody = `确定要结束进程 <code>${pid}</code> (${UI.escapeHtml(cmd)}) 吗？<br>将先发送 <code>SIGTERM</code>，10s 后未退再发 <code>SIGKILL</code>。`;
        if (isProtected) {
            confirmBody = `<span style="color:var(--warn)">⚠️ 该进程被白名单保护</span><br><br>${confirmBody}<br><br>输入 <code>FORCE</code> 强制结束（请确认你知道自己在做什么）`;
        }
        const ok = await UI.confirm('结束进程', confirmBody);
        if (!ok) return;

        try {
            const body = { pid: parseInt(pid, 10), signal: 'SIGTERM' };
            if (isProtected) body.confirm = 'FORCE';
            const r = await Api.killProcess(pid, body);
            UI.toast(`已结束进程 ${pid}`, 'success');
            setTimeout(refreshProcesses, 500);
        } catch (e) {
            UI.toast('结束失败: ' + e.message, 'error', 5000);
        }
    }

    // ==================== 端口 ====================
    async function refreshPorts() {
        try {
            const r = await Api.ports();
            $('stat-ports').textContent = r.total;
            renderPorts(r.ports || []);
        } catch (e) {
            if (e.status === 401) logout();
            else console.error('refreshPorts:', e);
        }
    }

    function renderPorts(ports) {
        const tbody = $('port-tbody');
        const search = state.portSearch.toLowerCase();
        const filtered = search ? ports.filter(p =>
            String(p.port).includes(search) ||
            (p.process_name && p.process_name.toLowerCase().includes(search)) ||
            (p.pid && String(p.pid).includes(search))
        ) : ports;

        if (filtered.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-3);padding:40px">无监听端口</td></tr>';
            return;
        }

        tbody.innerHTML = filtered.map(p => {
            const badge = p.protected ? `<span class="badge badge-protected" title="${UI.escapeHtml(p.protected_reason)}">🔒</span>` : '';
            const portBadge = `<span class="badge badge-listening">${p.port}</span>`;
            const killBtn = p.pid ? `<button class="action-btn kill" data-pid="${p.pid}" data-cmd="${UI.escapeHtml(p.process_name || '')}" data-protected="${p.protected}">结束</button>` : '-';
            return `<tr>
                <td><b>${portBadge}</b></td>
                <td>${p.proto.toUpperCase()}</td>
                <td style="color:var(--text-3)">${UI.escapeHtml(p.address || '*')}</td>
                <td>${UI.escapeHtml(p.state)}</td>
                <td>${UI.escapeHtml(p.process_name || '-')} ${badge}</td>
                <td>${p.pid || '-'}</td>
                <td>${killBtn}</td>
            </tr>`;
        }).join('');

        tbody.querySelectorAll('.action-btn.kill').forEach(btn => {
            btn.onclick = () => killProcessHandler(btn);
        });
    }

    // ==================== 服务 ====================
    async function refreshServices() {
        try {
            const r = await Api.services();
            $('stat-svcs').textContent = r.total;
            renderServices(r.services || []);
        } catch (e) {
            if (e.status === 401) logout();
            else console.error('refreshServices:', e);
        }
    }

    function renderServices(svcs) {
        const tbody = $('svc-tbody');
        const search = state.svcSearch.toLowerCase();
        const filtered = svcs.filter(s => {
            if (state.svcState && s.active !== state.svcState) return false;
            if (search && !s.unit.toLowerCase().includes(search) && !s.description.toLowerCase().includes(search)) return false;
            return true;
        });

        if (filtered.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-3);padding:40px">无匹配服务</td></tr>';
            return;
        }

        tbody.innerHTML = filtered.map(s => {
            const stateBadge = `<span class="badge badge-${s.active}">${s.active}</span>`;
            const isRunning = s.active === 'active' && s.sub === 'running';
            return `<tr>
                <td title="${UI.escapeHtml(s.unit)}"><b>${UI.escapeHtml(s.unit.replace('.service', ''))}</b></td>
                <td>${stateBadge} <span style="color:var(--text-3);font-size:11px">${UI.escapeHtml(s.sub)}</span></td>
                <td>${s.main_pid || '-'}</td>
                <td style="max-width:400px;overflow:hidden;text-overflow:ellipsis" title="${UI.escapeHtml(s.description)}">${UI.escapeHtml(s.description)}</td>
                <td>
                    <button class="action-btn svc" data-unit="${UI.escapeHtml(s.unit)}" data-action="start" ${isRunning ? 'disabled' : ''}>启动</button>
                    <button class="action-btn svc" data-unit="${UI.escapeHtml(s.unit)}" data-action="stop" ${!isRunning ? 'disabled' : ''}>停止</button>
                    <button class="action-btn svc" data-unit="${UI.escapeHtml(s.unit)}" data-action="restart">重启</button>
                    <button class="action-btn svc" data-unit="${UI.escapeHtml(s.unit)}" data-action="logs">日志</button>
                </td>
            </tr>`;
        }).join('');

        tbody.querySelectorAll('.action-btn.svc').forEach(btn => {
            btn.onclick = () => serviceActionHandler(btn);
        });
    }

    async function serviceActionHandler(btn) {
        const unit = btn.dataset.unit;
        const action = btn.dataset.action;
        if (action === 'logs') {
            return showServiceLogs(unit);
        }
        const actionText = { start: '启动', stop: '停止', restart: '重启' }[action] || action;
        const ok = await UI.confirm(
            `${actionText}服务`,
            `确定要 <b>${actionText}</b> 服务 <code>${UI.escapeHtml(unit)}</code> 吗？`
        );
        if (!ok) return;
        try {
            // === BUG #32 修复：confirm=true 告诉服务端已二次确认 ===
            await Api.serviceAction({ unit, action, confirm: true });
            UI.toast(`已${actionText} ${unit}`, 'success');
            setTimeout(refreshServices, 800);
        } catch (e) {
            UI.toast('操作失败: ' + e.message, 'error', 5000);
        }
    }

    async function showServiceLogs(unit) {
        $('svc-logs-title').textContent = `服务日志 - ${unit}`;
        $('svc-logs-body').textContent = '加载中...';
        $('svc-logs').classList.remove('hidden');
        try {
            const r = await Api.serviceLogs(unit, 200);
            $('svc-logs-body').textContent = r.logs || '(空)';
        } catch (e) {
            $('svc-logs-body').textContent = '加载失败: ' + e.message;
        }
    }

    // ==================== 系统 ====================
    async function refreshSystemStats() {
        try {
            const r = await Api.system();
            $('stat-cpu').textContent = r.memory.percent || '-';
            $('stat-mem').textContent = r.memory.percent || '-';
            // 真实 cpu% 需要 top -bn1，这里用 loadavg 近似
        } catch (e) {}
    }

    async function refreshSystem() {
        try {
            const r = await Api.system();
            const grid = $('system-grid');
            const memPercent = r.memory.percent || 0;
            const memUsedGB = (r.memory.used / 1024 / 1024 / 1024).toFixed(2);
            const memTotalGB = (r.memory.total / 1024 / 1024 / 1024).toFixed(2);
            const diskUsedGB = (r.disk.used / 1024 / 1024 / 1024).toFixed(2);
            const diskTotalGB = (r.disk.total / 1024 / 1024 / 1024).toFixed(2);

            grid.innerHTML = `
                <div class="sys-card">
                    <h3>运行时间</h3>
                    <div class="sys-value">${UI.fmtUptime(r.uptime_seconds)}</div>
                    <div class="sys-sub">Load: ${UI.escapeHtml(r.loadavg)}</div>
                </div>
                <div class="sys-card">
                    <h3>CPU</h3>
                    <div class="sys-value">${r.cpu.count} 核</div>
                    <div class="sys-sub">${UI.escapeHtml(r.cpu.model || '')}</div>
                </div>
                <div class="sys-card">
                    <h3>内存</h3>
                    <div class="sys-value">${memPercent}%</div>
                    <div class="sys-sub">${memUsedGB} / ${memTotalGB} GB</div>
                </div>
                <div class="sys-card">
                    <h3>磁盘 (/vol3)</h3>
                    <div class="sys-value">${UI.escapeHtml(r.disk.percent || '0%')}</div>
                    <div class="sys-sub">${diskUsedGB} / ${diskTotalGB} GB</div>
                </div>
                <div class="sys-card">
                    <h3>主机</h3>
                    <ul>
                        <li>主机名: <b>${UI.escapeHtml(r.hostname)}</b></li>
                        ${(r.ips || []).map(ip => `<li>IP: <b>${UI.escapeHtml(ip)}</b></li>`).join('')}
                    </ul>
                </div>
                <div class="sys-card">
                    <h3>Node.js</h3>
                    <ul>
                        <li>版本: <b>${UI.escapeHtml(r.node.version)}</b></li>
                        <li>平台: <b>${UI.escapeHtml(r.node.platform)} / ${UI.escapeHtml(r.node.arch)}</b></li>
                        <li>运行时长: <b>${UI.fmtUptime(r.node.uptime)}</b></li>
                    </ul>
                </div>
            `;
        } catch (e) {
            if (e.status === 401) logout();
        }
    }

    // ==================== 白名单 ====================
    async function loadWhitelist() {
        try {
            const r = await Api.whitelist();
            const w = r.whitelist || {};
            $('wl-pids').value = (w.pids || []).join('\n');
            $('wl-users').value = (w.users || []).join('\n');
            $('wl-process_names').value = (w.process_names || []).join('\n');
            $('wl-cmdline_keywords').value = (w.cmdline_keywords || []).join('\n');
            $('wl-ports').value = (w.ports || []).join('\n');
            $('wl-status').textContent = '已加载';
        } catch (e) {
            $('wl-status').textContent = '加载失败: ' + e.message;
        }
    }

    async function saveWhitelist() {
        const parseLines = (s) => s.split('\n').map(l => l.trim()).filter(Boolean);
        const body = {
            pids: parseLines($('wl-pids').value).map(s => parseInt(s, 10)).filter(n => Number.isFinite(n)),
            users: parseLines($('wl-users').value),
            process_names: parseLines($('wl-process_names').value),
            cmdline_keywords: parseLines($('wl-cmdline_keywords').value),
            ports: parseLines($('wl-ports').value).map(s => parseInt(s, 10)).filter(n => Number.isFinite(n))
        };
        try {
            await Api.whitelistUpdate(body);
            UI.toast('白名单已保存', 'success');
            $('wl-status').textContent = '已保存';
        } catch (e) {
            UI.toast('保存失败: ' + e.message, 'error');
            $('wl-status').textContent = '保存失败';
        }
    }

    // ==================== 工具 ====================
    function logout() {
        Api.setToken('');
        location.reload();
    }

    // ==================== 启动 ====================
    document.addEventListener('DOMContentLoaded', bindLogin);
})();
