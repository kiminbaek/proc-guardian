// proc-guardian 端口扫描
// v1.1.1：ss 解析 + /proc/net inode 兜底，普通权限下也尽量关联 PID

const { execSync } = require('child_process');
const fs = require('fs');

const CACHE_TTL_MS = 1500;
let cache = null;
let cacheTime = 0;

function parseSs(out, forcedProto) {
    const lines = out.split('\n');
    const result = [];
    for (const line of lines) {
        if (!line.trim() || line.startsWith('State ') || line.startsWith('Netid ')) continue;
        const m = line.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/);
        if (!m) continue;
        const [, state, recvQ, sendQ, localAddr, peerAddr, procStr] = m;
        const proto = forcedProto || (state === 'UNCONN' ? 'udp' : 'tcp');
        let addr = '', port = '';
        const bracket = localAddr.match(/^(\[[^\]]+\]):(\d+)$/);
        if (bracket) { addr = bracket[1]; port = bracket[2]; }
        else {
            const idx = localAddr.lastIndexOf(':');
            if (idx > 0) { addr = localAddr.substring(0, idx); port = localAddr.substring(idx + 1); }
        }
        if (!port || !/^\d+$/.test(port)) continue;
        let pid = null, processName = null, fds = [];
        const re = /"([^"]+)",pid=(\d+),fd=(\d+)/g;
        let pm;
        while ((pm = re.exec(procStr || '')) !== null) {
            const item = { name: pm[1], pid: parseInt(pm[2], 10), fd: pm[3] };
            fds.push(item);
            if (!pid) { pid = item.pid; processName = item.name; }
        }
        result.push({ port: parseInt(port, 10), proto, address: addr, state: state.replace(/-\d+$/, ''), pid, process_name: processName, fds, inode: null });
    }
    return result;
}

function hexToIPv4(hex) {
    if (!hex || hex.length !== 8) return '';
    const parts = [];
    for (let i = 0; i < 8; i += 2) parts.unshift(parseInt(hex.slice(i, i + 2), 16));
    return parts.join('.');
}

function parseProcNet(file, proto) {
    let out = '';
    try { out = fs.readFileSync(file, 'utf8'); } catch (e) { return []; }
    const lines = out.trim().split('\n').slice(1);
    const result = [];
    for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 10) continue;
        const local = parts[1];
        const stateHex = parts[3];
        const inode = parts[9];
        if (proto === 'tcp' && stateHex !== '0A') continue; // LISTEN
        const [addrHex, portHex] = local.split(':');
        const port = parseInt(portHex, 16);
        if (!Number.isFinite(port)) continue;
        const is6 = file.endsWith('6');
        const address = is6 ? '[::]' : hexToIPv4(addrHex);
        result.push({ port, proto, address, state: proto === 'tcp' ? 'LISTEN' : 'UNCONN', pid: null, process_name: null, fds: [], inode });
    }
    return result;
}

function buildInodePidMap() {
    const map = new Map();
    let pids = [];
    try { pids = fs.readdirSync('/proc').filter(x => /^\d+$/.test(x)); } catch (e) { return map; }
    for (const pid of pids) {
        let comm = '';
        try { comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch (e) {}
        let fds = [];
        try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch (e) { continue; }
        for (const fd of fds) {
            try {
                const link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
                const m = link.match(/^socket:\[(\d+)\]$/);
                if (!m) continue;
                const inode = m[1];
                if (!map.has(inode)) map.set(inode, []);
                map.get(inode).push({ pid: parseInt(pid, 10), name: comm || null, fd });
            } catch (e) {}
        }
    }
    return map;
}

function fillPidByInode(ports) {
    const need = ports.some(p => !p.pid && p.inode);
    if (!need) return ports;
    const inodeMap = buildInodePidMap();
    for (const p of ports) {
        if (p.pid || !p.inode) continue;
        const fds = inodeMap.get(String(p.inode)) || [];
        if (fds.length > 0) {
            p.fds = fds;
            p.pid = fds[0].pid;
            p.process_name = fds[0].name;
        }
    }
    return ports;
}

function getAllListeningPorts() {
    const now = Date.now();
    if (cache && (now - cacheTime) < CACHE_TTL_MS) return cache;
    let result = [];
    try {
        result = [
            ...parseSs(execSync('ss -tlnp 2>/dev/null', { encoding: 'utf8', timeout: 5000 }), 'tcp'),
            ...parseSs(execSync('ss -ulnp 2>/dev/null', { encoding: 'utf8', timeout: 5000 }), 'udp'),
            ...parseSs(execSync('ss -tlnp6 2>/dev/null', { encoding: 'utf8', timeout: 5000 }), 'tcp'),
            ...parseSs(execSync('ss -ulnp6 2>/dev/null', { encoding: 'utf8', timeout: 5000 }), 'udp')
        ];
    } catch (e) {
        console.error('ss exec failed:', e.message);
    }
    const procNet = [
        ...parseProcNet('/proc/net/tcp', 'tcp'),
        ...parseProcNet('/proc/net/tcp6', 'tcp'),
        ...parseProcNet('/proc/net/udp', 'udp'),
        ...parseProcNet('/proc/net/udp6', 'udp')
    ];
    fillPidByInode(procNet);
    const byKey = new Map();
    for (const p of [...result, ...procNet]) {
        const k = `${p.proto}|${p.port}|${p.pid || ''}|${p.address || ''}`;
        const old = byKey.get(k);
        if (!old || (!old.pid && p.pid)) byKey.set(k, p);
    }
    cache = Array.from(byKey.values()).sort((a,b) => a.port - b.port || a.proto.localeCompare(b.proto));
    cacheTime = now;
    return cache;
}

function getPortByPort(port) { return getAllListeningPorts().filter(p => p.port === Number(port)); }
function clearCache() { cache = null; cacheTime = 0; }
module.exports = { getAllListeningPorts, getPortByPort, clearCache };
