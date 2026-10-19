// Proforma Invoice document — one renderer for the admin print view and the customer portal.
import { brand } from './brand.js';
import { getCustomer, quoteExpired } from './service.js';
import { DICT, label } from '../../../shared/dictionary.js';
import { config } from '../config.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const money = (cur, n) => `${cur} ${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const T = {
  en: { pi: 'Proforma Invoice', no: 'PI No.', date: 'Date', valid: 'Valid until', seller: 'Seller', buyer: 'Buyer', item: 'Item', desc: 'Description', qty: 'Qty', unit: 'Unit price', amount: 'Amount', subtotal: 'Subtotal', freight: 'Freight', discount: 'Discount', total: 'Total', terms: 'Terms', incoterm: 'Price term', port: 'Port / destination', payment: 'Payment', lead: 'Lead time', leadv: (a, b) => `${a}–${b} days after deposit and sample approval`, bank: 'Bank details', bankNone: 'Bank details are sent by our sales engineer with the confirmed PI. Always verify bank details by phone before paying.', notes: 'Notes', status: 'Status', accept: 'Accept this PI and place the order', accepted: 'Accepted — thank you. Your order number is', expired: 'This PI has expired. Please ask us for an updated quotation.', print: 'Print / save as PDF', sign: 'Authorised signature' },
  zh: { pi: '形式发票（PI）', no: 'PI 编号', date: '日期', valid: '有效期至', seller: '卖方', buyer: '买方', item: '型号', desc: '描述', qty: '数量', unit: '单价', amount: '金额', subtotal: '小计', freight: '运费', discount: '折扣', total: '合计', terms: '条款', incoterm: '价格条款', port: '港口 / 目的地', payment: '付款方式', lead: '交期', leadv: (a, b) => `收到定金并确认样品后 ${a}–${b} 天`, bank: '收款账户', bankNone: '收款账户信息由业务工程师随确认版 PI 发送。付款前请务必电话核实账户信息。', notes: '备注', status: '状态', accept: '确认此 PI 并下单', accepted: '已确认，谢谢！您的订单号是', expired: '此 PI 已过期，请联系我们获取最新报价。', print: '打印 / 存为 PDF', sign: '授权签字' },
};

function leadTime(lines) {
  const prods = lines.map((l) => config.catalog.products.find((p) => p.id === l.sku || l.sku.startsWith(p.id))).filter(Boolean);
  if (!prods.length) return null;
  return [Math.max(...prods.map((p) => p.leadTimeDays[0])), Math.max(...prods.map((p) => p.leadTimeDays[1]))];
}

