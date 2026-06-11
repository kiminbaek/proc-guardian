// proc-guardian 前端主逻辑 v1.4.2
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
        timers: {},
        settings: { theme: 'system', compact: false, homeTab: 'dashboard', cmdWidth: 'normal' }
    };



    const PREF_KEY = 'proc_guardian_prefs_v142';
    const tabMeta = {
        dashboard: ['总览', '系统运行态、应用、端口和安全操作总览'],
        apps: ['应用', '飞牛应用、进程、端口和资源占用聚合'],
        processes: ['进程', '查看进程、风险等级和安全结束操作'],
        ports: ['端口', '监听端口、占用进程和应用归属'],
        services: ['系统服务', 'systemd 服务状态、控制和日志'],
        audit: ['审计日志', '最近敏感操作和安全事件'],
        system: ['系统信息', 'CPU、内存、系统版本和运行状态'],
        whitelist: ['安全策略', '白名单、保护对象和高危操作策略'],
        settings: ['设置中心', '界面偏好、刷新行为、安全入口和数据维护']
    };

    function loadPrefs() {
        try {
            const raw = localStorage.getItem(PREF_KEY);
            if (!raw) return;
            const p = JSON.parse(raw);
            state.settings = Object.assign(state.settings, p || {});
            if (p && p.autoRefresh) state.autoRefresh = Object.assign(state.autoRefresh, p.autoRefresh);
            if (p && p.homeTab) state.currentTab = p.homeTab;
        } catch (e) { console.warn('loadPrefs failed:', e); }
    }

    function savePrefs() {
        const p = {
            theme: state.settings.theme || 'system',
            compact: !!state.settings.compact,
            homeTab: state.settings.homeTab || state.currentTab || 'dashboard',
            cmdWidth: state.settings.cmdWidth || 'normal',
            autoRefresh: Object.assign({}, state.autoRefresh)
        };
        localStorage.setItem(PREF_KEY, JSON.stringify(p));
        return p;
    }

    async function loadServerSettings() {
        try {
            const r = await Api.settings();
            const p = r.settings || {};
            state.settings = Object.assign(state.settings, p || {});
            if (p.autoRefresh) state.autoRefresh = Object.assign(state.autoRefresh, p.autoRefresh);
            if (p.homeTab) state.currentTab = p.homeTab;
            return true;
        } catch (e) {
            console.warn('loadServerSettings failed, fallback localStorage:', e.message);
            return false;
        }
    }

    async function saveServerSettings() {
        const p = savePrefs();
        try {
            const r = await Api.settingsUpdate(p);
            if (r.settings) {
                state.settings = Object.assign(state.settings, r.settings);
                if (r.settings.autoRefresh) state.autoRefresh = Object.assign(state.autoRefresh, r.settings.autoRefresh);
            }
            return r;
        } catch (e) {
            UI.toast('服务端设置保存失败，已保存在当前浏览器: ' + e.message, 'error', 4000);
            throw e;
        }
    }

    function downloadJson(filename, obj) {
        const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function getAutoKey(tab) {
        if (tab === 'processes') return 'processes';
        if (tab === 'ports') return 'ports';
        if (tab === 'services') return 'services';
        return '';
    }

    function updateAutoIndicator() {
        const btn = $('auto-refresh-toggle');
        const label = $('auto-refresh-label');
        if (!btn || !label) return;
        const key = getAutoKey(state.currentTab);
        if (!key) {
            btn.classList.add('hidden');
            return;
        }
        btn.classList.remove('hidden');
        const on = !!state.autoRefresh[key];
        btn.classList.toggle('off', !on);
        label.textContent = on ? '自动' : '手动';
        btn.title = `${on ? '已开启' : '已关闭'}当前页自动刷新，点击切换`;
    }

    function toggleCurrentAutoRefresh() {
        const key = getAutoKey(state.currentTab);
        if (!key) return;
        state.autoRefresh[key] = !state.autoRefresh[key];
        applyPrefs();
        syncSettingsForm();
        savePrefs();
        UI.toast(`${tabMeta[state.currentTab][0]}自动刷新：${state.autoRefresh[key] ? '开' : '关'}`, 'success', 1200);
    }

    function applyPrefs() {
        document.body.dataset.theme = state.settings.theme || 'system';
        document.body.classList.toggle('compact-mode', !!state.settings.compact);
        document.body.dataset.cmdWidth = state.settings.cmdWidth || 'normal';
        document.querySelectorAll('[data-cmd-width]').forEach(x => x.classList.toggle('active', x.dataset.cmdWidth === (state.settings.cmdWidth || 'normal')));
        updateAutoIndicator();
    }

    function syncSettingsForm() {
        const theme = $('setting-theme'); if (theme) theme.value = state.settings.theme || 'system';
        const home = $('setting-home-tab'); if (home) home.value = state.settings.homeTab || state.currentTab || 'dashboard';
        const compact = $('setting-compact'); if (compact) compact.checked = !!state.settings.compact;
        const cmdWidth = $('setting-cmd-width'); if (cmdWidth) cmdWidth.value = state.settings.cmdWidth || 'normal';
        const ap = $('setting-auto-proc'); if (ap) ap.checked = !!state.autoRefresh.processes;
        const aport = $('setting-auto-port'); if (aport) aport.checked = !!state.autoRefresh.ports;
        const asvc = $('setting-auto-svc'); if (asvc) asvc.checked = !!state.autoRefresh.services;
    }

    function updateWorkspaceTitle(name) {
        const meta = tabMeta[name] || tabMeta.dashboard;
        const title = $('workspace-title'); if (title) title.textContent = meta[0];
        const sub = $('workspace-subtitle'); if (sub) sub.textContent = meta[1];
    }

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
        switchTab(state.currentTab || 'dashboard');
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
        document.querySelectorAll('[data-jump-tab]').forEach(t => {
            t.onclick = () => switchTab(t.dataset.jumpTab);
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
        const autoToggle = $('auto-refresh-toggle'); if (autoToggle) autoToggle.onclick = toggleCurrentAutoRefresh;
        document.querySelectorAll('[data-proc-filter]').forEach(btn => {
            btn.onclick = () => {
                state.procCategoryFilter = btn.dataset.procFilter || '';
                const sel = $('proc-category-filter'); if (sel) sel.value = state.procCategoryFilter;
                document.querySelectorAll('[data-proc-filter]').forEach(x => x.classList.toggle('active', x === btn));
                refreshProcesses();
            };
        });
        const clearFilters = $('proc-clear-filters');
        if (clearFilters) clearFilters.onclick = () => {
            state.procSearch = ''; state.procUserFilter = ''; state.procCategoryFilter = '';
            $('proc-search').value = ''; $('proc-user-filter').value = ''; $('proc-category-filter').value = '';
            document.querySelectorAll('[data-proc-filter]').forEach(x => x.classList.remove('active'));
            refreshProcesses();
        };
        document.querySelectorAll('[data-cmd-width]').forEach(btn => {
            btn.onclick = () => {
                state.settings.cmdWidth = btn.dataset.cmdWidth || 'normal';
                applyPrefs(); savePrefs();
                document.querySelectorAll('[data-cmd-width]').forEach(x => x.classList.toggle('active', x === btn));
            };
        });
        if (window.PGExtra) window.PGExtra.bindExtra(state);

        // 端口
        $('port-search').addEventListener('input', (e) => { state.portSearch = e.target.value; refreshPorts(); });
        

        // 服务
        $('svc-search').addEventListener('input', (e) => { state.svcSearch = e.target.value; refreshServices(); });
        $('svc-state').addEventListener('change', (e) => { state.svcState = e.target.value; refreshServices(); });
        

        // 日志面板关闭
        $('svc-logs-close').onclick = () => $('svc-logs').classList.add('hidden');

        // 白名单
        $('wl-save').onclick = saveWhitelist;
        $('wl-reload').onclick = loadWhitelist;
        const wlAdd = $('wl-add'); if (wlAdd) wlAdd.onclick = addWhitelistItem;
        const wlDefaults = $('wl-defaults'); if (wlDefaults) wlDefaults.onclick = restoreWhitelistDefaults;

        // 设置中心（本地偏好，不触碰后端核心逻辑）
        const bindSetting = (id, fn) => { const el = $(id); if (el) el.onchange = fn; };
        bindSetting('setting-theme', e => { state.settings.theme = e.target.value; applyPrefs(); });
        bindSetting('setting-home-tab', e => { state.settings.homeTab = e.target.value; });
        bindSetting('setting-compact', e => { state.settings.compact = e.target.checked; applyPrefs(); });
        bindSetting('setting-cmd-width', e => { state.settings.cmdWidth = e.target.value; applyPrefs(); });
        bindSetting('setting-auto-proc', e => { state.autoRefresh.processes = e.target.checked; updateAutoIndicator(); });
        bindSetting('setting-auto-port', e => { state.autoRefresh.ports = e.target.checked; updateAutoIndicator(); });
        bindSetting('setting-auto-svc', e => { state.autoRefresh.services = e.target.checked; updateAutoIndicator(); });
        const saveBtn = $('settings-save');
        if (saveBtn) saveBtn.onclick = async () => { await saveServerSettings(); syncSettingsForm(); const s = $('settings-status'); if (s) s.textContent = '已保存到 appdata/settings.json'; UI.toast('设置已保存', 'success', 1600); };
        const resetBtn = $('settings-reset');
        if (resetBtn) resetBtn.onclick = async () => { localStorage.removeItem(PREF_KEY); try { const r = await Api.settingsReset(); state.settings = Object.assign(state.settings, r.settings || {}); if (r.settings && r.settings.autoRefresh) state.autoRefresh = Object.assign(state.autoRefresh, r.settings.autoRefresh); } catch(e) { state.settings = { theme: 'system', compact: false, homeTab: 'dashboard', cmdWidth: 'normal' }; state.autoRefresh = { processes: true, ports: true, services: true }; } applyPrefs(); syncSettingsForm(); UI.toast('已恢复默认设置', 'success', 1600); };
        const refreshAllBtn = $('settings-refresh-all');
        if (refreshAllBtn) refreshAllBtn.onclick = () => { refreshAll(); UI.toast('已刷新全部数据', 'success', 1500); };
        const exportBtn = $('settings-export-prefs');
        if (exportBtn) exportBtn.onclick = () => { const p = savePrefs(); navigator.clipboard && navigator.clipboard.writeText(JSON.stringify(p, null, 2)); UI.toast('偏好 JSON 已复制到剪贴板', 'success', 2000); };
        syncSettingsForm();
    }

    function switchTab(name) {
        state.currentTab = name;
        updateWorkspaceTitle(name);
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
        else if (name === 'settings') syncSettingsForm();
        updateAutoIndicator();
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
            tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--text-3);padding:40px">无匹配进程</td></tr>';
            return;
        }
        const rows = procs.map(p => {
            const prot = p.protected ? 'protected' : '';
            const badge = p.protected ? `<span class="badge badge-protected" title="${UI.escapeHtml(p.protected_reason)}">🔒</span>` : '';
            const portList = (p.ports || []);
            const portsHtml = portList.slice(0, 2).map(pt => `<span class="port-pill">${pt.proto.toUpperCase()} ${pt.port}</span>`).join(' ') + (portList.length > 2 ? ` <span class="muted">+${portList.length - 2}</span>` : '');
            const riskText = UI.escapeHtml(String(p.risk_label || '-').replace('风险', ''));
            const appLine = p.app_name ? `<span class="badge badge-app" title="${UI.escapeHtml(p.app_id || '')}">${UI.escapeHtml(p.app_name)}</span>` : `<span class="proc-name">${UI.escapeHtml(p.comm || '-')}</span>`;
            return `<tr class="${prot}">
                <td><button class="link-btn proc-detail" data-pid="${p.pid}"><b>${p.pid}</b></button> ${badge}</td>
                <td>${UI.escapeHtml(p.user)}</td>
                <td class="proc-app-cell">${appLine}<small>${UI.escapeHtml(p.comm || '')}</small></td>
                <td class="num cpu-cell">${Number(p.pcpu || 0).toFixed(1)}</td>
                <td class="num mem-cell">${Number(p.pmem || 0).toFixed(1)}</td>
                <td class="cmd-cell" title="${UI.escapeHtml(p.cmdline)}"><b>${UI.escapeHtml(p.comm || '')}</b><span>${UI.escapeCmd(p.cmdline || '')}</span></td>
                <td class="ports-cell">${portsHtml || '<span class="muted">-</span>'}</td>
                <td class="risk-cell"><span class="risk-dot risk-${p.risk_level}" title="${UI.escapeHtml((p.risk_reasons || []).join('；'))}"></span><span>${riskText}</span></td>
                <td class="op-cell">
                    <button class="action-btn detail proc-detail" data-pid="${p.pid}">查看</button>
                    <button class="action-btn kill" data-pid="${p.pid}" data-cmd="${UI.escapeHtml(p.comm)}" data-risk="${p.risk_level}" data-policy="${p.kill_policy}" data-phrase="${p.confirm_phrase || ''}" data-label="${UI.escapeHtml(p.risk_label || '')}">结束</button>
                </td>
            </tr>`;
        }).join('');
        tbody.innerHTML = rows;
        tbody.querySelectorAll('.action-btn.kill').forEach(btn => { btn.onclick = () => killProcessHandler(btn); });
        tbody.querySelectorAll('.proc-detail').forEach(btn => { btn.onclick = () => showProcessDetail(btn.dataset.pid); });
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
            $('drawer-title').textContent = `${p.comm || '进程'} · PID ${p.pid}`;
            const ports = (p.ports || []).map(pt => `<span class="badge badge-listening">${pt.proto.toUpperCase()} ${pt.port}</span>`).join(' ') || '<span class="muted">无监听端口</span>';
            const reasons = (p.risk_reasons || []).map(x => `<li>${UI.escapeHtml(x)}</li>`).join('') || '<li class="muted">无明显风险原因</li>';
            const children = (p.children || []).map(c => `<tr><td>${c.pid}</td><td>${UI.escapeHtml(c.comm)}</td><td>${UI.escapeHtml(c.user)}</td><td>${Number(c.pcpu||0).toFixed(1)}</td><td>${Number(c.pmem||0).toFixed(1)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">无子进程</td></tr>';
            $('drawer-body').innerHTML = `
                <div class="tool-detail-hero">
                    <div><span class="muted">${UI.escapeHtml(p.user || '-')}</span><h3>${UI.escapeHtml(p.comm || p.cmdline || '-')}</h3><p>PID ${p.pid} · PPID ${p.ppid || '-'} · ${UI.escapeHtml(p.etime || '-')}</p></div>
                    <span class="badge risk-${p.risk_level}">${UI.escapeHtml(p.risk_label || '-')}</span>
                </div>
                <div class="metric-strip">
                    <div><b>${Number(p.pcpu||0).toFixed(1)}%</b><span>CPU</span></div>
                    <div><b>${Number(p.pmem||0).toFixed(1)}%</b><span>MEM</span></div>
                    <div><b>${UI.fmtBytes((p.rss||0) * 1024)}</b><span>RSS</span></div>
                    <div><b>${(p.children||[]).length}</b><span>子进程</span></div>
                </div>
                <div class="detail-grid tool-grid">
                    <div><b>应用</b><span>${UI.escapeHtml(p.app_name || '-')}</span></div>
                    <div><b>保护状态</b><span>${p.protected ? '🔒 ' + UI.escapeHtml(p.protected_reason || 'protected') : '未保护'}</span></div>
                    <div><b>端口</b><span>${ports}</span></div>
                    <div><b>父进程</b><span>${p.ppid || '-'} ${UI.escapeHtml(p.parent_name || '')}</span></div>
                    <div><b>cwd</b><span>${UI.escapeHtml(p.cwd || '-')}</span></div>
                    <div><b>exe</b><span>${UI.escapeHtml(p.exe || '-')}</span></div>
                </div>
                <h4>完整命令行</h4><pre class="detail-pre">${UI.escapeHtml(p.cmdline || p.args || '')}</pre>
                <h4>风险原因</h4><ul class="risk-list">${reasons}</ul>
                <div class="drawer-actions"><button class="danger" data-kill-pid="${p.pid}">结束进程</button><button id="drawer-refresh-proc">刷新详情</button></div>
                <h4>子进程 (${p.child_count || 0})</h4>
                <table class="mini-table"><thead><tr><th>PID</th><th>名称</th><th>用户</th><th>CPU</th><th>MEM</th></tr></thead><tbody>${children}</tbody></table>
            `;
            const k = $('drawer-body').querySelector('[data-kill-pid]'); if (k) k.onclick = () => killProcess(p.pid, p.risk_level >= 2 ? 'danger' : 'normal');
            const rr = $('drawer-refresh-proc'); if (rr) rr.onclick = () => showProcessDetail(p.pid);
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
    const WL_FIELDS = ['pids', 'users', 'process_names', 'cmdline_keywords', 'ports'];
    const WL_LABELS = { pids: 'PID', users: '用户', process_names: '进程名', cmdline_keywords: '命令关键词', ports: '端口' };

    function readWhitelistForm() {
        const parseLines = (s) => String(s || '').split('\n').map(l => l.trim()).filter(Boolean);
        return {
            pids: parseLines($('wl-pids').value).map(s => parseInt(s, 10)).filter(n => Number.isFinite(n)),
            users: parseLines($('wl-users').value),
            process_names: parseLines($('wl-process_names').value),
            cmdline_keywords: parseLines($('wl-cmdline_keywords').value),
            ports: parseLines($('wl-ports').value).map(s => parseInt(s, 10)).filter(n => Number.isFinite(n))
        };
    }

    function writeWhitelistForm(w) {
        $('wl-pids').value = (w.pids || []).join('\n');
        $('wl-users').value = (w.users || []).join('\n');
        $('wl-process_names').value = (w.process_names || []).join('\n');
        $('wl-cmdline_keywords').value = (w.cmdline_keywords || []).join('\n');
        $('wl-ports').value = (w.ports || []).join('\n');
        renderWhitelistChips(w);
    }

    function renderWhitelistChips(w) {
        const tbody = $('wl-rule-tbody');
        if (!tbody) return;
        const rows = [];
        WL_FIELDS.forEach(f => (w[f] || []).forEach(v => rows.push({ field: f, value: v })));
        tbody.innerHTML = rows.length ? rows.map(r => `<tr><td><span class="rule-type">${WL_LABELS[r.field]}</span></td><td><code>${UI.escapeHtml(String(r.value))}</code></td><td><button class="action-btn" data-wl-field="${r.field}" data-wl-value="${UI.escapeHtml(String(r.value))}">删除</button></td></tr>`).join('') : '<tr><td colspan="3" class="muted" style="text-align:center;padding:24px">暂无自定义规则</td></tr>';
        tbody.querySelectorAll('[data-wl-field]').forEach(btn => btn.onclick = () => {
            const data = readWhitelistForm();
            const f = btn.dataset.wlField; const v = btn.dataset.wlValue;
            data[f] = (data[f] || []).filter(x => String(x) !== String(v));
            writeWhitelistForm(data);
        });
    }

    async function loadWhitelist() {
        try {
            const r = await Api.whitelist();
            const w = r.whitelist || {};
            writeWhitelistForm(w);
            $('wl-status').textContent = '已加载';
        } catch (e) {
            $('wl-status').textContent = '加载失败: ' + e.message;
        }
    }

    async function saveWhitelist() {
        const body = readWhitelistForm();
        try {
            const r = await Api.whitelistUpdate(body);
            writeWhitelistForm(r.whitelist || body);
            UI.toast('白名单已保存', 'success');
            $('wl-status').textContent = '已保存到 appdata/config.json';
        } catch (e) {
            UI.toast('保存失败: ' + e.message, 'error');
            $('wl-status').textContent = '保存失败';
        }
    }

    function addWhitelistItem() {
        const type = $('wl-add-type').value;
        const raw = $('wl-add-value').value.trim();
        if (!raw) return;
        const data = readWhitelistForm();
        let val = raw;
        if (type === 'pids' || type === 'ports') {
            val = parseInt(raw, 10);
            if (!Number.isFinite(val) || val < 1) { UI.toast('请输入有效数字', 'error'); return; }
        }
        data[type] = Array.from(new Set([...(data[type] || []), val]));
        writeWhitelistForm(data);
        $('wl-add-value').value = '';
    }

    async function restoreWhitelistDefaults() {
        const ok = await UI.confirm('恢复默认白名单', '将恢复 PID 1/2 保护并清空其它自定义白名单，确定继续？');
        if (!ok) return;
        const d = { pids: [1, 2], users: [], process_names: [], cmdline_keywords: [], ports: [] };
        writeWhitelistForm(d);
        await saveWhitelist();
    }

    // ==================== 工具 ====================
    function logout() {
        Api.setToken('');
        location.reload();
    }

    // ==================== 启动 ====================
    document.addEventListener('DOMContentLoaded', async () => {
        loadPrefs();
        await loadServerSettings();
        applyPrefs();
        updateWorkspaceTitle(state.currentTab || 'dashboard');
        bindLogin();
    });
})();
