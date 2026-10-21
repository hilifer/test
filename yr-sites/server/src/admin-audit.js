// 后台：操作日志（谁、什么时间、对哪条数据、做了什么、结果），可筛选、导出 CSV
import { shell, esc, fmt } from './admin.js';
import * as Audit from './audit.js';

const ACTIONS = { login: '登录', login_failed: '登录失败', logout: '退出', post: '提交', save: '保存', new: '新建', bulk: '批量操作', publish: '发布', import: '导入', delete: '删除', status: '改状态', payment: '登记收款', refund: '退款', ship: '发货', reply: '回复客户', takeover: '人工接管', release: '交还 AI', decide: '审批', void: '作废', backup: '备份', lang: '切换语言' };
const csvCell = (v) => { const s = String(v ?? '').replace(/^[=+\-@\t\r]/, "'$&"); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

function filters(c) {
  return { user: c.req.query('user') || '', entity: c.req.query('entity') || '', q: c.req.query('q') || '', from: c.req.query('from') || '', to: c.req.query('to') || '', ok: c.req.query('ok') ?? '' };
}

export function mountAuditAdmin(app) {
  app.get('/admin/audit', (c) => {
    const f = filters(c);
    const page = Math.max(1, Number(c.req.query('page')) || 1);
    const { total, rows } = Audit.search({ ...f, limit: 100, offset: (page - 1) * 100 });
    const opt = (list, v) => list.map((x) => `<option value="${esc(x)}"${x === v ? ' selected' : ''}>${esc(x)}</option>`).join('');
    const tr = rows.map((r) => { const fields = JSON.parse(r.fields || '{}'); return `<tr><td>${fmt(r.ts)}</td><td><b>${esc(r.username)}</b></td><td>${esc(ACTIONS[r.action] || r.action)}<div class="mute">${esc(r.method)} ${esc(r.path)}</div></td><td>${esc(r.entity)}${r.entity_id ? `<div class="mute">${esc(r.entity_id)}</div>` : ''}</td>
<td>${r.ok ? '<span class="pill" style="background:#e3f2e5">成功</span>' : '<span class="pill" style="background:#fdecea">失败</span>'} <span class="mute">${r.status}</span><div>${esc(String(r.message || '').replace(/^e=/, ''))}</div></td><td style="max-width:360px" class="mute">${esc(Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' · ').slice(0, 300))}</td><td class="mute">${esc(r.ip)}</td></tr>`; }).join('');
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v !== ''));
    return c.html(shell('操作日志', `<h2>操作日志（${total}）</h2>
<p class="mute">记录后台的每一次修改、登录和退出，以及被拒绝的越权操作。密码等敏感字段不会记录。</p>
<form method="get" class="acts" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px"><select name="user"><option value="">全部人员</option>${opt(Audit.auditUsers(), f.user)}</select><select name="entity"><option value="">全部模块</option>${opt(Audit.auditEntities(), f.entity)}</select>
<select name="ok"><option value="">全部结果</option><option value="1"${f.ok === '1' ? ' selected' : ''}>成功</option><option value="0"${f.ok === '0' ? ' selected' : ''}>失败</option></select>
<input name="q" value="${esc(f.q)}" placeholder="单号 / 编码 / 关键词"><label>从 <input type="date" name="from" value="${esc(f.from)}"></label><label>到 <input type="date" name="to" value="${esc(f.to)}"></label><button>筛选</button> <a href="/admin/audit.csv?${qs}">导出 CSV</a></form>
<div class="wrap"><table><thead><tr><th>时间</th><th>人员</th><th>操作</th><th>对象</th><th>结果</th><th>提交内容</th><th>IP</th></tr></thead><tbody>${tr || '<tr><td colspan="7" class="mute">没有记录</td></tr>'}</tbody></table></div>
${total > 100 ? `<p>${Array.from({ length: Math.min(50, Math.ceil(total / 100)) }, (_, i) => `<a href="/admin/audit?${new URLSearchParams({ ...Object.fromEntries(qs), page: i + 1 })}" style="margin-right:8px">${i + 1}</a>`).join('')}</p>` : ''}`));
  });
  app.get('/admin/audit.csv', (c) => {
    const { rows } = Audit.search({ ...filters(c), limit: 50000 });
    const cols = ['ts', 'username', 'roles', 'action', 'method', 'path', 'entity', 'entity_id', 'status', 'ok', 'message', 'fields', 'ip'];
    c.header('content-type', 'text/csv; charset=utf-8');
    c.header('content-disposition', 'attachment; filename="audit-log.csv"');
    return c.body('﻿' + [cols.join(','), ...rows.map((r) => cols.map((k) => csvCell(r[k])).join(','))].join('\r\n') + '\r\n');
  });
}
