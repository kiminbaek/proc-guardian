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
