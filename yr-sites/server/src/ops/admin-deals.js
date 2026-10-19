// 后台：AI 议价（审批队列、授权政策、SKU 底价）、销售合同（列表、详情、作废、模板）；客户端：合同在线签署页。
import { esc, fmt } from '../admin.js';
import { config } from '../config.js';
import { DICT } from '../../../shared/dictionary.js';
import { opsView as view, opsBack as back, opsTimeline as timeline, opsInp as inp } from './admin-ops.js';
import { page as portalPage } from './portal.js';
import { money } from './pi.js';
import { listSkus, getCustomer, getQuote, getOrderByQuote } from './service.js';
import * as D from './deals.js';

const OFFER_ST = { offered: ['AI 已报价', '#1565c0'], needs_approval: ['待审批', '#ef8f00'], approved: ['已审批', '#2e7d32'], rejected: ['已拒绝', '#9e9e9e'], contracted: ['已发合同', '#6a1b9a'], expired: ['已过期', '#8d6e63'] };
const K_ST = { sent: ['待客户签署', '#1565c0'], signed: ['已签署', '#2e7d32'], void: ['已作废', '#9e9e9e'] };
const tag = (m, s) => `<span class="pill" style="background:${(m[s] || [])[1] || '#90a4ae'};color:#fff">${esc((m[s] || [s])[0])}</span>`;
const REASON = (r) => {
  const [k, v] = r.split(':');
  return { over_value_cap: '超过 AI 可成交金额', max_rounds: '超过议价轮数', no_list_price: `没有标价（${v}）`, payment_terms: `付款方式需审批：${DICT.paymentTerms.find((t) => t.id === v)?.zh || v}`, incoterm: `价格条款需审批：${v}` }[k] || r;
};
const q = (c) => [c.req.query('m') || '', c.req.query('e') || ''];

function offersPage(c) {
  const status = c.req.query('status') ?? '';
  const list = D.listOffers(status);
  const waiting = D.listOffers('needs_approval').length;
  return view('AI 议价', `<h2>AI 议价</h2>
<p class="mute">AI 在下面"授权政策"范围内自动报价（分轮让步），超出范围的进入审批。AI 看不到折扣上限和底价，只拿到最终报价。客户接受后自动生成 PI 和销售合同，合同链接只发到客户邮箱。</p>
<div class="acts"><a class="btn${waiting ? '' : ' l'}" href="/admin/deals?status=needs_approval">待审批 ${waiting}</a>${Object.entries(OFFER_ST).map(([k, [l]]) => `<a href="/admin/deals?status=${k}">${l}</a>`).join(' · ')} · <a href="/admin/deals">全部</a> · <a href="/admin/deals/policy">授权政策与底价</a> · <a href="/admin/contracts">合同</a></div>
<div class="wrap"><table><thead><tr><th>编号</th><th>时间</th><th>客户</th><th>级别 / 轮次</th><th class="n">标价</th><th class="n">报价</th><th>折扣</th><th>状态</th><th>原因</th></tr></thead><tbody>
${list.map((o) => `<tr><td><a href="/admin/deals/${o.id}"><b>${esc(o.number)}</b></a><div class="mute">${esc(o.source)}</div></td><td>${fmt(o.created_at)}</td><td>${esc(o.buyer.company || '')}<div class="mute">${esc(o.email)}</div></td><td>${esc(o.grade)} / 第 ${o.round} 轮</td>
<td class="n">${money(o.currency, o.list_total)}</td><td class="n"><b>${money(o.currency, o.total)}</b></td><td>${o.discount_pct}%</td><td>${tag(OFFER_ST, o.status)}</td><td>${o.reasons.map((r) => esc(REASON(r))).join('<br>')}</td></tr>`).join('') || '<tr><td colspan="9" class="mute">暂无</td></tr>'}</tbody></table></div>`, ...q(c));
}

