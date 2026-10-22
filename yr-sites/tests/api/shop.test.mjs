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

const ctx = {};

describe('browse & cart', () => {
  test('SA-01a buy box API returns live variants with price, MOQ and stock', async () => {
    const p = await (await api.get('/api/shop/product/YR-HB-U2')).json();
    assert.equal(p.salesMode, 'both');
    assert.equal(p.variants[0].sku, 'YR-HB-U2');
    assert.ok(p.variants[0].price > 0 && p.variants[0].minQty === 50 && p.variants[0].available > 0);
  });
  test('SA-01b buy box API answers 404 for an unknown product', async () => {
    assert.equal((await api.get('/api/shop/product/NOPE')).status, 404);
  });
  test('SA-02a adding less than the MOQ raises the quantity to the MOQ and returns the badge count', async () => {
    ctx.cartClient = client();
    const r = await ctx.cartClient.add('YR-HB-U2', 1);
    assert.deepEqual([r.ok, r.qty, r.raisedToMoq, r.count], [true, 50, true, 1]);
  });
  test('SA-02b the cart is kept in a cookie and the cart API reports its count', async () => {
    const b = ctx.cartClient;
    assert.ok(b.jar.get('yr_cart'));
    assert.equal((await (await b('/api/shop/cart')).json()).count, 1);
  });
  test('SA-02c the cart page shows the item and its minimum order', async () => {
    const html = await (await ctx.cartClient('/shop/cart')).text();
    assert.match(html, /UFO High Bay U2/);
    assert.match(html, /Min\. order 50/);
  });
  test('SA-03a the cart API only accepts JSON (415 otherwise, so no cross-site form posts)', async () => {
    const b = client();
    assert.equal((await b('/api/shop/cart', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"sku":"YR-HB-U2"}' })).status, 415);
  });
  test('SA-03b the cart API rejects unknown SKUs (400)', async () => {
    const b = client();
    assert.equal((await b('/api/shop/cart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"sku":"NOPE"}' })).status, 400);
  });
  test('SA-04 cross-site form posts to the shop are refused', async () => {
    const r = await fetch(`${api.url}/shop/cart/update`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.test' }, body: 'sku=YR-HB-U2&qty=999' });
    assert.equal(r.status, 403);
  });
  test('SA-05a the cart page updates an item quantity', async () => {
    const b = client();
    ctx.updateClient = b;
    await b.add('YR-HB-U2', 50);
    await b.form('/shop/cart/update', { sku: 'YR-HB-U2', qty: '600' });
    assert.match(await (await b('/shop/cart')).text(), /value="600"/);
  });
  test('SA-05b the cart page removes an item', async () => {
    const b = ctx.updateClient;
    await b.form('/shop/cart/remove', { sku: 'YR-HB-U2' });
    assert.match(await (await b('/shop/cart')).text(), /Your cart is empty/);
  });
});

describe('checkout & payment', () => {
  test('SA-06a a checkout with a missing field re-renders the form with the error', async () => {
    const b = client();
    await b.add('YR-HB-U2', 50);
    const r = await checkout(b, 'tt', { phone: '' });
    assert.equal(r.status, 200);
    ctx.invalidCheckout = await r.text();
    assert.match(ctx.invalidCheckout, /Phone is required/);
  });
  test('SA-06b the re-rendered checkout form keeps what the buyer entered', async () => {
    assert.match(ctx.invalidCheckout, /value="Jane Buyer"/);
  });
  test('SA-07a a bank transfer checkout redirects to the order page with an access token', async () => {
    const b = client();
    ctx.tt = { b };
    await b.add('YR-HB-U2', 50);
    const r = await checkout(b, 'tt');
    assert.equal(r.status, 302);
    ctx.tt.loc = r.headers.get('location');
    assert.match(ctx.tt.loc, /^\/shop\/order\/SO-\d{6}-\d{3}\?t=/);
    ctx.tt.no = ctx.tt.loc.match(/SO-\d{6}-\d{3}/)[0];
  });
  test('SA-07b the bank transfer order page says awaiting payment and shows the payment reference', async () => {
    const html = await (await ctx.tt.b(ctx.tt.loc)).text();
    assert.match(html, /Awaiting payment/);
    assert.match(html, /Payment reference/);
  });
  test('SA-07c the order page needs the right token (404 without or with a wrong one)', async () => {
    assert.equal((await api.get(`/shop/order/${ctx.tt.no}`)).status, 404, 'no token');
    assert.equal((await api.get(`/shop/order/${ctx.tt.no}?t=guess`)).status, 404, 'wrong token');
  });
  test('SA-07d the cart is emptied after ordering', async () => {
    assert.equal((await (await ctx.tt.b('/api/shop/cart')).json()).count, 0, 'cart emptied after ordering');
  });
  test('SA-07e finance confirms the transfer in the admin and the order page shows ready to ship', async () => {
    const { b, loc, no } = ctx.tt;
    const orders = await (await api.admin('/admin/orders')).text();
    const id = orders.match(new RegExp(`/admin/orders/([\\w-]+)"><b>${no}`))[1];
    const total = Number((await (await b(loc)).text()).match(/Balance due<\/td><td class="n">US\$([\d,.]+)/)[1].replace(/,/g, ''));
    assert.match(flash(await api.form(`/admin/orders/${id}/payment`, { kind: 'balance', amount: String(total), ref: 'TT-1' })).ok, /已登记收款/);
    assert.match(await (await b(loc)).text(), /<li class="done">Ready to ship<\/li>/);
  });
  test('SA-08a a Stripe checkout redirects to the hosted payment page', async () => {
    const b = client();
    await b.add('YR-HB-U2', 50);
    const r = await checkout(b, 'stripe');
    assert.match(r.headers.get('location'), /^https:\/\/checkout\.stripe\.test\/cs_test_\d+$/);
    const s = sessions.at(-1);
    ctx.stripeOrder = s.body.get('metadata[order_id]');
    const amount = Number(s.body.get('line_items[0][price_data][unit_amount]'));
    ctx.stripeEvent = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: s.id, payment_status: 'paid', amount_total: amount, currency: 'usd', payment_intent: 'pi_123' } } });
  });
  test('SA-08b a Stripe webhook with a bad signature is rejected (400)', async () => {
    const bad = await fetch(`${api.url}/api/pay/stripe/webhook`, { method: 'POST', headers: { 'stripe-signature': 't=1,v1=00' }, body: ctx.stripeEvent });
    assert.equal(bad.status, 400);
  });
  test('SA-08c a correctly signed Stripe webhook books the payment', async () => {
    const ok = await (await fetch(`${api.url}/api/pay/stripe/webhook`, { method: 'POST', headers: { 'stripe-signature': sign(ctx.stripeEvent) }, body: ctx.stripeEvent })).json();
    assert.equal(ok.result, 'paid');
  });
  test('SA-08d the same Stripe webhook delivered again is recognised as a duplicate', async () => {
    const again = await (await fetch(`${api.url}/api/pay/stripe/webhook`, { method: 'POST', headers: { 'stripe-signature': sign(ctx.stripeEvent) }, body: ctx.stripeEvent })).json();
    assert.equal(again.result, 'duplicate');
  });
  test('SA-08e after the Stripe payment the order is ready to ship and paid online', async () => {
    await new Promise((res) => setTimeout(res, 300));
    ctx.stripePage = await (await api.admin(`/admin/orders/${ctx.stripeOrder}`)).text();
    assert.match(ctx.stripePage, /待发货/);
    assert.match(ctx.stripePage, /Stripe 在线支付/);
  });
  test('SA-08f after the Stripe payment the order is pushed to Kingdee (mock)', async () => {
    assert.match(ctx.stripePage, /XSDD\d+/, 'pushed to Kingdee (mock) after payment');
  });
  test('SA-09a PayPal: approve link → return → the buyer is told the payment is being confirmed', async () => {
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
    ctx.paypal = { b, loc: back.headers.get('location') };
  });
  test('SA-09b PayPal: the server-side capture marks the order paid (ready to ship)', async () => {
    assert.match(await (await ctx.paypal.b(ctx.paypal.loc)).text(), /<li class="done">Ready to ship<\/li>/);
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
  test('SA-11a a pending order can be paid later from the order page (redirect to Stripe)', async () => {
    const b = client();
    await b.add('YR-HB-U2', 50);
    const loc = (await checkout(b, 'tt')).headers.get('location');
    ctx.later = { b, no: loc.match(/SO-\d{6}-\d{3}/)[0] };
    const t = new URL(loc, api.url).searchParams.get('t');
    const r = await b.form(`/shop/order/${ctx.later.no}/pay?t=${encodeURIComponent(t)}`, { method: 'stripe' });
    assert.match(r.headers.get('location'), /checkout\.stripe\.test/);
  });
  test('SA-11b paying later with a wrong token answers 404', async () => {
    assert.equal((await ctx.later.b.form(`/shop/order/${ctx.later.no}/pay?t=wrong`, { method: 'stripe' })).status, 404);
  });
});

