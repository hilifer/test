// Customer self-service portal: view/accept PIs, follow orders and shipments, request after-sales.
// Access: private link with a token (sent with every PI/order email), or order number + email.
import { config } from '../config.js';
import { brand } from './brand.js';
import { esc, money, renderPI } from './pi.js';
import { DICT, label } from '../../../shared/dictionary.js';
import {
  customerByToken, quoteByToken, acceptQuote, getOrder, ordersForCustomer, shipmentsFor, paymentsFor, rmasForCustomer,
  createRma, verifyOrder, getCustomer, quotesForCustomer, getOrderByQuote,
} from './service.js';
import { alertOps } from '../alerts.js';
import { pushOrder } from './erp/index.js';
import { contractForQuote } from './deals.js';

const T = {
  en: { title: 'Customer portal', lookup: 'Track an order', lookupLede: 'Enter your order number and the email address on the order.', order: 'Order number', email: 'Email', go: 'Find my order', notFound: 'We could not find an order with that number and email. Check both, or contact us.', hello: 'Welcome', pis: 'Quotations (PI)', orders: 'Orders', rmas: 'After-sales requests', none: 'Nothing here yet.', view: 'View', placed: 'Placed', total: 'Total', paid: 'Paid', balance: 'Balance due', status: 'Status', items: 'Items', shipments: 'Shipments', noShip: 'Not shipped yet. We will add tracking details as soon as it ships.', tracking: 'Tracking', eta: 'ETA', etd: 'ETD', container: 'Container', history: 'Updates', rmaH: 'Report a problem with this order', rmaLede: 'Tell us what happened. Photos help: paste links to photos or a shared folder.', sku: 'Item', qty: 'Quantity affected', issue: 'Problem', desc: 'What happened?', photos: 'Photo links (optional)', submit: 'Send request', rmaOk: 'Request received. Your after-sales number is', back: 'Back to my account', contact: 'Questions? Email', lang: '中文' },
  zh: { title: '客户中心', lookup: '查询订单', lookupLede: '请输入订单号和下单时使用的邮箱。', order: '订单号', email: '邮箱', go: '查询', notFound: '没有找到对应的订单，请核对订单号和邮箱，或联系我们。', hello: '欢迎', pis: '报价单（PI）', orders: '订单', rmas: '售后申请', none: '暂无记录。', view: '查看', placed: '下单日期', total: '合计', paid: '已付', balance: '待付', status: '状态', items: '明细', shipments: '发货与物流', noShip: '尚未发货，发货后会在这里更新物流信息。', tracking: '运单号', eta: '预计到达', etd: '开船/发出', container: '柜号', history: '物流动态', rmaH: '申请售后', rmaLede: '请描述遇到的问题。可以附上照片链接或共享文件夹链接。', sku: '产品', qty: '涉及数量', issue: '问题类型', desc: '具体情况', photos: '照片链接（选填）', submit: '提交申请', rmaOk: '已收到您的申请，售后单号', back: '返回我的账户', contact: '有疑问请联系', lang: 'English' },
};

