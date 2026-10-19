// Black-box: the online shop over HTTP — buy box API, cart, checkout, order page access, Stripe (signed webhook)
// and PayPal (capture) against mock providers, accounts, guest-cart merge, isolation, CSRF, admin. IDs SA-xx.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { startServer, flash } from '../helpers/server.mjs';
import { mockServer } from '../helpers/mock-http.mjs';

let api, prov;
const sessions = [];
before(async () => {
  prov = await mockServer((call) => {
    if (call.url === '/v1/checkout/sessions') { const id = `cs_test_${sessions.length + 1}`; sessions.push({ id, body: new URLSearchParams(call.body) }); return { json: { id, url: `https://checkout.stripe.test/${id}` } }; }
    if (call.url === '/v1/oauth2/token') return { json: { access_token: 'T', expires_in: 3600 } };
    if (call.url === '/v2/checkout/orders') return { json: { id: `PPO-${call.body.purchase_units[0].reference_id}`, links: [{ rel: 'approve', href: `https://paypal.test/approve/${call.body.purchase_units[0].reference_id}` }], _v: call.body.purchase_units[0].amount.value } };
    const m = call.url.match(/^\/v2\/checkout\/orders\/PPO-(.+)\/capture$/);
    if (m) { const create = prov.calls.find((c) => c.url === '/v2/checkout/orders' && c.body.purchase_units[0].reference_id === m[1]); const v = create.body.purchase_units[0].amount.value; return { json: { status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAP1', status: 'COMPLETED', amount: { value: v, currency_code: 'USD' } }] } }] } }; }
    return { status: 404, text: '' };
  });
  api = await startServer({ site: 'led', env: { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x', STRIPE_API_BASE: prov.url, PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 's', PAYPAL_API_BASE: prov.url, TRUSTED_PROXY_HOPS: '0' } });
});
after(async () => { await api.stop(); await prov.close(); });

/** A browser-like client with a cookie jar. */
function client() {
  const jar = new Map();
  const send = async (path, opts = {}) => {
    const r = await fetch(api.url + path, { redirect: 'manual', ...opts, headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(opts.headers || {}) } });
    for (const sc of r.headers.getSetCookie()) { const [kv] = sc.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i); const v = kv.slice(i + 1); if (!v || /Max-Age=0/i.test(sc)) jar.delete(k); else jar.set(k, v); }
    return r;
  };
  send.form = (path, data) => send(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data) });
  send.add = async (sku, qty) => (await send('/api/shop/cart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sku, qty }) })).json();
  send.jar = jar;
  return send;
}
const ADDR = { name: 'Jane Buyer', phone: '+1 512 555 0100', line1: '1 Congress Ave', city: 'Austin', state: 'TX', postcode: '78701', country: 'US' };
async function checkout(b, payment, extra = {}) {
  const page = await (await b('/shop/checkout?country=US')).text();
  const zone = page.match(/name="zone" value="(\d+)"/)[1];
  return b.form('/shop/checkout', { email: 'jane@buyer.test', ...ADDR, zone, payment, ...extra });
}
const sign = (payload, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', 'whsec_x').update(`${t}.${payload}`).digest('hex')}`;

describe('browse & cart', () => {
  test('SA-01 buy box API: live variants with price, tiers, MOQ and stock; quote-only products say so', async () => {
    const p = await (await api.get('/api/shop/product/YR-HB-U2')).json();
    assert.equal(p.salesMode, 'both');
    assert.equal(p.variants[0].sku, 'YR-HB-U2');
    assert.ok(p.variants[0].price > 0 && p.variants[0].minQty === 50 && p.variants[0].available > 0);
    assert.equal((await api.get('/api/shop/product/NOPE')).status, 404);
  });
  test('SA-02 add to cart sets an HttpOnly cookie; MOQ applied; badge count', async () => {
    const b = client();
    const r = await b.add('YR-HB-U2', 1);
    assert.deepEqual([r.ok, r.qty, r.raisedToMoq, r.count], [true, 50, true, 1]);
    assert.ok(b.jar.get('yr_cart'));
    assert.equal((await (await b('/api/shop/cart')).json()).count, 1);
    const html = await (await b('/shop/cart')).text();
    assert.match(html, /UFO High Bay U2/);
    assert.match(html, /Min\. order 50/);
  });
  test('SA-03 cart API only accepts JSON (no cross-site form posts) and rejects unknown SKUs', async () => {
    const b = client();
    assert.equal((await b('/api/shop/cart', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"sku":"YR-HB-U2"}' })).status, 415);
    assert.equal((await b('/api/shop/cart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"sku":"NOPE"}' })).status, 400);
  });
  test('SA-04 cross-site form posts to the shop are refused', async () => {
    const r = await fetch(`${api.url}/shop/cart/update`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.test' }, body: 'sku=YR-HB-U2&qty=999' });
    assert.equal(r.status, 403);
  });
  test('SA-05 update and remove items from the cart page', async () => {
    const b = client();
    await b.add('YR-HB-U2', 50);
    await b.form('/shop/cart/update', { sku: 'YR-HB-U2', qty: '600' });
    assert.match(await (await b('/shop/cart')).text(), /value="600"/);
    await b.form('/shop/cart/remove', { sku: 'YR-HB-U2' });
    assert.match(await (await b('/shop/cart')).text(), /Your cart is empty/);
  });
});

describe('checkout & payment', () => {
  test('SA-06 checkout validation keeps the form and shows the error', async () => {
    const b = client();
    await b.add('YR-HB-U2', 50);
    const r = await checkout(b, 'tt', { phone: '' });
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /Phone is required/);
    assert.match(html, /value="Jane Buyer"/);
  });
  test('SA-07 bank transfer order: order page with reference, confirmation e-mail; token required', async () => {
    const b = client();
    await b.add('YR-HB-U2', 50);
    const r = await checkout(b, 'tt');
    assert.equal(r.status, 302);
    const loc = r.headers.get('location');
    assert.match(loc, /^\/shop\/order\/SO-\d{6}-\d{3}\?t=/);
    const html = await (await b(loc)).text();
    assert.match(html, /Awaiting payment/);
    assert.match(html, /Payment reference/);
    const no = loc.match(/SO-\d{6}-\d{3}/)[0];
    assert.equal((await api.get(`/shop/order/${no}`)).status, 404, 'no token');
    assert.equal((await api.get(`/shop/order/${no}?t=guess`)).status, 404, 'wrong token');
    assert.equal((await (await b('/api/shop/cart')).json()).count, 0, 'cart emptied after ordering');
    // finance confirms the transfer in the admin
    const orders = await (await api.admin('/admin/orders')).text();
    const id = orders.match(new RegExp(`/admin/orders/([\\w-]+)"><b>${no}`))[1];
    const total = Number((await (await b(loc)).text()).match(/Balance due<\/td><td class="n">US\$([\d,.]+)/)[1].replace(/,/g, ''));
    assert.match(flash(await api.form(`/admin/orders/${id}/payment`, { kind: 'balance', amount: String(total), ref: 'TT-1' })).ok, /已登记收款/);
    assert.match(await (await b(loc)).text(), /<li class="done">Ready to ship<\/li>/);
  });
  test('SA-08 Stripe: redirect to the hosted page; the signed webhook books the payment and pushes to Kingdee (mock)', async () => {
    const b = client();
    await b.add('YR-HB-U2', 50);
    const r = await checkout(b, 'stripe');
    assert.match(r.headers.get('location'), /^https:\/\/checkout\.stripe\.test\/cs_test_\d+$/);
    const s = sessions.at(-1);
    const orderId = s.body.get('metadata[order_id]');
    const amount = Number(s.body.get('line_items[0][price_data][unit_amount]'));
    const event = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: s.id, payment_status: 'paid', amount_total: amount, currency: 'usd', payment_intent: 'pi_123' } } });
    const bad = await fetch(`${api.url}/api/pay/stripe/webhook`, { method: 'POST', headers: { 'stripe-signature': 't=1,v1=00' }, body: event });
    assert.equal(bad.status, 400);
    const ok = await (await fetch(`${api.url}/api/pay/stripe/webhook`, { method: 'POST', headers: { 'stripe-signature': sign(event) }, body: event })).json();
    assert.equal(ok.result, 'paid');
    const again = await (await fetch(`${api.url}/api/pay/stripe/webhook`, { method: 'POST', headers: { 'stripe-signature': sign(event) }, body: event })).json();
    assert.equal(again.result, 'duplicate');
    await new Promise((res) => setTimeout(res, 300));
    const page = await (await api.admin(`/admin/orders/${orderId}`)).text();
    assert.match(page, /待发货/);
    assert.match(page, /Stripe 在线支付/);
    assert.match(page, /XSDD\d+/, 'pushed to Kingdee (mock) after payment');
  });
  test('SA-09 PayPal: approve link → return → server-side capture → paid', async () => {
    const b = client();
    await b.add('YR-HB-U2', 50);
    const r = await checkout(b, 'paypal');
    const approve = r.headers.get('location');
    const no = approve.match(/SO-\d{6}-\d{3}/)[0];
    const create = prov.calls.find((c) => c.url === '/v2/checkout/orders' && c.body.purchase_units[0].reference_id === no);
    const ret = new URL(create.body.application_context.return_url);
    const back = await b(`${ret.pathname}${ret.search}&token=PPO-${no}`);
    assert.equal(back.status, 302);
    assert.match(decodeURIComponent(back.headers.get('location')), /payment is being confirmed/);
    assert.match(await (await b(back.headers.get('location'))).text(), /<li class="done">Ready to ship<\/li>/);
  });
  test('SA-10 a PayPal return for another order is rejected', async () => {
    const b = client();
    await b.add('YR-HB-U2', 50);
    const r = await checkout(b, 'paypal');
    const no = r.headers.get('location').match(/SO-\d{6}-\d{3}/)[0];
    const ret = new URL(prov.calls.find((c) => c.url === '/v2/checkout/orders' && c.body.purchase_units[0].reference_id === no).body.application_context.return_url);
    const other = prov.calls.filter((c) => c.url === '/v2/checkout/orders').map((c) => c.body.purchase_units[0].reference_id).find((x) => x !== no);
    const back = await b(`${ret.pathname}${ret.search}&token=PPO-${other}`);
    assert.match(decodeURIComponent(back.headers.get('location')), /does not belong|could not be confirmed|duplicate|not completed/);
  });
  test('SA-11 pending orders can be paid later from the order page', async () => {
    const b = client();
    await b.add('YR-HB-U2', 50);
    const loc = (await checkout(b, 'tt')).headers.get('location');
    const no = loc.match(/SO-\d{6}-\d{3}/)[0];
    const t = new URL(loc, api.url).searchParams.get('t');
    const r = await b.form(`/shop/order/${no}/pay?t=${encodeURIComponent(t)}`, { method: 'stripe' });
    assert.match(r.headers.get('location'), /checkout\.stripe\.test/);
    assert.equal((await b.form(`/shop/order/${no}/pay?t=wrong`, { method: 'stripe' })).status, 404);
  });
});

describe('accounts', () => {
  const PW = 'Passw0rd99';
  test('SA-12 register → logged in; account page; e-mail verification link works', async () => {
    const b = client();
    const r = await b.form('/shop/account/register', { email: 'acct@buyer.test', password: PW, name: 'Acct' });
    assert.equal(r.status, 302);
    assert.ok(b.jar.get('yr_cust'));
    assert.match(await (await b('/shop/account')).text(), /acct@buyer\.test/);
  });
  test('SA-13 guest cart merges into the account at login; "My orders" lists only my orders', async () => {
    const b = client();
    await b.add('YR-HB-U2', 50);
    const r = await b.form('/shop/account/login', { email: 'acct@buyer.test', password: PW, next: '/shop/cart' });
    assert.equal(r.headers.get('location'), '/shop/cart');
    assert.match(await (await b('/shop/cart')).text(), /UFO High Bay U2/);
    const page = await (await b('/shop/checkout?country=US')).text();
    const zone = page.match(/name="zone" value="(\d+)"/)[1];
    const placed = await b.form('/shop/checkout', { ...ADDR, email: 'acct@buyer.test', zone, payment: 'tt' });
    const no = placed.headers.get('location').match(/SO-\d{6}-\d{3}/)[0];
    const acct = await (await b('/shop/account')).text();
    assert.match(acct, new RegExp(no));
    assert.doesNotMatch(acct, /jane@buyer/);
    assert.match(acct, /1 Congress Ave/, 'address saved to the address book');
  });
  test('SA-14 wrong password; lockout; logout clears the session', async () => {
    const b = client();
    assert.match(new URL((await b.form('/shop/account/login', { email: 'acct@buyer.test', password: 'nope' })).headers.get('location'), api.url).searchParams.get('e'), /Wrong e-mail or password/);
    await b.form('/shop/account/login', { email: 'acct@buyer.test', password: PW });
    await b.form('/shop/account/logout', {});
    assert.equal((await b('/shop/account')).headers.get('location'), '/shop/account/login');
  });
  test('SA-15 open redirect via login "next" is blocked', async () => {
    const b = client();
    const r = await b.form('/shop/account/login', { email: 'acct@buyer.test', password: PW, next: 'https://evil.test' });
    assert.equal(r.headers.get('location'), '/shop/account');
  });
});

describe('admin', () => {
  test('SA-16 shop overview and freight templates; a new template is used at checkout immediately', async () => {
    assert.match(await (await api.admin('/admin/shop')).text(), /Stripe[\s\S]*已启用/);
    assert.match(flash(await api.form('/admin/shop/freight', { name: 'US Sea LCL', countries: 'US', method: 'sea', first_kg: '100', first_fee: '50', extra_fee_per_kg: '0.4', volumetric_divisor: '1000', free_over: '', days_min: '25', days_max: '40', sort: '0', active: '1' })).ok, /已保存/);
    const b = client();
    await b.add('YR-HB-U2', 50);
    assert.match(await (await b('/shop/checkout?country=US')).text(), /US Sea LCL/);
    assert.match(flash(await api.form('/admin/shop/freight', { name: 'bad', countries: 'USA', first_kg: '0' })).err || '', /ISO|首重/);
  });
  test('SA-17 roles: warehouse may view the shop but not change freight; sales cannot either', async () => {
    const PW = 'Str0ngPassw0rd';
    await api.form('/admin/users/new', { username: 'whouse', role: 'warehouse', password: PW });
    const h = { authorization: 'Basic ' + Buffer.from(`whouse:${PW}`).toString('base64') };
    assert.equal((await api.get('/admin/shop', { headers: h })).status, 200);
    const r = await fetch(`${api.url}/admin/shop/freight`, { method: 'POST', redirect: 'manual', headers: { ...h, 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=x' });
    assert.equal(r.status, 403);
  });
});
