// 内部线索后台（中文界面）：线索、对话、转人工、CSV 导出
import { config, aiEnabled } from './config.js';
import { listLeads, listConversations, conversationMessages, stats } from './db.js';
import { currentUser, can, permissionFor, ROLES } from './auth.js';

// Main navigation; each entry is only shown to staff whose role may open it.
export const NAV = [['/admin/dashboard', '看板'], ['/admin', '线索'], ['/admin/conversations', '对话'], ['/admin/ops', '业务闭环'], ['/admin/deals', 'AI 议价'], ['/admin/shop', '网店'], ['/admin/coupons', '优惠券'], ['/admin/reviews', '评价'], ['/admin/products', '商品'], ['/admin/categories', '品类'], ['/admin/settings', '站点设置'], ['/admin/content', '内容'], ['/admin/geo', 'GEO 监测'], ['/admin/leads.csv', '导出 CSV'], ['/admin/users', '账号权限']];
const navHtml = () => { const u = currentUser(); return NAV.filter(([h]) => !u || can(u, permissionFor(h))).map(([h, l]) => `<a href="${h}">${l}</a>`).join(''); };
const userHtml = () => { const u = currentUser(); return u ? `<span class="mute">${esc(u.name || u.username)}（${esc(ROLES[u.role]?.zh || u.role)}）</span> <a href="/admin/me">修改密码</a> <form method="post" action="/admin/logout" style="display:inline"><button>退出</button></form>` : ''; };

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const fmt = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '');
export const LEAD_STATUS = { new: '新线索', contacted: '已联系', quoted: '已报价', won: '已成交', lost: '丢单', spam: '无效' };

