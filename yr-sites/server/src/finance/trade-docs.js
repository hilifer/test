// Export documents for an order: Commercial Invoice and Packing List (carton numbers, net / gross weight, CBM, HS codes,
// shipping marks). Same look as the PI; "print / save as PDF" in the browser. English or Chinese by the customer's language.
import { brand } from '../ops/brand.js';
import { getCustomer, getSku, getOrder, getQuote, paymentsFor } from '../ops/service.js';
import { DICT } from '../../../shared/dictionary.js';
import { esc, money } from '../ops/pi.js';

const T = {
  en: { ci: 'Commercial Invoice', pl: 'Packing List', no: 'Invoice No.', order: 'Order No.', date: 'Date', seller: 'Seller / Exporter', buyer: 'Buyer / Consignee', item: 'Item', desc: 'Description', hs: 'HS code', qty: 'Qty', unit: 'Unit price', amount: 'Amount',
    subtotal: 'Subtotal', freight: 'Freight', discount: 'Discount', total: 'Total', paid: 'Paid', balance: 'Balance due', incoterm: 'Price term', port: 'Port / destination', payment: 'Payment terms', origin: 'Country of origin', originV: 'China',
    cartons: 'Cartons', cartonNo: 'Carton No.', pcsCtn: 'Pcs / carton', nw: 'N.W. (kg)', gw: 'G.W. (kg)', cbm: 'CBM', marks: 'Shipping marks', totalPkg: 'Total', missing: 'Packing data missing for', declare: 'We hereby certify that the above information is true and correct.', sign: 'Authorised signature', print: 'Print / save as PDF' },
  zh: { ci: '商业发票', pl: '装箱单', no: '发票号', order: '订单号', date: '日期', seller: '卖方 / 出口商', buyer: '买方 / 收货人', item: '型号', desc: '品名', hs: '海关编码', qty: '数量', unit: '单价', amount: '金额',
    subtotal: '小计', freight: '运费', discount: '折扣', total: '合计', paid: '已付', balance: '待付', incoterm: '价格条款', port: '港口 / 目的地', payment: '付款方式', origin: '原产地', originV: '中国',
    cartons: '箱数', cartonNo: '箱号', pcsCtn: '每箱数量', nw: '净重（kg）', gw: '毛重（kg）', cbm: '体积（m³）', marks: '唛头', totalPkg: '合计', missing: '缺少装箱数据：', declare: '兹证明以上内容真实无误。', sign: '授权签字', print: '打印 / 存为 PDF' },
};
const r2 = (x) => Math.round(x * 100) / 100;
const CSS = (b) => `:root{--a:${b.accent};--b:${b.accent2};--line:#d9e0e6;--mute:#5f6b77}*{box-sizing:border-box}body{margin:0;background:#eef2f5;font:13px/1.5 -apple-system,"Segoe UI",Arial,"PingFang SC","Microsoft YaHei",sans-serif;color:#18222d}
.doc{max-width:900px;margin:24px auto;background:#fff;padding:36px 40px;border-top:8px solid var(--a);box-shadow:0 4px 24px rgba(0,0,0,.08)}.hd{display:flex;justify-content:space-between;gap:24px;border-bottom:3px solid var(--b);padding-bottom:14px;margin-bottom:18px}
.hd h1{margin:0;font-size:24px}.brand{font-weight:800;font-size:17px}.mute{color:var(--mute)}.meta{text-align:right}.meta b{display:inline-block;min-width:96px}
.parties{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:18px}.parties div{border:1px solid var(--line);padding:10px 12px;border-radius:6px}.parties h3{margin:0 0 4px;font-size:12px;color:var(--mute);font-weight:600}
table{width:100%;border-collapse:collapse;margin-bottom:12px}th,td{padding:7px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{background:#f4f6f8;font-size:12px;color:var(--mute)}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
tfoot td{font-weight:700;border-top:2px solid var(--a)}.tot{width:320px;margin-left:auto}.tot td{border:0;padding:3px 8px}.tot tr:last-child td{border-top:2px solid var(--a);font-weight:800}
.terms{display:grid;grid-template-columns:150px 1fr;gap:3px 14px;margin:14px 0}.terms dt{color:var(--mute)}.terms dd{margin:0}.box{border:1px solid var(--line);padding:10px 12px;border-radius:6px;margin:12px 0}
.sign{display:flex;justify-content:space-between;align-items:flex-end;margin-top:30px}.sign div.l{border-top:1px solid #18222d;padding-top:6px;width:240px;text-align:center;color:var(--mute)}.bar{max-width:900px;margin:0 auto 40px}
.btn{background:var(--a);color:#fff;border:0;padding:10px 18px;border-radius:6px;font:600 14px/1 inherit;cursor:pointer}@media print{body{background:#fff}.doc{box-shadow:none;margin:0;max-width:none}.bar{display:none}}`;
function frame(title, b, lang, body, t) {
  return `<!doctype html><html lang="${lang === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} | ${esc(b.brand)}</title><style>${CSS(b)}</style></head><body>
<div class="doc">${body}</div><div class="bar"><button class="btn" onclick="print()">${t.print}</button></div></body></html>`;
}
function parties(o, b, lang, t) {
  const c = getCustomer(o.customer_id) || {};
  let addr = {};
  try { addr = JSON.parse(o.shipping_address || '{}'); } catch { /* B2B orders have no shipping address */ }
  const lines = o.channel === 'shop' ? [addr.name, addr.company, addr.line1, addr.line2, [addr.city, addr.state, addr.postcode].filter(Boolean).join(' '), addr.country, addr.phone] : [c.company || c.contact, c.contact, c.address, c.country, c.email, c.phone || c.whatsapp];
  return `<div class="parties"><div><h3>${t.seller}</h3><b>${esc(lang === 'zh' ? b.companyZh : b.company)}</b><br>${esc(b.address)}<br>${esc(b.email)}</div><div><h3>${t.buyer}</h3>${lines.filter(Boolean).map((x, i) => (i ? esc(x) : `<b>${esc(x)}</b>`)).join('<br>')}</div></div>`;
}
const header = (b, lang, title, rows) => `<div class="hd"><div><div class="brand">${esc(b.brand)}</div><div class="mute">${esc(lang === 'zh' ? b.companyZh : b.company)}<br>${esc(b.address)}</div></div><div class="meta"><h1>${esc(title)}</h1>${rows.map(([k, v]) => `<div><b>${k}</b> ${esc(v)}</div>`).join('')}</div></div>`;
export const invoiceNumber = (o) => `CI-${o.number.replace(/^[A-Z]+-?/, '')}`;