export function renderPI(q, { lang = 'en', portal = false, order = null, error = '' } = {}) {
  const t = T[lang] || T.en;
  const b = brand();
  const c = getCustomer(q.customer_id) || {};
  const date = (q.sent_at || q.created_at).slice(0, 10);
  const until = new Date(new Date(q.sent_at || q.created_at).getTime() + q.validity_days * 864e5).toISOString().slice(0, 10);
  const term = DICT.paymentTerms.find((x) => x.id === q.payment_terms);
  const lt = leadTime(q.lines);
  const expired = quoteExpired(q) || q.status === 'expired';
  const canAccept = portal && q.status === 'sent' && !expired;
  return `<!doctype html><html lang="${lang === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(t.pi)} ${esc(q.number)} | ${esc(b.brand)}</title>
<style>
:root{--a:${b.accent};--b:${b.accent2};--line:#d9e0e6;--mute:#5f6b77}
*{box-sizing:border-box}body{margin:0;background:#eef2f5;font:14px/1.5 -apple-system,"Segoe UI",Arial,"PingFang SC","Microsoft YaHei",sans-serif;color:#18222d}
.doc{max-width:860px;margin:24px auto;background:#fff;padding:40px 44px;border-top:8px solid var(--a);box-shadow:0 4px 24px rgba(0,0,0,.08)}
.hd{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;border-bottom:3px solid var(--b);padding-bottom:16px;margin-bottom:20px}
.hd h1{margin:0;font-size:26px;letter-spacing:.02em}.brand{font-weight:800;font-size:18px}.mute{color:var(--mute)}
.meta{text-align:right}.meta b{display:inline-block;min-width:90px}
.parties{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px}.parties div{border:1px solid var(--line);padding:12px 14px;border-radius:6px}
.parties h3{margin:0 0 4px;font-size:12px;color:var(--mute);font-weight:600}
table{width:100%;border-collapse:collapse;margin-bottom:12px}th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{background:#f4f6f8;font-size:12px;color:var(--mute)}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.tot{width:320px;margin-left:auto}.tot td{border:0;padding:4px 10px}.tot tr:last-child td{border-top:2px solid var(--a);font-weight:800;font-size:16px}
.terms{display:grid;grid-template-columns:160px 1fr;gap:4px 16px;margin:18px 0}.terms dt{color:var(--mute)}.terms dd{margin:0}
.box{border:1px solid var(--line);padding:12px 14px;border-radius:6px;margin:12px 0}
.sign{display:flex;justify-content:flex-end;margin-top:36px}.sign div{border-top:1px solid #18222d;padding-top:6px;width:240px;text-align:center;color:var(--mute)}
.bar{max-width:860px;margin:0 auto 40px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.btn{background:var(--a);color:#fff;border:0;padding:12px 20px;border-radius:6px;font:600 15px/1 inherit;cursor:pointer;text-decoration:none}
.btn.alt{background:#fff;color:var(--a);border:2px solid var(--a)}
.note{padding:12px 16px;border-radius:6px;background:#fff6dc;border:1px solid #f1d27a}.ok{background:#e8f5e9;border-color:#a5d6a7}.err{background:#fdecea;border-color:#f5b7b1}
@media print{body{background:#fff}.doc{box-shadow:none;margin:0;max-width:none}.bar{display:none}}
@media(max-width:640px){.doc{padding:24px 18px}.parties{grid-template-columns:1fr}.hd{flex-direction:column}.meta{text-align:left}.terms{grid-template-columns:1fr}}
</style></head><body>
<div class="doc">
 <div class="hd"><div><div class="brand">${esc(b.brand)}</div><div class="mute">${esc(lang === 'zh' ? b.companyZh : b.company)}<br>${esc(b.address)}<br>${esc(b.email)}${b.whatsapp ? ' · WhatsApp ' + esc(b.whatsapp) : ''}</div></div>
 <div class="meta"><h1>${esc(t.pi)}</h1><div><b>${t.no}</b> ${esc(q.number)}</div><div><b>${t.date}</b> ${date}</div><div><b>${t.valid}</b> ${until}</div>${portal ? '' : `<div><b>${t.status}</b> ${esc(label('quote', q.status, lang))}</div>`}</div></div>
 <div class="parties"><div><h3>${t.seller}</h3>${esc(lang === 'zh' ? b.companyZh : b.company)}<br>${esc(b.address)}</div><div><h3>${t.buyer}</h3><b>${esc(c.company || c.contact)}</b><br>${esc(c.contact)}<br>${esc([c.address, c.country].filter(Boolean).join(', '))}<br>${esc(c.email)}</div></div>
 <table><thead><tr><th>#</th><th>${t.item}</th><th>${t.desc}</th><th class="n">${t.qty}</th><th class="n">${t.unit}</th><th class="n">${t.amount}</th></tr></thead><tbody>
 ${q.lines.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.sku)}</td><td>${esc(l.name)}${l.variant ? '<br><span class="mute">' + esc(l.variant) + '</span>' : ''}</td><td class="n">${l.qty} ${esc(l.unit)}</td><td class="n">${money(q.currency, l.unit_price)}</td><td class="n">${money(q.currency, l.amount)}</td></tr>`).join('')}
 </tbody></table>
 <table class="tot"><tr><td>${t.subtotal}</td><td class="n">${money(q.currency, q.subtotal)}</td></tr>${q.freight ? `<tr><td>${t.freight}</td><td class="n">${money(q.currency, q.freight)}</td></tr>` : ''}${q.discount ? `<tr><td>${t.discount}</td><td class="n">− ${money(q.currency, q.discount)}</td></tr>` : ''}<tr><td>${t.total}</td><td class="n">${money(q.currency, q.total)}</td></tr></table>
 <dl class="terms"><dt>${t.incoterm}</dt><dd>${esc(q.incoterm)} ${esc(q.port)}</dd><dt>${t.payment}</dt><dd>${esc(term ? term[lang] || term.en : q.payment_terms)}</dd>${lt ? `<dt>${t.lead}</dt><dd>${t.leadv(lt[0], lt[1])}</dd>` : ''}</dl>
 <div class="box"><b>${t.bank}</b><br>${b.bank ? esc(Object.entries(b.bank).map(([k, v]) => `${k}: ${v}`).join(' · ')) : `<span class="mute">${t.bankNone}</span>`}</div>
 ${q.notes ? `<div class="box"><b>${t.notes}</b><br>${esc(q.notes).replace(/\n/g, '<br>')}</div>` : ''}
 <div class="sign"><div>${t.sign}<br>${esc(lang === 'zh' ? b.companyZh : b.company)}</div></div>
</div>
<div class="bar">
 ${error ? `<div class="note err">${esc(error)}</div>` : ''}
 ${order ? `<div class="note ok">${t.accepted} <b>${esc(order.number)}</b>.</div>` : ''}
 ${portal && expired && !order ? `<div class="note">${t.expired}</div>` : ''}
 ${canAccept ? `<form method="post"><button class="btn">${t.accept}</button></form>` : ''}
 <button class="btn alt" onclick="print()">${t.print}</button>
</div></body></html>`;
}
