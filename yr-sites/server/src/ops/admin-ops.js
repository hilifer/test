// 后台：销售 → 交付闭环（看板、报价/PI、订单、发货物流、售后、SKU 中心、库存/金蝶、客户）
import { config } from '../config.js';
import { contractForQuote } from './deals.js';
import { shell, esc, fmt } from '../admin.js';
import { DICT, label, nextStates } from '../../../shared/dictionary.js';
import { db } from '../db.js';
import * as S from './service.js';
import { renderPI, money } from './pi.js';
import { erpLabel, erpLog, pushOrder, syncInventory, testConnection, pullMaterials } from './erp/index.js';
import { alertOps } from '../alerts.js';
import { refundOrder, refundsFor } from '../shop/refunds.js';
import { syncTracking, trackingEnabled } from '../shop/tracking.js';

const COLORS = { pending_payment: '#ef8f00', draft: '#90a4ae', sent: '#1565c0', accepted: '#2e7d32', expired: '#8d6e63', cancelled: '#9e9e9e', awaiting_deposit: '#ef8f00', in_production: '#6a1b9a', ready_to_ship: '#00838f', shipped: '#1565c0', delivered: '#2e7d32', completed: '#33691e', booked: '#5c6bc0', in_transit: '#1565c0', arrived: '#00838f', exception: '#c62828', submitted: '#ef8f00', reviewing: '#6a1b9a', approved: '#00838f', in_progress: '#1565c0', resolved: '#2e7d32', rejected: '#9e9e9e' };
const pill = (entity, s) => `<span class="pill" style="background:${COLORS[s] || '#90a4ae'};color:#fff">${esc(label(entity, s))}</span>`;
const d10 = (s) => (s ? String(s).slice(0, 10) : '');
const base = () => config.publicBaseUrl;
const portalLink = (c) => `${base()}/portal/c/${c.portal_token}/`;
const piLink = (q) => `${base()}/portal/pi/${q.token}`;
const opt = (pairs, v) => pairs.map(([k, l]) => `<option value="${esc(k)}"${String(k) === String(v ?? '') ? ' selected' : ''}>${esc(l)}</option>`).join('');
const inp = (label, name, value = '', attrs = '') => `<label class="fl"><span>${label}</span><input name="${name}" value="${esc(value ?? '')}" ${attrs}></label>`;
const CSS = `<style>
.fl{display:grid;gap:4px;font-size:13px;color:#66717d}.fl input,.fl select,.fl textarea,select,input,textarea{font:14px/1.4 inherit;padding:6px 8px;border:1px solid #cfd6dc;border-radius:6px;color:#1d2733;background:#fff}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin:10px 0}.card{background:#fff;border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin-bottom:14px}
.btn{display:inline-block;padding:6px 14px;border-radius:6px;border:1px solid #1d2733;background:#1d2733;color:#fff;font:600 13px/1.4 inherit;cursor:pointer;text-decoration:none}.btn.l{background:#fff;color:#1d2733}.btn.g{background:#2e7d32;border-color:#2e7d32}.btn.r{background:#fff;color:#c62828;border-color:#c62828}
.acts{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:10px 0}.flash{background:#e8f5e9;border:1px solid #a5d6a7;padding:10px 14px;border-radius:8px;margin-bottom:14px}.flash.err{background:#fdecea;border-color:#f5b7b1}
.tl{list-style:none;padding:0;margin:0;border-left:2px solid var(--line)}.tl li{padding:2px 0 8px 14px;position:relative;font-size:13px}.tl li::before{content:'';position:absolute;left:-5px;top:7px;width:8px;height:8px;border-radius:50%;background:#1d2733}
.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}h2{margin:6px 0 12px}h3{margin:18px 0 8px;font-size:15px}code{background:#f0f3f5;padding:1px 5px;border-radius:4px;font-size:12px;word-break:break-all}
.sub{display:flex;gap:6px;flex-wrap:wrap;margin:-6px 0 16px}.sub a{padding:4px 10px;border:1px solid var(--line);border-radius:999px;background:#fff;text-decoration:none;color:#1d2733;font-size:13px}.sub a.on{background:#1d2733;color:#fff}
.kpi{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:18px}.kpi div{background:#fff;border:1px solid var(--line);border-radius:8px;padding:10px 12px}.kpi span{font-size:12px;color:#66717d}.kpi b{display:block;font-size:20px}
</style>`;
const OPSNAV = `<div class="sub">${[['/admin/ops', '闭环看板'], ['/admin/quotes', '报价/PI'], ['/admin/deals', 'AI 议价'], ['/admin/contracts', '合同'], ['/admin/orders', '订单'], ['/admin/shipments', '发货物流'], ['/admin/rma', '售后'], ['/admin/skus', 'SKU 中心'], ['/admin/inventory', '库存 / 金蝶'], ['/admin/customers', '客户']].map(([h, l]) => `<a href="${h}">${l}</a>`).join('')}</div>`;
const view = (title, body, flash = '', err = '') => shell(title, CSS + OPSNAV + (flash ? `<div class="flash">${esc(flash)}</div>` : '') + (err ? `<div class="flash err">${esc(err)}</div>` : '') + body);
const back = (c, path, msg, isErr = false) => c.redirect(`${path}${path.includes('?') ? '&' : '?'}${isErr ? 'e' : 'm'}=${encodeURIComponent(msg)}`);
const timeline = (entity, id) => `<ul class="tl">${S.eventsFor(entity, id).reverse().map((e) => `<li><b>${esc(e.to_state ? label(entity, e.to_state) : e.action)}</b> <span class="mute">${fmt(e.ts)} · ${esc(e.actor)}</span>${e.note ? '<br>' + esc(e.note) : ''}</li>`).join('')}</ul>`;

export { view as opsView, back as opsBack, timeline as opsTimeline, inp as opsInp };

