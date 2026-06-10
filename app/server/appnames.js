// proc-guardian 进程→应用名映射 v1.0.8
// 负责：通过 PID/exe/cwd 反查应用名（fnOS 应用 + 系统服务）
// 缓存 fnOS manifest 扫描结果 60s

const fs = require('fs');
const path = require('path');

// === 内置系统服务映射表（手动维护，覆盖常见关键进程）===
const SYSTEM_SERVICES = {
  // SSH
  'sshd':       { app_id: 'system', app_name: 'SSH 远程连接' },
  'sshd-session': { app_id: 'system', app_name: 'SSH 会话' },
  'ssh':        { app_id: 'system', app_name: 'SSH' },
  // Web 服务器
  'nginx':      { app_id: 'system', app_name: 'Nginx Web 服务' },
  'caddy':      { app_id: 'system', app_name: 'Caddy Web 服务' },
  'apache2':    { app_id: 'system', app_name: 'Apache Web 服务' },
  'httpd':      { app_id: 'system', app_name: 'Apache HTTPD' },
  // 数据库
  'postgres':   { app_id: 'system', app_name: 'PostgreSQL' },
  'mysqld':     { app_id: 'system', app_name: 'MySQL' },
  'mariadbd':   { app_id: 'system', app_name: 'MariaDB' },
  'redis-server': { app_id: 'system', app_name: 'Redis' },
  // 飞牛核心
  'trim_app_center': { app_id: 'system', app_name: '飞牛应用中心' },
  'trim_paneld':     { app_id: 'system', app_name: '飞牛面板' },
  'trim.helper':     { app_id: 'system', app_name: '飞牛助手' },
  'smbd':           { app_id: 'system', app_name: 'SMB 文件共享' },
  'nmbd':           { app_id: 'system', app_name: 'NetBIOS 名称服务' },
  'rpcbind':        { app_id: 'system', app_name: 'RPC 端口映射' },
  // 系统
  'systemd':        { app_id: 'system', app_name: 'Systemd 初始化' },
  'systemd-journald': { app_id: 'system', app_name: '系统日志' },
  'systemd-logind':   { app_id: 'system', app_name: '登录管理器' },
  'systemd-udevd':    { app_id: 'system', app_name: '设备管理器' },
  'systemd-resolved': { app_id: 'system', app_name: 'DNS 解析' },
  'systemd-networkd': { app_id: 'system', app_name: '网络管理器' },
  'dbus-daemon':  { app_id: 'system', app_name: 'D-Bus 消息总线' },
  'networkd-dispatcher': { app_id: 'system', app_name: '网络事件分发' },
  'polkitd':      { app_id: 'system', app_name: '权限管理' },
  'chronyd':      { app_id: 'system', app_name: 'NTP 时间同步' },
  'rsyslogd':     { app_id: 'system', app_name: '系统日志服务' },
  'fcron':        { app_id: 'system', app_name: '任务调度' },
  'cron':         { app_id: 'system', app_name: '定时任务' },
  'atd':          { app_id: 'system', app_name: '一次性任务' },
  'fail2ban-server': { app_id: 'system', app_name: 'Fail2ban 安全防护' },
  'nginx':        { app_id: 'system', app_name: 'Nginx Web 服务' },
  // QwenPaw
  'qwenpaw':      { app_id: 'com.dustinky.qwenpaw', app_name: 'QwenPaw 智能管家' },
  'qwenpaw-cli':  { app_id: 'com.dustinky.qwenpaw', app_name: 'QwenPaw 命令行' },
  'sandbox-init': { app_id: 'com.dustinky.qwenpaw', app_name: 'QwenPaw 沙箱' },
  // 网络
  'dhclient':     { app_id: 'system', app_name: 'DHCP 客户端' },
  'NetworkManager': { app_id: 'system', app_name: '网络管理器' },
  'avahi-daemon': { app_id: 'system', app_name: 'Avahi 零配置网络' },
};

