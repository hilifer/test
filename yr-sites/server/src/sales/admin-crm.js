// 后台：业务（销售）。线索列表（我的 / 公海 / 待跟进 / 全部）、线索详情（跟进记录、转交、领取、放回公海）、分配规则与节日提醒、
// 销售业绩与目标、报价模板，以及给报价页和客户页用的"客户打开记录""客户 360"片段。
import { shell, esc, fmt, LEAD_STATUS } from '../admin.js';
import { config } from '../config.js';
import { db, stats } from '../db.js';
import { currentUser, actorName } from '../auth.js';
import * as S from '../ops/service.js';
import * as CRM from './crm.js';
import { contractForQuote } from '../ops/deals.js';

const flash = (c) => `${c.req.query('m') ? `<div class="warn" style="background:#e8f5e9;border-color:#a5d6a7">${esc(c.req.query('m'))}</div>` : ''}${c.req.query('e') ? `<div class="warn" style="background:#fdecea;border-color:#f5b7b1">${esc(c.req.query('e'))}</div>` : ''}`;
const back = (c, path, k, v) => c.redirect(`${path}${path.includes('?') ? '&' : '?'}${k}=${encodeURIComponent(v)}`);
const SUB = (all) => `<p class="acts"><a href="/admin">线索</a> · <a href="/admin/sales/performance">销售业绩</a> · <a href="/admin/quotes/templates">报价模板</a>${all ? ' · <a href="/admin/sales/settings">分配规则与提醒</a>' : ''}</p>`;
const view = (title, body) => shell(title, SUB(CRM.seesAllLeads(currentUser())) + body);
const opt = (pairs, v) => pairs.map(([k, l]) => `<option value="${esc(k)}"${String(k) === String(v ?? '') ? ' selected' : ''}>${esc(l)}</option>`).join('');
const money = (x) => `${config.catalog.currency || 'USD'} ${Math.round(Number(x) || 0).toLocaleString('en-US')}`;
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const SRC = { 'quote-page': '询价单', 'quote-form': '产品页询价', 'lighting-design': '免费灯光设计', wholesale: '批发/经销申请', 'oem-odm': 'OEM/ODM', 'chat-form': 'AI 对话留资', calculator: '收益测算', partner: '渠道合作', contact: '联系表单', chat: 'AI 对话' };
function extraSummary(raw) {
  let x = {};
  try { x = JSON.parse(raw || '{}'); } catch { /* old rows */ }
  const parts = [];
  if (Array.isArray(x.lines)) parts.push(`询价单 ${x.lines.length} 项`);
  for (const [k, v] of Object.entries(x)) if (!['lines', 'page', 'calculator'].includes(k) && v) parts.push(`${k}: ${String(v).slice(0, 80)}`);
  if (x.calculator) parts.push(`测算：${x.calculator.kwp} kWp，回本 ${x.calculator.payback ? Number(x.calculator.payback).toFixed(1) + ' 年' : '—'}`);
  return parts.length ? `<div class="mute" style="margin-top:4px">${esc(parts.join(' · '))}</div>` : '';
}
const reasonsOf = (l) => { try { return JSON.parse(l.reasons || '[]').join('，'); } catch { return ''; } };
const ownerCell = (l) => (l.owner ? esc(l.owner) : '<span class="pill" style="background:#fff4e5">公海</span>');
const due = (l) => l.next_follow_at && l.next_follow_at <= new Date().toISOString();

