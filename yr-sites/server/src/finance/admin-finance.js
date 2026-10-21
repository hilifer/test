// 后台：财务。应收账款（按客户 / 账龄、逾期提醒）、对账（Stripe、PayPal、银行流水）、月度财务报表与导出、收款单同步金蝶，
// 以及订单的商业发票和装箱单。
import { shell, esc, fmt } from '../admin.js';
import { config } from '../config.js';
import { currentUser, actorName } from '../auth.js';
import { getSetting, setSetting } from '../catalog/store.js';
import { adapter, erpLabel } from '../ops/erp/index.js';
import * as F from './finance.js';
import { renderCommercialInvoice, renderPackingList } from './trade-docs.js';
import { lastMonths } from '../sales/crm.js';

const flash = (c) => `${c.req.query('m') ? `<div class="warn" style="background:#e8f5e9;border-color:#a5d6a7">${esc(c.req.query('m'))}</div>` : ''}${c.req.query('e') ? `<div class="warn" style="background:#fdecea;border-color:#f5b7b1">${esc(c.req.query('e'))}</div>` : ''}`;
const back = (c, path, k, v) => c.redirect(`${path}${path.includes('?') ? '&' : '?'}${k}=${encodeURIComponent(v)}`);
const SUB = '<p class="acts"><a href="/admin/finance">应收账款</a> · <a href="/admin/finance/reconcile">对账</a> · <a href="/admin/finance/report">财务报表</a> · <a href="/admin/deals/policy">议价授权</a> · <a href="/admin/orders">订单</a></p>';
const view = (title, body) => shell(title, SUB + body);
const money = (x, cur = config.catalog.currency || 'USD') => `${cur} ${(Math.round((Number(x) || 0) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const csvCell = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?%?$/.test(s)) s = `'${s}`; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csv = (c, name, cols, rows) => {
  const en = currentUser()?.lang === 'en';
  c.header('content-type', 'text/csv; charset=utf-8');
  c.header('content-disposition', `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.csv"`);
  return c.body('﻿' + [cols.map((x) => (en ? x[2] : x[1])).join(','), ...rows.map((r) => cols.map(([k]) => csvCell(r[k])).join(','))].join('\r\n') + '\r\n');
};
const STATUS = { awaiting_deposit: '待付定金', in_production: '生产中', ready_to_ship: '待发货', shipped: '已发货', delivered: '已签收', completed: '已完成', pending_payment: '待付款' };

function receivablesPage(c) {
  const rows = F.receivables();
  const cust = F.receivablesByCustomer(rows);
  const total = rows.reduce((a, r) => a + r.outstanding, 0), overdue = rows.filter((r) => r.overdueDays).reduce((a, r) => a + r.outstanding, 0);
  const week = rows.filter((r) => r.due && !r.overdueDays && Date.parse(r.due) - Date.now() < 7 * 86400e3).reduce((a, r) => a + r.outstanding, 0);
  const tile = (l, v, s = '') => `<div class="tile"><span>${l}</span><strong style="${s}">${v}</strong></div>`;
  return view('应收账款', `${flash(c)}<h2>应收账款</h2><p class="mute">所有还没收齐款的订单。到期规则：定金在下单后 ${F.DEPOSIT_DAYS()} 天内；尾款按付款方式在发货前（30% 定金 / 100% 预付）、见提单副本（发货后 7 天）或发货时（信用证）到期；网店订单按付款期限。每天 9:00 把新逾期的订单推送企业微信。</p>
<div class="tiles">${tile('应收合计', money(total))}${tile('已逾期', money(overdue), overdue ? 'color:#c62828' : '')}${tile('7 天内到期', money(week))}${tile('笔数', rows.length)}</div>
<h3>按客户 / 账龄</h3><div class="wrap"><table><thead><tr><th>客户</th><th class="n">订单</th><th class="n">未收</th><th class="n">已逾期</th>${F.BUCKETS.map(([k]) => `<th class="n">${k} 天</th>`).join('')}<th class="n">最久（天）</th></tr></thead><tbody>
${cust.map((x) => `<tr><td><a href="/admin/customers/${x.customer_id}"><b>${esc(x.company || '—')}</b></a><div class="mute">${esc(x.country || '')}</div></td><td class="n">${x.orders}</td><td class="n">${money(x.outstanding)}</td><td class="n" style="${x.overdue ? 'color:#c62828;font-weight:700' : ''}">${money(x.overdue)}</td>${F.BUCKETS.map(([k]) => `<td class="n">${x.buckets[k] ? money(x.buckets[k]) : ''}</td>`).join('')}<td class="n">${x.oldest}</td></tr>`).join('') || `<tr><td colspan="${5 + F.BUCKETS.length}" class="mute">没有应收款</td></tr>`}</tbody></table></div>
<h3>明细 <a href="/admin/finance/receivables.csv" style="font-size:13px">导出表格</a></h3><div class="wrap"><table><thead><tr><th>订单</th><th>客户</th><th>状态</th><th class="n">订单金额</th><th class="n">已收</th><th class="n">未收</th><th>到期</th><th>账龄</th></tr></thead><tbody>
${rows.map((r) => `<tr><td><a href="/admin/orders/${r.id}"><b>${esc(r.number)}</b></a>${r.channel === 'shop' ? ' <span class="pill">网店</span>' : ''}</td><td>${esc(r.company || '')}</td><td>${esc(STATUS[r.status] || r.status)}</td><td class="n">${money(r.total, r.currency)}</td><td class="n">${money(r.paid, r.currency)}</td><td class="n"><b>${money(r.outstanding, r.currency)}</b></td>
<td>${r.due ? `${fmt(r.due).slice(0, 10)}${r.overdueDays ? `<div style="color:#c62828;font-weight:700">逾期 ${r.overdueDays} 天</div>` : ''}` : '<span class="mute">未到期（发货前收）</span>'}</td><td>${r.age} 天 <span class="mute">${r.bucket}</span></td></tr>`).join('') || '<tr><td colspan="8" class="mute">没有应收款</td></tr>'}</tbody></table></div>
<form method="post" action="/admin/finance/settings" class="acts"><label>定金到期天数 <input name="deposit_days" value="${F.DEPOSIT_DAYS()}" size="3"></label> <button>保存</button></form>`);
}

