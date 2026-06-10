// proc-guardian 前端 API 封装
// v1.0.6 BUG #13 修复：token 改用 sessionStorage（关浏览器即失效）
(function() {
    'use strict';

    const TOKEN_KEY = 'proc_guardian_token';
    // === BUG #13 修复：sessionStorage 替代 localStorage ===
    // 好处：XSS 风险降低（关浏览器自动失效）、CSRF 攻击面减少
    // 代价：用户每次开新浏览器标签/窗口都要重新登录（可接受）
    const storage = window.sessionStorage;

    const Api = {
        getToken() {
            return storage.getItem(TOKEN_KEY) || '';
        },
        setToken(t) {
            if (t) storage.setItem(TOKEN_KEY, t);
            else storage.removeItem(TOKEN_KEY);
        },
        // === BUG #20 修复：登出清 token ===
        clearToken() {
            storage.removeItem(TOKEN_KEY);
        },

        _buildHeaders(extra) {
            const h = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
            const token = this.getToken();
            if (token) h['X-Auth-Token'] = token;
            return h;
        },

        async _request(method, path, body) {
            const opt = {
                method,
                headers: this._buildHeaders(),
            };
            if (body !== undefined) opt.body = JSON.stringify(body);
            const resp = await fetch(path, opt);
            let data = null;
            try { data = await resp.json(); } catch (e) {}
            if (!resp.ok) {
                const err = new Error((data && data.error) || `http_${resp.status}`);
                err.status = resp.status;
                err.data = data;
                throw err;
            }
            return data;
        },

        get(p)    { return this._request('GET', p); },
        post(p, b){ return this._request('POST', p, b); },
        put(p, b) { return this._request('PUT', p, b); },
        del(p)    { return this._request('DELETE', p); },

        // 业务封装
        authMode()          { return this.get('/api/auth/mode'); },
        setupPassword(password) { return this.post('/api/auth/setup', { password }); },
        upgradePassword(token, password) { return this.post('/api/auth/upgrade', { token, password }); },
        login(password)     { return this.post('/api/auth/login', { password }); },
        logout()            { return this.post('/api/auth/logout', {}); },
        authStatus()        { return this.get('/api/auth/status'); },
        processes(params)   {
            const q = new URLSearchParams(params || {}).toString();
            return this.get('/api/processes' + (q ? '?' + q : ''));
        },
        process(pid)        { return this.get('/api/processes/' + pid); },
        killProcess(p, o)   { return this.post('/api/processes/kill', o); },
        killByName(o)       { return this.post('/api/processes/kill-by-name', o); },
        apps()              { return this.get('/api/apps'); },
        audit(limit)        { return this.get('/api/audit?limit=' + (limit || 200)); },
        ports()             { return this.get('/api/ports'); },
        port(p)             { return this.get('/api/ports/' + p); },
        services()          { return this.get('/api/services'); },
        serviceLogs(u, n)   { return this.get('/api/services/' + encodeURIComponent(u) + '/logs?lines=' + (n || 100)); },
        serviceAction(o)    { return this.post('/api/services/action', o); },
        system()            { return this.get('/api/system'); },
        whitelist()         { return this.get('/api/whitelist'); },
        whitelistUpdate(o)  { return this.put('/api/whitelist', o); },
        whitelistCheck(o)   { return this.post('/api/whitelist/check', o); }
    };

    window.Api = Api;
})();