function offerPage(c) {
  const o = D.getOffer(c.req.param('id'));
  if (!o) return view('未找到', '<p>报价不存在</p>');
  const floors = D.floorPrices();
  const can = o.status === 'needs_approval';
  return view(o.number, `<p><a href="/admin/deals">← AI 议价</a></p><h2>${esc(o.number)} ${tag(OFFER_ST, o.status)}</h2>
<div class="card">客户：<b>${esc(o.buyer.company || '')}</b> ${esc(o.buyer.name || '')} · ${esc(o.email)} · ${esc(o.buyer.country || '')} · 信用级别 <b>${esc(o.grade)}</b>（A=付过款的老客户，B=企业邮箱，C=免费邮箱）· 第 ${o.round} 轮
<br>${esc(o.incoterm)} ${esc(o.port || '')} · ${esc(DICT.paymentTerms.find((t) => t.id === o.payment_terms)?.zh || o.payment_terms)} · 有效期至 ${esc(o.valid_until.slice(0, 10))}
${o.reasons.length ? `<div class="flash err" style="margin-top:10px">需要审批：${o.reasons.map((r) => esc(REASON(r))).join('；')}</div>` : ''}
${o.decided_by ? `<div class="mute">审批：${esc(o.decided_by)} · ${fmt(o.decided_at)} ${esc(o.decision_note || '')}</div>` : ''}
${o.contract_id ? `<div>合同：<a href="/admin/contracts/${o.contract_id}">查看</a></div>` : ''}</div>
<form method="post" action="/admin/deals/${o.id}/decide" class="card"><table><thead><tr><th>产品</th><th class="n">数量</th><th class="n">标价</th><th class="n">客户要价</th><th class="n">底价</th><th class="n">报价单价</th><th class="n">金额</th></tr></thead><tbody>
${o.lines.map((l) => `<tr><td>${esc(l.sku)}<div class="mute">${esc(l.name)}</div></td><td class="n">${l.qty}</td><td class="n">${l.list_price ?? '—'}</td><td class="n">${l.target ?? '—'}</td><td class="n">${floors[l.sku] ?? '—'}</td>
<td class="n">${can ? `<input name="price_${esc(l.sku)}" value="${l.unit_price ?? ''}" style="width:100px;text-align:right">` : l.unit_price ?? '—'}</td><td class="n">${l.amount ?? '—'}</td></tr>`).join('')}</tbody></table>
<p><b>合计 ${money(o.currency, o.total)}</b> <span class="mute">（标价 ${money(o.currency, o.list_total)}，折扣 ${o.discount_pct}%）</span></p>
${can ? `${inp('审批意见（拒绝时会发给客户）', 'note')}<div class="acts"><button class="btn" name="decision" value="approve">批准并发送合同</button><button class="btn r" name="decision" value="reject">拒绝</button></div>` : ''}</form>
<h3>记录</h3>${timeline('offer', o.id)}`, ...q(c));
}

function policyPage(c) {
  const p = D.dealPolicy();
  const floors = D.floorPrices();
  const skus = listSkus().filter((s) => s.active);
  const chk = (name, value, on, l) => `<label style="display:inline-flex;gap:4px;align-items:center;margin-right:12px"><input type="checkbox" name="${name}" value="${esc(value)}"${on ? ' checked' : ''}> ${esc(l)}</label>`;
  return view('议价授权', `<p><a href="/admin/deals">← AI 议价</a></p><h2>AI 议价授权政策</h2>
<p class="mute">由财务设置。AI 只能在这里的范围内报价；第一轮最多让出一半授权，第二轮起可到上限；超过任何一项都进入人工审批。底价不会出现在网站、AI 或 MCP 中。</p>
<form method="post" action="/admin/deals/policy" class="card">
${chk('enabled', '1', p.enabled, '启用 AI 议价（关闭后 AI 的报价请求全部转人工）')}
<div class="grid2" style="margin-top:10px">${inp('A 级（付过款的老客户）最大折扣 %', 'pct_A', p.maxDiscountPct.A)}${inp('B 级（企业邮箱）最大折扣 %', 'pct_B', p.maxDiscountPct.B)}${inp('C 级（免费邮箱）最大折扣 %', 'pct_C', p.maxDiscountPct.C)}
${inp(`AI 可直接成交的最大订单金额（${esc(config.catalog.currency || 'USD')}）`, 'maxOrderValue', p.maxOrderValue)}${inp('最多议价轮数（14 天内同一邮箱）', 'maxRounds', p.maxRounds)}${inp('报价有效期（天）', 'validityDays', p.validityDays)}</div>
<p><b>AI 可以接受的付款方式：</b><br>${DICT.paymentTerms.map((t) => chk('paymentTerms', t.id, p.paymentTerms.includes(t.id), t.zh)).join('')}</p>
<p><b>AI 可以报的价格条款：</b><br>${DICT.incoterms.map((t) => chk('incoterms', t, p.incoterms.includes(t), t)).join('')}</p>
<div class="acts"><button class="btn">保存政策</button></div></form>
<h3>SKU 底价</h3><p class="mute">任何报价（包括人工审批时的建议价）都不低于底价。留空 = 只按折扣上限控制。</p>
<form method="post" action="/admin/deals/floors" class="card"><div class="wrap"><table><thead><tr><th>SKU</th><th>名称</th><th class="n">网店售价</th><th class="n">底价</th></tr></thead><tbody>
${skus.map((s) => `<tr><td>${esc(s.sku)}</td><td>${esc(s.name)} ${esc(s.variant || '')}</td><td class="n">${s.price ?? '—'}</td><td class="n"><input name="floor_${esc(s.sku)}" value="${floors[s.sku] ?? ''}" style="width:100px;text-align:right"></td></tr>`).join('')}</tbody></table></div>
<div class="acts"><button class="btn">保存底价</button></div></form>`, ...q(c));
}