export function page(lang, title, body) {
  const b = brand();
  const t = T[lang];
  return `<!doctype html><html lang="${lang === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>${esc(title)} | ${esc(b.brand)}</title><style>
:root{--a:${b.accent};--b:${b.accent2};--line:#d9e0e6;--mute:#5f6b77;--bg:#f2f5f7}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:#18222d;font:15px/1.55 -apple-system,"Segoe UI",Arial,"PingFang SC","Microsoft YaHei",sans-serif}
header{background:var(--a);color:#fff;border-bottom:4px solid var(--b)}header .in{max-width:960px;margin:auto;padding:14px 20px;display:flex;align-items:center;gap:12px}
header a{color:#fff;text-decoration:none}header img{width:36px;height:36px;border-radius:6px}header b{font-size:18px;letter-spacing:.03em}header .sp{margin-left:auto;font-size:14px}
main{max-width:960px;margin:auto;padding:28px 20px 64px}h1{font-size:28px;margin:0 0 6px}h2{font-size:19px;margin:28px 0 10px}
.card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:18px 20px;margin-bottom:14px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:12.5px;color:var(--mute);font-weight:600}
.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.mute{color:var(--mute)}a{color:#0b5cad}
.pill{display:inline-block;font-size:12.5px;padding:2px 9px;border-radius:999px;background:#e8edf2;white-space:nowrap}.pill.go{background:#e3f2e5;color:#1b5e20}.pill.warn{background:#fff3cd;color:#7a5600}
.steps{display:flex;gap:0;list-style:none;padding:0;margin:8px 0 4px;overflow-x:auto}.steps li{flex:1;min-width:96px;text-align:center;font-size:12.5px;color:var(--mute);position:relative;padding-top:22px}
.steps li::before{content:'';position:absolute;top:6px;left:50%;width:12px;height:12px;margin-left:-6px;border-radius:50%;background:#cfd8df;z-index:1}
.steps li::after{content:'';position:absolute;top:11px;left:-50%;width:100%;height:2px;background:#cfd8df}.steps li:first-child::after{display:none}
.steps li.done{color:#18222d}.steps li.done::before,.steps li.done::after{background:var(--a)}.steps li.cur::before{background:var(--b);box-shadow:0 0 0 3px var(--a)}
form.f{display:grid;gap:12px}label{display:grid;gap:5px;font-size:14px;font-weight:600}input,select,textarea{font:inherit;padding:10px 12px;border:1px solid #c3ccd5;border-radius:6px;background:#fff;font-weight:400}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}.btn{background:var(--a);color:#fff;border:0;padding:12px 20px;border-radius:6px;font:600 15px/1 inherit;cursor:pointer;justify-self:start}
.note{padding:12px 16px;border-radius:8px;margin-bottom:14px;background:#e8f5e9;border:1px solid #a5d6a7}.note.err{background:#fdecea;border-color:#f5b7b1}
.tl{list-style:none;padding:0;margin:0;border-left:2px solid var(--line)}.tl li{padding:4px 0 10px 16px;position:relative}.tl li::before{content:'';position:absolute;left:-6px;top:10px;width:10px;height:10px;border-radius:50%;background:var(--a)}
@media(max-width:600px){.row{grid-template-columns:1fr}th.h,td.h{display:none}}
</style></head><body><header><div class="in"><img src="${b.logo}" alt=""><b>${esc(b.brand)}</b><span class="mute" style="color:#cfd8df">${t.title}</span><span class="sp">${t.contact} <a href="mailto:${esc(b.email)}">${esc(b.email)}</a></span></div></header><main>${body}</main></body></html>`;
}

const fmtD = (iso) => (iso ? String(iso).slice(0, 10) : '');
const langOf = (c, q) => (q === 'zh' || q === 'en' ? q : c?.lang === 'zh' ? 'zh' : 'en');

function lookupPage(lang, err = '') {
  const t = T[lang];
  return page(lang, t.lookup, `<h1>${t.lookup}</h1><p class="mute">${t.lookupLede} <a href="?lang=${lang === 'zh' ? 'en' : 'zh'}">${t.lang}</a></p>${err ? `<div class="note err">${esc(err)}</div>` : ''}
<div class="card"><form class="f" method="post"><input type="hidden" name="lang" value="${lang}"><div class="row"><label>${t.order}<input name="order" placeholder="SO-261017-001" required></label><label>${t.email}<input name="email" type="email" required></label></div><button class="btn">${t.go}</button></form></div>`);
}

function homePage(c, lang) {
  const t = T[lang];
  const orders = ordersForCustomer(c.id);
  const rmas = rmasForCustomer(c.id);
  const quotes = quotesForCustomer(c.id);
  return page(lang, t.title, `<h1>${t.hello}, ${esc(c.contact || c.company)}</h1><p class="mute">${esc(c.company)} · ${esc(c.email)} · <a href="?lang=${lang === 'zh' ? 'en' : 'zh'}">${t.lang}</a></p>
<h2>${t.orders}</h2><div class="card">${orders.length ? `<table><thead><tr><th>${t.order}</th><th class="h">${t.placed}</th><th>${t.status}</th><th class="n">${t.total}</th><th class="n h">${t.balance}</th><th></th></tr></thead><tbody>${orders.map((o) => `<tr><td><b>${esc(o.number)}</b></td><td class="h">${fmtD(o.created_at)}</td><td><span class="pill ${['shipped', 'delivered', 'completed'].includes(o.status) ? 'go' : o.status === 'awaiting_deposit' ? 'warn' : ''}">${esc(label('order', o.status, lang))}</span></td><td class="n">${money(o.currency, o.total)}</td><td class="n h">${money(o.currency, o.total - o.paid)}</td><td><a href="o/${encodeURIComponent(o.number)}?lang=${lang}">${t.view}</a></td></tr>`).join('')}</tbody></table>` : `<p class="mute">${t.none}</p>`}</div>
<h2>${t.pis}</h2><div class="card">${quotes.length ? `<table><tbody>${quotes.map((q) => `<tr><td><b>${esc(q.number)}</b></td><td>${fmtD(q.sent_at)}</td><td><span class="pill">${esc(label('quote', q.status, lang))}</span></td><td class="n">${money(q.currency, q.total)}</td><td><a href="../../pi/${q.token}?lang=${lang}">${t.view}</a></td></tr>`).join('')}</tbody></table>` : `<p class="mute">${t.none}</p>`}</div>
<h2>${t.rmas}</h2><div class="card">${rmas.length ? `<table><tbody>${rmas.map((r) => `<tr><td><b>${esc(r.number)}</b></td><td>${esc(r.order_number)}</td><td>${esc(DICT.rma.issues[r.issue]?.[lang] || r.issue)}</td><td><span class="pill">${esc(label('rma', r.status, lang))}</span></td><td class="mute">${esc(r.resolution_note || '')}</td></tr>`).join('')}</tbody></table>` : `<p class="mute">${t.none}</p>`}</div>`);
}