export function shell(title, body) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title><style>
:root{--ink:#1d2733;--mute:#66717d;--line:#e2e6ea;--bg:#f5f7f9;--a:#c62828;--b:#ef8f00;--c:#2e7d32;--d:#90a4ae}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:var(--ink);background:var(--bg)}
header{display:flex;gap:16px;align-items:center;padding:12px 20px;background:#fff;border-bottom:1px solid var(--line);flex-wrap:wrap}
header b{font-size:16px}header nav a{margin-right:14px;color:var(--ink)}main{padding:20px;max-width:1280px;margin:auto}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px}
.tile{background:#fff;border:1px solid var(--line);border-radius:8px;padding:12px 14px}.tile span{color:var(--mute);font-size:12px}.tile strong{display:block;font-size:22px}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line)}th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{background:#fafbfc;font-weight:600;font-size:12px;color:var(--mute);white-space:nowrap}td:first-child{white-space:nowrap}.g{display:inline-block;width:24px;text-align:center;border-radius:4px;color:#fff;font-weight:700}
.gA{background:var(--a)}.gB{background:var(--b)}.gC{background:var(--c)}.gD{background:var(--d)}.mute{color:var(--mute)}
.wrap{overflow-x:auto}.msg{background:#fff;border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:8px 0;max-width:760px}.msg.user{margin-left:auto;background:#eef4ff}
.pill{font-size:12px;padding:1px 8px;border-radius:10px;background:#eceff1;white-space:nowrap}.warn{background:#fff4e5;border:1px solid #ffcc80;padding:10px 14px;border-radius:8px;margin-bottom:16px}
select,button{font:inherit}a{color:#1565c0}
</style></head><body><header><b>${esc(config.profile.brand)} · AI 销售后台</b><nav>${navHtml()}</nav>
<span class="mute">站点 ${esc(config.site)} · ${aiEnabled() ? 'AI 模式：' + esc(config.llm.provider + ' / ' + config.llm.model) : '规则模式（未配置大模型密钥）'}</span><span style="margin-left:auto">${userHtml()}</span></header><main>${body}</main></body></html>`;
}

const SRC = { 'quote-page': '询价单', 'quote-form': '产品页询价', 'lighting-design': '免费灯光设计', wholesale: '批发/经销申请', 'oem-odm': 'OEM/ODM', 'chat-form': 'AI 对话留资', calculator: '收益测算', partner: '渠道合作', contact: '联系表单' };
function extraSummary(raw) {
  let x = {};
  try { x = JSON.parse(raw || '{}'); } catch {}
  const parts = [];
  if (Array.isArray(x.lines)) parts.push(`询价单 ${x.lines.length} 项`);
  for (const [k, v] of Object.entries(x)) if (!['lines', 'page', 'calculator'].includes(k) && v) parts.push(`${k}: ${String(v).slice(0, 80)}`);
  if (x.calculator) parts.push(`测算：${x.calculator.kwp} kWp，回本 ${x.calculator.payback ? Number(x.calculator.payback).toFixed(1) + ' 年' : '—'}`);
  return parts.length ? `<div class="mute" style="margin-top:4px">${esc(parts.join(' · '))}</div>` : '';
}

export function leadsPage() {
  const s = stats();
  const g = Object.fromEntries(s.byGrade.map((x) => [x.grade, x.n]));
  const rows = listLeads()
    .map((l) => `<tr><td><span class="g g${esc(l.grade)}">${esc(l.grade)}</span></td><td>${fmt(l.created_at)}<div class="mute">${esc(SRC[l.source] || l.source)}</div></td>
<td><b>${esc(l.company || '—')}</b><div>${esc(l.name)}</div><div class="mute">${esc(l.country)}</div></td>
<td>${esc(l.email)}<div>${esc(l.whatsapp || l.phone)}</div></td><td>${esc(l.product_id)}<div class="mute">${l.quantity ? '数量 ' + l.quantity : ''} ${esc(l.timeline)}</div></td>
<td style="max-width:320px">${esc(l.needs)}${extraSummary(l.extra)}<div class="mute">${esc(JSON.parse(l.reasons || '[]').join('，'))}</div></td>
<td><form method="post" action="/admin/lead/${esc(l.id)}/status"><select name="status" onchange="this.form.submit()">${Object.entries(LEAD_STATUS).map(([k, v]) => `<option value="${k}"${l.status === k ? ' selected' : ''}>${v}</option>`).join('')}</select></form>
<a href="/admin/quotes/new?lead=${esc(l.id)}">生成报价</a> ${l.conv_id ? `<a href="/admin/conv/${esc(l.conv_id)}">看对话</a>` : ''}</td></tr>`)
    .join('');
  return shell('线索', `${aiEnabled() ? '' : '<div class="warn">当前为规则模式：AI 对话使用内置规则答复。配置 LLM_PROVIDER / LLM_API_KEY / LLM_MODEL 后自动切换为大模型。</div>'}
<div class="tiles"><div class="tile"><span>对话总数</span><strong>${s.conversations}</strong></div><div class="tile"><span>近 7 天对话</span><strong>${s.conversations7d}</strong></div>
<div class="tile"><span>线索总数</span><strong>${s.leads}</strong></div><div class="tile"><span>A / B / C / D</span><strong>${g.A || 0} / ${g.B || 0} / ${g.C || 0} / ${g.D || 0}</strong></div>
<div class="tile"><span>转人工</span><strong>${s.handoffs}</strong></div></div>
<div class="wrap"><table><thead><tr><th>级</th><th>时间/来源</th><th>客户</th><th>联系方式</th><th>产品/数量</th><th>需求与评级依据</th><th>状态</th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="mute">还没有线索。网站对话或表单留资后会出现在这里。</td></tr>'}</tbody></table></div>`);
}

export function conversationsPage() {
  const rows = listConversations()
    .map((c) => `<tr><td>${fmt(c.updated_at)}</td><td>${c.msg_count}</td><td>${esc(c.page)}</td><td>${esc(c.lang)}</td><td>${c.handoff ? `<span class="pill" style="background:#ffe0b2">转人工</span> ${esc(c.handoff_reason)}` : ''}</td><td>${c.lead_id ? '已留资' : ''}</td><td><a href="/admin/conv/${esc(c.id)}">查看</a></td></tr>`)
    .join('');
  return shell('对话', `<div class="wrap"><table><thead><tr><th>最近更新</th><th>消息数</th><th>入口页面</th><th>语言</th><th>转人工</th><th>线索</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="mute">暂无对话</td></tr>'}</tbody></table></div>`);
}

export function conversationPage(id) {
  const msgs = conversationMessages(id).map((m) => `<div class="msg ${m.role}"><div class="mute">${m.role === 'user' ? '客户' : 'AI'} · ${fmt(m.ts)}</div>${esc(m.content).replace(/\n/g, '<br>')}</div>`).join('');
  return shell('对话详情', `<p><a href="/admin/conversations">← 返回对话列表</a></p>${msgs || '<p class="mute">没有消息</p>'}`);
}

export function leadsCsv() {
  const cols = ['created_at', 'grade', 'score', 'status', 'source', 'company', 'name', 'email', 'whatsapp', 'phone', 'country', 'buyer_type', 'product_id', 'quantity', 'timeline', 'needs', 'extra'];
  // Leading = + - @ (or tab/CR) would run as a formula in Excel: prefix with ' (CSV injection).
  const q = (v) => `"${String(v ?? '').replace(/^[=+\-@\t\r]/, "'$&").replace(/"/g, '""')}"`;
  return '﻿' + [cols.join(','), ...listLeads(10000).map((l) => cols.map((c) => q(l[c])).join(','))].join('\n');
}
