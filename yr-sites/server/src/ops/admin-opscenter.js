// 后台：运维。服务连通性、错误日志、两站状态、登录与会话、配置检查、网站版本（回滚）、定时任务（立即运行 / 暂停）、恢复演练。
import { shell, esc, fmt } from '../admin.js';
import { config } from '../config.js';
import { currentUser, actorName } from '../auth.js';
import * as Audit from '../audit.js';
import { setSetting, getSetting } from '../catalog/store.js';
import * as S from './services.js';
import * as E from './errors.js';
import * as Sec from './security.js';
import * as J from '../jobs.js';
import { listReleases, rollbackRelease, buildRunning } from '../content/publisher.js';
import { systemStatus, backupRuns } from './backup.js';

export const OPS_NAV = '<p class="acts"><a href="/admin/system">系统状态</a> · <a href="/admin/system/services">服务连通性</a> · <a href="/admin/system/errors">错误日志</a> · <a href="/admin/system/sites">两站状态</a> · <a href="/admin/system/security">登录与会话</a> · <a href="/admin/system/config">配置检查</a> · <a href="/admin/system/releases">网站版本</a> · <a href="/admin/system/jobs">定时任务</a></p>';
const flash = (c) => `${c.req.query('m') ? `<div class="warn" style="background:#e8f5e9;border-color:#a5d6a7">${esc(c.req.query('m'))}</div>` : ''}${c.req.query('e') ? `<div class="warn" style="background:#fdecea;border-color:#f5b7b1">${esc(c.req.query('e'))}</div>` : ''}`;
const view = (title, body) => shell(title, OPS_NAV + body);
const back = (c, path, k, v) => c.redirect(`${path}${path.includes('?') ? '&' : '?'}${k}=${encodeURIComponent(v)}`);
const STATE = { ok: ['#e3f2e5', '正常'], warn: ['#fff4e5', '需处理'], fail: ['#fdecea', '异常'], none: ['#eceff1', '未检查'], off: ['#eceff1', '未配置'] };
const pill = (k) => `<span class="pill" style="background:${STATE[k][0]}">${STATE[k][1]}</span>`;
const csvCell = (v) => { const s = String(v ?? '').replace(/^[=+\-@\t\r]/, "'$&"); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const ago = (ms) => (ms == null ? '' : ms < 60e3 ? '刚刚' : ms < 3600e3 ? `${Math.round(ms / 60e3)} 分钟前` : ms < 86400e3 ? `${Math.round(ms / 3600e3)} 小时前` : `${Math.round(ms / 86400e3)} 天前`);

/** This site's health details, also served to the other site at /api/health?detail=1 (with OPS_TOKEN). */
export function healthDetail() {
  const s = systemStatus();
  const b = backupRuns(1)[0];
  return { version: s.version, uptimeSec: s.uptimeSec, rssMb: s.rssMb, diskFree: s.disk?.free ?? null, backup: b ? { ok: Boolean(b.ok), ts: b.ts } : null, errors24h: E.errorStats(24).distinct, failingServices: S.failingServices().map((x) => x.id) };
}

function servicesPage(c) {
  const list = S.serviceList();
  const tr = list.map((s) => {
    const state = !s.configured ? 'off' : !s.last ? 'none' : s.last.level;
    return `<tr><td><b>${esc(s.name)}</b><div class="mute">${esc(s.setting)}</div></td><td>${pill(state)}</td><td>${s.last ? `${esc(s.last.detail)}<div class="mute">${fmt(s.last.ts)} · ${s.last.ms} ms · ${esc(s.last.by)}</div>` : ''}</td>
<td>${s.lastOk ? fmt(s.lastOk.ts) : '—'}</td><td>${s.lastFail ? `${fmt(s.lastFail.ts)}<div class="mute" style="color:#c62828">${esc(s.lastFail.detail)}</div>` : '—'}</td>
<td>${s.configured ? `<form method="post" action="/admin/system/services/check"><input type="hidden" name="id" value="${esc(s.id)}"><button>测试</button></form>` : ''}</td></tr>`;
  }).join('');
  return view('服务连通性', `${flash(c)}<h2>服务连通性</h2><p class="mute">一键测试网站依赖的外部服务。每天 8:00 自动检查一次，原本正常的服务出现异常时推送企业微信。测试企业微信 / 飞书时会往群里发一条测试消息。</p>
<form method="post" action="/admin/system/services/check" class="acts"><input type="hidden" name="id" value="all"><button>全部测试</button></form>
<div class="wrap"><table><thead><tr><th>服务</th><th>状态</th><th>最近一次</th><th>最近成功</th><th>最近失败</th><th></th></tr></thead><tbody>${tr}</tbody></table></div>`);
}

function errorsPage(c) {
  const f = { q: c.req.query('q') || '', status: c.req.query('status') || 'open', from: c.req.query('from') || '', to: c.req.query('to') || '' };
  const rows = E.searchErrors(f);
  const st = E.errorStats(24);
  const opt = (v, l) => `<option value="${v}"${f.status === v ? ' selected' : ''}>${l}</option>`;
  return view('错误日志', `${flash(c)}<h2>错误日志</h2><p class="mute">服务器出错（页面报错、定时任务失败、后台进程异常）按"位置 + 错误"归类计数。新错误或标记已解决后再次出现的错误会推送企业微信（同一错误每小时最多一次）。</p>
<div class="tiles"><div class="tile"><span>24 小时内出现的错误</span><strong>${st.distinct}</strong></div><div class="tile"><span>未解决</span><strong>${st.open}</strong></div></div>
<form method="get" class="acts" style="display:flex;flex-wrap:wrap;gap:8px"><select name="status">${opt('open', '未解决')}${opt('resolved', '已解决')}${opt('all', '全部')}</select><input name="q" value="${esc(f.q)}" placeholder="错误信息 / 地址"><label>从 <input type="date" name="from" value="${esc(f.from)}"></label><label>到 <input type="date" name="to" value="${esc(f.to)}"></label><button>筛选</button> <a href="/admin/system/errors.csv?${new URLSearchParams(f)}">导出 CSV</a></form>
<form method="post" action="/admin/system/errors/resolve"><div class="wrap"><table><thead><tr><th><input type="checkbox" onclick="document.querySelectorAll('input[name=ids]').forEach((x)=>x.checked=this.checked)" aria-label="全选"></th><th>最近发生</th><th>位置</th><th>错误</th><th>次数</th><th>首次</th><th>状态</th></tr></thead><tbody>
${rows.map((r) => `<tr><td><input type="checkbox" name="ids" value="${r.id}"></td><td>${fmt(r.last_at)}</td><td>${esc(r.source === 'job' ? `定时任务 ${r.path}` : r.source === 'process' ? '后台进程' : `${r.method} ${r.path}`)}</td><td><a href="/admin/system/errors/${r.id}">${esc(r.message.slice(0, 160))}</a></td><td>${r.count}</td><td>${fmt(r.first_at)}</td><td>${r.resolved ? `已解决 <span class="mute">${esc(r.resolved_by || '')}</span>` : '<b style="color:#c62828">未解决</b>'}</td></tr>`).join('') || '<tr><td colspan="7" class="mute">没有错误</td></tr>'}</tbody></table></div>
${rows.some((r) => !r.resolved) ? '<button style="margin-top:8px">标记选中为已解决</button>' : ''}</form>`);
}

function sitesPage(c, rows) {
  return view('两站状态', `${flash(c)}<h2>两站状态</h2><p class="mute">本站和其他站点（在 PEER_SITES 中配置，例如北美 LED 站和东南亚 YR GRID 站）的运行情况。读取对方的详细状态需要两边配置相同的 OPS_TOKEN。</p>
<div class="wrap"><table><thead><tr><th>站点</th><th>状态</th><th>版本</th><th>运行时间</th><th>内存</th><th>磁盘剩余</th><th>最近备份</th><th>24 小时错误</th><th>异常的外部服务</th></tr></thead><tbody>
${rows.map((r) => `<tr><td><b>${esc(r.name)}</b><div class="mute">${esc(r.url)}</div></td><td>${r.error ? `${pill('fail')} <span class="mute">${esc(r.error)}</span>` : `${pill('ok')}${r.ms != null ? ` <span class="mute">${r.ms} ms</span>` : ''}`}</td>
<td>${esc(r.version ?? '—')}</td><td>${r.uptimeSec != null ? `${Math.floor(r.uptimeSec / 86400)} 天 ${Math.floor((r.uptimeSec % 86400) / 3600)} 小时` : '—'}</td><td>${r.rssMb != null ? `${r.rssMb} MB` : '—'}</td><td>${r.diskFree != null ? `${(r.diskFree / 1073741824).toFixed(1)} GB` : '—'}</td>
<td>${r.backup ? `${r.backup.ok ? '成功' : '<b style="color:#c62828">失败</b>'} <span class="mute">${fmt(r.backup.ts)}</span>` : '—'}</td><td>${r.errors24h ?? '—'}</td><td>${r.failingServices?.length ? esc(r.failingServices.join('、')) : r.failingServices ? '无' : '—'}</td></tr>`).join('')}</tbody></table></div>
${S.peerSites().length ? '' : '<p class="mute">还没有配置其他站点：在 .env 中加入 PEER_SITES=grid|https://另一个站点的地址，并在两边设置相同的 OPS_TOKEN。</p>'}`);
}

function securityPage(c) {
  const f = { user: c.req.query('user') || '', result: c.req.query('result') || '' };
  const ACT = { login: '登录成功', login_failed: '登录失败', logout: '退出', kick: '被强制下线' };
  const sessions = Sec.onlineSessions();
  return view('登录与会话', `${flash(c)}<h2>登录与会话</h2>
<h3>在线会话（${sessions.length}）</h3><div class="wrap"><table><thead><tr><th>账号</th><th>IP</th><th>登录时间</th><th>最近活动</th><th></th></tr></thead><tbody>
${sessions.map((s) => `<tr><td><b>${esc(s.username)}</b> <span class="mute">${esc(s.name || '')}</span></td><td>${esc(s.ip || '')}</td><td>${fmt(s.created_at)}</td><td>${ago(Date.now() - s.last_seen)}</td><td>${s.username === currentUser()?.username ? '<span class="mute">（当前账号）</span>' : `<form method="post" action="/admin/system/sessions/${s.sid}/kick" onsubmit="return confirm('强制下线 ${esc(s.username)}？')"><button>强制下线</button></form>`}</td></tr>`).join('') || '<tr><td colspan="5" class="mute">没有在线会话（用脚本 Basic 认证访问不产生会话）</td></tr>'}</tbody></table></div>
<h3>账号登录情况</h3><div class="wrap"><table><thead><tr><th>账号</th><th>最近登录</th><th>最近 IP</th><th>用过的 IP 数</th><th>24 小时失败</th><th>在线</th></tr></thead><tbody>
${Sec.loginSummary().map((u) => `<tr><td><b>${esc(u.username)}</b>${u.active ? '' : ' <span class="pill">已停用</span>'}</td><td>${fmt(u.last_at) || '<span class="mute">从未登录</span>'}</td><td>${esc(u.last_ip)}</td><td>${u.ips}</td><td>${u.fails24h ? `<b style="color:#c62828">${u.fails24h}</b>` : 0}</td><td>${u.sessions}</td></tr>`).join('')}</tbody></table></div>
<form method="post" action="/admin/system/security/settings" class="acts" style="margin:12px 0"><label><input type="checkbox" name="alert_new_ip" value="1"${getSetting('alert_new_ip', true) ? ' checked' : ''}> 账号在新的 IP 登录时推送企业微信</label> <button>保存</button> <span class="mute">同一账号 15 分钟内失败 5 次会自动锁定并提醒。</span></form>
<h3>登录记录</h3><form method="get" class="acts"><select name="user"><option value="">全部账号</option>${Audit.auditUsers().map((u) => `<option${u === f.user ? ' selected' : ''}>${esc(u)}</option>`).join('')}</select> <select name="result"><option value="">全部</option><option value="ok"${f.result === 'ok' ? ' selected' : ''}>成功</option><option value="fail"${f.result === 'fail' ? ' selected' : ''}>失败</option></select> <button>筛选</button></form>
<div class="wrap"><table><thead><tr><th>时间</th><th>账号</th><th>事件</th><th>IP</th><th>说明</th></tr></thead><tbody>${Sec.loginEvents(f).map((e) => `<tr><td>${fmt(e.ts)}</td><td>${esc(e.username)}</td><td>${e.action === 'login_failed' ? `<b style="color:#c62828">${ACT[e.action]}</b>` : ACT[e.action] || esc(e.action)}</td><td>${esc(e.ip)}</td><td class="mute">${esc(e.message || '')}</td></tr>`).join('') || '<tr><td colspan="5" class="mute">没有记录</td></tr>'}</tbody></table></div>`);
}

function configPage(c) {
  const r = Sec.configCheck();
  return view('配置检查', `${flash(c)}<h2>配置检查</h2><p class="mute">检查服务器 .env 中哪些配置已填写（只显示是否填写，不显示内容）。修改配置后需要重启服务。证书到期时间见"服务连通性 → HTTPS 证书"。</p>
${r.warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join('')}
${r.groups.map((g) => `<h3>${esc(g.name)}</h3><div class="wrap"><table><thead><tr><th>配置项</th><th>状态</th><th>作用 / 不配置的影响</th></tr></thead><tbody>${g.items.map((i) => `<tr><td><code>${esc(i.key)}</code></td><td>${i.set ? pill('ok').replace('正常', '已配置') : i.required ? pill('fail').replace('异常', '必须配置') : pill('off')}</td><td>${esc(i.impact)}</td></tr>`).join('')}</tbody></table></div>`).join('')}`);
}

function releasesPage(c) {
  const rels = listReleases();
  return view('网站版本', `${flash(c)}<h2>网站版本</h2><p class="mute">每次发布网站都会生成一个新版本，服务器保留最近 3 个。新版本有问题时可以一键切回上一个版本（立即生效，不需要重新构建）；之后再次发布会生成新的版本。</p>
${config.content.releasesDir ? '' : '<div class="warn">未启用网站版本目录（RELEASES_DIR），无法回滚。生产环境部署请按部署手册配置。</div>'}${buildRunning() ? '<div class="warn">网站正在构建中</div>' : ''}
<div class="wrap"><table><thead><tr><th>版本</th><th>生成时间</th><th>状态</th><th></th></tr></thead><tbody>${rels.map((r) => `<tr><td><code>${esc(r.name)}</code></td><td>${fmt(r.mtime)}</td><td>${r.current ? '<span class="pill" style="background:#e3f2e5">线上</span>' : ''}</td><td>${r.current ? '' : `<form method="post" action="/admin/system/releases/rollback" onsubmit="return confirm('把网站切换到这个版本？')"><input type="hidden" name="name" value="${esc(r.name)}"><button>切换到这个版本</button></form>`}</td></tr>`).join('') || '<tr><td colspan="4" class="mute">还没有网站版本</td></tr>'}</tbody></table></div>`);
}

function jobsPage(c) {
  const list = J.listJobs();
  const runs = J.jobRuns(c.req.query('job') || '', 50);
  const name = Object.fromEntries(list.map((j) => [j.id, j.name]));
  return view('定时任务', `${flash(c)}<h2>定时任务</h2><p class="mute">网站后台自动运行的任务。暂停后到时间不再运行，可以随时"立即运行"。每分钟级的任务只记录有处理内容或失败的运行。</p>
<div class="wrap"><table><thead><tr><th>任务</th><th>频率</th><th>状态</th><th>上次运行</th><th>下次运行</th><th>最近失败</th><th></th></tr></thead><tbody>
${list.map((j) => `<tr><td><b>${esc(j.name)}</b><div class="mute">${esc(j.id)}</div></td><td>${esc(J.describeSchedule(j.schedule))}</td><td>${!j.enabled ? `${pill('off')} <span class="mute">${esc(j.note)}</span>` : j.paused ? '<span class="pill" style="background:#fff4e5">已暂停</span>' : j.running ? '<span class="pill" style="background:#e3f2fd">运行中</span>' : pill('ok').replace('正常', '运行')}</td>
<td>${j.last ? `${fmt(j.last.ts)} ${j.last.ok ? '' : '<b style="color:#c62828">失败</b>'}<div class="mute">${esc(String(j.last.detail || '').slice(0, 80))}${j.last.manual ? ` · ${esc(j.last.manual)} 手动` : ''}</div>` : '—'}</td><td>${j.next ? fmt(new Date(j.next).toISOString()) : '—'}</td>
<td>${j.lastFail ? `${fmt(j.lastFail.ts)}<div class="mute" style="color:#c62828">${esc(String(j.lastFail.detail || '').slice(0, 100))}</div>` : '—'}</td>
<td style="white-space:nowrap"><form method="post" action="/admin/system/jobs/${encodeURIComponent(j.id)}/run" style="display:inline"><button${j.running ? ' disabled' : ''}>立即运行</button></form> <form method="post" action="/admin/system/jobs/${encodeURIComponent(j.id)}/${j.paused ? 'resume' : 'pause'}" style="display:inline"><button>${j.paused ? '继续' : '暂停'}</button></form> <a href="/admin/system/jobs?job=${encodeURIComponent(j.id)}">记录</a></td></tr>`).join('')}</tbody></table></div>
<h3>运行记录${c.req.query('job') ? `：${esc(name[c.req.query('job')] || c.req.query('job'))}` : ''}</h3><div class="wrap"><table><thead><tr><th>时间</th><th>任务</th><th>结果</th><th>用时</th><th>详情</th></tr></thead><tbody>${runs.map((r) => `<tr><td>${fmt(r.ts)}</td><td>${esc(name[r.job] || r.job)}${r.manual ? ` <span class="mute">（${esc(r.manual)} 手动）</span>` : ''}</td><td>${r.ok ? '成功' : '<b style="color:#c62828">失败</b>'}</td><td>${r.seconds.toFixed(1)}s</td><td class="mute" style="max-width:520px">${esc(String(r.detail || '').slice(0, 300))}</td></tr>`).join('') || '<tr><td colspan="5" class="mute">暂无</td></tr>'}</tbody></table></div>`);
}

export function mountOpsCenter(app) {
  app.get('/admin/system/services', (c) => c.html(servicesPage(c)));
  app.post('/admin/system/services/check', async (c) => {
    const id = String((await c.req.parseBody()).id || '');
    try {
      if (id === 'all') { const r = await S.checkAll(actorName()); const bad = Object.values(r).filter((x) => !x.ok).length; return back(c, '/admin/system/services', bad ? 'e' : 'm', bad ? `${bad} 个服务异常` : `已测试 ${Object.keys(r).length} 个服务，全部正常`); }
      const r = await S.checkService(id, actorName());
      return back(c, '/admin/system/services', r.ok ? 'm' : 'e', `${r.ok ? '正常' : '异常'}：${r.detail}`);
    } catch (e) { return back(c, '/admin/system/services', 'e', e.message); }
  });
  app.get('/admin/system/errors', (c) => c.html(errorsPage(c)));
  app.get('/admin/system/errors.csv', (c) => {
    const rows = E.searchErrors({ q: c.req.query('q') || '', status: c.req.query('status') || 'all', from: c.req.query('from') || '', to: c.req.query('to') || '', limit: 10000 });
    const cols = ['last_at', 'first_at', 'source', 'method', 'path', 'message', 'count', 'resolved'];
    c.header('content-type', 'text/csv; charset=utf-8');
    c.header('content-disposition', 'attachment; filename="errors.csv"');
    return c.body('﻿' + [cols.join(','), ...rows.map((r) => cols.map((k) => csvCell(r[k])).join(','))].join('\r\n') + '\r\n');
  });
  app.get('/admin/system/errors/:id', (c) => {
    const r = E.getError(c.req.param('id'));
    if (!r) return c.html(view('错误日志', '<p>记录不存在</p>'), 404);
    return c.html(view('错误详情', `<p><a href="/admin/system/errors">← 错误日志</a></p><h2>${esc(r.message.slice(0, 120))}</h2><p>${esc(r.source === 'job' ? `定时任务 ${r.path}` : `${r.method} ${r.path}`)} · 共 ${r.count} 次 · 首次 ${fmt(r.first_at)} · 最近 ${fmt(r.last_at)}</p><pre style="white-space:pre-wrap;background:#fff;border:1px solid var(--line);padding:12px;border-radius:8px">${esc(r.stack || r.message)}</pre>
${r.resolved ? '' : `<form method="post" action="/admin/system/errors/resolve"><input type="hidden" name="ids" value="${r.id}"><button>标记为已解决</button></form>`}`));
  });
  app.post('/admin/system/errors/resolve', async (c) => {
    const ids = [].concat((await c.req.parseBody({ all: true })).ids || []);
    if (!ids.length) return back(c, '/admin/system/errors', 'e', '请先勾选错误');
    E.resolveErrors(ids, actorName());
    return back(c, '/admin/system/errors', 'm', `已标记 ${ids.length} 条为已解决`);
  });
  app.get('/admin/system/sites', async (c) => {
    const self = { name: `${config.site}（本站）`, url: config.publicBaseUrl, ...healthDetail() };
    const peers = await Promise.all(S.peerSites().map(async (p) => { try { return { ...p, ...(await S.peerHealth(p.url)) }; } catch (e) { return { ...p, error: String(e.cause?.code || e.message) }; } }));
    return c.html(sitesPage(c, [self, ...peers]));
  });
  app.get('/admin/system/security', (c) => c.html(securityPage(c)));
  app.post('/admin/system/sessions/:sid/kick', (c) => {
    try {
      const who = Sec.kickSession(c.req.param('sid'));
      Audit.record({ username: who, path: '/admin/system/sessions', action: 'kick', status: 302, message: `操作人：${actorName()}` });
      return back(c, '/admin/system/security', 'm', `已强制 ${who} 下线`);
    } catch (e) { return back(c, '/admin/system/security', 'e', e.message); }
  });
  app.post('/admin/system/security/settings', async (c) => { setSetting('alert_new_ip', (await c.req.parseBody()).alert_new_ip === '1'); return back(c, '/admin/system/security', 'm', '已保存'); });
  app.get('/admin/system/config', (c) => c.html(configPage(c)));
  app.get('/admin/system/releases', (c) => c.html(releasesPage(c)));
  app.post('/admin/system/releases/rollback', async (c) => {
    try { const r = rollbackRelease(String((await c.req.parseBody()).name || '')); return back(c, '/admin/system/releases', 'm', `网站已切换到 ${r.name}`); } catch (e) { return back(c, '/admin/system/releases', 'e', e.message); }
  });
  app.get('/admin/system/jobs', (c) => c.html(jobsPage(c)));
  app.post('/admin/system/jobs/:id/run', async (c) => {
    try { const r = await J.runJob(c.req.param('id'), { manual: actorName() }); return back(c, '/admin/system/jobs', r.ok ? 'm' : 'e', `${r.ok ? '已运行' : '运行失败'}${r.detail ? `：${String(r.detail).slice(0, 200)}` : ''}`); } catch (e) { return back(c, '/admin/system/jobs', 'e', e.message); }
  });
  app.post('/admin/system/jobs/:id/pause', (c) => { try { J.setPaused(c.req.param('id'), true); return back(c, '/admin/system/jobs', 'm', '已暂停'); } catch (e) { return back(c, '/admin/system/jobs', 'e', e.message); } });
  app.post('/admin/system/jobs/:id/resume', (c) => { try { J.setPaused(c.req.param('id'), false); return back(c, '/admin/system/jobs', 'm', '已继续'); } catch (e) { return back(c, '/admin/system/jobs', 'e', e.message); } });
  app.post('/admin/system/drill', async (c) => {
    const file = String((await c.req.parseBody()).file || '');
    try { const r = await Sec.restoreDrill(file, actorName()); return back(c, '/admin/system', r.ok ? 'm' : 'e', r.ok ? `恢复演练通过：${file}（商品 ${r.detail.tables.products}，订单 ${r.detail.tables.orders}，客户 ${r.detail.tables.customers}）` : `恢复演练失败：${r.detail.error || r.detail.integrity}`); } catch (e) { return back(c, '/admin/system', 'e', e.message); }
  });
}
