// proc-guardian 审计日志 v1.1.0
const fs = require('fs');
const path = require('path');
const TRIM_PKGVAR = process.env.TRIM_PKGVAR || '/tmp';
const AUDIT_FILE = path.join(TRIM_PKGVAR, 'audit.log');

function append(event, detail) {
    const row = {
        ts: new Date().toISOString(),
        event,
        ...(detail || {})
    };
    try {
        // M3 修复：日志轮转，超过 10MB 截断保留最后 2000 行
        try {
            const stat = fs.statSync(AUDIT_FILE);
            if (stat.size > 10 * 1024 * 1024) {
                const lines = fs.readFileSync(AUDIT_FILE, 'utf8').trim().split('\n');
                fs.writeFileSync(AUDIT_FILE, lines.slice(-2000).join('\n') + '\n', { mode: 0o600 });
            }
        } catch (e2) {}
        fs.appendFileSync(AUDIT_FILE, JSON.stringify(row) + '\n', { mode: 0o600 });
    } catch (e) {}
}

function fromReq(req) {
    return {
        ip: req.ip || (req.connection && req.connection.remoteAddress) || 'unknown',
        ua: req.headers['user-agent'] || ''
    };
}

module.exports = { append, fromReq, AUDIT_FILE };