// ---------------------------------------------------------------- leads list
export function leadsPage(c) {
  const me = currentUser();
  const all = CRM.seesAllLeads(me);
  const f = { scope: c.req.query('scope') || 'all', q: c.req.query('q') || '', grade: c.req.query('grade') || '', status: c.req.query('status') || '', owner: c.req.query('owner') || '' };
  const rows = CRM.listLeadsFor(me, f);
  const s = stats();
  const g = Object.fromEntries(s.byGrade.map((x) => [x.grade, x.n]));
  const counts = { mine: CRM.listLeadsFor(me, { scope: 'mine' }).length, pool: CRM.listLeadsFor(me, { scope: 'pool' }).length, due: CRM.dueFollowups(me.username).length };
  const tab = (k, l) => `<a href="/admin?scope=${k}" style="margin-right:14px;${f.scope === k ? 'font-weight:700;text-decoration:none;color:var(--ink)' : ''}">${l}</a>`;
  const people = CRM.salesPeople();
  const tr = rows.map((l) => `<tr><td><span class="g g${esc(l.grade)}">${esc(l.grade)}</span></td><td>${fmt(l.created_at)}<div class="mute">${esc(SRC[l.source] || l.source)}</div></td>
<td><a href="/admin/lead/${esc(l.id)}"><b>${esc(l.company || l.name || l.email || '—')}</b></a><div>${esc(l.company ? l.name : '')}</div><div class="mute">${esc(l.country)}</div></td><td>${esc(l.email)}<div>${esc(l.whatsapp || l.phone)}</div></td><td>${esc(l.product_id)}<div class="mute">${l.quantity ? `数量 ${l.quantity}` : ''} ${esc(l.timeline)}</div></td>
<td style="max-width:300px">${esc(String(l.needs || '').slice(0, 200))}${extraSummary(l.extra)}<div class="mute">${esc(reasonsOf(l))}</div></td>
<td>${ownerCell(l)}</td><td><form method="post" action="/admin/lead/${esc(l.id)}/status"><select name="status" onchange="this.form.submit()" aria-label="状态">${opt(Object.entries(LEAD_STATUS), l.status)}</select></form>${l.next_follow_at ? `<div class="${due(l) ? '' : 'mute'}" style="${due(l) ? 'color:#c62828;font-weight:600' : ''}">下次跟进 ${fmt(l.next_follow_at)}</div>` : ''}${l.last_follow_at ? `<div class="mute">上次 ${fmt(l.last_follow_at)}</div>` : ''}</td>
<td>${l.owner ? '' : `<form method="post" action="/admin/lead/${esc(l.id)}/claim" style="display:inline"><button>领取</button></form> `}<a href="/admin/lead/${esc(l.id)}">跟进</a> · <a href="/admin/quotes/new?lead=${esc(l.id)}">生成报价</a></td></tr>`).join('');
  return view('线索', `${flash(c)}<div class="tiles"><div class="tile"><span>线索总数</span><strong>${s.leads}</strong></div><div class="tile"><span>A / B / C / D</span><strong>${g.A || 0} / ${g.B || 0} / ${g.C || 0} / ${g.D || 0}</strong></div>
<div class="tile"><span>我的线索</span><strong>${counts.mine}</strong></div><div class="tile"><span>今天要跟进</span><strong style="${counts.due ? 'color:#c62828' : ''}">${counts.due}</strong></div><div class="tile"><span>公海</span><strong>${counts.pool}</strong></div></div>
<p>${tab('mine', `我的线索（${counts.mine}）`)}${tab('due', `待跟进（${counts.due}）`)}${tab('pool', `公海（${counts.pool}）`)}${tab('all', all ? '全部' : '我的 + 公海')}</p>
<form method="get" class="acts" style="display:flex;flex-wrap:wrap;gap:8px"><input type="hidden" name="scope" value="${esc(f.scope)}"><input name="q" value="${esc(f.q)}" placeholder="公司 / 姓名 / 邮箱 / 国家 / 产品"><select name="grade"><option value="">全部级别</option>${opt(['A', 'B', 'C', 'D'].map((x) => [x, `${x} 级`]), f.grade)}</select><select name="status"><option value="">全部状态</option>${opt(Object.entries(LEAD_STATUS), f.status)}</select>
${all && f.scope === 'all' ? `<select name="owner"><option value="">全部负责人</option>${opt(people.map((u) => [u.username, u.username]), f.owner)}</select>` : ''}<button>筛选</button></form>
<div class="wrap"><table><thead><tr><th>级</th><th>时间 / 来源</th><th>客户</th><th>联系方式</th><th>产品 / 数量</th><th>需求与评级依据</th><th>负责人</th><th>状态 / 跟进</th><th></th></tr></thead><tbody>${tr || '<tr><td colspan="9" class="mute">没有线索</td></tr>'}</tbody></table></div>`);
}