// ---------------------------------------------------------------- dashboard
function dashboard() {
  const st = S.pipelineStats();
  const cur = config.catalog.currency;
  const todo = [
    ['草稿报价待发送', S.listQuotes().filter((q) => q.status === 'draft').map((q) => `<a href="/admin/quotes/${q.id}">${esc(q.number)}</a> ${esc(q.company || q.email)}`)],
    ['待收定金', S.listOrders("WHERE o.status = 'awaiting_deposit'").map((o) => `<a href="/admin/orders/${o.id}">${esc(o.number)}</a> ${esc(o.company)} · 应收定金 ${money(o.currency, o.deposit_due - o.paid)}`)],
    ['待发货', S.listOrders("WHERE o.status = 'ready_to_ship'").map((o) => `<a href="/admin/orders/${o.id}">${esc(o.number)}</a> ${esc(o.company)}`)],
    ['待收尾款', S.listOrders("WHERE o.status IN ('ready_to_ship','shipped','delivered') AND o.paid < o.total - 0.01").map((o) => `<a href="/admin/orders/${o.id}">${esc(o.number)}</a> ${esc(o.company)} · 待收 ${money(o.currency, o.total - o.paid)}`)],
    ['新售后申请', S.listRmas().filter((r) => r.status === 'submitted').map((r) => `<a href="/admin/rma/${r.id}">${esc(r.number)}</a> ${esc(r.company || r.email)} · ${esc(DICT.rma.issues[r.issue]?.zh)}`)],
    ['金蝶同步失败', S.listOrders("WHERE o.erp_error IS NOT NULL AND o.erp_error != ''").map((o) => `<a href="/admin/orders/${o.id}">${esc(o.number)}</a> ${esc(o.erp_error.slice(0, 80))}`)],
    ['物流异常', S.listShipments().filter((s) => s.status === 'exception').map((s) => `<a href="/admin/shipments/${s.id}">${esc(s.number)}</a>`)],
  ];
  const by = Object.fromEntries(st.byStatus.map((x) => [x.status, x.n]));
  return view('闭环看板', `<h2>销售 → 交付闭环</h2>
<div class="kpi"><div><span>近 30 天线索</span><b>${st.leads30}</b></div><div><span>近 30 天发出 PI</span><b>${st.quotesSent30}</b></div><div><span>近 30 天客户确认</span><b>${st.accepted30}</b></div>
<div><span>在途订单</span><b>${st.ordersOpen.n}</b><span>${money(cur, st.ordersOpen.v)}</span></div><div><span>应收款</span><b>${money(cur, st.receivable)}</b></div><div><span>运输中</span><b>${st.inTransit}</b></div><div><span>未结售后</span><b>${st.rmaOpen}</b></div></div>
<div class="card"><b>订单状态分布</b><div class="acts">${DICT.order.timeline.concat('cancelled').map((s) => `${pill('order', s)} <b>${by[s] || 0}</b>`).join('&nbsp;&nbsp;')}</div></div>
<div class="grid2">${todo.map(([t, items]) => `<div class="card"><b>${t}</b> <span class="mute">${items.length}</span><ul style="margin:8px 0 0;padding-left:18px">${items.slice(0, 8).map((i) => `<li>${i}</li>`).join('') || '<li class="mute" style="list-style:none;margin-left:-18px">无</li>'}</ul></div>`).join('')}</div>
<p class="mute">ERP：${esc(erpLabel())}</p>`);
}

// ---------------------------------------------------------------- quotes
function quotesList(f, e) {
  const rows = S.listQuotes().map((q) => `<tr><td><a href="/admin/quotes/${q.id}"><b>${esc(q.number)}</b></a></td><td>${d10(q.created_at)}</td><td>${esc(q.company || '')}<div class="mute">${esc(q.email || '')}</div></td><td>${pill('quote', S.quoteExpired(q) ? 'expired' : q.status)}</td><td class="n">${money(q.currency, q.total)}</td><td>${q.lines.length} 项</td></tr>`).join('');
  return view('报价/PI', `<h2>报价 / PI</h2><div class="card"><form method="post" action="/admin/quotes/new" class="acts">${inp('客户邮箱', 'email', '', 'type="email" required')}${inp('公司', 'company')}${inp('联系人', 'contact')}${inp('国家', 'country')}<button class="btn">新建报价</button></form><p class="mute" style="margin:0">也可以在「线索」页点「生成报价」，自动带入客户和产品。</p></div>
<div class="wrap"><table><thead><tr><th>编号</th><th>日期</th><th>客户</th><th>状态</th><th class="n">金额</th><th>明细</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="mute">暂无报价</td></tr>'}</tbody></table></div>`, f, e);
}

function quoteEdit(id, f, e) {
  const q = S.getQuote(id);
  if (!q) return view('未找到', '<p>报价不存在</p>');
  const c = S.getCustomer(q.customer_id);
  const editable = ['draft', 'sent', 'expired'].includes(q.status);
  const skus = S.listSkus().filter((s) => s.active);
  const skuOpts = (v) => `<option value="">— 选择 SKU —</option>` + skus.map((s) => `<option value="${esc(s.sku)}"${s.sku === v ? ' selected' : ''}>${esc(s.sku)} · ${esc(s.name)} ${esc(s.variant || '')}${s.ref_price ? ` (参考 ${s.ref_price})` : ''}</option>`).join('');
  const rows = [...q.lines, {}, {}, {}].map((l, i) => `<tr><td><select name="sku_${i}" ${editable ? '' : 'disabled'}>${skuOpts(l.sku)}</select></td><td><input name="variant_${i}" value="${esc(l.variant || '')}" placeholder="规格（如 150W 5000K）" ${editable ? '' : 'disabled'}></td><td><input name="qty_${i}" value="${esc(l.qty || '')}" size="6" ${editable ? '' : 'disabled'}></td><td><input name="price_${i}" value="${esc(l.unit_price ?? '')}" size="8" placeholder="留空=参考价" ${editable ? '' : 'disabled'}></td><td class="n">${l.amount != null ? money(q.currency, l.amount) : ''}</td></tr>`).join('');
  const terms = DICT.paymentTerms.map((t) => [t.id, t.zh]);
  return view(q.number, `<p><a href="/admin/quotes">← 报价列表</a></p><h2>${esc(q.number)} ${pill('quote', S.quoteExpired(q) ? 'expired' : q.status)}</h2>
<div class="card">客户：<a href="/admin/customers/${c.id}"><b>${esc(c.company || c.contact)}</b></a> ${esc(c.email)} ${esc(c.country)}</div>
<form method="post" action="/admin/quotes/${q.id}/save" class="card"><table><thead><tr><th>SKU</th><th>规格说明</th><th>数量</th><th>单价 (${esc(q.currency)})</th><th class="n">金额</th></tr></thead><tbody>${rows}</tbody></table>
<div class="grid2">${`<label class="fl"><span>币种</span><select name="currency" ${editable ? '' : 'disabled'}>${opt([['USD', 'USD'], ['CNY', 'CNY'], ['EUR', 'EUR']], q.currency)}</select></label>`}<label class="fl"><span>价格条款</span><select name="incoterm" ${editable ? '' : 'disabled'}>${opt(DICT.incoterms.map((x) => [x, x]), q.incoterm)}</select></label>${inp('港口/目的地', 'port', q.port, editable ? '' : 'disabled')}<label class="fl"><span>付款方式</span><select name="payment_terms" ${editable ? '' : 'disabled'}>${opt(terms, q.payment_terms)}</select></label>${inp('有效期（天）', 'validity_days', q.validity_days, editable ? '' : 'disabled')}${inp('运费', 'freight', q.freight, editable ? '' : 'disabled')}${inp('折扣', 'discount', q.discount, editable ? '' : 'disabled')}</div>
<label class="fl"><span>备注（显示在 PI 上）</span><textarea name="notes" rows="3" ${editable ? '' : 'disabled'}>${esc(q.notes || '')}</textarea></label>
<p><b>合计：${money(q.currency, q.total)}</b> <span class="mute">（小计 ${money(q.currency, q.subtotal)} + 运费 ${q.freight} − 折扣 ${q.discount}）</span></p>
${editable ? '<div class="acts"><button class="btn l" name="action" value="save">保存</button><button class="btn" name="action" value="send">保存并发送给客户</button></div>' : ''}</form>
<div class="acts"><a class="btn l" href="/admin/quotes/${q.id}/print" target="_blank">打印 / 导出 PDF</a>${q.status !== 'draft' && q.status !== 'cancelled' ? `<span>客户确认链接：<code>${esc(piLink(q))}</code></span>` : ''}${['draft', 'sent'].includes(q.status) ? `<form method="post" action="/admin/quotes/${q.id}/status"><input type="hidden" name="to" value="cancelled"><button class="btn r">作废</button></form>` : ''}${q.status === 'accepted' ? (() => { const o = S.getOrderByQuote(q.id); return o ? `<a class="btn g" href="/admin/orders/${o.id}">查看订单 ${esc(o.number)}</a>` : ''; })() : ''}</div>
${contractBox(q)}${q.status === 'sent' ? `<div class="card"><b>发给客户的邮件模板（复制使用）</b><pre style="white-space:pre-wrap;margin:8px 0 0;font:13px/1.6 inherit">${esc(emailTemplate(q, c))}</pre></div>` : ''}
<h3>记录</h3>${timeline('quote', q.id)}`, f, e);
}