function contractsPage(c) {
  const list = D.listContracts();
  return view('合同', `<h2>销售合同</h2><div class="acts"><a href="/admin/deals">AI 议价</a> · <a href="/admin/contracts/template">合同模板</a></div>
<div class="wrap"><table><thead><tr><th>合同号</th><th>时间</th><th>客户</th><th>PI</th><th>状态</th><th>签署</th></tr></thead><tbody>
${list.map((k) => { const qt = getQuote(k.quote_id); return `<tr><td><a href="/admin/contracts/${k.id}"><b>${esc(k.number)}</b></a></td><td>${fmt(k.created_at)}<div class="mute">${esc(k.created_by)}</div></td><td>${esc(k.company || '')}<div class="mute">${esc(k.email)}</div></td><td><a href="/admin/quotes/${k.quote_id}">${esc(qt?.number || '')}</a> ${qt ? money(qt.currency, qt.total) : ''}</td><td>${tag(K_ST, k.status)}</td><td>${k.signed_at ? `${esc(k.signer_name)} · ${fmt(k.signed_at)}` : ''}</td></tr>`; }).join('') || '<tr><td colspan="6" class="mute">暂无</td></tr>'}</tbody></table></div>`, ...q(c));
}

const DOC_CSS = `<style>.doc{background:#fff;border:1px solid #d9e0e6;border-radius:10px;padding:28px 32px;max-width:860px}.doc h1{font-size:24px;margin:0 0 4px}.doc h2{font-size:16px;margin:22px 0 6px}.doc .two{display:grid;grid-template-columns:1fr 1fr;gap:18px}.doc h3{font-size:13px;color:#5f6b77;margin:12px 0 2px;text-transform:uppercase;letter-spacing:.04em}.doc table.goods{width:100%;border-collapse:collapse;margin:8px 0}.doc table.goods th,.doc table.goods td{border:1px solid #d9e0e6;padding:6px 8px;text-align:left}.sig{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:22px;border-top:1px solid #d9e0e6;padding-top:14px}.fp{font:12px/1.4 ui-monospace,monospace;color:#5f6b77;word-break:break-all}@media(max-width:600px){.doc{padding:18px}.doc .two,.sig{grid-template-columns:1fr}}@media print{header,form,.noprint{display:none!important}.doc{border:0}}</style>`;
function sigBlock(k) {
  const v = D.verifyContract(k);
  return `<div class="sig"><div><h3>Seller</h3><p>Issued by ${esc(config.profile.company)}<br><span class="fp">${esc(k.seller_signed_by)} · ${esc((k.sent_at || '').slice(0, 19).replace('T', ' '))} UTC</span></p></div>
<div><h3>Buyer</h3>${k.status === 'signed' ? `<p>Signed electronically by <b>${esc(k.signer_name)}</b>${k.signer_title ? `, ${esc(k.signer_title)}` : ''}<br>${esc(k.signer_email)}<br><span class="fp">${esc(k.signed_at.slice(0, 19).replace('T', ' '))} UTC · IP ${esc(k.signer_ip)}</span></p>` : '<p class="mute">Not signed yet</p>'}</div></div>
<p class="fp">Document fingerprint (SHA-256): ${esc(k.hash)} — ${v.intact ? 'intact' : 'MODIFIED'}${k.signature_hash ? `<br>Signature record: ${esc(k.signature_hash)} — ${v.signature ? 'valid' : 'INVALID'}` : ''}</p>`;
}