// ---------------------------------------------------------------- lead detail
function leadPage(c, lead) {
  const me = currentUser();
  const all = CRM.seesAllLeads(me);
  const extra = (() => { try { return JSON.parse(lead.extra || '{}'); } catch { return {}; } })();
  const reasons = (() => { try { return JSON.parse(lead.reasons || '[]'); } catch { return []; } })();
  const quotes = db.prepare('SELECT * FROM quotes WHERE lead_id = ? ORDER BY created_at DESC').all(lead.id);
  const cust = db.prepare('SELECT * FROM customers WHERE lead_id = ? OR (email != \'\' AND email = ?) LIMIT 1').get(lead.id, String(lead.email || '').toLowerCase());
  const mine = lead.owner === me.username;
  const LOG = { transfer: '转交' };
  return view(lead.company || lead.email || '线索', `${flash(c)}<p><a href="/admin">← 线索</a></p><h2><span class="g g${esc(lead.grade)}">${esc(lead.grade)}</span> ${esc(lead.company || lead.name || lead.email)} <span class="mute" style="font-size:14px">${esc(LEAD_STATUS[lead.status] || lead.status)}</span></h2>
<div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(280px,360px);gap:16px"><div>
<div class="msg" style="max-width:none"><b>${esc(lead.name)}</b> · ${esc(lead.email)} · ${esc(lead.whatsapp || lead.phone || '')} · ${esc(lead.country)}<br>产品：${esc(lead.product_id || '—')} ${lead.quantity ? `× ${lead.quantity}` : ''} · ${esc(lead.timeline || '')} · 来源：${esc(SRC[lead.source] || lead.source)} · ${fmt(lead.created_at)}
${lead.needs ? `<p style="margin:8px 0 0">${esc(lead.needs)}</p>` : ''}${Array.isArray(extra.lines) ? `<p class="mute" style="margin:6px 0 0">询价单：${extra.lines.map((x) => `${esc(x.sku)} × ${esc(x.qty)}`).join('，')}</p>` : ''}${extraSummary(lead.extra)}<p class="mute" style="margin:6px 0 0">评级依据：${esc(reasons.join('，'))}</p>
<p style="margin:8px 0 0"><a href="/admin/quotes/new?lead=${esc(lead.id)}">生成报价</a>${lead.conv_id ? ` · <a href="/admin/conv/${esc(lead.conv_id)}">看对话</a>` : ''}${cust ? ` · <a href="/admin/customers/${cust.id}">客户档案</a>` : ''}</p></div>
<form method="post" action="/admin/lead/${esc(lead.id)}/followup" class="msg" style="max-width:none;display:grid;gap:8px"><b>添加跟进记录</b>
<div style="display:flex;gap:8px;flex-wrap:wrap"><select name="kind" aria-label="跟进方式">${opt(Object.entries(CRM.FOLLOW_KINDS), 'call')}</select><label>下次跟进 <input type="datetime-local" name="next_at"></label></div>
<textarea name="content" rows="3" required placeholder="沟通内容、客户反馈、下一步"></textarea><div><button>保存跟进</button></div></form>
<h3>跟进记录</h3>${CRM.followupsOf(lead.id).map((x) => `<div class="msg" style="max-width:none"><div class="mute">${esc(CRM.FOLLOW_KINDS[x.kind] || x.kind)} · ${esc(x.by)} · ${fmt(x.ts)}${x.next_at ? ` · 下次跟进 ${fmt(x.next_at)}` : ''}</div>${esc(x.content).replace(/\n/g, '<br>')}</div>`).join('') || '<p class="mute">还没有跟进记录</p>'}
${quotes.length ? `<h3>报价</h3><div class="wrap"><table><tbody>${quotes.map((q) => { const v = CRM.viewsOf('quote', q.id); return `<tr><td><a href="/admin/quotes/${q.id}">${esc(q.number)}</a></td><td>${esc(q.status)}</td><td>${money(q.total)}</td><td>${v.count ? `客户打开 ${v.count} 次，最近 ${fmt(v.last)}` : '<span class="mute">客户还没打开</span>'}</td></tr>`; }).join('')}</tbody></table></div>` : ''}</div>
<div><div class="msg" style="max-width:none"><b>负责人：</b>${ownerCell(lead)}${lead.assigned_at ? `<div class="mute">分配于 ${fmt(lead.assigned_at)}</div>` : ''}
${!lead.owner ? `<form method="post" action="/admin/lead/${esc(lead.id)}/claim" style="margin-top:8px"><button>领取这条线索</button></form>` : ''}
${(mine || all) ? `<form method="post" action="/admin/lead/${esc(lead.id)}/transfer" style="margin-top:8px;display:flex;gap:6px"><select name="to" aria-label="转交给">${opt(CRM.salesPeople().filter((u) => u.username !== lead.owner).map((u) => [u.username, u.name ? `${u.username}（${u.name}）` : u.username]), '')}</select><button>转交</button></form>` : ''}
${lead.owner && (mine || all) ? `<form method="post" action="/admin/lead/${esc(lead.id)}/release" style="margin-top:8px;display:flex;gap:6px"><input name="reason" placeholder="原因（可选）"><button>放回公海</button></form>` : ''}
<form method="post" action="/admin/lead/${esc(lead.id)}/status" style="margin-top:8px"><select name="status" onchange="this.form.submit()" aria-label="状态">${opt(Object.entries(LEAD_STATUS), lead.status)}</select></form></div>
<h3>分配记录</h3><ul class="mute" style="padding-left:18px">${CRM.leadLogOf(lead.id).map((x) => `<li>${fmt(x.ts)} ${x.action === 'transfer' ? `${LOG.transfer}：` : ''}${esc(x.note)}</li>`).join('') || '<li>无</li>'}</ul></div></div>`);
}

