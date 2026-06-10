// proc-guardian 前端主逻辑 v1.0.0
(function() {
    'use strict';

    const $ = (id) => document.getElementById(id);

    // 状态
    const state = {
        currentTab: 'dashboard',
        procSort: 'cpu',
        procSearch: '',
        procUserFilter: '',
        procCategoryFilter: '',
        authMode: 'password',
        portSearch: '',
        svcSearch: '',
        svcState: '',
        appSearch: '',
        autoRefresh: { processes: true, ports: true, services: true },
        timers: {}
    };

    // ==================== 登录 / 注册 / 旧 Token 升级 ====================
    async function detectAuthMode() {
        try {
            const r = await Api.authMode();
            state.authMode = r.mode || 'password';
            const hint = $('login-hint');
            const btn = $('login-btn');
            const p2 = $('login-password2');
            const legacy = $('legacy-token-row');
            if (state.authMode === 'setup_required') {
                hint.textContent = '首次使用：请创建管理员密码（至少 8 位）';
                btn.textContent = '创建管理员密码';
                p2.classList.remove('hidden');
                legacy.classList.add('hidden');
            } else if (state.authMode === 'legacy_upgrade') {
                hint.textContent = '检测到旧版 Token，请输入旧 Token 并设置管理员密码';
                btn.textContent = '升级并登录';
                p2.classList.remove('hidden');
                legacy.classList.remove('hidden');
            } else {
                hint.textContent = '请输入管理员密码登录';
                btn.textContent = '登 录';
                p2.classList.add('hidden');
                legacy.classList.add('hidden');
            }
        } catch (e) {
            $('login-hint').textContent = '认证状态检测失败，请刷新重试';
        }
    }

    async function submitAuth() {
        const btn = $('login-btn');
        const pwd = $('login-password').value;
        const pwd2 = $('login-password2').value;
        const legacy = $('legacy-token').value.trim();
        $('login-error').textContent = '';
        if (!pwd || pwd.length < 8) { $('login-error').textContent = '密码至少 8 位'; return false; }
        if ((state.authMode === 'setup_required' || state.authMode === 'legacy_upgrade') && pwd !== pwd2) {
            $('login-error').textContent = '两次密码不一致'; return false;
        }
        if (state.authMode === 'legacy_upgrade' && !legacy) { $('login-error').textContent = '请输入旧版 Token'; return false; }
        btn.disabled = true;
        try {
            let r;
            if (state.authMode === 'setup_required') r = await Api.setupPassword(pwd);
            else if (state.authMode === 'legacy_upgrade') r = await Api.upgradePassword(legacy, pwd);
            else r = await Api.login(pwd);
            if (r.ok && r.session_token) {
                Api.setToken(r.session_token);
                return true;
            }
            $('login-error').textContent = '认证失败';
        } catch (e) {
            const map = { bad_password: '密码错误', bad_legacy_token: '旧版 Token 错误', too_many_attempts: '失败次数过多，已锁定', password_too_short: '密码至少 8 位', already_initialized: '已初始化，请登录' };
            $('login-error').textContent = map[e.message] || ('认证失败: ' + e.message);
        } finally {
            btn.disabled = false;
        }
        return false;
    }

    function showMain() {
        $('login-page').classList.add('hidden');
        $('main-page').classList.remove('hidden');
        boot();
    }

    function bindLogin() {
        const btn = $('login-btn');
        const input = $('login-password');
        detectAuthMode().then(() => {
            const cached = Api.getToken();
            if (cached && state.authMode === 'password') {
                Api.system().then(showMain).catch(() => { Api.setToken(''); input.focus(); });
            } else input.focus();
        });
        const submit = async () => { if (await submitAuth()) showMain(); };
        btn.onclick = submit;
        ['login-password','login-password2','legacy-token'].forEach(id => {
            const el = $(id); if (el) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
        });
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

        const closeBtn = $('close-btn');
        if (closeBtn) closeBtn.onclick = () => {
            window.close();
            setTimeout(() => UI.toast('如果窗口未关闭，请使用浏览器/飞牛窗口右上角关闭', 'info', 3000), 200);
        };

        $('drawer-close').onclick = closeProcessDrawer;
        $('proc-drawer').addEventListener('click', (e) => {
            if (e.target && e.target.id === 'proc-drawer') closeProcessDrawer();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeProcessDrawer();
        });

        // 进程
        $('proc-search').addEventListener('input', (e) => { state.procSearch = e.target.value; refreshProcesses(); });
        $('proc-sort').addEventListener('change', (e) => { state.procSort = e.target.value; refreshProcesses(); });
        $('proc-user-filter').addEventListener('change', (e) => { state.procUserFilter = e.target.value; refreshProcesses(); });
        $('proc-category-filter').addEventListener('change', (e) => { state.procCategoryFilter = e.target.value; refreshProcesses(); });
        $('proc-auto-refresh').addEventListener('change', (e) => { state.autoRefresh.processes = e.target.checked; });
        if (window.PGExtra) window.PGExtra.bindExtra(state);

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
        if (name === 'dashboard') { if (window.PGExtra) window.PGExtra.refreshDashboard(); }
        else if (name === 'apps') { if (window.PGExtra) window.PGExtra.refreshApps(); }
        else if (name === 'processes') refreshProcesses();
        else if (name === 'ports') refreshPorts();
        else if (name === 'services') refreshServices();
        else if (name === 'audit') { if (window.PGExtra) window.PGExtra.refreshAudit(); }
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
                category: state.procCategoryFilter,
                size: 1000
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
            tbody.innerHTML = '<tr><td colspan="13" style="text-align:center;color:var(--text-3);padding:40px">无匹配进程</td></tr>';
            return;
        }
        const rows = procs.map(p => {
            const prot = p.protected ? 'protected' : '';
            const badge = p.protected ? `<span class="badge badge-protected" title="${UI.escapeHtml(p.protected_reason)}">🔒</span>` : '';
            const portsHtml = (p.ports || []).map(pt =>
                `<span class="badge badge-listening">${pt.proto.toUpperCase()} ${pt.port}</span>`
            ).join(' ');
            return `<tr class="${prot}">
                <td><button class="link-btn proc-detail" data-pid="${p.pid}"><b>${p.pid}</b></button> ${badge}</td>
                <td>${p.ppid || '-'}</td>
                <td>${UI.escapeHtml(p.user)}</td>
                <td>${p.app_name ? `<span class="badge badge-app" title="${UI.escapeHtml(p.app_id || '')}">${UI.escapeHtml(p.app_name)}</span>` : '<span class="muted">-</span>'}</td>
                <td style="text-align:right">${p.pcpu.toFixed(1)}</td>
                <td style="text-align:right">${p.pmem.toFixed(1)}</td>
                <td style="text-align:right;color:var(--text-3)">${UI.fmtBytes(p.rss * 1024)}</td>
                <td style="color:var(--text-3)">${UI.escapeHtml(p.etime)}</td>
                <td class="col-cmd" title="${UI.escapeHtml(p.cmdline)}"><span class="cmd-text">${UI.escapeCmd(p.cmdline)}</span></td>
                <td>${portsHtml || '<span class="muted">-</span>'}</td>
                <td><span class="badge risk-${p.risk_level}" title="${UI.escapeHtml((p.risk_reasons || []).join('；'))}">${UI.escapeHtml(p.risk_label || '-')}</span></td>
                <td>
                    <button class="action-btn detail proc-detail" data-pid="${p.pid}">详情</button>
                    <button class="action-btn kill" data-pid="${p.pid}" data-cmd="${UI.escapeHtml(p.comm)}" data-risk="${p.risk_level}" data-policy="${p.kill_policy}" data-phrase="${p.confirm_phrase || ''}" data-label="${UI.escapeHtml(p.risk_label || '')}">结束</button>
                </td>
            </tr>`;
        }).join('');
        tbody.innerHTML = rows;

        tbody.querySelectorAll('.action-btn.kill').forEach(btn => {
            btn.onclick = () => killProcessHandler(btn);
        });
        tbody.querySelectorAll('.proc-detail').forEach(btn => {
            btn.onclick = () => showProcessDetail(btn.dataset.pid);
        });
    }

    async function killProcessHandler(btn) {
        const pid = btn.dataset.pid;
        const cmd = btn.dataset.cmd;
        const policy = btn.dataset.policy || 'normal';
        const phrase = btn.dataset.phrase || '';
        const label = btn.dataset.label || '';
        let confirmBody = `确定要结束进程 <code>${pid}</code> (${UI.escapeHtml(cmd)}) 吗？<br>将先发送 <code>SIGTERM</code>，10s 后未退再发 <code>SIGKILL</code>。`;
        let ok = false;
        if (policy === 'deny') {
            await UI.confirm('禁止结束', `<span style="color:var(--danger)">⛔ ${UI.escapeHtml(label)}禁止结束。</span>`);
            return;
        } else if (policy === 'strict') {
            confirmBody = `<span style="color:var(--danger);font-weight:700">⚠️ 严正警告：这是${UI.escapeHtml(label)}，结束后会导致 NAS / 飞牛功能异常。</span><br><br>${confirmBody}`;
            ok = await UI.promptConfirm('高危系统进程确认', confirmBody, phrase || 'STOP SYSTEM PROCESS');
        } else if (policy === 'warn') {
            confirmBody = `<span style="color:var(--warn)">⚠️ 这是飞牛应用进程，结束会影响对应应用。</span><br><br>${confirmBody}`;
            ok = await UI.promptConfirm('应用进程确认', confirmBody, phrase || 'STOP APP PROCESS');
        } else {
            ok = await UI.confirm('结束进程', confirmBody);
        }
        if (!ok) return;

        try {
            const body = { pid: parseInt(pid, 10), signal: 'SIGTERM', force: true };
            if (phrase) body.confirm_phrase = phrase;
            const r = await Api.killProcess(pid, body);
            UI.toast(`已结束进程 ${pid}`, 'success');
            setTimeout(refreshProcesses, 500);
        } catch (e) {
            UI.toast('结束失败: ' + e.message, 'error', 5000);
        }
    }

    function closeProcessDrawer() {
        $('proc-drawer').classList.add('hidden');
    }

    async function showProcessDetail(pid) {
        try {
            const r = await Api.process(pid);
            const p = r.process;
            $('drawer-title').textContent = `进程详情 PID ${p.pid}`;
            const ports = (p.ports || []).map(pt => `<span class="badge badge-listening">${pt.proto.toUpperCase()} ${pt.port}</span>`).join(' ') || '<span class="muted">无监听端口</span>';
            const children = (p.children || []).map(c => `<tr><td>${c.pid}</td><td>${UI.escapeHtml(c.comm)}</td><td>${UI.escapeHtml(c.user)}</td><td>${c.pcpu.toFixed ? c.pcpu.toFixed(1) : c.pcpu}</td><td>${c.pmem.toFixed ? c.pmem.toFixed(1) : c.pmem}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">无子进程</td></tr>';
            $('drawer-body').innerHTML = `
                <div class="detail-grid">
                    <div><b>进程</b><span>${UI.escapeHtml(p.comm)}</span></div>
                    <div><b>用户</b><span>${UI.escapeHtml(p.user)}</span></div>
                    <div><b>父进程</b><span>${p.ppid || '-'} ${UI.escapeHtml(p.parent_name || '')}</span></div>
                    <div><b>应用</b><span>${UI.escapeHtml(p.app_name || '-')}</span></div>
                    <div><b>风险</b><span class="badge risk-${p.risk_level}">${UI.escapeHtml(p.risk_label || '-')}</span></div>
                    <div><b>资源</b><span>CPU ${p.pcpu}% / MEM ${p.pmem}% / RSS ${UI.fmtBytes(p.rss * 1024)}</span></div>
                    <div><b>端口</b><span>${ports}</span></div>
                    <div><b>cwd</b><span>${UI.escapeHtml(p.cwd || '-')}</span></div>
                    <div><b>exe</b><span>${UI.escapeHtml(p.exe || '-')}</span></div>
                </div>
                <h4>命令行</h4><pre class="detail-pre">${UI.escapeHtml(p.cmdline || p.args || '')}</pre>
                <h4>子进程 (${p.child_count || 0})</h4>
                <table class="mini-table"><thead><tr><th>PID</th><th>名称</th><th>用户</th><th>CPU</th><th>MEM</th></tr></thead><tbody>${children}</tbody></table>
            `;
            $('proc-drawer').classList.remove('hidden');
        } catch (e) {
            UI.toast('加载详情失败: ' + e.message, 'error');
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
            (p.app_name && p.app_name.toLowerCase().includes(search)) ||
            (p.app_id && p.app_id.toLowerCase().includes(search)) ||
            (p.pid && String(p.pid).includes(search))
        ) : ports;

        if (filtered.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-3);padding:40px">无监听端口</td></tr>';
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
                <td>${p.app_name ? `<span class="badge badge-app" title="${UI.escapeHtml(p.app_id || '')}">${UI.escapeHtml(p.app_name)}</span>` : '<span class="muted">-</span>'}</td>
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
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-3);padding:40px">无匹配系统服务。说明：这里显示 systemd 服务，不显示 fnOS 应用；fnOS 应用请在进程页通过“应用”列查看。</td></tr>';
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
            await Api.serviceAction({ name: unit, unit, action, confirm: true });
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
            $('stat-cpu').textContent = (r.cpu && Number.isFinite(r.cpu.usage)) ? r.cpu.usage : '-';
            $('stat-mem').textContent = (r.memory && Number.isFinite(r.memory.percent)) ? r.memory.percent : '-';
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