function contractBox(q) {
  const k = contractForQuote(q.id);
  if (k) return `<div class="card"><b>销售合同</b> <a href="/admin/contracts/${k.id}">${esc(k.number)}</a> · ${k.status === 'signed' ? `客户已签署（${esc(k.signer_name)}，${fmt(k.signed_at)}）` : '已发送，待客户签署'}</div>`;
  if (!['draft', 'sent'].includes(q.status) || !q.lines.length) return '';
  return `<form method="post" action="/admin/quotes/${q.id}/contract" class="card"><b>销售合同</b> <span class="mute">按合同模板生成，邮件发给客户在线签署；签署后自动生成订单。</span> <button class="btn">生成合同并发给客户签署</button></form>`;
}

function emailTemplate(q, c) {
  if (c.lang === 'zh') return `主题：形式发票 ${q.number} — ${config.profile.brand}\n\n${c.contact || c.company} 您好，\n\n感谢询价。形式发票 ${q.number} 已准备好，合计 ${money(q.currency, q.total)}（${q.incoterm} ${q.port}），有效期 ${q.validity_days} 天。\n\n在线查看并确认下单：${piLink(q)}\n\n确认后订单号会立即生成，之后可随时在客户中心查看生产与物流进度：${portalLink(c)}\n\n如有任何问题请直接回复本邮件。`;
  return `Subject: Proforma Invoice ${q.number} — ${config.profile.brand}\n\nHi ${c.contact || c.company},\n\nThank you for your inquiry. Proforma Invoice ${q.number} is ready: total ${money(q.currency, q.total)} (${q.incoterm} ${q.port}), valid for ${q.validity_days} days.\n\nView and accept it online: ${piLink(q)}\n\nOnce you accept, your order number is created right away, and you can follow production and shipping any time in your customer portal: ${portalLink(c)}\n\nJust reply to this email with any questions.`;
}

// ---------------------------------------------------------------- orders
function ordersList(status, f, e) {
  const list = status ? S.listOrders('WHERE o.status = ?', status) : S.listOrders();
  const rows = list.map((o) => `<tr><td><a href="/admin/orders/${o.id}"><b>${esc(o.number)}</b></a>${o.channel === 'shop' ? ' <span class="pill">网店</span>' : ''}</td><td>${d10(o.created_at)}</td><td>${esc(o.company || '')}<div class="mute">${esc(o.country || '')}</div></td><td>${pill('order', o.status)}</td><td class="n">${money(o.currency, o.total)}</td><td class="n">${money(o.currency, o.paid)}</td><td>${o.erp_bill_no ? `<span title="金蝶单号">${esc(o.erp_bill_no)}</span>` : o.erp_error ? '<span style="color:#c62828">同步失败</span>' : '<span class="mute">—</span>'}</td></tr>`).join('');
  return view('订单', `<h2>订单</h2><div class="sub"><a href="/admin/orders" class="${status ? '' : 'on'}">全部</a>${Object.keys(DICT.order.states).map((s) => `<a href="/admin/orders?status=${s}" class="${status === s ? 'on' : ''}">${esc(label('order', s))}</a>`).join('')}</div>
<div class="wrap"><table><thead><tr><th>订单号</th><th>日期</th><th>客户</th><th>状态</th><th class="n">金额</th><th class="n">已收</th><th>金蝶</th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="mute">暂无订单。客户在门户确认 PI 后自动生成。</td></tr>'}</tbody></table></div>`, f, e);
}