// ---------------------------------------------------------------- settings, performance, quote templates
function settingsPage(c) {
  const s = CRM.assignSettings();
  const people = CRM.salesPeople();
  const rules = [...s.rules, {}, {}, {}];
  return view('分配规则与提醒', `${flash(c)}<h2>线索分配规则</h2><form method="post" action="/admin/sales/settings" class="msg" style="max-width:none;display:grid;gap:10px">
<label>分配方式 <select name="mode">${opt([['round_robin', '自动分配（先按规则，其余轮流）'], ['manual', '不自动分配（全部进公海，由销售领取或主管分配）']], s.mode)}</select></label>
<div><b>按规则分配</b> <span class="mute">国家可写多个（逗号分隔，如 US, CA, United States）；品类填品类编码。从上到下第一条符合的规则生效。</span>
<table><thead><tr><th>国家</th><th>品类</th><th>分配给</th></tr></thead><tbody>${rules.map((r, i) => `<tr><td><input name="r${i}_country" value="${esc(r.country || '')}"></td><td><input name="r${i}_category" value="${esc(r.category || '')}"></td><td><select name="r${i}_owner"><option value="">—</option>${opt(people.map((u) => [u.username, u.username]), r.owner)}</select></td></tr>`).join('')}</tbody></table></div>
<div><b>轮流分配给</b> ${people.map((u) => `<label style="margin-right:10px"><input type="checkbox" name="members" value="${esc(u.username)}"${s.members.includes(u.username) ? ' checked' : ''}> ${esc(u.username)}</label>`).join('') || '<span class="mute">还没有销售账号</span>'}</div>
<label>超过 <input name="poolDays" value="${s.poolDays}" size="4"> 天没有跟进的线索自动回到公海（0 = 不回收）</label><div><button>保存分配规则</button></div></form>
<h2>节日提醒</h2><form method="post" action="/admin/sales/settings/holidays" class="msg" style="max-width:none;display:grid;gap:8px"><span class="mute">每行一个："月-日 名称"。节日前 7 天在销售工作台提醒给 VIP 客户发祝福；客户生日在客户档案里填写。</span><textarea name="holidays" rows="6">${esc(CRM.holidays().map(([d, n]) => `${d} ${n}`).join('\n'))}</textarea><div><button>保存节日</button></div></form>`);
}