function orderPage(c, o, lang, msg = '', err = '') {
  const t = T[lang];
  const ships = shipmentsFor(o.id);
  const tl = o.channel === 'shop' ? DICT.order.timelineShop : DICT.order.timeline;
  const idx = tl.indexOf(o.status);
  const steps = o.status === 'cancelled' ? `<p><span class="pill warn">${label('order', 'cancelled', lang)}</span></p>` : `<ol class="steps">${tl.map((s, i) => `<li class="${i <= idx ? 'done' : ''} ${i === idx ? 'cur' : ''}">${esc(label('order', s, lang))}</li>`).join('')}</ol>`;
  return page(lang, o.number, `<p><a href="../?lang=${lang}">← ${t.back}</a></p><h1>${esc(o.number)}</h1>
${msg ? `<div class="note">${msg}</div>` : ''}${err ? `<div class="note err">${esc(err)}</div>` : ''}
<div class="card">${steps}<table style="margin-top:10px"><tbody><tr><td>${t.placed}</td><td>${fmtD(o.created_at)}</td><td>${t.total}</td><td class="n">${money(o.currency, o.total)}</td></tr><tr><td>${esc(o.incoterm)} ${esc(o.port)}</td><td></td><td>${t.paid}</td><td class="n">${money(o.currency, o.paid)}</td></tr><tr><td></td><td></td><td><b>${t.balance}</b></td><td class="n"><b>${money(o.currency, o.total - o.paid)}</b></td></tr></tbody></table></div>
<h2>${t.items}</h2><div class="card"><table><tbody>${o.lines.map((l) => `<tr><td>${esc(l.sku)}</td><td>${esc(l.name)} <span class="mute">${esc(l.variant || '')}</span></td><td class="n">${l.qty} ${esc(l.unit)}</td></tr>`).join('')}</tbody></table></div>
<h2>${t.shipments}</h2>${ships.length ? ships.map((s) => `<div class="card"><b>${esc(s.number)}</b> · ${esc(DICT.shipment.modes[s.mode]?.[lang] || s.mode)} · <span class="pill ${s.status === 'delivered' ? 'go' : s.status === 'exception' ? 'warn' : ''}">${esc(label('shipment', s.status, lang))}</span>${s.rma_id ? ' <span class="pill">RMA</span>' : ''}
<table style="margin:10px 0"><tbody>${s.carrier || s.tracking_no ? `<tr><td>${t.tracking}</td><td>${esc(s.carrier)} ${esc(s.tracking_no)}</td></tr>` : ''}${s.container_no ? `<tr><td>${t.container}</td><td>${esc(s.container_no)}</td></tr>` : ''}${s.etd ? `<tr><td>${t.etd}</td><td>${esc(s.etd)}</td></tr>` : ''}${s.eta ? `<tr><td>${t.eta}</td><td>${esc(s.eta)}</td></tr>` : ''}</tbody></table>
<p class="mute" style="margin:0 0 6px">${t.history}</p><ul class="tl">${[...s.events].reverse().map((e) => `<li><b>${esc(label('shipment', e.status, lang))}</b> <span class="mute">${fmtD(e.ts)}</span>${e.location ? ' · ' + esc(e.location) : ''}${e.note ? '<br>' + esc(e.note) : ''}</li>`).join('')}</ul></div>`).join('') : `<div class="card mute">${t.noShip}</div>`}
${['shipped', 'delivered', 'completed'].includes(o.status) ? `<h2>${t.rmaH}</h2><div class="card"><p class="mute">${t.rmaLede}</p><form class="f" method="post" action="${encodeURIComponent(o.number)}/rma?lang=${lang}">
<div class="row"><label>${t.sku}<select name="sku">${o.lines.map((l) => `<option value="${esc(l.sku)}">${esc(l.sku)} ${esc(l.name)}</option>`).join('')}</select></label><label>${t.qty}<input name="qty" type="number" min="0" value="1"></label></div>
<label>${t.issue}<select name="issue">${Object.entries(DICT.rma.issues).map(([k, v]) => `<option value="${k}">${esc(v[lang])}</option>`).join('')}</select></label>
<label>${t.desc}<textarea name="description" rows="4" required></textarea></label><label>${t.photos}<input name="photos" placeholder="https://…"></label><button class="btn">${t.submit}</button></form></div>` : ''}`);
}