function contractAdmin(c) {
  const k = D.getContract(c.req.param('id'));
  if (!k) return view('未找到', '<p>合同不存在</p>');
  const qt = getQuote(k.quote_id);
  const order = getOrderByQuote(k.quote_id);
  return view(k.number, `${DOC_CSS}<p><a href="/admin/contracts">← 合同</a></p><h2>${esc(k.number)} ${tag(K_ST, k.status)}</h2>
<div class="card">PI：<a href="/admin/quotes/${k.quote_id}">${esc(qt?.number || '')}</a>${order ? ` · 订单：<a href="/admin/orders/${order.id}">${esc(order.number)}</a>` : ''} · 签署链接（只通过邮件发给客户）：<code>${esc(D.signUrl(k))}</code>${k.offer_id ? ` · 来自 AI 议价 <a href="/admin/deals/${k.offer_id}">查看</a>` : ''}
${k.status === 'signed' ? `<div>签署人：${esc(k.signer_name)} ${esc(k.signer_title || '')} · ${esc(k.signer_email)} · ${fmt(k.signed_at)} · IP ${esc(k.signer_ip)}<div class="mute">${esc(k.signer_ua || '')}</div></div>` : ''}
${k.status === 'void' ? `<div class="mute">作废原因：${esc(k.void_reason)}（${fmt(k.voided_at)}）</div>` : ''}</div>
${k.status === 'sent' ? `<form method="post" action="/admin/contracts/${k.id}/void" class="card acts">${inp('作废原因', 'reason', '', 'required')}<button class="btn r">作废合同</button></form>` : ''}
<div class="doc">${k.body}${sigBlock(k)}</div><h3>记录</h3>${timeline('contract', k.id)}`, ...q(c));
}

function templatePage(c) {
  return view('合同模板', `<p><a href="/admin/contracts">← 合同</a></p><h2>合同模板</h2>
<p class="mute">纯文本：空行分段，"## " 开头为条款标题，**加粗**。占位符：${['contract_number', 'date', 'pi_number', 'seller_company', 'seller_address', 'buyer_company', 'buyer_contact', 'buyer_email', 'buyer_country', 'goods_table', 'currency', 'total', 'incoterm', 'port', 'payment_terms', 'lead_time', 'warranty', 'validity'].map((x) => `<code>{{${x}}}</code>`).join(' ')}。已发出的合同不受模板修改影响（内容已冻结并有指纹）。请让法务审核模板。</p>
<form method="post" action="/admin/contracts/template" class="card"><textarea name="template" rows="30" style="width:100%;font:13px/1.5 ui-monospace,monospace">${esc(D.contractTemplate())}</textarea><div class="acts"><button class="btn">保存模板</button></div></form>`, ...q(c));
}

const PT = {
  en: { title: 'Sales contract', sign: 'Sign the contract', name: 'Full name (your electronic signature)', role: 'Title / position', agree: 'I have read this contract, I am authorised to sign it for the Buyer, and I agree that my typed name is my electronic signature.', btn: 'Sign contract', signed: 'Signed — thank you. Your order number is', print: 'Print / save as PDF', void: 'This contract has been withdrawn. Please contact us for an updated version.', exp: 'The offer in this contract has expired.' },
  zh: { title: '销售合同', sign: '签署合同', name: '姓名（作为电子签名）', role: '职务', agree: '我已阅读本合同，有权代表买方签署，并同意以输入的姓名作为电子签名。', btn: '签署合同', signed: '签署成功，谢谢！您的订单号是', print: '打印 / 存为 PDF', void: '此合同已撤回，请联系我们获取新版本。', exp: '本合同中的报价已过期。' },
};
function contractPortal(k, { lang = 'en', error = '', order = null } = {}) {
  const t = PT[lang] || PT.en;
  const cust = getCustomer(k.customer_id);
  const o = order || (k.status === 'signed' ? getOrderByQuote(k.quote_id) : null);
  const form = k.status === 'sent' ? `<form method="post" class="card f noprint"><h2 style="margin-top:0">${t.sign}</h2><div class="row"><label>${t.name}<input name="name" required autocomplete="name" value="${esc(cust.contact || '')}"></label><label>${t.role}<input name="title" autocomplete="organization-title"></label></div>
<label style="font-weight:400;display:flex;gap:8px;align-items:flex-start"><input type="checkbox" name="agree" value="1" required style="margin-top:4px"> ${t.agree}</label><button class="btn">${t.btn}</button></form>` : '';
  return portalPage(lang, `${t.title} ${k.number}`, `${DOC_CSS}${error ? `<div class="note err">${esc(error)}</div>` : ''}${o ? `<div class="note">${t.signed} <a href="/portal/c/${esc(cust.portal_token)}/o/${encodeURIComponent(o.number)}"><b>${esc(o.number)}</b></a>.</div>` : ''}${k.status === 'void' ? `<div class="note err">${t.void}</div>` : ''}
<p class="noprint"><a href="javascript:print()">${t.print}</a></p><div class="doc">${k.body}${sigBlock(k)}</div>${form}`);
}