function orderView(id, f, e) {
  const o = S.getOrder(id);
  if (!o) return view('未找到', '<p>订单不存在</p>');
  const c = S.getCustomer(o.customer_id);
  const q = S.getQuote(o.quote_id);
  const pays = S.paymentsFor(o.id);
  const ships = S.shipmentsFor(o.id);
  const stock = new Map(S.stockView().map((s) => [s.sku, s]));
  const nx = nextStates('order', o.status).filter((s) => s !== 'shipped');
  return view(o.number, `<p><a href="/admin/orders">← 订单列表</a></p><h2>${esc(o.number)} ${pill('order', o.status)}</h2>
<div class="grid2"><div class="card"><b>客户</b><br><a href="/admin/customers/${c.id}">${esc(c.company || c.contact)}</a><br>${esc(c.email)} ${esc(c.whatsapp || c.phone)}<br><span class="mute">客户中心：</span><code>${esc(portalLink(c))}</code></div>
<div class="card"><b>金额</b><br>合计 ${money(o.currency, o.total)}<br>应收定金 ${money(o.currency, o.deposit_due)}<br>已收 ${money(o.currency, o.paid)} · 待收 <b>${money(o.currency, o.total - o.paid)}</b></div>
${o.channel === 'shop' ? (() => { const a = JSON.parse(o.shipping_address || '{}'); return `<div class="card"><b>网店订单</b><br>付款方式：${esc({ stripe: 'Stripe 在线支付', paypal: 'PayPal', tt: '银行电汇' }[o.payment_method] || o.payment_method)}<br>配送：${esc(o.shipping_method || '')}（运费 ${money(o.currency, o.shipping_fee || 0)}）<br>${o.status === 'pending_payment' ? `付款截止：${fmt(o.expires_at)}` : ''}<br><b>收货地址</b><br>${esc(a.name)}${a.company ? ' / ' + esc(a.company) : ''} · ${esc(a.phone)}<br>${esc(a.line1)} ${esc(a.line2 || '')}<br>${esc(a.city)} ${esc(a.state || '')} ${esc(a.postcode || '')} ${esc(a.country)}${o.customer_note ? `<br><span class="mute">备注：${esc(o.customer_note)}</span>` : ''}</div>`; })() : `<div class="card"><b>条款</b><br>${esc(o.incoterm)} ${esc(o.port)}<br>${esc(DICT.paymentTerms.find((t) => t.id === o.payment_terms)?.zh || o.payment_terms)}<br>来源 PI：${q ? `<a href="/admin/quotes/${q.id}">${esc(q.number)}</a>` : '—'}</div>`}
<div class="card"><b>金蝶</b> <span class="mute">${esc(erpLabel())}</span><br>${o.erp_bill_no ? `销售订单号 <b>${esc(o.erp_bill_no)}</b><br><span class="mute">${fmt(o.erp_synced_at)}</span>` : o.erp_error ? `<span style="color:#c62828">${esc(o.erp_error)}</span>` : '<span class="mute">未同步</span>'}${!o.erp_bill_no && config.erp.mode !== 'local' ? `<form method="post" action="/admin/orders/${o.id}/erp"><button class="btn l" style="margin-top:6px">推送到金蝶</button></form>` : ''}</div></div>
<div class="card"><b>明细</b><table><thead><tr><th>SKU</th><th>产品</th><th class="n">数量</th><th class="n">单价</th><th class="n">金额</th><th class="n">可用库存</th></tr></thead><tbody>${o.lines.map((l) => { const s = stock.get(l.sku); return `<tr><td>${esc(l.sku)}</td><td>${esc(l.name)} <span class="mute">${esc(l.variant || '')}</span></td><td class="n">${l.qty}</td><td class="n">${money(o.currency, l.unit_price)}</td><td class="n">${money(o.currency, l.amount)}</td><td class="n">${s ? `${s.on_hand}<span class="mute"> / 占用 ${s.reserved}</span>` : '—'}</td></tr>`; }).join('')}</tbody></table></div>
${o.paid > 0.01 || refundsFor(o.id).length ? `<div class="card"><b>退款</b>（原路退回：${(() => { const i = S.getOrder(o.id) && (o.payment_method || 'manual'); return esc({ stripe: 'Stripe', paypal: 'PayPal', tt: '线下电汇', manual: '线下' }[i] || i); })()}）${refundsFor(o.id).map((r) => `<div class="mute">${fmt(r.created_at)} · ${esc(r.actor)} · ${esc(r.provider)} ${money(r.currency, r.amount)} · ${esc(r.status)}${r.error ? ' · ' + esc(r.error) : ''}${r.reason ? ' · ' + esc(r.reason) : ''}</div>`).join('')}
${o.paid > 0.01 ? `<form method="post" action="/admin/orders/${o.id}/refund" class="grid2" onsubmit="return confirm('确认退款？退款会立即发起，无法撤回。')">${inp('退款金额', 'amount', '', `inputmode="decimal" placeholder="最多 ${o.paid}"`)}${inp('原因', 'reason')}<label class="fl"><span>售后单（可选）</span><select name="rma_id"><option value="">—</option>${S.listRmas().filter((r) => r.order_id === o.id && ['approved', 'in_progress'].includes(r.status)).map((r) => `<option value="${r.id}">${esc(r.number)}</option>`).join('')}</select></label><button class="btn r" style="align-self:end">发起退款</button></form>` : ''}</div>` : ''}
${S.balanceDueBeforeShipment(o) ? `<div class="flash err">按付款条款（${esc(DICT.paymentTerms.find((t) => t.id === o.payment_terms)?.zh)}），发货前应收清尾款：当前待收 <b>${money(o.currency, o.total - o.paid)}</b>。</div>` : ''}
<div class="acts"><b>推进状态：</b>${nx.map((s) => `<form method="post" action="/admin/orders/${o.id}/status"><input type="hidden" name="to" value="${s}"><button class="btn ${s === 'cancelled' ? 'r' : ''}">→ ${esc(label('order', s))}</button></form>`).join('') || '<span class="mute">无可用操作</span>'}<span class="mute">「已发货/已签收」由物流状态自动推进</span></div>
<div class="grid2"><div class="card"><b>收款</b><table><tbody>${pays.map((p) => `<tr><td>${d10(p.ts)}</td><td>${esc(label('payment', p.kind))}</td><td class="n">${money(p.currency, p.amount)}</td><td class="mute">${esc(p.ref)}</td></tr>`).join('') || '<tr><td class="mute">暂无</td></tr>'}</tbody></table>
<form method="post" action="/admin/orders/${o.id}/payment" class="acts"><select name="kind">${opt(Object.entries(DICT.payment.kinds).map(([k, v]) => [k, v.zh]), o.paid ? 'balance' : 'deposit')}</select><input name="amount" placeholder="金额" size="9" required><input name="ref" placeholder="水单号/备注" size="12"><button class="btn">登记收款</button></form><p class="mute" style="margin:0">定金到账后订单自动进入「生产/备货中」。</p></div>
<div class="card"><b>发货</b>${ships.map((s) => `<div style="margin:6px 0"><a href="/admin/shipments/${s.id}"><b>${esc(s.number)}</b></a> ${pill('shipment', s.status)} ${esc(DICT.shipment.modes[s.mode]?.zh || s.mode)} ${esc(s.carrier)} ${esc(s.tracking_no)}${s.rma_id ? ' <span class="pill">售后补发</span>' : ''}</div>`).join('') || '<p class="mute">暂无</p>'}
${['ready_to_ship', 'shipped'].includes(o.status) && S.shippedQty(o).some((l) => l.remaining > 0) ? `<form method="post" action="/admin/orders/${o.id}/ship" class="grid2"><table style="grid-column:1/-1"><thead><tr><th>SKU</th><th class="n">订购</th><th class="n">已发</th><th class="n">本次发货</th></tr></thead><tbody>${S.shippedQty(o).map((l, i) => `<tr><td>${esc(l.sku)} <span class="mute">${esc(l.variant || '')}</span></td><td class="n">${l.qty}</td><td class="n">${l.shipped}</td><td class="n"><input type="hidden" name="sku_${i}" value="${esc(l.sku)}"><input name="qty_${i}" type="number" min="0" max="${l.remaining}" value="${l.remaining}" style="width:90px"></td></tr>`).join('')}</tbody></table><label class="fl"><span>运输方式</span><select name="mode">${opt(Object.entries(DICT.shipment.modes).map(([k, v]) => [k, v.zh]), 'sea')}</select></label>${inp('承运人/船司/快递', 'carrier')}${inp('运单号/订舱号', 'tracking_no')}${inp('柜号', 'container_no')}${inp('提单号', 'bl_no')}${inp('ETD', 'etd', '', 'type="date"')}${inp('ETA', 'eta', '', 'type="date"')}<button class="btn" style="align-self:end">创建发货单</button></form>` : ['ready_to_ship', 'shipped'].includes(o.status) ? '<p class="mute">货物已全部发出。</p>' : '<p class="mute">订单进入「待发货」后可创建发货单。</p>'}</div></div>
<h3>记录</h3>${timeline('order', o.id)}`, f, e);
}

