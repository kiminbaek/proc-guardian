// proc-guardian 前端 API 封装
(function() {
    'use strict';

    const TOKEN_KEY = 'proc_guardian_token';

    const Api = {
        getToken() {
            return localStorage.getItem(TOKEN_KEY) || '';
        },
        setToken(t) {
            if (t) localStorage.setItem(TOKEN_KEY, t);
            else localStorage.removeItem(TOKEN_KEY);
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
        login(token)        { return this.post('/api/auth/login', { token }); },
        authStatus()        { return this.get('/api/auth/status'); },
        processes(params)   {
            const q = new URLSearchParams(params || {}).toString();
            return this.get('/api/processes' + (q ? '?' + q : ''));
        },
        process(pid)        { return this.get('/api/processes/' + pid); },
        killProcess(p, o)   { return this.post('/api/processes/kill', o); },
        killByName(o)       { return this.post('/api/processes/kill-by-name', o); },
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