function performancePage(c) {
  const me = currentUser();
  const all = CRM.seesAllLeads(me);
  const months = CRM.lastMonths(Number(c.req.query('n')) === 12 ? 12 : 6);
  const cur = months.at(-1);
  const data = CRM.performance(months, { users: all ? null : [me.username] });
  const totals = (m) => data.reduce((a, p) => { const r = p.months[m]; for (const k of ['leads', 'quotes', 'quoted', 'won', 'wonAmount', 'received']) a[k] += r[k]; a.target += r.target || 0; return a; }, { leads: 0, quotes: 0, quoted: 0, won: 0, wonAmount: 0, received: 0, target: 0 });
  const t = totals(cur);
  const bar = (x) => (x == null ? '—' : `<div style="background:#eceff1;border-radius:4px;height:8px;width:100px;display:inline-block;vertical-align:middle"><div style="width:${Math.min(100, Math.round(x * 100))}%;height:8px;border-radius:4px;background:${x >= 1 ? '#2e7d32' : '#1565c0'}"></div></div> ${pct(x)}`);
  return view('销售业绩', `${flash(c)}<h2>销售业绩 <span class="mute" style="font-size:14px">${all ? '团队' : '我的'} · 本月 ${cur}</span></h2>
<div class="tiles"><div class="tile"><span>本月新线索</span><strong>${t.leads}</strong></div><div class="tile"><span>本月报价</span><strong>${t.quotes} 份 · ${money(t.quoted)}</strong></div><div class="tile"><span>本月成交</span><strong>${t.won} 单 · ${money(t.wonAmount)}</strong></div><div class="tile"><span>本月回款</span><strong>${money(t.received)}</strong></div><div class="tile"><span>目标完成度</span><strong>${t.target ? pct(t.wonAmount / t.target) : '未设目标'}</strong></div></div>
<h3>本月（${cur}）</h3><div class="wrap"><table><thead><tr><th>销售</th><th>新线索</th><th>已跟进</th><th>报价</th><th>线索→报价</th><th>成交</th><th>报价→成交</th><th>成交额</th><th>回款</th><th>目标</th><th>完成度</th></tr></thead><tbody>
${data.map((p) => { const r = p.months[cur]; return `<tr><td><b>${esc(p.username)}</b></td><td>${r.leads}</td><td>${r.followed}</td><td>${r.quotes}</td><td>${pct(r.leadToQuote)}</td><td>${r.won}</td><td>${pct(r.quoteToWon)}</td><td>${money(r.wonAmount)}</td><td>${money(r.received)}</td><td>${r.target != null ? money(r.target) : '—'}</td><td>${bar(r.completion)}</td></tr>`; }).join('') || '<tr><td colspan="11" class="mute">本期还没有数据</td></tr>'}</tbody></table></div>
<h3>按月对比 <span class="mute" style="font-size:13px"><a href="?n=6">近 6 个月</a> · <a href="?n=12">近 12 个月</a></span></h3><div class="wrap"><table><thead><tr><th>销售</th>${months.map((m) => `<th>${m}</th>`).join('')}</tr></thead><tbody>
${data.map((p) => `<tr><td><b>${esc(p.username)}</b></td>${months.map((m) => { const r = p.months[m]; return `<td>${money(r.wonAmount)}<div class="mute">${r.won} 单 · 报价 ${r.quotes}${r.target ? ` · ${pct(r.completion)}` : ''}</div></td>`; }).join('')}</tr>`).join('')}
<tr><td><b>合计</b></td>${months.map((m) => { const x = totals(m); return `<td><b>${money(x.wonAmount)}</b><div class="mute">${x.won} 单 · 回款 ${money(x.received)}</div></td>`; }).join('')}</tr></tbody></table></div>
${all ? `<h3>设置月度目标</h3><form method="post" action="/admin/sales/targets" class="acts"><select name="username" aria-label="销售">${opt(CRM.salesPeople().map((u) => [u.username, u.username]), '')}</select> <input name="month" value="${cur}" size="8" aria-label="月份"> <input name="amount" placeholder="目标成交额" size="10" aria-label="目标成交额"> <button>保存目标</button></form>` : ''}`);
}

function templatesPage(c) {
  const list = CRM.listQuoteTemplates();
  return view('报价模板', `${flash(c)}<h2>报价模板</h2><p class="mute">常用条款（币种、价格条款、港口、付款方式、有效期、备注）和常用产品组合。在报价页"套用模板"一键带入；在报价页"存为模板"保存当前报价。</p>
<div class="wrap"><table><thead><tr><th>名称</th><th>条款</th><th>产品</th><th>保存人</th><th></th></tr></thead><tbody>${list.map((t) => `<tr><td><b>${esc(t.name)}</b></td><td>${esc(Object.entries(t.terms).filter(([k]) => k !== 'notes').map(([k, v]) => `${k}=${v}`).join(' · '))}${t.terms.notes ? `<div class="mute">${esc(String(t.terms.notes).slice(0, 120))}</div>` : ''}</td><td>${t.lines.map((l) => `${esc(l.sku)} × ${l.qty}`).join('<br>') || '—'}</td><td>${esc(t.created_by)}<div class="mute">${fmt(t.updated_at)}</div></td>
<td><form method="post" action="/admin/quotes/templates/${t.id}/delete" onsubmit="return confirm('删除这个模板？')"><button>删除</button></form></td></tr>`).join('') || '<tr><td colspan="5" class="mute">还没有模板。打开任意报价，点"存为模板"。</td></tr>'}</tbody></table></div>`);
}