// ---------------------------------------------------------------- shipments
function shipmentsList(f, e) {
  const rows = S.listShipments().map((s) => { const o = S.getOrder(s.order_id); return `<tr><td><a href="/admin/shipments/${s.id}"><b>${esc(s.number)}</b></a>${s.rma_id ? ' <span class="pill">售后</span>' : ''}</td><td><a href="/admin/orders/${o.id}">${esc(o.number)}</a></td><td>${pill('shipment', s.status)}</td><td>${esc(DICT.shipment.modes[s.mode]?.zh || s.mode)} ${esc(s.carrier)}</td><td>${esc(s.tracking_no)} ${esc(s.container_no)}</td><td>${esc(s.etd)}</td><td>${esc(s.eta)}</td><td class="mute">${esc(s.events.at(-1)?.location || '')} ${d10(s.events.at(-1)?.ts)}</td></tr>`; }).join('');
  return view('发货物流', `<h2>发货与物流</h2><div class="wrap"><table><thead><tr><th>发货单</th><th>订单</th><th>状态</th><th>方式/承运人</th><th>运单/柜号</th><th>ETD</th><th>ETA</th><th>最新动态</th></tr></thead><tbody>${rows || '<tr><td colspan="8" class="mute">暂无发货单</td></tr>'}</tbody></table></div>`, f, e);
}

function shipmentView(id, f, e) {
  const s = S.getShipment(id);
  if (!s) return view('未找到', '<p>发货单不存在</p>');
  const o = S.getOrder(s.order_id);
  const p = s.packing || {};
  const nx = [s.status, ...nextStates('shipment', s.status)];
  return view(s.number, `<p><a href="/admin/shipments">← 发货列表</a></p><h2>${esc(s.number)} ${pill('shipment', s.status)} ${s.rma_id ? '<span class="pill">售后补发</span>' : ''}</h2>
<p>订单 <a href="/admin/orders/${o.id}">${esc(o.number)}</a></p>
<form method="post" action="/admin/shipments/${s.id}/save" class="card"><div class="grid2"><label class="fl"><span>运输方式</span><select name="mode">${opt(Object.entries(DICT.shipment.modes).map(([k, v]) => [k, v.zh]), s.mode)}</select></label>${inp('承运人', 'carrier', s.carrier)}${inp('运单号', 'tracking_no', s.tracking_no)}${inp('柜号', 'container_no', s.container_no)}${inp('提单号', 'bl_no', s.bl_no)}${inp('ETD', 'etd', s.etd, 'type="date"')}${inp('ETA', 'eta', s.eta, 'type="date"')}</div><button class="btn l">保存</button></form>
<div class="grid2"><div class="card"><b>装箱汇总</b>（按 SKU 中心的装箱数据计算）<br>${p.cartons || 0} 箱 · ${p.cbm || 0} m³ · 毛重 ${p.gw_kg || 0} kg${p.missing_packing_data?.length ? `<br><span style="color:#c62828">缺少装箱数据：${esc(p.missing_packing_data.join(', '))}</span>（到 SKU 中心补充）` : ''}<table style="margin-top:8px"><tbody>${s.lines.map((l) => `<tr><td>${esc(l.sku)}</td><td>${esc(l.name)}</td><td class="n">${l.qty}</td></tr>`).join('')}</tbody></table></div>
<div class="card"><b>更新物流动态</b><form method="post" action="/admin/shipments/${s.id}/event" class="grid2"><label class="fl"><span>状态</span><select name="status">${opt(nx.map((x) => [x, label('shipment', x)]), s.status)}</select></label>${inp('地点', 'location', '', 'placeholder="如 Yantian / Los Angeles"')}${inp('说明', 'note', '', 'placeholder="如 已开船、清关中"')}<button class="btn" style="align-self:end">添加动态</button></form><p class="mute">状态改为「运输中」时订单自动变为已发货，「已签收」时订单自动变为已签收；客户在客户中心实时可见。</p></div></div>
<div class="card"><b>自动轨迹（17TRACK）</b> ${trackingEnabled() ? `${s.tracking_no ? `状态：${esc(s.track_status || '未查询')} ${s.track_checked_at ? `<span class="mute">${fmt(s.track_checked_at)}</span>` : ''}${s.track_error ? `<br><span style="color:#c62828">${esc(s.track_error)}</span>` : ''}<form method="post" action="/admin/shipments/${s.id}/track" style="margin-top:6px"><button class="btn l">立即刷新轨迹</button></form>` : '<span class="mute">填写运单号后自动跟踪</span>'}` : '<span class="mute">未配置 TRACK17_KEY，物流状态需手动更新</span>'}</div>
<h3>物流动态</h3><ul class="tl">${[...s.events].reverse().map((ev) => `<li><b>${esc(label('shipment', ev.status))}</b> <span class="mute">${fmt(ev.ts)}</span> ${esc(ev.location)}${ev.note ? '<br>' + esc(ev.note) : ''}</li>`).join('')}</ul>`, f, e);
}

// ---------------------------------------------------------------- RMA
function rmaList(f, e) {
  const rows = S.listRmas().map((r) => `<tr><td><a href="/admin/rma/${r.id}"><b>${esc(r.number)}</b></a></td><td>${d10(r.created_at)}</td><td>${esc(r.company || r.email || '')}</td><td>${esc(r.order_number)}</td><td>${esc(DICT.rma.issues[r.issue]?.zh || r.issue)}</td><td>${esc(r.sku)} ×${r.qty}</td><td>${pill('rma', r.status)}</td><td class="mute">${esc({ portal: '客户中心', chat: 'AI 客服', admin: '后台' }[r.source] || r.source)}</td></tr>`).join('');
  return view('售后', `<h2>售后（RMA）</h2><div class="wrap"><table><thead><tr><th>单号</th><th>日期</th><th>客户</th><th>订单</th><th>问题</th><th>产品</th><th>状态</th><th>来源</th></tr></thead><tbody>${rows || '<tr><td colspan="8" class="mute">暂无售后申请</td></tr>'}</tbody></table></div>`, f, e);
}