describe('accounts', () => {
  const PW = 'Passw0rd99';
  test('SA-12a registering an account logs the customer in', async () => {
    const b = client();
    ctx.reg = b;
    const r = await b.form('/shop/account/register', { email: 'acct@buyer.test', password: PW, name: 'Acct' });
    assert.equal(r.status, 302);
    assert.ok(b.jar.get('yr_cust'));
  });
  test('SA-12b the account page shows the registered e-mail', async () => {
    assert.match(await (await ctx.reg('/shop/account')).text(), /acct@buyer\.test/);
  });
  test('SA-13a a guest cart merges into the account at login and "next" is followed', async () => {
    const b = client();
    ctx.acct = b;
    await b.add('YR-HB-U2', 50);
    const r = await b.form('/shop/account/login', { email: 'acct@buyer.test', password: PW, next: '/shop/cart' });
    assert.equal(r.headers.get('location'), '/shop/cart');
    assert.match(await (await b('/shop/cart')).text(), /UFO High Bay U2/);
  });
  test('SA-13b "My orders" lists my new order and not other customers\' orders', async () => {
    const b = ctx.acct;
    const page = await (await b('/shop/checkout?country=US')).text();
    const zone = page.match(/name="zone" value="(\d+)"/)[1];
    const placed = await b.form('/shop/checkout', { ...ADDR, email: 'acct@buyer.test', zone, payment: 'tt' });
    const no = placed.headers.get('location').match(/SO-\d{6}-\d{3}/)[0];
    ctx.acctPage = await (await b('/shop/account')).text();
    assert.match(ctx.acctPage, new RegExp(no));
    assert.doesNotMatch(ctx.acctPage, /jane@buyer/);
  });
  test('SA-13c the checkout address is saved to the address book', async () => {
    assert.match(ctx.acctPage, /1 Congress Ave/, 'address saved to the address book');
  });
  test('SA-14a a wrong password is refused with a message', async () => {
    const b = client();
    assert.match(new URL((await b.form('/shop/account/login', { email: 'acct@buyer.test', password: 'nope' })).headers.get('location'), api.url).searchParams.get('e'), /Wrong e-mail or password/);
  });
  test('SA-14b logout clears the session', async () => {
    const b = client();
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
  test('SA-16a the shop overview shows Stripe as enabled', async () => {
    assert.match(await (await api.admin('/admin/shop')).text(), /Stripe[\s\S]*已启用/);
  });
  test('SA-16b a new freight template is saved and offered at checkout immediately', async () => {
    assert.match(flash(await api.form('/admin/shop/freight', { name: 'US Sea LCL', countries: 'US', method: 'sea', first_kg: '100', first_fee: '50', extra_fee_per_kg: '0.4', volumetric_divisor: '1000', free_over: '', days_min: '25', days_max: '40', sort: '0', active: '1' })).ok, /已保存/);
    const b = client();
    await b.add('YR-HB-U2', 50);
    assert.match(await (await b('/shop/checkout?country=US')).text(), /US Sea LCL/);
  });
  test('SA-16c an invalid freight template (country code, first weight) is rejected', async () => {
    assert.match(flash(await api.form('/admin/shop/freight', { name: 'bad', countries: 'USA', first_kg: '0' })).err || '', /ISO|首重/);
  });
  const WPW = 'Str0ngPassw0rd';
  const wh = { authorization: 'Basic ' + Buffer.from(`whouse:${WPW}`).toString('base64') };
  test('SA-17a the warehouse role may view the shop overview', async () => {
    await api.form('/admin/users/new', { username: 'whouse', role: 'warehouse', password: WPW });
    assert.equal((await api.get('/admin/shop', { headers: wh })).status, 200);
  });
  test('SA-17b the warehouse role cannot change freight templates (403)', async () => {
    const r = await fetch(`${api.url}/admin/shop/freight`, { method: 'POST', redirect: 'manual', headers: { ...wh, 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=x' });
    assert.equal(r.status, 403);
  });
});
