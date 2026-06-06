// proc-guardian 端口扫描
// 解析 `ss -tlnp` / `ss -ulnp` 输出，关联 PID/进程名

const { execSync } = require('child_process');

const CACHE_TTL_MS = 1500;
let cache = null;
let cacheTime = 0;

function parseSs(out) {
    // ss -tlnp 格式：State Recv-Q Send-Q Local Address:Port Peer Address:Port Process
    // users:(("nginx",pid=2382,fd=10)) 格式
    const lines = out.split('\n');
    const result = [];
    for (const line of lines) {
        if (!line.trim()) continue;
        // 前 4 列用 split 取，剩下 Process 列可能含空格
        const m = line.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/);
        if (!m) continue;
        const [, state, recvQ, sendQ, localAddr, peerAddr, procStr] = m;
        const proto = state.includes('LISTEN') || state.includes('UNCONN') ? 'tcp' :
                      (state.startsWith('UDP') || state === 'UNCONN' ? 'udp' : 'tcp');
        // 解析 port
        let addr = '', port = '';
        if (localAddr.includes('[')) {
            // IPv6: [::]:80 或 [::ffff:192.168.2.132]:49152
            const m2 = localAddr.match(/^(\[[^\]]+\]):(\d+)$/);
            if (m2) { addr = m2[1]; port = m2[2]; }
        } else {
            const idx = localAddr.lastIndexOf(':');
            if (idx > 0) {
                addr = localAddr.substring(0, idx);
                port = localAddr.substring(idx + 1);
            }
        }
        if (!port) continue;

        // 解析进程 users:(("nginx",pid=2382,fd=10),("nginx",pid=2381,fd=10))
        let pid = null, processName = null, fds = [];
        const procMatch = procStr.match(/users:\(\((.+)\)\)\)/);
        if (procMatch) {
            const entries = procMatch[1].split(/\),\s*\(/);
            for (const e of entries) {
                const parts = e.replace(/^\(|\)$/g, '').split(',');
                const obj = {};
                for (const p of parts) {
                    const kv = p.match(/^(\w+)=("?)([^"]*)\2$/);
                    if (kv) obj[kv[1]] = kv[3];
                }
                if (obj.pid) {
                    fds.push({ pid: parseInt(obj.pid, 10), name: obj.name || null, fd: obj.fd || null });
                    if (!pid) {
                        pid = parseInt(obj.pid, 10);
                        processName = obj.name || null;
                    }
                }
            }
        }

        result.push({
            port: parseInt(port, 10),
            proto,
            address: addr,
            state: state.replace(/-\d+$/, ''),
            pid,
            process_name: processName,
            fds
        });
    }
    return result;
}

function getAllListeningPorts() {
    const now = Date.now();
    if (cache && (now - cacheTime) < CACHE_TTL_MS) return cache;

    let result = [];
    try {
        const tcpOut = execSync('ss -tlnp 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
        const udpOut = execSync('ss -ulnp 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
        result = [...parseSs(tcpOut), ...parseSs(udpOut)];
    } catch (e) {
        console.error('ss exec failed:', e.message);
    }

    // 去重 (port+proto+pid)
    const seen = new Set();
    result = result.filter(r => {
        const k = `${r.port}|${r.proto}|${r.pid || ''}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });

    cache = result;
    cacheTime = now;
    return cache;
}

function getPortByPort(port) {
    const all = getAllListeningPorts();
    return all.filter(p => p.port === Number(port));
}

function clearCache() {
    cache = null;
    cacheTime = 0;
}

module.exports = {
    getAllListeningPorts,
    getPortByPort,
    clearCache
};