function rmaView(id, f, e) {
  const r = S.getRma(id);
  if (!r) return view('未找到', '<p>售后单不存在</p>');
  const o = S.getOrder(r.order_id);
  const c = S.getCustomer(r.customer_id);
  const nx = nextStates('rma', r.status);
  const replShip = S.shipmentsFor(o.id).find((s) => s.rma_id === r.id);
  return view(r.number, `<p><a href="/admin/rma">← 售后列表</a></p><h2>${esc(r.number)} ${pill('rma', r.status)}</h2>
<div class="grid2"><div class="card"><b>客户</b><br>${esc(c.company || c.contact)}<br>${esc(c.email)} ${esc(c.whatsapp || c.phone)}</div><div class="card"><b>订单</b><br><a href="/admin/orders/${o.id}">${esc(o.number)}</a> ${pill('order', o.status)}</div>
<div class="card"><b>问题</b><br>${esc(DICT.rma.issues[r.issue]?.zh)} · ${esc(r.sku)} × ${r.qty}<br><span class="mute">来源：${esc(r.source)}</span></div></div>
<div class="card"><b>客户描述</b><p style="white-space:pre-wrap">${esc(r.description)}</p>${r.photos.length ? `<b>照片</b><br>${r.photos.map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>`).join('<br>')}` : ''}</div>
${nx.length ? `<form method="post" action="/admin/rma/${r.id}/status" class="card"><b>处理</b><div class="grid2"><label class="fl"><span>改为</span><select name="to">${opt(nx.map((x) => [x, label('rma', x)]))}</select></label><label class="fl"><span>处理方式</span><select name="resolution"><option value="">—</option>${opt(Object.entries(DICT.rma.resolutions).map(([k, v]) => [k, v.zh]), r.resolution)}</select></label>${inp('给客户的说明（客户中心可见）', 'note', r.resolution_note || '')}</div><button class="btn">保存</button></form>` : ''}
${['approved', 'in_progress'].includes(r.status) && r.resolution === 'replace' && !replShip ? `<form method="post" action="/admin/rma/${r.id}/ship"><button class="btn g">创建补发发货单</button></form>` : ''}${replShip ? `<p>补发单：<a href="/admin/shipments/${replShip.id}">${esc(replShip.number)}</a> ${pill('shipment', replShip.status)}</p>` : ''}
<h3>记录</h3>${timeline('rma', r.id)}`, f, e);
}

// ---------------------------------------------------------------- SKU centre
function skuList(f, e) {
  const rows = S.listSkus().map((s) => `<tr><td><a href="/admin/skus/edit?sku=${encodeURIComponent(s.sku)}"><b>${esc(s.sku)}</b></a></td><td>${esc(s.name)} <span class="mute">${esc(s.variant)}</span></td><td>${esc(s.unit)}</td><td class="n">${s.ref_price ?? '—'}</td><td class="n">${s.pcs_per_carton ? `${s.pcs_per_carton}/箱 · ${s.carton_cbm || '?'}m³ · ${s.carton_gw || '?'}kg` : '<span style="color:#c62828">未填</span>'}</td><td>${esc(s.hs_code)}</td><td>${s.erp_number ? esc(s.erp_number) : '<span class="mute">同 SKU</span>'}</td><td>${s.active ? '' : '<span class="mute">停用</span>'}</td></tr>`).join('');
  return view('SKU 中心', `<h2>SKU 中心</h2><p class="mute">一个 SKU 贯穿报价、订单、库存、发货和售后。「金蝶物料编码」用于和金蝶对应，留空表示与 SKU 编码相同。参考单价只是报价时的默认值，不对外显示。</p>
<p><a class="btn" href="/admin/skus/edit">新增 SKU / 规格变体</a></p><div class="wrap"><table><thead><tr><th>SKU</th><th>名称 / 规格</th><th>单位</th><th class="n">参考单价</th><th class="n">装箱</th><th>HS 编码</th><th>金蝶物料编码</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`, f, e);
}
function skuEdit(sku, f, e) {
  const s = sku ? S.getSku(sku) : { unit: 'pcs', active: 1 };
  if (!s) return view('未找到', '<p>SKU 不存在</p>');
  const prods = config.catalog.products.map((p) => [p.id, `${p.id} · ${p.name}`]);
  return view('SKU', `<p><a href="/admin/skus">← SKU 中心</a></p><h2>${sku ? esc(sku) : '新增 SKU'}</h2><form method="post" action="/admin/skus/save" class="card"><div class="grid2">
${inp('SKU 编码', 'sku', s.sku, sku ? 'readonly' : 'required placeholder="如 YR-HB-U2-150-50K"')}<label class="fl"><span>所属产品</span><select name="product_id">${opt([['', '—'], ...prods], s.product_id)}</select></label>${inp('名称', 'name', s.name)}${inp('规格（变体）', 'variant', s.variant, 'placeholder="150W 5000K 90°"')}${inp('单位', 'unit', s.unit)}${inp('参考单价', 'ref_price', s.ref_price)}
${inp('每箱数量', 'pcs_per_carton', s.pcs_per_carton)}${inp('每箱体积 m³', 'carton_cbm', s.carton_cbm)}${inp('每箱毛重 kg', 'carton_gw', s.carton_gw)}${inp('HS 编码', 'hs_code', s.hs_code)}${inp('金蝶物料编码', 'erp_number', s.erp_number)}${config.erp.mode === 'local' ? inp('本地库存', 'stock_local', s.stock_local) : ''}
<label class="fl"><span>状态</span><select name="active">${opt([['1', '启用'], ['0', '停用']], s.active ? '1' : '0')}</select></label></div><button class="btn">保存</button></form>`, f, e);
}

// ---------------------------------------------------------------- inventory / ERP
async function inventoryPage(f, e, materials = null) {
  const rows = S.stockView().map((s) => `<tr><td>${esc(s.sku)}</td><td>${esc(s.name)} <span class="mute">${esc(s.variant)}</span></td><td>${esc(s.erp_number || s.sku)}</td><td class="n">${s.on_hand}</td><td class="n">${s.reserved}</td><td class="n" style="${s.available < 0 ? 'color:#c62828;font-weight:700' : ''}">${s.available}</td><td class="mute">${fmt(s.synced_at)}</td></tr>`).join('');
  const logs = erpLog(15).map((l) => `<tr><td>${fmt(l.ts)}</td><td>${esc(l.action)}</td><td>${l.ok ? '成功' : '<span style="color:#c62828">失败</span>'}</td><td class="mute">${esc(l.detail)}</td></tr>`).join('');
  const skus = new Set(S.listSkus().map((s) => s.erp_number || s.sku));
  return view('库存 / 金蝶', `<h2>库存与金蝶</h2><div class="card">ERP 模式：<b>${esc(erpLabel())}</b> ${config.erp.mode !== 'local' ? `· 每 ${config.erp.syncMinutes} 分钟同步即时库存 · 订单自动推送：${config.erp.autoPushOrders ? '开' : '关'}` : '· 在 SKU 中心直接维护库存；设置 ERP_MODE=kingdee 接入金蝶'}
${config.erp.mode !== 'local' ? `<div class="acts"><form method="post" action="/admin/inventory/test"><button class="btn l">测试连接</button></form><form method="post" action="/admin/inventory/sync"><button class="btn">立即同步库存</button></form><form method="post" action="/admin/inventory/materials"><button class="btn l">拉取金蝶物料，核对编码</button></form></div>` : ''}</div>
${materials ? `<div class="card"><b>金蝶物料（${materials.length}）</b> — 标绿的已与 SKU 对应；未对应的物料，在 SKU 中心填写「金蝶物料编码」即可。<table><tbody>${materials.slice(0, 300).map((m) => `<tr style="${skus.has(m.number) ? 'background:#e8f5e9' : ''}"><td>${esc(m.number)}</td><td>${esc(m.name)}</td><td class="mute">${esc(m.spec)}</td></tr>`).join('')}</tbody></table></div>` : ''}
<div class="wrap"><table><thead><tr><th>SKU</th><th>名称</th><th>物料编码</th><th class="n">在库</th><th class="n">订单占用</th><th class="n">可承诺</th><th>同步时间</th></tr></thead><tbody>${rows}</tbody></table></div>
<p class="mute">订单占用 = 待付定金、生产/备货中、待发货订单的数量合计。可承诺为负数表示需要排产或采购。</p>
<h3>同步记录</h3><div class="wrap"><table><tbody>${logs || '<tr><td class="mute">暂无</td></tr>'}</tbody></table></div>`, f, e);
}

// ---------------------------------------------------------------- customers
function customersList(f, e) {
  const rows = S.listCustomers().map((c) => `<tr><td><a href="/admin/customers/${c.id}"><b>${esc(c.company || c.contact || c.email)}</b></a></td><td>${esc(c.email)}</td><td>${esc(c.country)}</td><td class="n">${c.orders}</td><td class="n">${money(config.catalog.currency, c.revenue)}</td><td>${esc(c.erp_number || '')}</td><td>${d10(c.created_at)}</td></tr>`).join('');
  return view('客户', `<h2>客户</h2><div class="wrap"><table><thead><tr><th>客户</th><th>邮箱</th><th>国家</th><th class="n">订单</th><th class="n">成交额</th><th>金蝶客户编码</th><th>创建</th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="mute">暂无客户。从线索生成报价时自动建档。</td></tr>'}</tbody></table></div>`, f, e);
}
function customerView(id, f, e) {
  const c = S.getCustomer(id);
  if (!c) return view('未找到', '<p>客户不存在</p>');
  const orders = S.ordersForCustomer(id);
  return view(c.company || c.email, `<p><a href="/admin/customers">← 客户列表</a></p><h2>${esc(c.company || c.contact)}</h2><p>客户中心链接（可发给客户）：<code>${esc(portalLink(c))}</code></p>
<form method="post" action="/admin/customers/${c.id}/save" class="card"><div class="grid2">${inp('公司', 'company', c.company)}${inp('联系人', 'contact', c.contact)}${inp('邮箱', 'email', c.email, 'type="email"')}${inp('电话', 'phone', c.phone)}${inp('WhatsApp', 'whatsapp', c.whatsapp)}${inp('国家', 'country', c.country)}${inp('地址', 'address', c.address)}${inp('金蝶客户编码', 'erp_number', c.erp_number)}<label class="fl"><span>文档语言</span><select name="lang">${opt([['en', 'English'], ['zh', '中文']], c.lang)}</select></label></div><button class="btn l">保存</button></form>
<h3>订单</h3><table><tbody>${orders.map((o) => `<tr><td><a href="/admin/orders/${o.id}">${esc(o.number)}</a></td><td>${d10(o.created_at)}</td><td>${pill('order', o.status)}</td><td class="n">${money(o.currency, o.total)}</td></tr>`).join('') || '<tr><td class="mute">暂无</td></tr>'}</tbody></table>`, f, e);
}

// ---------------------------------------------------------------- routes
export function mountOpsAdmin(app) {
  const q = (c) => [c.req.query('m') || '', c.req.query('e') || ''];
  const guard = (fn, onErr) => async (c) => { try { return await fn(c); } catch (err) { return back(c, onErr(c), err.message, true); } };

  app.get('/admin/ops', (c) => c.html(dashboard()));

  app.get('/admin/quotes', (c) => c.html(quotesList(...q(c))));
  app.get('/admin/quotes/new', guard((c) => {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(c.req.query('lead') || '');
    if (!lead) throw new Error('线索不存在');
    let extra = {};
    try { extra = JSON.parse(lead.extra || '{}'); } catch {}
    let lines = [];
    if (Array.isArray(extra.lines) && extra.lines.length) {
      // multi-product quote list from the website
      lines = extra.lines.map((l) => { const s = S.getSku(String(l.sku)); return s ? { sku: s.sku, qty: Number(l.qty) || 1, unit_price: s.ref_price, variant: String(l.note || '').slice(0, 120) } : null; }).filter(Boolean);
    } else {
      const p = config.catalog.products.find((x) => x.id === lead.product_id);
      const s = p && S.getSku(p.id);
      if (s) lines = [{ sku: s.sku, qty: Number(lead.quantity) || p.moq, unit_price: s.ref_price }];
    }
    const qt = S.createQuote({ customer: { email: lead.email, company: lead.company, contact: lead.name, country: lead.country, phone: lead.phone, whatsapp: lead.whatsapp }, lead_id: lead.id, lines, notes: lead.needs ? `客户需求：${lead.needs}`.slice(0, 500) : '' });
    db.prepare("UPDATE leads SET status = 'quoted' WHERE id = ?").run(lead.id);
    return back(c, `/admin/quotes/${qt.id}`, `已从线索生成报价 ${qt.number}（${lines.length} 个产品），请核对价格和条款`);
  }, () => '/admin'));
  app.post('/admin/quotes/new', guard(async (c) => {
    const f = await c.req.parseBody();
    if (!f.email) throw new Error('请填写客户邮箱');
    const qt = S.createQuote({ customer: { email: String(f.email), company: String(f.company || ''), contact: String(f.contact || ''), country: String(f.country || '') } });
    return c.redirect(`/admin/quotes/${qt.id}`);
  }, () => '/admin/quotes'));
  app.get('/admin/quotes/:id', (c) => c.html(quoteEdit(c.req.param('id'), ...q(c))));
  app.get('/admin/quotes/:id/print', (c) => { const qt = S.getQuote(c.req.param('id')); return qt ? c.html(renderPI(qt, { lang: S.getCustomer(qt.customer_id)?.lang || 'en' })) : c.text('not found', 404); });
  app.post('/admin/quotes/:id/save', guard(async (c) => {
    const id = c.req.param('id');
    const f = await c.req.parseBody();
    const lines = [];
    for (let i = 0; i < 60; i++) {
      if (!f[`sku_${i}`]) continue;
      const s = S.getSku(String(f[`sku_${i}`]));
      const price = f[`price_${i}`] === '' || f[`price_${i}`] == null ? s?.ref_price : Number(f[`price_${i}`]);
      lines.push({ sku: String(f[`sku_${i}`]), variant: String(f[`variant_${i}`] ?? ''), qty: Number(f[`qty_${i}`]) || 0, unit_price: price || 0 });
    }
    S.updateQuote(id, { lines, currency: f.currency, incoterm: f.incoterm, port: String(f.port || ''), payment_terms: f.payment_terms, validity_days: f.validity_days, freight: f.freight, discount: f.discount, notes: String(f.notes || '') });
    if (f.action === 'send') { S.setQuoteStatus(id, 'sent'); return back(c, `/admin/quotes/${id}`, '已发送：把下方链接或邮件模板发给客户，客户在线确认后自动生成订单'); }
    return back(c, `/admin/quotes/${id}`, '已保存');
  }, (c) => `/admin/quotes/${c.req.param('id')}`));
  app.post('/admin/quotes/:id/status', guard(async (c) => { const f = await c.req.parseBody(); S.setQuoteStatus(c.req.param('id'), String(f.to)); return back(c, `/admin/quotes/${c.req.param('id')}`, '已更新'); }, (c) => `/admin/quotes/${c.req.param('id')}`));

  app.get('/admin/orders', (c) => c.html(ordersList(c.req.query('status') || '', ...q(c))));
  app.get('/admin/orders/:id', (c) => c.html(orderView(c.req.param('id'), ...q(c))));
  app.post('/admin/orders/:id/status', guard(async (c) => { const f = await c.req.parseBody(); S.setOrderStatus(c.req.param('id'), String(f.to)); return back(c, `/admin/orders/${c.req.param('id')}`, '状态已更新，客户中心同步可见'); }, (c) => `/admin/orders/${c.req.param('id')}`));
  app.post('/admin/orders/:id/payment', guard(async (c) => {
    const f = await c.req.parseBody();
    const o = S.recordPayment(c.req.param('id'), { kind: String(f.kind), amount: f.amount, ref: String(f.ref || '') });
    return back(c, `/admin/orders/${o.id}`, `已登记收款，当前已收 ${money(o.currency, o.paid)}`);
  }, (c) => `/admin/orders/${c.req.param('id')}`));
  app.post('/admin/orders/:id/erp', guard(async (c) => {
    const r = await pushOrder(c.req.param('id'));
    if (r.error) throw new Error(`推送失败：${r.error}`);
    return back(c, `/admin/orders/${c.req.param('id')}`, r.bill ? `已推送到金蝶，销售订单号 ${r.bill}` : '无需推送');
  }, (c) => `/admin/orders/${c.req.param('id')}`));
  app.post('/admin/orders/:id/ship', guard(async (c) => {
    const f = await c.req.parseBody();
    const lines = [];
    for (let i = 0; i < 200 && f[`sku_${i}`] != null; i++) lines.push({ sku: String(f[`sku_${i}`]), qty: Number(f[`qty_${i}`]) || 0 });
    const s = S.createShipment({ order_id: c.req.param('id'), lines: lines.length ? lines : null, mode: String(f.mode), carrier: String(f.carrier || ''), tracking_no: String(f.tracking_no || ''), container_no: String(f.container_no || ''), bl_no: String(f.bl_no || ''), etd: String(f.etd || ''), eta: String(f.eta || '') });
    return back(c, `/admin/shipments/${s.id}`, `已创建发货单 ${s.number}`);
  }, (c) => `/admin/orders/${c.req.param('id')}`));

  app.get('/admin/shipments', (c) => c.html(shipmentsList(...q(c))));
  app.get('/admin/shipments/:id', (c) => c.html(shipmentView(c.req.param('id'), ...q(c))));
  app.post('/admin/shipments/:id/save', guard(async (c) => { S.updateShipment(c.req.param('id'), await c.req.parseBody()); return back(c, `/admin/shipments/${c.req.param('id')}`, '已保存'); }, (c) => `/admin/shipments/${c.req.param('id')}`));
  app.post('/admin/shipments/:id/event', guard(async (c) => {
    const f = await c.req.parseBody();
    const s = S.addShipmentEvent(c.req.param('id'), { status: String(f.status), location: String(f.location || ''), note: String(f.note || '') });
    if (s.status === 'exception') alertOps('物流异常', [`${s.number}`, String(f.location || ''), String(f.note || '')]).catch(() => {});
    return back(c, `/admin/shipments/${s.id}`, '物流动态已更新，客户中心同步可见');
  }, (c) => `/admin/shipments/${c.req.param('id')}`));

  app.post('/admin/orders/:id/refund', guard(async (c) => {
    const f = await c.req.parseBody();
    const r = await refundOrder(c.req.param('id'), { amount: f.amount, reason: String(f.reason || ''), rmaId: f.rma_id ? String(f.rma_id) : null });
    return back(c, `/admin/orders/${c.req.param('id')}`, `已退款 ${r.amount}（${r.provider}）`);
  }, (c) => `/admin/orders/${c.req.param('id')}`));
  app.post('/admin/shipments/:id/track', guard(async (c) => {
    const r = await syncTracking({ ids: [c.req.param('id')] });
    return back(c, `/admin/shipments/${c.req.param('id')}`, r.skipped ? '未配置 17TRACK' : `已刷新${r.changed ? '，状态已更新' : '，状态无变化'}`);
  }, (c) => `/admin/shipments/${c.req.param('id')}`));
  app.get('/admin/rma', (c) => c.html(rmaList(...q(c))));
  app.get('/admin/rma/:id', (c) => c.html(rmaView(c.req.param('id'), ...q(c))));
  app.post('/admin/rma/:id/status', guard(async (c) => { const f = await c.req.parseBody(); S.setRmaStatus(c.req.param('id'), String(f.to), { resolution: f.resolution ? String(f.resolution) : null, note: String(f.note || '') }); return back(c, `/admin/rma/${c.req.param('id')}`, '已更新，客户中心同步可见'); }, (c) => `/admin/rma/${c.req.param('id')}`));
  app.post('/admin/rma/:id/ship', guard(async (c) => {
    const r = S.getRma(c.req.param('id'));
    const o = S.getOrder(r.order_id);
    const line = o.lines.find((l) => l.sku === r.sku) || o.lines[0];
    const s = S.createShipment({ order_id: o.id, rma_id: r.id, lines: [{ ...line, qty: r.qty || 1, amount: 0 }], mode: 'express' });
    if (r.status === 'approved') S.setRmaStatus(r.id, 'in_progress', { note: `补发单 ${s.number}` });
    return back(c, `/admin/shipments/${s.id}`, `已创建补发单 ${s.number}，请填写快递信息`);
  }, (c) => `/admin/rma/${c.req.param('id')}`));

  app.get('/admin/skus', (c) => c.html(skuList(...q(c))));
  app.get('/admin/skus/edit', (c) => c.html(skuEdit(c.req.query('sku') || '', ...q(c))));
  app.post('/admin/skus/save', guard(async (c) => { const f = await c.req.parseBody(); S.saveSku(f); return back(c, '/admin/skus', `已保存 ${f.sku}`); }, () => '/admin/skus'));

  app.get('/admin/inventory', async (c) => c.html(await inventoryPage(...q(c))));
  app.post('/admin/inventory/sync', guard(async (c) => { const r = await syncInventory(); if (r.error) throw new Error(r.error); return back(c, '/admin/inventory', r.skipped ? '本地模式无需同步' : `已同步 ${r.rows} 行库存`); }, () => '/admin/inventory'));
  app.post('/admin/inventory/test', guard(async (c) => back(c, '/admin/inventory', await testConnection()), () => '/admin/inventory'));
  app.post('/admin/inventory/materials', guard(async (c) => c.html(await inventoryPage('', '', await pullMaterials())), () => '/admin/inventory'));

  app.get('/admin/customers', (c) => c.html(customersList(...q(c))));
  app.get('/admin/customers/:id', (c) => c.html(customerView(c.req.param('id'), ...q(c))));
  app.post('/admin/customers/:id/save', guard(async (c) => { S.updateCustomer(c.req.param('id'), await c.req.parseBody()); return back(c, `/admin/customers/${c.req.param('id')}`, '已保存'); }, (c) => `/admin/customers/${c.req.param('id')}`));
}
