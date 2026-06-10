const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const procMod = require('../process');
const portsMod = require('../ports');
const appnames = require('../appnames');
const risk = require('../risk');
const wlMod = require('../whitelist');
function mv(raw, key) { const m = raw.match(new RegExp('^' + key + '\\s*=\\s*(.+)$', 'm')); return m ? m[1].trim() : ''; }
function manifests() {
  const apps = new Map();
  try { for (const ent of fs.readdirSync('/var/apps', { withFileTypes: true })) {
    if (!ent.isDirectory()) continue; const mf = path.join('/var/apps', ent.name, 'manifest'); if (!fs.existsSync(mf)) continue;
    const raw = fs.readFileSync(mf, 'utf8'); const id = mv(raw,'appname') || ent.name;
    apps.set(id, { app_id:id, dir_name:ent.name, app_name:mv(raw,'display_name') || id, version:mv(raw,'version') || '?', processes:[], ports:[], cpu:0, rss:0, status:'installed' });
  }} catch(e) {}
  return apps;
}
function appFor(proc, byPid, cache) {
  if (!proc) return null; if (cache.has(proc.pid)) return cache.get(proc.pid);
  let app = appnames.getAppName(proc);
  if ((!app || app.app_id === 'nodejs_v22') && proc.ppid && byPid.has(proc.ppid)) {
    const pa = appFor(byPid.get(proc.ppid), byPid, cache); if (pa && pa.app_id && pa.app_id !== 'system') app = pa;
  }
  cache.set(proc.pid, app); return app;
}
router.get('/', (req, res) => {
  const apps = manifests(); const procs = procMod.getAllProcesses(); const byPid = new Map(procs.map(p => [p.pid,p])); const cache = new Map();
  const ports = portsMod.getAllListeningPorts(); const portByPid = new Map();
  for (const pt of ports) { const ids = new Set(); if (pt.pid) ids.add(pt.pid); for (const fd of pt.fds || []) if (fd.pid) ids.add(fd.pid); for (const pid of ids) { if (!portByPid.has(pid)) portByPid.set(pid, []); portByPid.get(pid).push(pt); } }
  for (const proc of procs) { const app = appFor(proc, byPid, cache); if (!app || !app.app_id || app.app_id === 'system') continue;
    if (!apps.has(app.app_id)) apps.set(app.app_id, { app_id:app.app_id, dir_name:app.dir_name || app.app_id, app_name:app.app_name || app.app_id, version:app.version || '?', processes:[], ports:[], cpu:0, rss:0, status:'detected' });
    const item = apps.get(app.app_id); const rk = risk.classify(proc, app, wlMod.checkProcess(proc));
    item.processes.push({ pid:proc.pid, ppid:proc.ppid, user:proc.user, comm:proc.comm, pcpu:proc.pcpu, pmem:proc.pmem, rss:proc.rss, cmdline:proc.cmdline, risk_label:rk.risk_label, kill_policy:rk.kill_policy });
    item.cpu += proc.pcpu || 0; item.rss += proc.rss || 0; for (const pt of portByPid.get(proc.pid) || []) item.ports.push({ port:pt.port, proto:pt.proto, address:pt.address, pid:proc.pid });
  }
  const list = Array.from(apps.values()).map(a => { const seen = new Set(); a.ports = a.ports.filter(p => { const k=p.proto+'|'+p.port+'|'+p.address; if(seen.has(k)) return false; seen.add(k); return true; }).sort((x,y)=>x.port-y.port); a.process_count=a.processes.length; a.has_running_process=a.process_count>0; a.rss_bytes=a.rss*1024; return a; }).sort((a,b)=>Number(b.has_running_process)-Number(a.has_running_process)||a.app_name.localeCompare(b.app_name));
  res.json({ ok:true, total:list.length, apps:list });
});
module.exports = router;
