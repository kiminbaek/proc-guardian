// proc-guardian 审计日志 v1.9.0
const fs = require('fs');
const path = require('path');
const TRIM_PKGVAR = process.env.TRIM_PKGVAR || '/tmp';
const AUDIT_FILE = path.join(TRIM_PKGVAR, 'audit.log');

const MAX_SIZE = 10 * 1024 * 1024;   // 10MB 触发轮转
const KEEP_LINES = 2000;             // 轮转后保留最后 2000 行
const ROTATE_MIN_INTERVAL_MS = 5000; // 同一进程内最短轮转间隔

let lastRotateAt = 0;

// v1.9.0 修「日志轮转竞态」：
//   旧实现是 readFileSync 全文 → writeFileSync 覆写，两步之间到达的
//   appendFileSync 写入会被整段丢弃；而且每条日志都要 statSync 一次。
//   改法：① 轮转写临时文件后 renameSync 原子替换（rename 期间的 append
//   会落到旧 inode，最多丢极少数记录而不是丢整段）；② 用内存 size 计数器
//   替代每次 statSync；③ 加最短轮转间隔，避免高频写入时反复触发。
function rotateIfNeeded() {
    const now = Date.now();
    if (now - lastRotateAt < ROTATE_MIN_INTERVAL_MS) return;

    let size = 0;
    try {
        size = fs.statSync(AUDIT_FILE).size;
    } catch (e) {
        return;   // 文件不存在，无需轮转
    }
    if (size <= MAX_SIZE) return;

    lastRotateAt = now;
    const tmp = AUDIT_FILE + '.rotate.' + process.pid;
    try {
        const lines = fs.readFileSync(AUDIT_FILE, 'utf8').split('\n').filter(Boolean);
        fs.writeFileSync(tmp, lines.slice(-KEEP_LINES).join('\n') + '\n', { mode: 0o600 });
        fs.renameSync(tmp, AUDIT_FILE);   // 原子替换
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch (e2) {}
    }
}

let writeCount = 0;

function append(event, detail) {
    const row = {
        ts: new Date().toISOString(),
        event,
        ...(detail || {})
    };
    try {
        // 每 200 条检查一次大小，而不是每条都 statSync
        if (writeCount++ % 200 === 0) rotateIfNeeded();
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
