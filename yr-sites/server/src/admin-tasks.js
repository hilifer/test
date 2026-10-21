// 后台：任务中心。所有批量处理任务的进度、每一项的结果、日志，可暂停 / 继续 / 取消 / 重试失败项。
// 普通账号只看自己创建的任务，有"系统"或"管理员"权限的看全部。
import { shell, esc, fmt } from './admin.js';
import { currentUser, can } from './auth.js';
import * as T from './tasks.js';

const seesAll = () => can(currentUser(), ['system']);
const mine = (t) => t && (seesAll() || t.created_by === currentUser()?.username);
const COLOR = { queued: '#eceff1', running: '#e3f2fd', paused: '#fff4e5', done: '#e3f2e5', failed: '#fdecea', cancelled: '#eceff1' };
const pill = (s, map = T.STATUS) => `<span class="pill" style="background:${COLOR[s] || '#eceff1'}">${esc(map[s] || s)}</span>`;
const bar = (p) => `<div style="background:#eceff1;border-radius:6px;height:10px;min-width:120px" role="progressbar" aria-valuenow="${p.pct}" aria-valuemin="0" aria-valuemax="100"><div style="width:${p.pct}%;height:10px;border-radius:6px;background:${p.failed ? '#ef8f00' : '#2e7d32'}"></div></div>`;
const flash = (c) => `${c.req.query('m') ? `<div class="warn" style="background:#e8f5e9;border-color:#a5d6a7">${esc(c.req.query('m'))}</div>` : ''}${c.req.query('e') ? `<div class="warn" style="background:#fdecea;border-color:#f5b7b1">${esc(c.req.query('e'))}</div>` : ''}`;
const live = (on) => (on ? '<script>setTimeout(()=>location.reload(),2500)</script>' : '');
const buttons = (t) => [
  ['queued', 'running'].includes(t.status) && ['pause', '暂停'], t.status === 'paused' && ['resume', '继续'],
  ['queued', 'running', 'paused'].includes(t.status) && ['cancel', '取消'], ['failed', 'cancelled'].includes(t.status) && ['retry', '重试失败项'],
].filter(Boolean).map(([a, l]) => `<button formaction="/admin/tasks/${t.id}/${a}">${l}</button>`).join(' ');
const result = (r) => (!r ? '' : typeof r === 'string' ? esc(r) : `${esc(r.text || '')}${r.link ? ` <a href="${esc(r.link)}">查看</a>` : ''}`);

export function mountTasksAdmin(app) {
  app.get('/admin/tasks', (c) => {
    const status = c.req.query('status') || '';
    const rows = T.listTasks({ user: seesAll() ? null : currentUser()?.username, status, limit: 200 });
    const tr = rows.map((t) => { const p = T.progress(t); return `<tr><td><a href="/admin/tasks/${t.id}">${esc(t.title)}</a><div class="mute">${esc(T.handlerLabel(t.kind))}</div></td><td>${pill(t.status)}</td><td>${bar(p)}<div class="mute">${p.done + p.failed} / ${p.total}${p.failed ? ` · 失败 ${p.failed}` : ''}</div></td><td>${esc(t.created_by)}<div class="mute">${fmt(t.created_at)}</div></td><td>${fmt(t.finished_at)}</td><td><form method="post">${buttons(t)}</form></td></tr>`; }).join('');
    const opts = Object.entries(T.STATUS).map(([k, l]) => `<option value="${k}"${k === status ? ' selected' : ''}>${l}</option>`).join('');
    return c.html(shell('任务中心', `${flash(c)}<h2>任务中心</h2><p class="mute">批量改尺寸、白底、AI 抠图等批量操作在后台逐项处理，可以离开页面；失败的项目可以单独重试。${seesAll() ? '' : '这里只显示你自己创建的任务。'}</p>
<form method="get" class="acts"><select name="status"><option value="">全部状态</option>${opts}</select> <button>筛选</button></form>
<div class="wrap"><table><thead><tr><th>任务</th><th>状态</th><th>进度</th><th>创建</th><th>完成时间</th><th></th></tr></thead><tbody>${tr || '<tr><td colspan="6" class="mute">还没有任务</td></tr>'}</tbody></table></div>${live(rows.some((t) => ['queued', 'running'].includes(t.status)))}`));
  });
  app.get('/admin/tasks/:id', (c) => {
    const t = T.getTask(c.req.param('id'));
    if (!mine(t)) return c.html(shell('任务中心', '<p>任务不存在</p>'), 404);
    const p = T.progress(t);
    return c.html(shell(t.title, `${flash(c)}<p><a href="/admin/tasks">← 任务中心</a></p><h2>${esc(t.title)} ${pill(t.status)}</h2>
<div class="tiles"><div class="tile"><span>总数</span><strong>${p.total}</strong></div><div class="tile"><span>成功</span><strong>${p.done}</strong></div><div class="tile"><span>失败</span><strong>${p.failed}</strong></div><div class="tile"><span>进度</span><strong>${p.pct}%</strong>${bar(p)}</div></div>
<form method="post" class="acts">${buttons(t)}</form><p class="mute">${esc(T.handlerLabel(t.kind))} · 创建 ${esc(t.created_by)} ${fmt(t.created_at)}${t.started_at ? ` · 开始 ${fmt(t.started_at)}` : ''}${t.finished_at ? ` · 结束 ${fmt(t.finished_at)}` : ''}</p>
<h3>明细</h3><div class="wrap"><table><thead><tr><th>#</th><th>项目</th><th>状态</th><th>结果 / 失败原因</th></tr></thead><tbody>${t.items.map((i, n) => `<tr><td>${n + 1}</td><td>${esc(i.label)}</td><td>${pill(i.status === 'failed' ? 'failed' : i.status === 'done' ? 'done' : i.status === 'running' ? 'running' : 'queued', T.ITEM_STATUS)}</td><td>${i.error ? `<span style="color:#c62828">${esc(i.error)}</span>` : result(i.result)}</td></tr>`).join('')}</tbody></table></div>
<h3>日志</h3><div class="wrap"><table><tbody>${t.log.slice().reverse().map((l) => `<tr><td>${fmt(l.ts)}</td><td>${esc(l.msg)}</td></tr>`).join('')}</tbody></table></div>${live(['queued', 'running'].includes(t.status))}`));
  });
  app.get('/admin/tasks/:id/json', (c) => { const t = T.getTask(c.req.param('id')); return mine(t) ? c.json({ ...t, progress: T.progress(t) }) : c.json({ message: 'not found' }, 404); });
  const act = (fn, msg) => async (c) => {
    const id = c.req.param('id');
    if (!mine(T.getTask(id))) return c.text('Not found', 404);
    const to = (c.req.header('referer') || '').includes(`/admin/tasks/${id}`) ? `/admin/tasks/${id}` : '/admin/tasks';
    try { fn(id); return c.redirect(`${to}?m=${encodeURIComponent(msg)}`); } catch (e) { return c.redirect(`${to}?e=${encodeURIComponent(e.message)}`); }
  };
  app.post('/admin/tasks/:id/pause', act(T.pauseTask, '已暂停'));
  app.post('/admin/tasks/:id/resume', act(T.resumeTask, '已继续'));
  app.post('/admin/tasks/:id/cancel', act(T.cancelTask, '已取消'));
  app.post('/admin/tasks/:id/retry', act(T.retryTask, '已重新排队'));
}