export function mountPortal(app) {
  app.get('/portal', (c) => c.html(lookupPage(langOf(null, c.req.query('lang')))));
  app.post('/portal', async (c) => {
    const f = await c.req.parseBody();
    const lang = langOf(null, String(f.lang || ''));
    const v = verifyOrder(f.order, f.email);
    if (!v) return c.html(lookupPage(lang, T[lang].notFound), 404);
    return c.redirect(`/portal/c/${v.customer.portal_token}/o/${encodeURIComponent(v.order.number)}?lang=${lang}`);
  });
  app.get('/portal/c/:t/', (c) => {
    const cust = customerByToken(c.req.param('t'));
    if (!cust) return c.html(lookupPage('en', T.en.notFound), 404);
    return c.html(homePage(cust, langOf(cust, c.req.query('lang'))));
  });
  app.get('/portal/c/:t', (c) => c.redirect(`/portal/c/${c.req.param('t')}/${c.req.query('lang') ? '?lang=' + c.req.query('lang') : ''}`));
  app.get('/portal/c/:t/o/:num', (c) => {
    const cust = customerByToken(c.req.param('t'));
    const o = cust && getOrder(c.req.param('num'));
    if (!cust || !o || o.customer_id !== cust.id) return c.html(lookupPage('en', T.en.notFound), 404);
    const lang = langOf(cust, c.req.query('lang'));
    const m = c.req.query('rma');
    return c.html(orderPage(cust, o, lang, m ? `${T[lang].rmaOk} <b>${esc(m)}</b>.` : ''));
  });
  app.post('/portal/c/:t/o/:num/rma', async (c) => {
    const cust = customerByToken(c.req.param('t'));
    const o = cust && getOrder(c.req.param('num'));
    if (!cust || !o || o.customer_id !== cust.id) return c.html(lookupPage('en', T.en.notFound), 404);
    const lang = langOf(cust, c.req.query('lang'));
    const f = await c.req.parseBody();
    if (!String(f.description || '').trim()) return c.html(orderPage(cust, o, lang, '', T[lang].desc));
    const photos = String(f.photos || '').split(/[\s,]+/).filter((u) => /^https?:\/\//.test(u));
    const r = createRma({ order_id: o.id, sku: String(f.sku || ''), qty: f.qty, issue: String(f.issue || 'other'), description: String(f.description), photos, source: 'portal' });
    alertOps('新售后申请', [`${r.number} / 订单 ${o.number}`, `客户：${cust.company || cust.email}`, `问题：${DICT.rma.issues[r.issue].zh} ${r.sku} ×${r.qty}`, String(f.description).slice(0, 200), `处理：${config.publicBaseUrl}/admin/rma/${r.id}`]).catch(() => {});
    return c.redirect(`/portal/c/${cust.portal_token}/o/${encodeURIComponent(o.number)}?lang=${lang}&rma=${r.number}`);
  });
  app.get('/portal/pi/:t', (c) => {
    const q = quoteByToken(c.req.param('t'));
    if (!q || q.status === 'draft' || q.status === 'cancelled') return c.html(lookupPage('en', 'This quotation link is not valid.'), 404);
    const cust = getCustomer(q.customer_id);
    const order = q.status === 'accepted' ? getOrderByQuote(q.id) : null;
    return c.html(renderPI(q, { lang: langOf(cust, c.req.query('lang')), portal: true, order }));
  });
  app.post('/portal/pi/:t', async (c) => {
    const q = quoteByToken(c.req.param('t'));
    if (!q) return c.html(lookupPage('en', 'This quotation link is not valid.'), 404);
    const cust = getCustomer(q.customer_id);
    const lang = langOf(cust, c.req.query('lang'));
    // a PI that has a sales contract is accepted by signing the contract
    const k = contractForQuote(q.id);
    if (k && k.status === 'sent') return c.redirect(`/portal/contract/${k.token}`);
    try {
      const o = acceptQuote(q.token, 'customer');
      alertOps('客户已确认 PI，生成订单', [`${o.number} ← ${q.number}`, `客户：${cust.company || cust.email}`, `金额：${money(o.currency, o.total)}，待收定金 ${money(o.currency, o.deposit_due)}`, `${config.publicBaseUrl}/admin/orders/${o.id}`]).catch(() => {});
      if (config.erp.autoPushOrders) pushOrder(o.id).catch(() => {});
      return c.html(renderPI(quoteByToken(q.token), { lang, portal: true, order: o }));
    } catch (e) {
      return c.html(renderPI(quoteByToken(q.token), { lang, portal: true, error: e.message }));
    }
  });
}