// ---------------------------------------------------------------- fragments for the quote and customer pages
/** On the quote page: template controls and whether the customer opened the PI / contract. */
export function quoteCrmBox(q) {
  const v = CRM.viewsOf('quote', q.id);
  const k = contractForQuote(q.id);
  const kv = k ? CRM.viewsOf('contract', k.id) : null;
  const editable = ['draft', 'sent', 'expired'].includes(q.status);
  const tpls = CRM.listQuoteTemplates();
  return `<div class="card"><b>客户打开记录</b> ${q.status === 'draft' ? '<span class="mute">发送后开始记录</span>' : v.count ? `报价单链接已打开 <b>${v.count}</b> 次 · 首次 ${fmt(v.first)} · 最近 ${fmt(v.last)}` : '<span class="mute">客户还没有打开报价单链接</span>'}${k ? ` · 合同 ${kv.count ? `已打开 <b>${kv.count}</b> 次，最近 ${fmt(kv.last)}` : '<span class="mute">合同还没有打开</span>'}` : ''}${q.owner ? ` · 负责人 ${esc(q.owner)}` : ''}</div>
<div class="card acts">${editable && tpls.length ? `<form method="post" action="/admin/quotes/${q.id}/template" class="acts"><select name="template" aria-label="报价模板">${opt(tpls.map((t) => [t.id, t.name]), '')}</select><button class="btn l">套用模板</button></form>` : ''}<form method="post" action="/admin/quotes/${q.id}/save-template" class="acts"><input name="name" placeholder="模板名称" required><button class="btn l">存为模板</button></form> <a href="/admin/quotes/templates">管理报价模板</a></div>`;
}
/** Customer 360: tier / tags / birthday / owner form, plus everything about the customer on one page. */
export function customer360(cust) {
  const id = cust.id;
  const tags = (() => { try { return JSON.parse(cust.tags || '[]'); } catch { return []; } })();
  const leads = db.prepare("SELECT * FROM leads WHERE id = ? OR (email != '' AND lower(email) = ?) ORDER BY created_at DESC").all(cust.lead_id || '', String(cust.email || '').toLowerCase());
  const convs = leads.filter((l) => l.conv_id).map((l) => db.prepare('SELECT * FROM conversations WHERE id = ?').get(l.conv_id)).filter(Boolean);
  const follows = leads.flatMap((l) => CRM.followupsOf(l.id)).sort((a, b) => b.ts.localeCompare(a.ts));
  const quotes = db.prepare('SELECT * FROM quotes WHERE customer_id = ? ORDER BY created_at DESC').all(id);
  const orders = S.ordersForCustomer(id);
  const pays = orders.flatMap((o) => S.paymentsFor(o.id).map((p) => ({ ...p, number: o.number, currency: o.currency }))).sort((a, b) => b.ts.localeCompare(a.ts));
  const rmas = db.prepare('SELECT * FROM rmas WHERE customer_id = ? ORDER BY created_at DESC').all(id);
  const contracts = db.prepare('SELECT * FROM contracts WHERE customer_id = ? ORDER BY created_at DESC').all(id);
  let reviews = [];
  try { reviews = db.prepare('SELECT * FROM reviews WHERE customer_id = ? ORDER BY created_at DESC').all(id); } catch { /* shop reviews not installed */ }
  const paid = orders.reduce((a, o) => a + (Number(o.paid) || 0), 0), total = orders.filter((o) => o.status !== 'cancelled').reduce((a, o) => a + (Number(o.total) || 0), 0);
  const sec = (title, n, body) => `<details${n ? ' open' : ''} class="card"><summary><b>${title}</b> <span class="mute">${n}</span></summary>${body}</details>`;
  return `<form method="post" action="/admin/customers/${id}/crm" class="card"><b>客户分级与标签</b><div class="grid2"><label class="fl"><span>客户类型</span><select name="tier"><option value="">—</option>${opt(Object.entries(CRM.TIERS), cust.tier)}</select></label>
<label class="fl"><span>VIP</span><select name="vip">${opt([['0', '否'], ['1', '是']], String(cust.vip || 0))}</select></label><label class="fl"><span>标签（逗号分隔）</span><input name="tags" value="${esc(tags.join(', '))}" list="ctags"><datalist id="ctags">${CRM.customerTags().map((t) => `<option value="${esc(t)}">`).join('')}</datalist></label>
<label class="fl"><span>生日（月-日）</span><input name="birthday" value="${esc(cust.birthday || '')}" placeholder="03-18"></label><label class="fl"><span>负责人</span><select name="owner"><option value="">—</option>${opt(CRM.salesPeople().map((u) => [u.username, u.username]), cust.owner)}</select></label></div>
<label class="fl"><span>客户备注</span><textarea name="notes" rows="2">${esc(cust.crm_notes || '')}</textarea></label><button class="btn l">保存</button></form>
<div class="tiles"><div class="tile"><span>订单</span><strong>${orders.length}</strong></div><div class="tile"><span>成交额</span><strong>${money(total)}</strong></div><div class="tile"><span>已付款</span><strong>${money(paid)}</strong></div><div class="tile"><span>报价</span><strong>${quotes.length}</strong></div><div class="tile"><span>售后</span><strong>${rmas.length}</strong></div></div>
${sec('联系人', leads.length + 1, `<ul><li>${esc(cust.contact || '')} · ${esc(cust.email)} · ${esc(cust.phone || '')} ${esc(cust.whatsapp || '')}</li>${leads.filter((l) => l.name && l.name !== cust.contact).map((l) => `<li>${esc(l.name)} · ${esc(l.email)} · ${esc(l.whatsapp || l.phone || '')}</li>`).join('')}</ul>`)}
${sec('询价（线索）', leads.length, `<ul>${leads.map((l) => `<li><a href="/admin/lead/${esc(l.id)}">${fmt(l.created_at)} ${esc(l.grade)} 级 · ${esc(l.product_id || '')} ${l.quantity ? `× ${l.quantity}` : ''}</a> · ${esc(LEAD_STATUS[l.status] || l.status)} · ${l.owner ? esc(l.owner) : '公海'}</li>`).join('')}</ul>`)}
${sec('跟进记录', follows.length, follows.map((x) => `<div class="msg" style="max-width:none"><div class="mute">${esc(CRM.FOLLOW_KINDS[x.kind] || x.kind)} · ${esc(x.by)} · ${fmt(x.ts)}</div>${esc(x.content)}</div>`).join(''))}
${sec('聊天记录', convs.length, `<ul>${convs.map((v) => `<li><a href="/admin/conv/${esc(v.id)}">${fmt(v.started_at || v.updated_at)} · ${v.msg_count ?? ''} 条消息</a></li>`).join('')}</ul>`)}
${sec('报价', quotes.length, `<ul>${quotes.map((q) => { const v = CRM.viewsOf('quote', q.id); return `<li><a href="/admin/quotes/${q.id}">${esc(q.number)}</a> · ${esc(q.status)} · ${money(q.total)} · ${v.count ? `客户打开 ${v.count} 次` : '未打开'}</li>`; }).join('')}</ul>`)}
${sec('合同', contracts.length, `<ul>${contracts.map((k) => `<li><a href="/admin/contracts/${k.id}">${esc(k.number)}</a> · ${esc(k.status)}${k.signed_at ? ` · 签署 ${fmt(k.signed_at)}` : ''}</li>`).join('')}</ul>`)}
${sec('付款', pays.length, `<ul>${pays.map((p) => `<li>${fmt(p.ts)} · ${esc(p.number)} · ${esc(p.kind)} · ${esc(p.currency)} ${p.amount}</li>`).join('')}</ul>`)}
${sec('售后', rmas.length, `<ul>${rmas.map((r) => `<li><a href="/admin/rma/${esc(r.id)}">${esc(r.number)}</a> · ${esc(r.issue)} · ${esc(r.status)}</li>`).join('')}</ul>`)}
${sec('评价', reviews.length, `<ul>${reviews.map((r) => `<li>${'★'.repeat(r.rating)} ${esc(r.title || '')} · ${esc(r.product_id)} · ${esc(r.status)}</li>`).join('')}</ul>`)}`;
}
/** Customer list filters (tier / tag / VIP). */
export function filterCustomers(list, q) {
  return list.filter((c) => (!q.tier || c.tier === q.tier) && (!q.vip || Number(c.vip) === 1) && (!q.tag || (() => { try { return JSON.parse(c.tags || '[]').includes(q.tag); } catch { return false; } })()));
}