export function renderCommercialInvoice(orderId, { lang } = {}) {
  const o = getOrder(orderId);
  if (!o) return null;
  const c = getCustomer(o.customer_id) || {};
  lang = lang || (c.lang === 'zh' ? 'zh' : 'en');
  const t = T[lang], b = brand();
  const q = o.quote_id ? getQuote(o.quote_id) : null;
  const freight = q ? q.freight : Number(o.shipping_fee || 0), discount = q ? q.discount : Number(o.discount || 0);
  const subtotal = r2(o.lines.reduce((a, l) => a + (Number(l.amount) || l.qty * l.unit_price), 0));
  const paid = paymentsFor(o.id).reduce((a, p) => a + p.amount, 0);
  const term = DICT.paymentTerms.find((x) => x.id === o.payment_terms);
  const body = `${header(b, lang, t.ci, [[t.no, invoiceNumber(o)], [t.order, o.number], [t.date, (o.updated_at || o.created_at).slice(0, 10)]])}${parties(o, b, lang, t)}
<table><thead><tr><th>#</th><th>${t.item}</th><th>${t.desc}</th><th>${t.hs}</th><th class="n">${t.qty}</th><th class="n">${t.unit}</th><th class="n">${t.amount}</th></tr></thead><tbody>
${o.lines.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.sku)}</td><td>${esc(l.name || getSku(l.sku)?.name || '')}${l.variant ? `<br><span class="mute">${esc(l.variant)}</span>` : ''}</td><td>${esc(getSku(l.sku)?.hs_code || '')}</td><td class="n">${l.qty} ${esc(l.unit || 'pcs')}</td><td class="n">${money(o.currency, l.unit_price)}</td><td class="n">${money(o.currency, Number(l.amount) || l.qty * l.unit_price)}</td></tr>`).join('')}</tbody></table>
<table class="tot"><tbody><tr><td>${t.subtotal}</td><td class="n">${money(o.currency, subtotal)}</td></tr>${freight ? `<tr><td>${t.freight}</td><td class="n">${money(o.currency, freight)}</td></tr>` : ''}${discount ? `<tr><td>${t.discount}</td><td class="n">−${money(o.currency, discount)}</td></tr>` : ''}<tr><td>${t.total}</td><td class="n">${money(o.currency, o.total)}</td></tr></tbody></table>
<dl class="terms"><dt>${t.incoterm}</dt><dd>${esc(o.incoterm || '')} ${esc(o.port || '')}</dd><dt>${t.payment}</dt><dd>${esc(term ? term[lang] : o.payment_terms || '')}</dd><dt>${t.paid}</dt><dd>${money(o.currency, paid)}</dd><dt>${t.balance}</dt><dd>${money(o.currency, Math.max(0, o.total - paid))}</dd><dt>${t.origin}</dt><dd>${t.originV}</dd></dl>
<div class="sign"><span class="mute">${t.declare}</span><div class="l">${t.sign}</div></div>`;
  return frame(`${t.ci} ${invoiceNumber(o)}`, b, lang, body, t);
}

/** Cartons per line, numbered continuously (1–5 for the first SKU, 6–8 for the next…). */
export function packingRows(lines) {
  let n = 0;
  const rows = [], missing = [];
  for (const l of lines) {
    const s = getSku(l.sku);
    if (!s?.pcs_per_carton) { missing.push(l.sku); rows.push({ ...l, cartons: null }); continue; }
    const cartons = Math.ceil(l.qty / s.pcs_per_carton);
    const gw = r2(cartons * (s.carton_gw || 0));
    const nw = s.weight_kg ? r2(l.qty * s.weight_kg) : r2(gw * 0.9);
    rows.push({ ...l, from: n + 1, to: n + cartons, cartons, pcs: s.pcs_per_carton, nw, gw, cbm: r2(cartons * (s.carton_cbm || 0)), hs: s.hs_code || '' });
    n += cartons;
  }
  const sum = (k) => r2(rows.reduce((a, r) => a + (r[k] || 0), 0));
  return { rows, missing, totals: { cartons: n, qty: rows.reduce((a, r) => a + r.qty, 0), nw: sum('nw'), gw: sum('gw'), cbm: sum('cbm') } };
}
export function renderPackingList(orderId, { lang, lines = null } = {}) {
  const o = getOrder(orderId);
  if (!o) return null;
  const c = getCustomer(o.customer_id) || {};
  lang = lang || (c.lang === 'zh' ? 'zh' : 'en');
  const t = T[lang], b = brand();
  const p = packingRows(lines || o.lines);
  const marks = [c.company || c.contact || '', o.port || c.country || '', `${t.order} ${o.number}`, 'C/No. 1-' + p.totals.cartons, 'MADE IN CHINA'].filter(Boolean);
  const body = `${header(b, lang, t.pl, [[t.no, invoiceNumber(o)], [t.order, o.number], [t.date, new Date().toISOString().slice(0, 10)]])}${parties(o, b, lang, t)}
