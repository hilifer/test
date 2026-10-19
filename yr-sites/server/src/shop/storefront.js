// Online shop pages (server-rendered, EN + 中文) and the JSON API used by the buy box on static product pages.
//   /shop/cart · /shop/checkout · /shop/order/:no · /shop/account/* · /shop/pay/* · /api/shop/* · /api/pay/stripe/webhook
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { config } from '../config.js';
import { brand } from '../ops/brand.js';
import { esc } from '../ops/pi.js';
import { label, DICT } from '../../../shared/dictionary.js';
import { shipmentsFor } from '../ops/service.js';
import { resolveCart, createCart, setItem, removeItem, viewCart, sellable, unitPrice, availableBySku } from './cart.js';
import { quoteShipping } from './freight.js';
import * as A from './accounts.js';
import { placeOrder, orderByAccess, ordersOfCustomer, CheckoutError } from './checkout.js';
import * as P from './payments.js';
import { sendMail } from './mailer.js';

const CART = 'yr_cart', CUST = 'yr_cust';
const secure = () => config.publicBaseUrl.startsWith('https://');
const COUNTRIES = 'US United States|CA Canada|MX Mexico|BR Brazil|CL Chile|CO Colombia|PE Peru|AR Argentina|GB United Kingdom|IE Ireland|DE Germany|FR France|IT Italy|ES Spain|PT Portugal|NL Netherlands|BE Belgium|AT Austria|CH Switzerland|PL Poland|CZ Czechia|HU Hungary|RO Romania|GR Greece|SE Sweden|NO Norway|DK Denmark|FI Finland|TR Türkiye|AE United Arab Emirates|SA Saudi Arabia|QA Qatar|KW Kuwait|OM Oman|BH Bahrain|JO Jordan|IL Israel|EG Egypt|MA Morocco|NG Nigeria|KE Kenya|GH Ghana|ZA South Africa|IN India|PK Pakistan|BD Bangladesh|LK Sri Lanka|SG Singapore|MY Malaysia|TH Thailand|VN Vietnam|ID Indonesia|PH Philippines|KH Cambodia|MM Myanmar|AU Australia|NZ New Zealand|JP Japan|KR South Korea|HK Hong Kong|TW Taiwan|CN China'.split('|').map((x) => [x.slice(0, 2), x.slice(3)]);

const T = {
  en: { cart: 'Cart', account: 'Account', products: 'Products', empty: 'Your cart is empty.', browse: 'Browse products', item: 'Item', qty: 'Qty', price: 'Unit price', total: 'Total', subtotal: 'Subtotal', shipping: 'Shipping', update: 'Update', remove: 'Remove', checkout: 'Checkout', moq: 'Min. order', notAvail: 'No longer available — please remove it.', oos: 'Only {n} available.', noWeight: 'Shipping for this item is quoted by our sales team — please request a quote instead.', contact: 'Contact', email: 'E-mail', address: 'Shipping address', name: 'Full name', company: 'Company (optional)', phone: 'Phone', line1: 'Address line 1', line2: 'Address line 2 (optional)', city: 'City', state: 'State / province', postcode: 'Postcode', country: 'Country', chooseCountry: 'Choose a country', ship: 'Shipping method', days: 'days', free: 'Free', pay: 'Payment', stripe: 'Card / Apple Pay / Google Pay (Stripe)', paypal: 'PayPal', tt: 'Bank transfer (T/T)', note: 'Order note (optional)', place: 'Place order', haveAccount: 'Have an account?', login: 'Log in', register: 'Create account', logout: 'Log out', password: 'Password', forgot: 'Forgot password?', orders: 'My orders', addresses: 'Addresses', order: 'Order', status: 'Status', placed: 'Placed', payNow: 'Pay now', payWith: 'Pay with', bank: 'Bank transfer details', bankRef: 'Payment reference', bankMissing: 'Our finance team will e-mail you the bank details. Always confirm bank details by phone before paying — we never change them by e-mail.', paid: 'Paid', due: 'Balance due', save: 'Save', saved: 'Saved', default: 'Default', reset: 'Set a new password', resetSent: 'If an account exists for that address, we have sent a link.', verify: 'E-mail confirmed. Thank you!', invalidLink: 'This link is invalid or has expired.', regSent: 'Check your e-mail — we sent a link to finish setting up your account.', processing: 'Thank you! Your payment is being confirmed — you will receive an e-mail shortly.', cancelled: 'Payment was cancelled. You can try again below.', expires: 'Please pay by', trackOrder: 'Track this order', guest: 'Guest checkout — or', newAddr: 'Add an address', useAddr: 'Use a saved address', lang: '中文', shipTo: 'Ship to', tracking: 'Tracking', reference: 'Reference only' },
  zh: { cart: '购物车', account: '我的账户', products: '产品', empty: '购物车是空的。', browse: '去选购', item: '商品', qty: '数量', price: '单价', total: '小计', subtotal: '商品金额', shipping: '运费', update: '更新', remove: '删除', checkout: '去结算', moq: '起订量', notAvail: '该商品已下架，请删除。', oos: '库存仅剩 {n}。', noWeight: '该商品运费需业务员报价，请改为询价。', contact: '联系方式', email: '邮箱', address: '收货地址', name: '收件人', company: '公司（选填）', phone: '电话', line1: '详细地址', line2: '地址第二行（选填）', city: '城市', state: '州/省', postcode: '邮编', country: '国家/地区', chooseCountry: '请选择国家', ship: '配送方式', days: '天', free: '包邮', pay: '付款方式', stripe: '银行卡 / Apple Pay / Google Pay（Stripe）', paypal: 'PayPal', tt: '银行电汇（T/T）', note: '订单备注（选填）', place: '提交订单', haveAccount: '已有账户？', login: '登录', register: '注册', logout: '退出', password: '密码', forgot: '忘记密码？', orders: '我的订单', addresses: '收货地址', order: '订单', status: '状态', placed: '下单时间', payNow: '立即付款', payWith: '付款方式', bank: '电汇收款信息', bankRef: '付款附言', bankMissing: '财务会通过邮件发送收款账户。付款前请务必电话核实账户，我们不会通过邮件更改收款账户。', paid: '已付', due: '待付', save: '保存', saved: '已保存', default: '默认', reset: '设置新密码', resetSent: '如果该邮箱已注册，我们已发送链接。', verify: '邮箱已验证，谢谢！', invalidLink: '链接无效或已过期。', regSent: '请查收邮件，按链接完成账户设置。', processing: '谢谢！正在确认付款，稍后会收到邮件通知。', cancelled: '付款已取消，可以在下方重新付款。', expires: '请在此时间前付款', trackOrder: '查看订单', guest: '游客结算，或', newAddr: '新增地址', useAddr: '使用已保存的地址', lang: 'English', shipTo: '收货地址', tracking: '物流', reference: '仅供参考' },
};