// === fnOS 应用名缓存 ===
let fnosAppsCache = null;
let fnosAppsCacheTime = 0;
const FNOS_CACHE_TTL = 60_000; // 60s

function readManifestValue(raw, key) {
  const m = raw.match(new RegExp('^' + key + '\\s*=\\s*(.+)$', 'm'));
  return m ? m[1].trim() : '';
}

function scanFnOSApps() {
  const now = Date.now();
  if (fnosAppsCache && (now - fnosAppsCacheTime) < FNOS_CACHE_TTL) return fnosAppsCache;

  const result = new Map(); // appname/dirName -> metadata
  try {
    const appsDir = '/var/apps';
    const entries = fs.readdirSync(appsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(appsDir, entry.name, 'manifest');
      try {
        if (!fs.existsSync(manifestPath)) continue;
        const raw = fs.readFileSync(manifestPath, 'utf8');
        const appname = readManifestValue(raw, 'appname') || entry.name;
        const display = readManifestValue(raw, 'display_name') || appname;
        const version = readManifestValue(raw, 'version') || '?';
        const meta = { app_id: appname, app_name: display, version, dir_name: entry.name };
        result.set(appname, meta);
        result.set(entry.name, meta);
      } catch (e) {}
    }
  } catch (e) {}

  fnosAppsCache = result;
  fnosAppsCacheTime = now;
  return result;
}

function matchAppFromText(text, fnosApps) {
  if (!text) return null;
  const patterns = [
    /\/var\/apps\/([^/\s]+)/g,
    /\/vol\d+\/@appdata\/([^/\s]+)/g,
    /\/vol\d+\/@apphome\/([^/\s]+)/g,
    /\/vol\d+\/@appshare\/([^/\s]+)/g,
    /\/vol\d+\/@appcenter\/([^/\s]+)/g,
    /\/vol\d+\/@appconf\/([^/\s]+)/g
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const key = m[1];
      if (fnosApps.has(key)) return { ...fnosApps.get(key) };
      return { app_id: key, app_name: key };
    }
  }
  return null;
}

/**
 * 通过进程信息反查应用名
 * @param {Object} proc - { pid, comm, exe, cwd, cmdline }
 * @returns {Object} { app_id, app_name } 或 null
 */
function getAppName(proc) {
  if (!proc) return null;

  const comm = (proc.comm || '').trim();
  if (comm && SYSTEM_SERVICES[comm]) return { ...SYSTEM_SERVICES[comm] };

  const exe = (proc.exe || '').trim();
  const cwd = (proc.cwd || '').trim();
  const cmdline = (proc.cmdline || '').trim();
  const args = (proc.args || '').trim();
  const fnosApps = scanFnOSApps();

  for (const text of [exe, cwd, cmdline, args]) {
    const app = matchAppFromText(text, fnosApps);
    if (app) return app;
  }

  // 常见命令名兜底：agent-backup 服务二进制名/脚本名
  const joined = [comm, cmdline, args].join(' ').toLowerCase();
  if (joined.includes('agentbackup') || joined.includes('agent-backup')) {
    const app = fnosApps.get('com.dustinky.agentbackup');
    return app ? { ...app } : { app_id: 'com.dustinky.agentbackup', app_name: 'Agent 备份' };
  }
  if (joined.includes('xray') || joined.includes('proxy-native')) {
    const app = fnosApps.get('xray-proxy-native');
    return app ? { ...app } : { app_id: 'xray-proxy-native', app_name: '代理管理' };
  }
  if (cmdline.includes('/opt/qwenpaw/') || cmdline.includes('/vol3/@apphome/com.dustinky.qwenpaw/') ||
      joined.includes('qwenpaw')) {
    const app = fnosApps.get('com.dustinky.qwenpaw');
    return app ? { ...app } : { app_id: 'com.dustinky.qwenpaw', app_name: 'QwenPaw' };
  }

  return null;
}

module.exports = { getAppName, scanFnOSApps };
