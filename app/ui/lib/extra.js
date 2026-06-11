(function(){
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => UI.escapeHtml(String(s == null ? '' : s));
  let stateRef = null;
  function card(k,v,s){ return `<div class="dash-card"><b>${esc(k)}</b><strong>${esc(v)}</strong><span>${esc(s)}</span></div>`; }
  function miniProc(rows){ return (rows||[]).map(p=>`<div class="mini-row"><b>${esc(p.app_name || p.comm)}</b><span>PID ${p.pid} · CPU ${Number(p.pcpu||0).toFixed(1)} · MEM ${Number(p.pmem||0).toFixed(1)}</span></div>`).join('') || '<p class="muted">暂无数据</p>'; }
  function miniApps(rows){ return (rows||[]).map(a=>`<div class="mini-row"><b>${esc(a.app_name)}</b><span>${(a.ports||[]).slice(0,4).map(p=>p.port).join(', ') || '-'}</span></div>`).join('') || '<p class="muted">暂无应用端口</p>'; }
  async function refreshDashboard(){
    try {
      const [sys, procs, ports, apps, aud] = await Promise.all([Api.system(), Api.processes({size:1000,sort:'cpu',order:'desc'}), Api.ports(), Api.apps(), Api.audit(5)]);
      if ($('stat-cpu')) $('stat-cpu').textContent = (sys.cpu && Number.isFinite(sys.cpu.usage)) ? sys.cpu.usage : '-';
      if ($('stat-mem')) $('stat-mem').textContent = sys.memory ? sys.memory.percent : '-';
      if ($('stat-ports')) $('stat-ports').textContent = ports.total; if ($('stat-procs')) $('stat-procs').textContent = procs.total;
      const list = procs.processes || []; const high = list.filter(p=>p.risk_level>=2).length; const appCount = (apps.apps||[]).filter(a=>a.has_running_process).length;
      $('dashboard-cards').innerHTML = [card('进程',procs.total,'当前进程'),card('端口',ports.total,'监听端口'),card('高风险',high,'需谨慎操作'),card('运行应用',appCount,'发现进程的应用')].join('');
      $('dash-top-cpu').innerHTML = miniProc(list.slice(0,8));
      $('dash-top-mem').innerHTML = miniProc([...list].sort((a,b)=>b.pmem-a.pmem).slice(0,8));
      $('dash-app-ports').innerHTML = miniApps((apps.apps||[]).filter(a=>a.ports.length).slice(0,8));
      $('dash-audit').innerHTML = (aud.logs||[]).map(x=>`<div class="mini-row"><b>${esc(x.event||'')}</b><span>${esc((x.ts||'').replace('T',' ').slice(0,19))}</span></div>`).join('') || '<p class="muted">暂无审计记录</p>';
    } catch(e) { console.error('refreshDashboard:', e); }
  }
  async function refreshApps(){
    try { const r=await Api.apps(); const q=((stateRef&&stateRef.appSearch)||'').toLowerCase(); const rows=(r.apps||[]).filter(a=>!q||a.app_name.toLowerCase().includes(q)||a.app_id.toLowerCase().includes(q)||(a.ports||[]).some(p=>String(p.port).includes(q)));
      $('app-tbody').innerHTML = rows.map(a=>`<tr class="${a.has_running_process?'':'dim'}"><td><b>${esc(a.app_name)}</b><br><span class="muted">${esc(a.app_id)} · v${esc(a.version||'?')}</span></td><td>${a.has_running_process?'<span class="badge badge-running">有进程</span>':'<span class="badge badge-inactive">无常驻进程</span>'}</td><td>${a.process_count}</td><td>${(a.ports||[]).map(p=>`<span class="badge badge-listening">${p.port}</span>`).join(' ')||'<span class="muted">-</span>'}</td><td>${Number(a.cpu||0).toFixed(1)}</td><td>${UI.fmtBytes(a.rss_bytes||0)}</td><td>${a.has_running_process?'进程页按应用名搜索可查看详情':'应用已安装，但当前未发现常驻进程'}</td></tr>`).join('') || '<tr><td colspan="7" class="muted" style="text-align:center;padding:40px">无匹配应用</td></tr>';
    } catch(e) { console.error('refreshApps:', e); }
  }
  async function refreshAudit(){
    try { const r=await Api.audit(200); $('audit-tbody').innerHTML=(r.logs||[]).map(x=>`<tr><td>${esc((x.ts||'').replace('T',' ').slice(0,19))}</td><td><span class="badge badge-app">${esc(x.event||'-')}</span></td><td>${esc(x.pid||x.name||x.action||x.unit||'-')}</td><td>${esc(x.result||x.error||x.ip||'-')}</td></tr>`).join('') || '<tr><td colspan="4" class="muted" style="text-align:center;padding:40px">暂无审计记录</td></tr>'; } catch(e) { console.error('refreshAudit:', e); }
  }
  function bindExtra(state){ stateRef=state; const appSearch=$('app-search'); if(appSearch) appSearch.oninput=e=>{state.appSearch=e.target.value; refreshApps();}; const appRefresh=$('app-refresh'); if(appRefresh) appRefresh.onclick=refreshApps; const auditRefresh=$('audit-refresh'); if(auditRefresh) auditRefresh.onclick=refreshAudit; setTimeout(refreshDashboard, 100); }
  window.PGExtra = { bindExtra, refreshDashboard, refreshApps, refreshAudit };
})();