const money = (cur, n) => `${cur === 'USD' ? 'US$' : cur + ' '}${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const langOf = (c) => { const q = c.req.query('lang'); if (q === 'zh' || q === 'en') return q; const k = getCookie(c, 'yr_lang'); return config.site === 'grid' && k === 'zh' ? 'zh' : 'en'; };
const nm = (lang, i) => (lang === 'zh' && i.nameZh) || i.name;

function page(c, title, body, { lang, customer, cartCount = null }) {
  const b = brand();
  const t = T[lang];
  const count = cartCount ?? viewCart(currentCartId(c)).count;
  const other = lang === 'zh' ? 'en' : 'zh';
  return c.html(`<!doctype html><html lang="${lang === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)} | ${esc(b.brand)}</title><style>
:root{--a:${b.accent};--b:${b.accent2};--line:#dde3e8;--mute:#5f6b77;--bg:#f4f6f8}*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:#18222d;font:15px/1.55 -apple-system,"Segoe UI",Arial,"PingFang SC","Microsoft YaHei",sans-serif}
header{background:var(--a);color:#fff;border-bottom:4px solid var(--b)}header .in{max-width:1080px;margin:auto;padding:12px 20px;display:flex;gap:18px;align-items:center;flex-wrap:wrap}
header a{color:#fff;text-decoration:none}header .brand{font-weight:700;font-size:18px;letter-spacing:.03em;margin-right:auto}.badge{background:var(--b);color:#111;border-radius:999px;padding:0 7px;font-size:12px;font-weight:700;margin-left:4px}
main{max-width:1080px;margin:auto;padding:26px 20px 70px}h1{font-size:26px;margin:0 0 16px}h2{font-size:18px;margin:22px 0 10px}
.card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:18px 20px;margin-bottom:14px}.mute{color:var(--mute)}.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:middle}th{font-size:12.5px;color:var(--mute);font-weight:600}
input,select,textarea{font:inherit;padding:9px 11px;border:1px solid #c3ccd5;border-radius:6px;background:#fff;width:100%}label{display:grid;gap:5px;font-size:14px;font-weight:600}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.btn{display:inline-block;background:var(--a);color:#fff;border:0;padding:12px 20px;border-radius:7px;font:600 15px/1 inherit;cursor:pointer;text-decoration:none}
.btn.l{background:#fff;color:var(--a);border:1px solid var(--a)}.btn.sm{padding:7px 12px;font-size:13px}.inline{display:inline}.qty{width:90px}.thumb{width:56px;height:56px;object-fit:cover;border-radius:6px;background:#eef1f4}
.note{padding:12px 16px;border-radius:8px;margin-bottom:14px;background:#e8f5e9;border:1px solid #a5d6a7}.note.err{background:#fdecea;border-color:#f5b7b1}.note.warn{background:#fff8e1;border-color:#ffe082}
.prob{color:#b71c1c;font-size:13px}.cols{display:grid;grid-template-columns:1.6fr 1fr;gap:18px}.opt{display:flex;gap:10px;align-items:flex-start;padding:10px;border:1px solid var(--line);border-radius:8px;margin-bottom:8px;font-weight:400}.opt input{width:auto;margin-top:4px}
.sum td{border:0;padding:4px 0}.sum .t td{font-weight:700;font-size:17px;border-top:1px solid var(--line);padding-top:10px}
.steps{display:flex;list-style:none;padding:0;margin:6px 0 4px;overflow-x:auto}.steps li{flex:1;min-width:90px;text-align:center;font-size:12.5px;color:var(--mute);position:relative;padding-top:22px}
.steps li::before{content:'';position:absolute;top:6px;left:50%;width:12px;height:12px;margin-left:-6px;border-radius:50%;background:#cfd8df}.steps li.done{color:#18222d}.steps li.done::before{background:var(--a)}
@media(max-width:760px){.cols{grid-template-columns:1fr}th.h,td.h{display:none}}
</style></head><body><header><div class="in"><a class="brand" href="/">${esc(b.brand)}</a><a href="/products/">${t.products}</a><a href="/shop/cart" data-cart-link>${t.cart}${count ? `<span class="badge">${count}</span>` : ''}</a>
<a href="/shop/account">${customer ? esc(customer.contact || customer.email) : t.account}</a>${config.site === 'grid' ? `<a href="?lang=${other}">${T[lang].lang}</a>` : ''}</div></header><main>${body}</main></body></html>`);
}

const currentCartId = (c) => c.get?.('cartId') || getCookie(c, CART);
function ctx(c) {
  const lang = langOf(c);
  const customer = A.sessionCustomer(getCookie(c, CUST));
  const cart = resolveCart(getCookie(c, CART), customer);
  if (cart && getCookie(c, CART) !== cart.id) setCookie(c, CART, cart.id, { httpOnly: true, sameSite: 'Lax', secure: secure(), path: '/', maxAge: 60 * 86400 });
  c.set('cartId', cart?.id || null);
  return { lang, t: T[lang], customer, cart };
}
function ensureCart(c, x) {
  if (x.cart) return x.cart;
  const cart = createCart(x.customer?.id || null);
  setCookie(c, CART, cart.id, { httpOnly: true, sameSite: 'Lax', secure: secure(), path: '/', maxAge: 60 * 86400 });
  c.set('cartId', cart.id);
  return cart;
}
const msg = (c) => {
  const m = c.req.query('m'), e = c.req.query('e'), w = c.req.query('w');
  return `${m ? `<div class="note">${esc(m)}</div>` : ''}${w ? `<div class="note warn">${esc(w)}</div>` : ''}${e ? `<div class="note err">${esc(e)}</div>` : ''}`;
};
const go = (c, path, q = {}) => c.redirect(path + (Object.keys(q).length ? (path.includes('?') ? '&' : '?') + new URLSearchParams(q) : ''));

// ---------------------------------------------------------------- pages
function cartPage(c, x) {
  const { t, lang } = x;
  const v = viewCart(x.cart?.id);
  if (!v.items.length) return page(c, t.cart, `<h1>${t.cart}</h1>${msg(c)}<div class="card"><p>${t.empty}</p><a class="btn" href="/products/">${t.browse}</a></div>`, { ...x, cartCount: 0 });
  const rows = v.items.map((i) => {
    if (i.problems.includes('not_available')) return `<tr><td colspan="4">${esc(i.sku)}<div class="prob">${t.notAvail}</div></td><td><form method="post" action="/shop/cart/remove"><input type="hidden" name="sku" value="${esc(i.sku)}"><button class="btn l sm">${t.remove}</button></form></td></tr>`;
    const probs = [i.problems.includes('out_of_stock') ? t.oos.replace('{n}', i.available) : '', i.problems.includes('no_weight') ? t.noWeight : ''].filter(Boolean);
    return `<tr><td>${i.image ? `<img class="thumb" src="${esc(i.image)}" alt="">` : ''}</td><td><a href="/products/${esc(i.slug)}/"><b>${esc(nm(lang, i))}</b></a><div class="mute">${esc(i.label || '')} · ${esc(i.sku)} · ${t.moq} ${i.minQty}</div>${probs.map((p) => `<div class="prob">${esc(p)}</div>`).join('')}</td>
<td class="n h">${money(v.currency, i.unitPrice)}${i.unitPrice < i.basePrice ? `<div class="mute"><s>${money(v.currency, i.basePrice)}</s></div>` : ''}</td>
<td><form method="post" action="/shop/cart/update" class="inline"><input type="hidden" name="sku" value="${esc(i.sku)}"><input class="qty" name="qty" type="number" min="${i.minQty}" value="${i.qty}"> <button class="btn l sm">${t.update}</button></form></td>
<td class="n">${money(v.currency, i.lineTotal)}<form method="post" action="/shop/cart/remove"><input type="hidden" name="sku" value="${esc(i.sku)}"><button class="btn l sm" style="margin-top:6px">${t.remove}</button></form></td></tr>`;
  }).join('');
  return page(c, t.cart, `<h1>${t.cart}</h1>${msg(c)}<div class="card"><table><thead><tr><th></th><th>${t.item}</th><th class="n h">${t.price}</th><th>${t.qty}</th><th class="n">${t.total}</th></tr></thead><tbody>${rows}</tbody></table>
<p class="n" style="font-size:18px;margin:14px 0"><b>${t.subtotal}: ${money(v.currency, v.subtotal)}</b></p><p class="n">${v.ok ? `<a class="btn" href="/shop/checkout">${t.checkout}</a>` : ''}</p></div>`, { ...x, cartCount: v.count });
}

function checkoutPage(c, x, { error = '', form = {} } = {}) {
  const { t, lang, customer } = x;
  const v = viewCart(x.cart?.id);
  if (!v.items.length || !v.ok) return go(c, '/shop/cart');
  const saved = customer ? A.listAddresses(customer.id) : [];
  const def = saved[0] || {};
  const f = { ...def, email: customer?.email || '', ...form };
  const country = String(c.req.query('country') || f.country || '').toUpperCase();
  const opts = country ? quoteShipping({ country, weightKg: v.weightKg, cbm: v.cbm, subtotal: v.subtotal }) : [];
  const methods = P.enabledMethods();
  const inp = (k, req = true, type = 'text') => `<label>${t[k]}<input name="${k}" type="${type}" value="${esc(f[k] || '')}"${req ? ' required' : ''}></label>`;
  return page(c, t.checkout, `<h1>${t.checkout}</h1>${error ? `<div class="note err">${esc(error)}</div>` : ''}<form method="post" action="/shop/checkout"><div class="cols"><div>
<div class="card"><h2 style="margin-top:0">${t.contact}</h2>${customer ? `<p>${esc(customer.email)}</p><input type="hidden" name="email" value="${esc(customer.email)}">` : `<p class="mute">${t.guest} <a href="/shop/account/login?next=/shop/checkout">${t.login}</a></p>${inp('email', true, 'email')}`}</div>
<div class="card"><h2 style="margin-top:0">${t.address}</h2><div class="grid">${inp('name')}${inp('company', false)}${inp('phone', true, 'tel')}</div>${inp('line1')}${inp('line2', false)}<div class="grid">${inp('city')}${inp('state', false)}${inp('postcode', false)}
<label>${t.country}<select name="country" required onchange="location.search='?country='+this.value"><option value="">${t.chooseCountry}</option>${COUNTRIES.map(([k, n]) => `<option value="${k}"${k === country ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select></label></div></div>
<div class="card"><h2 style="margin-top:0">${t.ship}</h2>${country ? opts.map((o, i) => `<label class="opt"><input type="radio" name="zone" value="${o.zoneId}"${i === 0 ? ' checked' : ''}><span><b>${esc(o.name)}</b> — ${o.free ? t.free : money(v.currency, o.fee)}<br><span class="mute">${o.days[0]}–${o.days[1]} ${t.days}${o.freeOver != null && !o.free ? ` · ${t.free} ≥ ${money(v.currency, o.freeOver)}` : ''}</span></span></label>`).join('') || '<p class="prob">—</p>' : `<p class="mute">${t.chooseCountry}</p>`}</div>
<div class="card"><h2 style="margin-top:0">${t.pay}</h2>${methods.map((m, i) => `<label class="opt"><input type="radio" name="payment" value="${m}"${i === 0 ? ' checked' : ''}><span>${t[m]}</span></label>`).join('')}<label>${t.note}<textarea name="note" rows="2">${esc(f.note || '')}</textarea></label></div></div>
<div><div class="card"><h2 style="margin-top:0">${t.cart}</h2><table class="sum">${v.items.map((i) => `<tr><td>${i.qty} × ${esc(nm(lang, i))}<div class="mute">${esc(i.label || '')}</div></td><td class="n">${money(v.currency, i.lineTotal)}</td></tr>`).join('')}
<tr><td>${t.subtotal}</td><td class="n">${money(v.currency, v.subtotal)}</td></tr><tr><td>${t.shipping}</td><td class="n">${opts[0] ? (opts[0].free ? t.free : money(v.currency, opts[0].fee)) : '—'}</td></tr>
<tr class="t"><td>${t.total}</td><td class="n">${opts[0] ? money(v.currency, v.subtotal + opts[0].fee) : '—'}</td></tr></table><button class="btn" style="width:100%;margin-top:14px"${opts.length ? '' : ' disabled'}>${t.place}</button></div></div></div></form>`, { ...x, cartCount: v.count });
}

function orderPage(c, x, o) {
  const { t, lang } = x;
  const addr = JSON.parse(o.shipping_address || '{}');
  const tl = DICT.order.timelineShop;
  const idx = tl.indexOf(o.status);
  const ships = shipmentsFor(o.id).filter((s) => !s.rma_id);
  const b = brand();
  const pending = o.status === 'pending_payment';
  const methods = P.enabledMethods();
  const tok = encodeURIComponent(o.access_token);
  const bank = b.bank ? `<table class="sum">${Object.entries(b.bank).map(([k, v2]) => `<tr><td class="mute">${esc(k)}</td><td>${esc(v2)}</td></tr>`).join('')}<tr><td class="mute">${t.bankRef}</td><td><b>${esc(o.number)}</b></td></tr></table>` : `<p>${t.bankMissing}</p><p>${t.bankRef}: <b>${esc(o.number)}</b></p>`;
  const back = c.req.query('paid') ? `<div class="note">${t.processing}</div>` : c.req.query('cancelled') && pending ? `<div class="note warn">${t.cancelled}</div>` : '';
  return page(c, `${t.order} ${o.number}`, `<h1>${t.order} ${esc(o.number)}</h1>${back}${msg(c)}
<div class="card">${o.status === 'cancelled' ? `<p><b>${esc(label('order', 'cancelled', lang))}</b></p>` : `<ol class="steps">${tl.map((s, i) => `<li class="${i <= idx ? 'done' : ''}">${esc(label('order', s, lang))}</li>`).join('')}</ol>`}
<p class="mute">${t.placed}: ${esc(o.created_at.slice(0, 16).replace('T', ' '))} UTC${pending ? ` · ${t.expires}: ${esc(String(o.expires_at).slice(0, 16).replace('T', ' '))} UTC` : ''}</p></div>
${pending ? `<div class="card"><h2 style="margin-top:0">${t.payNow}</h2>${o.payment_method === 'tt' ? `<h3>${t.bank}</h3>${bank}` : ''}<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px">${methods.filter((m) => m !== 'tt').map((m) => `<form method="post" action="/shop/order/${encodeURIComponent(o.number)}/pay?t=${tok}"><input type="hidden" name="method" value="${m}"><button class="btn">${t.payWith} ${m === 'stripe' ? 'Card' : 'PayPal'}</button></form>`).join('')}</div></div>` : ''}
<div class="card"><table><tbody>${o.lines.map((l) => `<tr><td>${l.qty} × ${esc(l.name)} <span class="mute">${esc(l.variant || '')}</span></td><td class="n">${money(o.currency, l.amount)}</td></tr>`).join('')}
<tr><td>${t.shipping} <span class="mute">${esc(o.shipping_method || '')}</span></td><td class="n">${money(o.currency, o.shipping_fee || 0)}</td></tr><tr><td><b>${t.total}</b></td><td class="n"><b>${money(o.currency, o.total)}</b></td></tr>
<tr><td>${t.paid}</td><td class="n">${money(o.currency, o.paid)}</td></tr><tr><td>${t.due}</td><td class="n">${money(o.currency, Math.max(0, o.total - o.paid))}</td></tr></tbody></table></div>
<div class="card"><b>${t.shipTo}</b><p>${esc(addr.name)}${addr.company ? ', ' + esc(addr.company) : ''}<br>${esc(addr.line1)}${addr.line2 ? '<br>' + esc(addr.line2) : ''}<br>${esc(addr.city)} ${esc(addr.state || '')} ${esc(addr.postcode || '')}<br>${esc(addr.country)} · ${esc(addr.phone)}</p>
${ships.map((s) => `<p><b>${t.tracking}</b>: ${esc(s.carrier)} ${esc(s.tracking_no)} — ${esc(label('shipment', s.status, lang))}${s.eta ? ` · ETA ${esc(s.eta)}` : ''}</p>`).join('')}</div>`, x);
}

const authPage = (c, x, title, inner) => page(c, title, `<div style="max-width:440px;margin:auto"><h1>${title}</h1>${msg(c)}<div class="card">${inner}</div></div>`, x);

function accountPage(c, x) {
  const { t, lang, customer } = x;
  const orders = ordersOfCustomer(customer.id);
  const addrs = A.listAddresses(customer.id);
  return page(c, t.account, `<h1>${t.account}</h1>${msg(c)}<p>${esc(customer.email)}${customer.email_verified ? '' : ' <span class="mute">(unverified)</span>'} · <form class="inline" method="post" action="/shop/account/logout"><button class="btn l sm">${t.logout}</button></form></p>
<h2>${t.orders}</h2><div class="card">${orders.length ? `<table><tbody>${orders.map((o) => `<tr><td><b>${esc(o.number)}</b></td><td class="h">${esc(o.created_at.slice(0, 10))}</td><td>${esc(label('order', o.status, lang))}</td><td class="n">${money(o.currency, o.total)}</td><td>${o.channel === 'shop' ? `<a href="/shop/order/${encodeURIComponent(o.number)}?t=${encodeURIComponent(o.access_token)}">${t.trackOrder}</a>` : `<a href="/portal/c/${encodeURIComponent(customer.portal_token)}/o/${encodeURIComponent(o.number)}">${t.trackOrder}</a>`}</td></tr>`).join('')}</tbody></table>` : `<p class="mute">—</p>`}</div>
<h2>${t.addresses}</h2>${addrs.map((a) => `<div class="card">${esc(a.name)} · ${esc(a.line1)}, ${esc(a.city)}, ${esc(a.country)} ${a.is_default ? `<b>(${t.default})</b>` : ''}<form class="inline" method="post" action="/shop/account/address/${a.id}/delete"> <button class="btn l sm">${t.remove}</button></form></div>`).join('')}
<div class="card"><b>${t.newAddr}</b><form method="post" action="/shop/account/address" class="grid" style="margin-top:10px">${['name', 'company', 'phone', 'line1', 'line2', 'city', 'state', 'postcode'].map((k) => `<label>${t[k]}<input name="${k}"></label>`).join('')}<label>${t.country}<select name="country"><option value=""></option>${COUNTRIES.map(([k, n]) => `<option value="${k}">${esc(n)}</option>`).join('')}</select></label><button class="btn">${t.save}</button></form></div>`, x);
}

// ---------------------------------------------------------------- routes
export function mountShop(app, { ipOf }) {
  // --- JSON API for the buy box on static product pages ---
  app.get('/api/shop/product/:id', (c) => {
    const p = config.catalog.products.find((x) => x.id === c.req.param('id'));
    if (!p) return c.json({ error: 'not_found' }, 404);
    const avail = availableBySku();
    return c.json({ id: p.id, salesMode: p.salesMode || 'inquiry', currency: config.catalog.currency, unit: p.unit,
      variants: (p.variants || []).filter((v) => v.price > 0).map((v) => ({ sku: v.sku, label: v.label, options: v.options, price: v.price, compareAt: v.compareAt, tiers: v.tiers, minQty: v.minQty, available: Math.max(0, avail.get(v.sku) || 0) })) });
  });
  app.get('/api/shop/cart', (c) => { const x = ctx(c); const v = viewCart(x.cart?.id); return c.json({ count: v.count, subtotal: v.subtotal, currency: v.currency }); });
  app.post('/api/shop/cart', async (c) => {
    if (!/application\/json/.test(c.req.header('content-type') || '')) return c.json({ error: 'json_required' }, 415);
    const b = await c.req.json().catch(() => ({}));
    const x = ctx(c);
    const cart = ensureCart(c, x);
    try {
      const r = setItem(cart.id, String(b.sku || ''), b.qty ?? 1);
      const v = viewCart(cart.id);
      return c.json({ ok: true, qty: r.qty, raisedToMoq: r.raisedToMoq, count: v.count, subtotal: v.subtotal, currency: v.currency });
    } catch (e) { return c.json({ error: e.code || 'error' }, 400); }
  });

  // --- cart ---
  app.get('/shop', (c) => c.redirect('/shop/cart'));
  app.get('/shop/cart', (c) => cartPage(c, ctx(c)));
  app.post('/shop/cart/update', async (c) => {
    const f = await c.req.parseBody();
    const x = ctx(c);
    if (!x.cart) return go(c, '/shop/cart');
    try { const r = setItem(x.cart.id, String(f.sku), f.qty, { set: true }); return go(c, '/shop/cart', r.raisedToMoq ? { w: `${x.t.moq}: ${r.qty}` } : {}); } catch (e) { return go(c, '/shop/cart', { e: x.t.notAvail }); }
  });
  app.post('/shop/cart/remove', async (c) => { const f = await c.req.parseBody(); const x = ctx(c); if (x.cart) removeItem(x.cart.id, String(f.sku)); return go(c, '/shop/cart'); });

  // --- checkout ---
  app.get('/shop/checkout', (c) => checkoutPage(c, ctx(c)));
  app.post('/shop/checkout', async (c) => {
    const f = await c.req.parseBody();
    const x = ctx(c);
    if (!x.cart) return go(c, '/shop/cart');
    try {
      const o = placeOrder({ cartId: x.cart.id, customer: x.customer, email: f.email, address: f, zoneId: f.zone, payment: String(f.payment || ''), note: f.note, lang: x.lang });
      if (x.customer) { const a = { ...f }; delete a.id; try { if (!A.listAddresses(x.customer.id).some((s) => s.line1 === a.line1 && s.city === a.city)) A.saveAddress(x.customer.id, a, x.lang); } catch { /* optional */ } }
      const url = `${config.publicBaseUrl}/shop/order/${encodeURIComponent(o.number)}?t=${encodeURIComponent(o.access_token)}`;
      await sendMail(String(x.customer?.email || f.email), `${config.profile.brand}: order ${o.number} received`, `Thank you for your order ${o.number} (${o.currency} ${o.total}).\n${o.payment_method === 'tt' ? `Please pay by bank transfer quoting ${o.number}. Payment details: ${url}` : 'If you have not completed payment yet, you can pay here:'}\n${url}`);
      if (o.payment_method === 'tt') return c.redirect(url.replace(config.publicBaseUrl, ''));
      return payRedirect(c, o, o.payment_method);
    } catch (e) {
      if (e instanceof CheckoutError || e.errors) return checkoutPage(c, x, { error: e.message, form: f });
      throw e;
    }
  });

  // --- order page & payment ---
  app.get('/shop/order/:no', (c) => {
    const x = ctx(c);
    const o = orderByAccess(c.req.param('no'), c.req.query('t'));
    if (!o) { c.status(404); return page(c, 'Not found', `<div class="card">${x.t.invalidLink}</div>`, x); }
    return orderPage(c, x, o);
  });
  app.post('/shop/order/:no/pay', async (c) => {
    const o = orderByAccess(c.req.param('no'), c.req.query('t'));
    if (!o || o.status !== 'pending_payment') return c.text('Not found', 404);
    const f = await c.req.parseBody();
    if (!P.enabledMethods().includes(String(f.method)) || f.method === 'tt') return c.text('Bad method', 400);
    return payRedirect(c, o, String(f.method));
  });
  async function payRedirect(c, o, method) {
    const base = `${config.publicBaseUrl}/shop/order/${encodeURIComponent(o.number)}?t=${encodeURIComponent(o.access_token)}`;
    try {
      if (method === 'stripe') return c.redirect(await P.stripeCheckout(o, { successUrl: `${base}&paid=1`, cancelUrl: `${base}&cancelled=1` }));
      if (method === 'paypal') return c.redirect(await P.paypalCheckout(o, { returnUrl: `${config.publicBaseUrl}/shop/pay/paypal/return?o=${encodeURIComponent(o.number)}&t=${encodeURIComponent(o.access_token)}`, cancelUrl: `${base}&cancelled=1` }));
    } catch (e) {
      console.error('[pay]', e.message);
      return c.redirect(`${base.replace(config.publicBaseUrl, '')}&e=${encodeURIComponent('Payment service unavailable, please try again or choose another method.')}`);
    }
    return c.redirect(base.replace(config.publicBaseUrl, ''));
  }
  app.get('/shop/pay/paypal/return', async (c) => {
    const o = orderByAccess(c.req.query('o'), c.req.query('t'));
    if (!o) return c.text('Not found', 404);
    const path = `/shop/order/${encodeURIComponent(o.number)}?t=${encodeURIComponent(o.access_token)}`;
    try {
      const r = await P.paypalCapture(String(c.req.query('token') || ''));
      if (r.orderId !== o.id) return c.redirect(`${path}&e=${encodeURIComponent('Payment does not belong to this order.')}`);
      return c.redirect(`${path}&${r.result === 'paid' || r.result === 'duplicate' ? 'm=' + encodeURIComponent(T[langOf(c)].processing) : 'e=' + encodeURIComponent('Payment was not completed.')}`);
    } catch (e) { return c.redirect(`${path}&e=${encodeURIComponent('Payment could not be confirmed. If you were charged, contact us.')}`); }
  });
  app.post('/api/pay/stripe/webhook', async (c) => {
    const raw = await c.req.text();
    if (!P.verifyStripeSignature(raw, c.req.header('stripe-signature'))) return c.text('bad signature', 400);
    let event;
    try { event = JSON.parse(raw); } catch { return c.text('bad json', 400); }
    return c.json({ received: true, result: P.handleStripeEvent(event) });
  });

  // --- accounts ---
  const login = (c, cust) => setCookie(c, CUST, A.createSession(cust), { httpOnly: true, sameSite: 'Lax', secure: secure(), path: '/', maxAge: 30 * 86400 });
  const nextOf = (v) => (/^\/(shop|portal)(\/|$)/.test(String(v || '')) ? String(v) : '/shop/account');
  app.get('/shop/account', (c) => { const x = ctx(c); return x.customer ? accountPage(c, x) : go(c, '/shop/account/login'); });
  app.get('/shop/account/login', (c) => {
    const x = ctx(c); const t = x.t;
    return authPage(c, x, t.login, `<form method="post" style="display:grid;gap:12px"><input type="hidden" name="next" value="${esc(nextOf(c.req.query('next')))}"><label>${t.email}<input name="email" type="email" required></label><label>${t.password}<input name="password" type="password" required></label><button class="btn">${t.login}</button></form>
<p><a href="/shop/account/forgot">${t.forgot}</a> · <a href="/shop/account/register">${t.register}</a></p>`);
  });
  app.post('/shop/account/login', async (c) => {
    const f = await c.req.parseBody(); const x = ctx(c);
    const r = A.login(String(f.email || ''), String(f.password || ''), ipOf(c), x.lang);
    if (!r.customer) return go(c, '/shop/account/login', { e: r.error });
    login(c, r.customer);
    resolveCart(getCookie(c, CART), r.customer); // merge the guest cart
    return c.redirect(nextOf(f.next));
  });
  app.post('/shop/account/logout', (c) => { A.endSession(getCookie(c, CUST)); deleteCookie(c, CUST, { path: '/' }); deleteCookie(c, CART, { path: '/' }); return c.redirect('/shop/account/login'); });
  app.get('/shop/account/register', (c) => {
    const x = ctx(c); const t = x.t;
    return authPage(c, x, t.register, `<form method="post" style="display:grid;gap:12px"><label>${t.email}<input name="email" type="email" required></label><label>${t.name}<input name="name"></label><label>${t.company}<input name="company"></label><label>${t.password}<input name="password" type="password" minlength="8" required></label>
<label style="font-weight:400"><input type="checkbox" name="marketing" value="1" style="width:auto"> Send me product news (optional)</label><button class="btn">${t.register}</button></form><p>${t.haveAccount} <a href="/shop/account/login">${t.login}</a></p>`);
  });
  app.post('/shop/account/register', async (c) => {
    const f = await c.req.parseBody(); const x = ctx(c);
    try {
      const r = await A.register({ email: f.email, password: String(f.password || ''), name: f.name, company: f.company, marketing: f.marketing === '1', lang: x.lang });
      if (r.emailSent) return go(c, '/shop/account/login', { m: x.t.regSent });
      login(c, r.customer);
      resolveCart(getCookie(c, CART), r.customer);
      return go(c, '/shop/account', { m: x.t.regSent });
    } catch (e) { return go(c, '/shop/account/register', { e: e.message }); }
  });
  app.get('/shop/account/verify', (c) => { const x = ctx(c); const ok = A.verifyEmail(c.req.query('t')); return authPage(c, x, x.t.account, ok ? x.t.verify : x.t.invalidLink); });
  app.get('/shop/account/forgot', (c) => { const x = ctx(c); return authPage(c, x, x.t.forgot, `<form method="post" style="display:grid;gap:12px"><label>${x.t.email}<input name="email" type="email" required></label><button class="btn">${x.t.reset}</button></form>`); });
  app.post('/shop/account/forgot', async (c) => { const f = await c.req.parseBody(); const x = ctx(c); await A.requestReset(String(f.email || '')); return go(c, '/shop/account/login', { m: x.t.resetSent }); });
  app.get('/shop/account/reset', (c) => { const x = ctx(c); return authPage(c, x, x.t.reset, `<form method="post" style="display:grid;gap:12px"><input type="hidden" name="t" value="${esc(c.req.query('t') || '')}"><label>${x.t.password}<input name="password" type="password" minlength="8" required></label><button class="btn">${x.t.save}</button></form>`); });
  app.post('/shop/account/reset', async (c) => {
    const f = await c.req.parseBody(); const x = ctx(c);
    try { const cust = A.resetPassword(String(f.t || ''), String(f.password || ''), x.lang); login(c, cust); return go(c, '/shop/account', { m: x.t.saved }); } catch (e) { return go(c, `/shop/account/reset?t=${encodeURIComponent(String(f.t || ''))}`, { e: e.message }); }
  });
  app.post('/shop/account/address', async (c) => {
    const x = ctx(c); if (!x.customer) return go(c, '/shop/account/login');
    const f = await c.req.parseBody();
    try { A.saveAddress(x.customer.id, f, x.lang); return go(c, '/shop/account', { m: x.t.saved }); } catch (e) { return go(c, '/shop/account', { e: e.message }); }
  });
  app.post('/shop/account/address/:id/delete', (c) => { const x = ctx(c); if (!x.customer) return go(c, '/shop/account/login'); A.deleteAddress(x.customer.id, c.req.param('id')); return go(c, '/shop/account'); });
}

export { COUNTRIES, unitPrice, sellable };
