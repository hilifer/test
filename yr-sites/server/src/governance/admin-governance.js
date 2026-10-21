// 后台：管理员 / 老板。全局看板（各部门关键指标和待办积压，本站 / 另一个站 / 两站合计）、审批（待审批、我的申请）、审批流设置。
import { shell, esc, fmt } from '../admin.js';
import { currentUser, can } from '../auth.js';
import { peerSites } from '../ops/services.js';
import * as A from './approvals.js';
import { summary, peerSummaries, merge } from './board.js';

const flash = (c) => `${c.req.query('m') ? `<div class="warn" style="background:#e8f5e9;border-color:#a5d6a7">${esc(c.req.query('m'))}</div>` : ''}${c.req.query('e') ? `<div class="warn" style="background:#fdecea;border-color:#f5b7b1">${esc(c.req.query('e'))}</div>` : ''}`;
const back = (c, path, k, v) => c.redirect(`${path}${path.includes('?') ? '&' : '?'}${k}=${encodeURIComponent(v)}`);
const num = (x) => (x == null ? '—' : Number(x).toLocaleString('en-US', { maximumFractionDigits: 2 }));
/** Money: a number in the site's currency, or { USD: 1, CNY: 2 } when sites are added together. */
const money = (x, cur) => (x && typeof x === 'object' ? Object.entries(x).map(([k, val]) => `${k} ${num(Math.round(val))}`).join(' + ') || '—' : `${cur} ${num(Math.round(x || 0))}`);
const pct = (x) => (x == null ? '—' : `${Math.round(x * 1000) / 10}%`);

function boardPage(c, s, sites, pick) {
  const cur = s.cur;
  const tile = (l, val, href) => `<a class="tile" href="${href}" style="text-decoration:none;color:inherit"><span>${l}</span><strong>${val}</strong></a>`;
  const sec = (title, tiles) => `<section style="background:#fff;border:1px solid var(--line);border-radius:10px;padding:12px 14px"><h3 style="margin:0 0 8px;font-size:15px">${title}</h3><div class="tiles" style="margin:0;grid-template-columns:repeat(auto-fit,minmax(130px,1fr))">${tiles.join('')}</div></section>`;
  const target = typeof s.sales.target === 'object' ? null : s.sales.target;
  const won = typeof s.sales.won === 'object' ? null : s.sales.won;
  const completion = target ? won / target : null;
  const local = !s.merged && pick === 'self';
  const L = (href) => (local ? href : '#');
  const tabs = [['self', '本站'], ...sites.map((p) => [p.name, p.name]), ...(sites.length ? [['all', '两站合计']] : [])];
  return shell('全局看板', `<h2>全局看板 <span class="mute" style="font-size:14px" translate="no">${esc(s.brand)}</span></h2>
${tabs.length > 1 ? `<p class="acts">${tabs.map(([k, l]) => `<a href="?site=${encodeURIComponent(k)}"${k === pick ? ' style="font-weight:700"' : ''}>${esc(l)}</a>`).join(' · ')}</p>` : '<p class="mute">只接了本站。设置 PEER_SITES 和两站相同的 OPS_TOKEN 后，可以切换到另一个站或看两站合计。</p>'}
${sites.filter((p) => p.error).map((p) => `<div class="warn">站点 ${esc(p.name)} 的数据取不到：${esc(p.error)}</div>`).join('')}
<p class="mute">更新于 ${fmt(s.at)}${s.merged ? ' · 金额按币种分别合计' : ''}</p>
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px">
${sec('销售', [tile('本月成交额', money(s.sales.gmvMonth, cur), L('/admin/orders')), tile('本月成交订单', num(s.sales.ordersMonth), L('/admin/orders')), tile('本月目标完成度', target ? pct(completion) : '未设目标', L('/admin/sales/performance')), tile('近 7 天新线索（A 级）', `${num(s.sales.newLeads7)}（${num(s.sales.gradeA7)}）`, L('/admin?scope=all')), tile('待客户确认的报价', num(s.sales.quotesOpen), L('/admin/quotes'))])}
${sec('运营（近 30 天）', [tile('访客', num(s.marketing.visitors30), L('/admin/marketing')), tile('网店转化率', pct(s.marketing.conversion), L('/admin/marketing')), tile('询盘率', pct(s.marketing.inquiryRate), L('/admin/marketing')), tile('询盘', num(s.marketing.leads30), L('/admin?scope=all')), tile('网店收入', money(s.marketing.shopRevenue30, cur), L('/admin/marketing'))])}
${sec('财务', [tile('应收合计', money(s.finance.receivable, cur), L('/admin/finance')), tile('已逾期', money(s.finance.overdue, cur), L('/admin/finance')), tile('本月回款', money(s.finance.receivedMonth, cur), L('/admin/finance/report')), tile('待退款', num(s.finance.refundsPending), L('/admin/rma'))])}
${sec('物流', [tile('待发货订单', num(s.logistics.toShip), L('/admin/warehouse')), tile('在途', num(s.logistics.inTransit), L('/admin/shipments')), tile('物流异常', num(s.logistics.exceptions), L('/admin/shipments')), tile('低库存 SKU', num(s.logistics.lowStock), L('/admin/warehouse/stock'))])}
${sec('客服', [tile('待处理对话', num(s.service.waiting), L('/admin/service?channel=chat')), tile('未关闭邮件', num(s.service.openEmails), L('/admin/service?channel=email')), tile('售后待处理', num(s.service.rmaOpen), L('/admin/rma')), tile('近 30 天客户评分', s.service.rating ?? '—', L('/admin/service/performance'))])}
${sec('系统', [tile('24 小时错误', num(s.system.errors24h), L('/admin/system/errors')), tile('外部服务异常', num(s.system.failing), L('/admin/system/services')), tile('最近备份', s.system.backupOk == null ? '还没有备份' : s.system.backupOk ? '成功' : '失败', L('/admin/system')), tile('待审批', num(s.approvals), L('/admin/approvals'))])}
</div>
<h3>各岗位待办积压</h3><div class="wrap"><table><thead><tr><th>岗位工作台</th><th class="n">待办</th></tr></thead><tbody>${[...s.backlog].sort((a, b) => b.count - a.count).map((b) => `<tr${b.count >= 10 ? ' style="background:#fff4e5"' : ''}><td>${esc(b.title)}</td><td class="n"><b>${b.count}</b></td></tr>`).join('')}</tbody></table></div>`);
}

