// proc-guardian 前端 UI 工具
(function() {
    'use strict';

    const UI = {
        // Toast
        toast(msg, type = 'info', duration = 3000) {
            const t = document.getElementById('toast');
            t.textContent = msg;
            t.className = 'toast ' + type;
            t.classList.remove('hidden');
            clearTimeout(this._toastTimer);
            this._toastTimer = setTimeout(() => t.classList.add('hidden'), duration);
        },

        // 确认弹窗
        confirm(title, body) {
            return new Promise((resolve) => {
                const modal = document.getElementById('modal-confirm');
                document.getElementById('modal-title').textContent = title;
                document.getElementById('modal-body').innerHTML = body;
                modal.classList.remove('hidden');

                const ok = document.getElementById('modal-ok');
                const cancel = document.getElementById('modal-cancel');
                const close = (v) => {
                    modal.classList.add('hidden');
                    ok.onclick = null;
                    cancel.onclick = null;
                    resolve(v);
                };
                ok.onclick = () => close(true);
                cancel.onclick = () => close(false);
            });
        },

        // 输入确认弹窗（用于高危操作）
        promptConfirm(title, body, phrase) {
            return new Promise((resolve) => {
                const modal = document.getElementById('modal-confirm');
                document.getElementById('modal-title').textContent = title;
                document.getElementById('modal-body').innerHTML = body + `<div class="confirm-phrase">请输入 <code>${this.escapeHtml(phrase)}</code><input id="modal-phrase-input" autocomplete="off" placeholder="输入确认短语"></div>`;
                modal.classList.remove('hidden');
                const ok = document.getElementById('modal-ok');
                const cancel = document.getElementById('modal-cancel');
                const input = document.getElementById('modal-phrase-input');
                ok.disabled = true;
                input.oninput = () => { ok.disabled = input.value === phrase ? false : true; };
                const close = (v) => {
                    modal.classList.add('hidden');
                    ok.disabled = false;
                    ok.onclick = null;
                    cancel.onclick = null;
                    resolve(v);
                };
                ok.onclick = () => close(true);
                cancel.onclick = () => close(false);
                input.focus();
            });
        },

        // 格式化
        fmtBytes(n) {
            if (!n || n < 1) return '0';
            const units = ['B', 'KB', 'MB', 'GB', 'TB'];
            let i = 0;
            while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
            return n.toFixed(1) + ' ' + units[i];
        },

        fmtUptime(sec) {
            if (!sec) return '-';
            sec = Math.floor(sec);
            const d = Math.floor(sec / 86400);
            const h = Math.floor((sec % 86400) / 3600);
            const m = Math.floor((sec % 3600) / 60);
            if (d > 0) return `${d}d ${h}h`;
            if (h > 0) return `${h}h ${m}m`;
            return `${m}m`;
        },

        escapeHtml(s) {
            if (s === null || s === undefined) return '';
            return String(s)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        },

        // 转义但保留 cmdline 可读性
        escapeCmd(s) {
            return this.escapeHtml(s).replace(/\s+/g, ' ').slice(0, 300);
        }
    };

    window.UI = UI;
})();