function reconcilePage(c, result = null, f = {}, error = '') {
  const today = new Date().toISOString().slice(0, 10), monthAgo = new Date(Date.now() - 30 * 86400e3).toISOString().slice(0, 10);
  const SRC = { stripe: 'Stripe', paypal: 'PayPal', bank: '银行流水（粘贴）' };
  const tx = (t) => `${fmt(t.date).slice(0, 10)} · ${esc(t.ref)} · ${t.currency} ${t.amount}${t.note ? ` <span class="mute">${esc(t.note)}</span>` : ''}`;
  const ours = (p) => `${fmt(p.ts).slice(0, 10)} · <a href="/admin/orders/${esc(p.order_id || '')}">${esc(p.number)}</a> · ${esc(p.currency || '')} ${p.amount} <span class="mute">${esc(p.ref || '')}</span>`;
  const res = result ? `<div class="msg" style="max-width:none"><h3 style="margin-top:0">对账结果：${SRC[result.source]} ${result.from} – ${result.to}</h3>
<div class="tiles"><div class="tile"><span>对上</span><strong>${result.matched.length}</strong></div><div class="tile"><span>对方有、我们没记</span><strong style="${result.missingOurs.length ? 'color:#c62828' : ''}">${result.missingOurs.length}</strong></div><div class="tile"><span>我们记了、对方没有</span><strong style="${result.missingSource.length ? 'color:#c62828' : ''}">${result.missingSource.length}</strong></div><div class="tile"><span>金额不一致</span><strong style="${result.mismatched.length ? 'color:#c62828' : ''}">${result.mismatched.length}</strong></div><div class="tile"><span>对方合计 / 我们合计</span><strong style="font-size:15px">${result.totals.theirs} / ${result.totals.ours}</strong></div></div>
${result.missingOurs.length ? `<h4>对方有、我们没记（可能漏登记收款）</h4><ul>${result.missingOurs.map((t) => `<li>${tx(t)}</li>`).join('')}</ul>` : ''}
${result.missingSource.length ? `<h4>我们记了、对方没有（可能登记错误或还在途）</h4><ul>${result.missingSource.map((p) => `<li>${ours(p)}</li>`).join('')}</ul>` : ''}
${result.mismatched.length ? `<h4>金额不一致</h4><ul>${result.mismatched.map((m) => `<li>对方 ${tx(m.theirs)}<br>我们 ${ours(m.ours)}</li>`).join('')}</ul>` : ''}
${result.parseErrors.length ? `<p class="mute">${esc(result.parseErrors.join('；'))}</p>` : ''}${!result.missingOurs.length && !result.missingSource.length && !result.mismatched.length ? '<p><b style="color:#2e7d32">✓ 全部对上</b></p>' : ''}</div>` : '';
  return view('对账', `${flash(c)}${error ? `<div class="warn" style="background:#fdecea;border-color:#f5b7b1">${esc(error)}</div>` : ''}<h2>对账</h2><p class="mute">把 Stripe、PayPal 的实际到账（直接从对方接口读取）或银行流水与系统里登记的收款逐笔核对。Stripe / PayPal 按交易号对；银行流水按摘要里的订单号对，没有订单号时按金额和日期（前后 3 天）对。</p>
<form method="post" action="/admin/finance/reconcile" class="msg" style="max-width:none;display:grid;gap:8px"><div style="display:flex;gap:10px;flex-wrap:wrap"><label>来源 <select name="source">${Object.entries(SRC).map(([k, l]) => `<option value="${k}"${(f.source || 'stripe') === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label><label>从 <input type="date" name="from" value="${esc(f.from || monthAgo)}"></label><label>到 <input type="date" name="to" value="${esc(f.to || today)}"></label></div>
<label>银行流水（来源选"银行流水"时）：每行"日期, 摘要/附言, 金额, 币种"，可从网银导出后粘贴<textarea name="csv" rows="4" placeholder="2026-11-03, SO-261103-001 deposit, 1500, USD">${esc(f.csv || '')}</textarea></label><div><button>开始对账</button></div></form>
${res}<h3>对账记录</h3><div class="wrap"><table><thead><tr><th>时间</th><th>来源</th><th>期间</th><th class="n">对上</th><th class="n">差异</th><th>操作人</th></tr></thead><tbody>${F.reconRuns().map((r) => `<tr><td>${fmt(r.ts)}</td><td>${SRC[r.source] || esc(r.source)}</td><td>${esc(r.period_from)} – ${esc(r.period_to)}</td><td class="n">${r.matched}</td><td class="n" style="${r.issues ? 'color:#c62828;font-weight:700' : ''}">${r.issues}</td><td>${esc(r.by)}</td></tr>`).join('') || '<tr><td colspan="6" class="mute">还没有对过账</td></tr>'}</tbody></table></div>`);
}

function reportPage(c) {
  const n = Number(c.req.query('n')) === 24 ? 24 : 12;
  const months = lastMonths(n);
  const rows = F.monthlyReport(months).reverse();
  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  const unsynced = adapter()?.pushReceipt ? F.unsyncedReceipts() : [];
  return view('财务报表', `${flash(c)}<h2>财务报表 <span class="mute" style="font-size:14px"><a href="?n=12">近 12 个月</a> · <a href="?n=24">近 24 个月</a> · <a href="/admin/finance/report.csv?n=${n}">导出表格</a></span></h2>
<div class="wrap"><table><thead><tr><th>月份</th><th class="n">订单数</th><th class="n">订单金额</th><th class="n">实收</th><th class="n">其中在线</th><th class="n">其中电汇</th><th class="n">退款</th><th class="n">净收款</th><th class="n">优惠 / 折扣</th><th class="n">运费</th></tr></thead><tbody>
${rows.map((r) => `<tr><td>${r.month}</td><td class="n">${r.orders}</td><td class="n">${money(r.orderValue)}</td><td class="n">${money(r.received)}</td><td class="n">${money(r.receivedOnline)}</td><td class="n">${money(r.receivedTransfer)}</td><td class="n">${money(r.refunds)}</td><td class="n"><b>${money(r.net)}</b></td><td class="n">${money(r.discounts)}</td><td class="n">${money(r.shipping)}</td></tr>`).join('')}
<tr><td><b>合计</b></td><td class="n"><b>${sum('orders')}</b></td><td class="n"><b>${money(sum('orderValue'))}</b></td><td class="n"><b>${money(sum('received'))}</b></td><td class="n">${money(sum('receivedOnline'))}</td><td class="n">${money(sum('receivedTransfer'))}</td><td class="n">${money(sum('refunds'))}</td><td class="n"><b>${money(sum('net'))}</b></td><td class="n">${money(sum('discounts'))}</td><td class="n">${money(sum('shipping'))}</td></tr></tbody></table></div>
<p class="mute">订单金额按下单月份（不含已取消）；实收、退款按到账 / 退款日期。</p>
<h3>收款单同步金蝶</h3>${adapter()?.pushReceipt ? `<p class="mute">${esc(erpLabel())}：每次登记收款（含网店在线付款）自动生成金蝶收款单；失败的每小时补推一次。客户需要先随订单同步到金蝶。</p>
<div class="wrap"><table><thead><tr><th>到账时间</th><th>订单</th><th class="n">金额</th><th>原因</th><th></th></tr></thead><tbody>${unsynced.map((p) => `<tr><td>${fmt(p.ts)}</td><td><a href="/admin/orders/${p.order_id}">${esc(p.number)}</a></td><td class="n">${esc(p.currency)} ${p.amount}</td><td class="mute">${esc(p.erp_error || '等待同步')}</td><td><form method="post" action="/admin/finance/receipts/${p.id}/push"><button>推送</button></form></td></tr>`).join('') || '<tr><td colspan="5" class="mute">全部已同步</td></tr>'}</tbody></table></div>` : '<p class="mute">未接金蝶（ERP_MODE=local），收款只记录在本系统。</p>'}
<h3>最近记录</h3><ul class="mute">${F.financeLog(10).map((l) => `<li>${fmt(l.ts)} ${l.ok ? '' : '<b style="color:#c62828">失败</b> '}${esc(l.detail)}</li>`).join('') || '<li>暂无</li>'}</ul>`);
}

export function mountFinanceAdmin(app) {
  app.get('/admin/finance', (c) => c.html(receivablesPage(c)));
  app.get('/admin/finance/receivables.csv', (c) => csv(c, 'receivables', [['number', '订单', 'Order'], ['company', '客户', 'Customer'], ['currency', '币种', 'Currency'], ['total', '订单金额', 'Order total'], ['paid', '已收', 'Paid'], ['outstanding', '未收', 'Outstanding'], ['due', '到期日', 'Due'], ['overdueDays', '逾期天数', 'Days overdue'], ['age', '账龄（天）', 'Age (days)']],
    F.receivables().map((r) => ({ ...r, due: r.due ? r.due.slice(0, 10) : '' }))));
  app.post('/admin/finance/settings', async (c) => {
    const d = Number((await c.req.parseBody()).deposit_days);
    if (!(Number.isInteger(d) && d >= 1 && d <= 90)) return back(c, '/admin/finance', 'e', '定金到期天数须为 1–90');
    setSetting('deposit_due_days', d);
    return back(c, '/admin/finance', 'm', '已保存');
  });
  app.get('/admin/finance/reconcile', (c) => c.html(reconcilePage(c)));
  app.post('/admin/finance/reconcile', async (c) => {
    const f = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v)]));
    try { return c.html(reconcilePage(c, await F.reconcile({ ...f, by: actorName() }), f)); } catch (e) { return c.html(reconcilePage(c, null, f, e.message), 400); }
  });
  app.get('/admin/finance/report', (c) => c.html(reportPage(c)));
  app.get('/admin/finance/report.csv', (c) => csv(c, 'finance-report', [['month', '月份', 'Month'], ['orders', '订单数', 'Orders'], ['orderValue', '订单金额', 'Order value'], ['received', '实收', 'Received'], ['receivedOnline', '在线', 'Online'], ['receivedTransfer', '电汇', 'Bank transfer'], ['refunds', '退款', 'Refunds'], ['net', '净收款', 'Net received'], ['discounts', '优惠', 'Discounts'], ['shipping', '运费', 'Shipping']],
    F.monthlyReport(lastMonths(Number(c.req.query('n')) === 24 ? 24 : 12))));
  app.post('/admin/finance/receipts/:id/push', async (c) => {
    try { const r = await F.pushReceipt(c.req.param('id')); return back(c, '/admin/finance/report', r.bill || r.already ? 'm' : 'e', r.bill ? `已生成金蝶收款单 ${r.bill}` : r.already ? `已同步过：${r.already}` : r.error || '未推送'); } catch (e) { return back(c, '/admin/finance/report', 'e', e.message); }
  });
  // documents (anyone who can see the order: sales, finance, warehouse)
  app.get('/admin/orders/:id/invoice', (c) => { const h = renderCommercialInvoice(c.req.param('id'), { lang: c.req.query('lang') }); return h ? c.html(h) : c.text('Not found', 404); });
  app.get('/admin/orders/:id/packing-list', (c) => { const h = renderPackingList(c.req.param('id'), { lang: c.req.query('lang') }); return h ? c.html(h) : c.text('Not found', 404); });
}