const describe = (a) => `${a.label}${a.detail ? ` <span class="mute" translate="no">${esc(a.detail)}</span>` : ''}`;
function approvalsPage(c) {
  const u = currentUser();
  const wait = A.toDecide(u);
  const list = A.listFor(u, { status: c.req.query('status') || '' });
  const rules = A.rules();
  const on = Object.entries(rules).filter(([, r]) => r.enabled);
  return shell('审批', `${flash(c)}<h2>审批</h2>
<p class="mute">${on.length ? `需要审批的操作：${on.map(([k, r]) => `${A.KINDS[k].what}${A.KINDS[k].param ? ` ${r[A.KINDS[k].param]}${A.KINDS[k].unit}` : ''}（审批人：${A.APPROVERS[r.approver]}）`).join('；')}。` : '还没有开启审批流。'} 申请人在审批通过后再操作一次即可完成。${can(u, ['admin']) ? ' <a href="/admin/approvals/settings">审批流设置</a>' : ''}</p>
<h3>待我审批（${wait.length}）</h3>${wait.length ? `<div class="wrap"><table><thead><tr><th>#</th><th>类型</th><th>内容</th><th>申请人</th><th>时间</th><th>审批</th></tr></thead><tbody>${wait.map((a) => `<tr><td>${a.id}</td><td>${esc(A.KINDS[a.kind].name)}</td><td><a href="${esc(A.KINDS[a.kind].path(a.ref))}">${describe(a)}</a></td><td>${esc(a.requested_by)}</td><td>${fmt(a.requested_at)}</td>
<td><form method="post" action="/admin/approvals/${a.id}/decide" style="display:flex;gap:6px;flex-wrap:wrap"><input name="note" placeholder="意见（选填）" size="14" aria-label="意见"><button name="decision" value="approve">通过</button><button name="decision" value="reject">驳回</button></form></td></tr>`).join('')}</tbody></table></div>` : '<p class="mute">没有等待你审批的申请。</p>'}
<h3>审批记录</h3><p class="acts"><a href="?">全部</a> · ${Object.entries(A.STATUS).map(([k, l]) => `<a href="?status=${k}">${l}</a>`).join(' · ')}</p>
<div class="wrap"><table><thead><tr><th>#</th><th>类型</th><th>内容</th><th>申请人</th><th>申请时间</th><th>状态</th><th>审批人</th><th>意见</th><th></th></tr></thead><tbody>
${list.map((a) => `<tr><td>${a.id}</td><td>${esc(A.KINDS[a.kind]?.name || a.kind)}</td><td><a href="${esc(A.KINDS[a.kind].path(a.ref))}">${describe(a)}</a></td><td>${esc(a.requested_by)}</td><td>${fmt(a.requested_at)}</td><td><span class="pill">${esc(A.STATUS[a.status])}</span></td><td>${esc(a.decided_by || '')}</td><td translate="no">${esc(a.note || '')}</td>
<td>${a.status === 'pending' && a.requested_by === u.username ? `<form method="post" action="/admin/approvals/${a.id}/cancel"><button>撤回</button></form>` : ''}</td></tr>`).join('') || '<tr><td colspan="9" class="mute">没有审批记录</td></tr>'}</tbody></table></div>`);
}

function settingsPage(c) {
  const rules = A.rules();
  const opt = (v) => Object.entries(A.APPROVERS).map(([k, l]) => `<option value="${k}"${k === v ? ' selected' : ''}>${l}</option>`).join('');
  return shell('审批流设置', `${flash(c)}<p><a href="/admin/approvals">← 返回审批</a></p><h2>审批流设置</h2><p class="mute">开启后，没有审批权限的员工做这些操作时会自动提交审批申请并推送企业微信；审批人本人直接操作不需要审批。AI 议价的审批在 <a href="/admin/deals/policy">AI 议价 → 授权政策</a> 设置。</p>
<form method="post" action="/admin/approvals/settings"><div class="wrap"><table><thead><tr><th>开启</th><th>操作</th><th>条件</th><th>审批人</th></tr></thead><tbody>
${Object.entries(A.KINDS).map(([k, d]) => `<tr><td><input type="checkbox" name="${k}.enabled" value="1"${rules[k].enabled ? ' checked' : ''} aria-label="开启 ${esc(d.name)}"></td><td><b>${esc(d.name)}</b><div class="mute">${esc(d.what)}</div></td>
<td>${d.param === 'percent' ? `折扣超过 <input name="${k}.percent" value="${rules[k].percent}" size="4"> % （折扣 ÷ 产品小计）` : d.param === 'amount' ? `单笔退款超过 <input name="${k}.amount" value="${rules[k].amount}" size="7"> （订单币种）` : '每次删除都需要'}</td><td><select name="${k}.approver">${opt(rules[k].approver)}</select></td></tr>`).join('')}</tbody></table></div><p><button>保存</button></p></form>`);
}

export function mountGovernanceAdmin(app) {
  app.get('/admin/board', async (c) => {
    const pick = c.req.query('site') || 'self';
    const self = summary();
    const peers = pick === 'self' ? peerSites() : await peerSummaries(); // the other sites are only asked when shown
    let s = self;
    if (pick === 'all') s = merge([self, ...peers.filter((p) => p.data).map((p) => p.data)]);
    else if (pick !== 'self') { const p = peers.find((x) => x.name === pick); if (p?.data) s = p.data; }
    return c.html(boardPage(c, s, peers, s === self ? 'self' : pick));
  });
  app.get('/admin/approvals', (c) => c.html(approvalsPage(c)));
  app.post('/admin/approvals/:id/decide', async (c) => {
    const f = await c.req.parseBody();
    try { const a = A.decide(c.req.param('id'), String(f.decision || ''), currentUser(), f.note); return back(c, '/admin/approvals', 'm', `#${a.id} ${A.STATUS[a.status]}`); } catch (e) { return back(c, '/admin/approvals', 'e', e.message); }
  });
  app.post('/admin/approvals/:id/cancel', (c) => { try { A.cancel(c.req.param('id'), currentUser()); return back(c, '/admin/approvals', 'm', '已撤回'); } catch (e) { return back(c, '/admin/approvals', 'e', e.message); } });
  app.get('/admin/approvals/settings', (c) => c.html(settingsPage(c)));
  app.post('/admin/approvals/settings', async (c) => {
    const f = await c.req.parseBody();
    const input = Object.fromEntries(Object.keys(A.KINDS).map((k) => [k, { enabled: false }])); // unticked boxes are not sent
    for (const [k, val] of Object.entries(f)) { const [kind, field] = k.split('.'); if (A.KINDS[kind] && field) (input[kind] ||= {})[field] = field === 'enabled' ? val === '1' : val; }
    try { A.saveRules(input); return back(c, '/admin/approvals/settings', 'm', '已保存'); } catch (e) { return back(c, '/admin/approvals/settings', 'e', e.message); }
  });
}

/** Public: this site's board figures for the other site's global board (shared OPS_TOKEN). */
export function mountGovernancePublic(app) {
  app.get('/api/board', (c) => {
    const token = process.env.OPS_TOKEN;
    if (!token || c.req.header('x-ops-token') !== token) return c.json({ error: 'not_found' }, 404);
    return c.json(summary());
  });
}