export function mountCrmAdmin(app) {
  app.get('/admin', (c) => c.html(leadsPage(c)));
  app.get('/admin/lead/:id', (c) => {
    const lead = CRM.getLead(c.req.param('id'));
    if (!CRM.canSeeLead(currentUser(), lead)) return c.html(view('线索', '<p>线索不存在，或已分配给其他销售</p>'), 404);
    return c.html(leadPage(c, lead));
  });
  const act = (fn, msg) => async (c) => {
    const id = c.req.param('id');
    const lead = CRM.getLead(id);
    if (!CRM.canSeeLead(currentUser(), lead)) return c.text('Not found', 404);
    try { const m = await fn(id, await c.req.parseBody(), c); return back(c, `/admin/lead/${id}`, 'm', m || msg); } catch (e) { return back(c, `/admin/lead/${id}`, 'e', e.message); }
  };
  app.post('/admin/lead/:id/followup', act((id, f) => CRM.addFollowup(id, { kind: String(f.kind || 'note'), content: f.content, nextAt: String(f.next_at || '') }, currentUser()), '跟进已保存'));
  app.post('/admin/lead/:id/claim', act((id) => CRM.claimLead(id, currentUser()), '已领取，这条线索归你跟进'));
  app.post('/admin/lead/:id/release', act((id, f) => CRM.releaseLead(id, currentUser(), String(f.reason || '')), '已放回公海'));
  app.post('/admin/lead/:id/transfer', act((id, f) => {
    const lead = CRM.getLead(id);
    if (lead.owner !== currentUser().username && !CRM.seesAllLeads(currentUser())) throw new Error('只能转交自己的线索');
    CRM.transferLead(id, String(f.to || ''), actorName());
    return `已转交给 ${f.to}`;
  }, '已转交'));
  app.get('/admin/sales/settings', (c) => c.html(settingsPage(c)));
  app.post('/admin/sales/settings', async (c) => {
    const f = await c.req.parseBody({ all: true });
    const one = (k) => String([].concat(f[k] ?? '')[0]);
    try {
      CRM.saveAssignSettings({ mode: one('mode'), members: [].concat(f.members || []), poolDays: one('poolDays'), rules: Array.from({ length: 30 }, (_, i) => ({ country: one(`r${i}_country`), category: one(`r${i}_category`), owner: one(`r${i}_owner`) })) });
      return back(c, '/admin/sales/settings', 'm', '分配规则已保存');
    } catch (e) { return back(c, '/admin/sales/settings', 'e', e.message); }
  });
  app.post('/admin/sales/settings/holidays', async (c) => { try { CRM.saveHolidays((await c.req.parseBody()).holidays); return back(c, '/admin/sales/settings', 'm', '节日已保存'); } catch (e) { return back(c, '/admin/sales/settings', 'e', e.message); } });
  app.get('/admin/sales/performance', (c) => c.html(performancePage(c)));
  app.post('/admin/sales/targets', async (c) => { const f = await c.req.parseBody(); try { CRM.setTarget(String(f.username || ''), String(f.month || ''), f.amount); return back(c, `/admin/sales/performance`, 'm', '目标已保存'); } catch (e) { return back(c, '/admin/sales/performance', 'e', e.message); } });
  app.get('/admin/quotes/templates', (c) => c.html(templatesPage(c)));
  app.post('/admin/quotes/templates/:tid/delete', (c) => { CRM.deleteQuoteTemplate(c.req.param('tid')); return back(c, '/admin/quotes/templates', 'm', '已删除'); });
  app.post('/admin/quotes/:id/template', async (c) => {
    const id = c.req.param('id');
    try { const r = CRM.applyQuoteTemplate(id, (await c.req.parseBody()).template); return c.redirect(`/admin/quotes/${id}?m=${encodeURIComponent(`已套用模板「${r.name}」，加入 ${r.added} 个产品`)}`); } catch (e) { return c.redirect(`/admin/quotes/${id}?e=${encodeURIComponent(e.message)}`); }
  });
  app.post('/admin/quotes/:id/save-template', async (c) => {
    const id = c.req.param('id');
    const q = S.getQuote(id);
    try {
      if (!q) throw new Error('报价不存在');
      CRM.saveQuoteTemplate({ name: (await c.req.parseBody()).name, terms: q, lines: q.lines });
      return c.redirect(`/admin/quotes/${id}?m=${encodeURIComponent('已存为报价模板')}`);
    } catch (e) { return c.redirect(`/admin/quotes/${id}?e=${encodeURIComponent(e.message)}`); }
  });
  app.post('/admin/customers/:id/crm', async (c) => {
    const id = c.req.param('id');
    const f = await c.req.parseBody();
    try { CRM.saveCustomerCrm(id, { tier: String(f.tier || ''), vip: f.vip === '1', tags: String(f.tags || ''), birthday: String(f.birthday || ''), owner: String(f.owner || ''), notes: String(f.notes || '') }); return c.redirect(`/admin/customers/${id}?m=${encodeURIComponent('已保存')}`); } catch (e) { return c.redirect(`/admin/customers/${id}?e=${encodeURIComponent(e.message)}`); }
  });
}