export function mountDeals(app, { ipOf }) {
  // ---------- customer: sign
  app.get('/portal/contract/:t', (c) => {
    const k = D.contractByToken(c.req.param('t'));
    if (!k) return c.text('Not found', 404);
    return c.html(contractPortal(k, { lang: c.req.query('lang') === 'zh' ? 'zh' : 'en' }));
  });
  app.post('/portal/contract/:t', async (c) => {
    const k = D.contractByToken(c.req.param('t'));
    if (!k) return c.text('Not found', 404);
    const lang = c.req.query('lang') === 'zh' ? 'zh' : 'en';
    const f = await c.req.parseBody();
    try {
      const order = await D.signContract(k.token, { name: f.name, title: f.title, agree: f.agree, ip: ipOf(c), ua: c.req.header('user-agent') || '' });
      return c.html(contractPortal(D.contractByToken(k.token), { lang, order }));
    } catch (e) { return c.html(contractPortal(D.contractByToken(k.token), { lang, error: e.message }), 400); }
  });

  // ---------- admin
  app.get('/admin/deals', (c) => c.html(offersPage(c)));
  app.get('/admin/deals/policy', (c) => c.html(policyPage(c)));
  app.post('/admin/deals/policy', async (c) => {
    const f = await c.req.parseBody({ all: true });
    try { D.saveDealPolicy(f); return back(c, '/admin/deals/policy', '政策已保存'); } catch (e) { return back(c, '/admin/deals/policy', e.message, true); }
  });
  app.post('/admin/deals/floors', async (c) => {
    const f = await c.req.parseBody();
    const errs = [];
    let n = 0;
    for (const [k, v] of Object.entries(f)) if (k.startsWith('floor_')) { const sku = k.slice(6); if ((D.floorPrices()[sku] ?? '') === (v === '' ? '' : Number(v))) continue; try { D.setFloorPrice(sku, String(v).trim()); n++; } catch (e) { errs.push(`${sku}：${e.message}`); } }
    return errs.length ? back(c, '/admin/deals/policy', errs.join('；'), true) : back(c, '/admin/deals/policy', `已更新 ${n} 个底价`);
  });
  app.get('/admin/deals/:id', (c) => c.html(offerPage(c)));
  app.post('/admin/deals/:id/decide', async (c) => {
    const f = await c.req.parseBody();
    const prices = Object.fromEntries(Object.entries(f).filter(([k]) => k.startsWith('price_')).map(([k, v]) => [k.slice(6), v]));
    try {
      const approve = f.decision === 'approve';
      // an approved price may never go below the floor
      if (approve) { const floors = D.floorPrices(); for (const [sku, v] of Object.entries(prices)) if (floors[sku] && Number(v) < floors[sku]) throw new Error(`${sku} 单价低于底价 ${floors[sku]}`); }
      const r = await D.decideOffer(c.req.param('id'), { approve, note: String(f.note || ''), prices });
      return back(c, `/admin/deals/${c.req.param('id')}`, approve ? (r.issued ? `已批准，合同 ${r.contract_number} 已发到 ${r.sent_to}` : `已批准，但合同未生成：${r.error}`) : '已拒绝，已邮件通知客户');
    } catch (e) { return back(c, `/admin/deals/${c.req.param('id')}`, e.message, true); }
  });
  app.get('/admin/contracts', (c) => c.html(contractsPage(c)));
  app.get('/admin/contracts/template', (c) => c.html(templatePage(c)));
  app.post('/admin/contracts/template', async (c) => {
    const f = await c.req.parseBody();
    try { D.saveContractTemplate(f.template); return back(c, '/admin/contracts/template', '模板已保存（只影响之后生成的合同）'); } catch (e) { return back(c, '/admin/contracts/template', e.message, true); }
  });
  app.get('/admin/contracts/:id', (c) => c.html(contractAdmin(c)));
  app.post('/admin/contracts/:id/void', async (c) => {
    const f = await c.req.parseBody();
    try { D.voidContract(c.req.param('id'), String(f.reason || '')); return back(c, `/admin/contracts/${c.req.param('id')}`, '已作废'); } catch (e) { return back(c, `/admin/contracts/${c.req.param('id')}`, e.message, true); }
  });
  app.post('/admin/quotes/:id/contract', async (c) => {
    try { const k = await D.createContractForQuote(c.req.param('id')); return back(c, `/admin/contracts/${k.id}`, `合同 ${k.number} 已生成并发到客户邮箱`); } catch (e) { return back(c, `/admin/quotes/${c.req.param('id')}`, e.message, true); }
  });

  setInterval(() => { try { D.expireOffers(); } catch (e) { console.error('[deals]', e.message); } }, 3600e3).unref();
}