<table><thead><tr><th>${t.cartonNo}</th><th>${t.item}</th><th>${t.desc}</th><th>${t.hs}</th><th class="n">${t.qty}</th><th class="n">${t.pcsCtn}</th><th class="n">${t.cartons}</th><th class="n">${t.nw}</th><th class="n">${t.gw}</th><th class="n">${t.cbm}</th></tr></thead><tbody>
${p.rows.map((r) => `<tr><td>${r.cartons ? (r.from === r.to ? r.from : `${r.from}–${r.to}`) : '—'}</td><td>${esc(r.sku)}</td><td>${esc(r.name || getSku(r.sku)?.name || '')}${r.variant ? `<br><span class="mute">${esc(r.variant)}</span>` : ''}</td><td>${esc(r.hs || '')}</td><td class="n">${r.qty}</td><td class="n">${r.pcs ?? '—'}</td><td class="n">${r.cartons ?? '—'}</td><td class="n">${r.nw ?? '—'}</td><td class="n">${r.gw ?? '—'}</td><td class="n">${r.cbm ?? '—'}</td></tr>`).join('')}</tbody>
<tfoot><tr><td colspan="4">${t.totalPkg}</td><td class="n">${p.totals.qty}</td><td></td><td class="n">${p.totals.cartons}</td><td class="n">${p.totals.nw}</td><td class="n">${p.totals.gw}</td><td class="n">${p.totals.cbm}</td></tr></tfoot></table>
${p.missing.length ? `<div class="box" style="border-color:#f5b7b1;background:#fdecea">${t.missing} ${esc(p.missing.join(', '))}</div>` : ''}
<div class="box"><b>${t.marks}</b><br>${marks.map(esc).join('<br>')}</div><div class="sign"><span></span><div class="l">${t.sign}</div></div>`;
  return frame(`${t.pl} ${o.number}`, b, lang, body, t);
}
