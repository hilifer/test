// Black-box: marketing over HTTP — coupons (admin + checkout), verified-buyer reviews with moderation, wishlist API,
// search page, related products, operations dashboard, role checks. IDs MA-xx.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, flash } from '../helpers/server.mjs';

let api;
before(async () => { api = await startServer({ site: 'led', env: { TRUSTED_PROXY_HOPS: '0' } }); });
after(async () => { await api.stop(); });

function client() {
  const jar = new Map();
  const send = async (path, opts = {}) => {
    const r = await fetch(api.url + path, { redirect: 'manual', ...opts, headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(opts.headers || {}) } });
    for (const sc of r.headers.getSetCookie()) { const [kv] = sc.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i); const v = kv.slice(i + 1); if (!v || /Max-Age=0/i.test(sc)) jar.delete(k); else jar.set(k, v); }
    return r;
  };
  send.form = (path, data) => send(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data) });
  send.json = (path, data, headers = {}) => send(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(data) });
  return send;
}
const PW = 'Str0ngPassw0rd';
const staff = (u) => ({
  get: (path) => fetch(api.url + path, { redirect: 'manual', headers: { authorization: 'Basic ' + Buffer.from(`${u}:${PW}`).toString('base64') } }),
  form: (path, data) => fetch(api.url + path, { method: 'POST', redirect: 'manual', headers: { authorization: 'Basic ' + Buffer.from(`${u}:${PW}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data) }),
});
const ADDR = { name: 'Maria Lopez', phone: '+1 512 555 0100', line1: '1 Congress Ave', city: 'Austin', postcode: '78701', country: 'US' };
const ctx = {};

test('MA-01 roles: content manages coupons/reviews; sales sees the dashboard but not coupons; warehouse neither', async () => {
  for (const [u, role] of [['mk1', 'content'], ['sales1', 'sales'], ['wh01', 'warehouse']]) assert.ok(flash(await api.form('/admin/users/new', { username: u, role, password: PW })).ok, u);
  const mk = staff('mk1'), sales = staff('sales1'), wh = staff('wh01');
  assert.equal((await mk.get('/admin/coupons')).status, 200);
  assert.equal((await mk.get('/admin/reviews')).status, 200);
  assert.equal((await sales.get('/admin/coupons')).status, 403);
  assert.equal((await sales.form('/admin/coupons', { code: 'HACK', kind: 'percent', value: '50' })).status, 403);
  assert.equal((await sales.get('/admin/dashboard')).status, 200);
  assert.equal((await mk.get('/admin/dashboard')).status, 403);
  assert.equal((await wh.get('/admin/dashboard')).status, 200); // orders.view
  assert.equal((await wh.get('/admin/reviews')).status, 403);
  assert.equal((await api.get('/admin/coupons')).status, 401);
});

test('MA-02 coupon admin: create, validation errors flashed, edit keeps one row, cross-site post refused', async () => {
  const mk = staff('mk1');
  assert.match(flash(await mk.form('/admin/coupons', { code: 'welcome5', kind: 'fixed', value: '5', min_subtotal: '100', per_customer: '1', active: '1', note: 'first order' })).ok, /已保存 WELCOME5/);
  assert.match(flash(await mk.form('/admin/coupons', { code: 'BAD', kind: 'percent', value: '99' })).err, /90/);
  assert.match(flash(await mk.form('/admin/coupons', { code: 'X', kind: 'percent', value: '10' })).err, /券码/);
  assert.match(flash(await mk.form('/admin/coupons', { code: 'WELCOME5', kind: 'fixed', value: '25', min_subtotal: '100', per_customer: '1', active: '1' })).ok, /WELCOME5/);
  const html = await (await mk.get('/admin/coupons')).text();
  assert.equal(html.match(/<b>WELCOME5<\/b>/g).length, 1);
  assert.match(html, /25/);
  assert.match(flash(await mk.form('/admin/coupons', { code: 'OFF1', kind: 'fixed', value: '5' })).ok, /OFF1/); // checkbox unticked → inactive
  const evil = await fetch(`${api.url}/admin/coupons`, { method: 'POST', redirect: 'manual', headers: { authorization: 'Basic ' + Buffer.from(`mk1:${PW}`).toString('base64'), origin: 'https://evil.test', 'content-type': 'application/x-www-form-urlencoded' }, body: 'code=EVIL&kind=percent&value=90' });
  assert.equal(evil.status, 403);
});

test('MA-03 checkout with a coupon: bad code re-renders the form with the error; valid code discounts the order', async () => {
  const b = client();
  assert.equal((await b.form('/shop/account/register', { email: 'maria@buyer.test', password: 'Passw0rd99', name: 'Maria Lopez' })).status, 302);
  await b.json('/api/shop/cart', { sku: 'YR-HB-U2', qty: 50 });
  const zone = (await (await b('/shop/checkout?country=US')).text()).match(/name="zone" value="(\d+)"/)[1];
  for (const [code, msg] of [['NOPE', /not valid/], ['OFF1', /not valid/]]) {
    const r = await b.form('/shop/checkout', { ...ADDR, zone, payment: 'tt', coupon: code });
    assert.equal(r.status, 200);
    assert.match(await r.text(), msg);
  }
  const r = await b.form('/shop/checkout', { ...ADDR, zone, payment: 'tt', coupon: 'welcome5' });
  assert.equal(r.status, 302);
  ctx.b = b;
  ctx.orderUrl = r.headers.get('location');
  ctx.no = ctx.orderUrl.match(/SO-\d{6}-\d{3}/)[0];
  const page = await (await b(ctx.orderUrl)).text();
  assert.match(page, /Discount <span class="mute">WELCOME5<\/span><\/td><td class="n">−US\$25/);
  ctx.total = Number(page.match(/Balance due<\/td><td class="n">US\$([\d,.]+)/)[1].replace(/,/g, ''));
  ctx.id = (await (await api.admin('/admin/orders')).text()).match(new RegExp(`/admin/orders/([\\w-]+)"><b>${ctx.no}`))[1];
  // same customer cannot use it twice
  await b.json('/api/shop/cart', { sku: 'YR-HB-U2', qty: 50 });
  assert.match(await (await b.form('/shop/checkout', { ...ADDR, zone, payment: 'tt', coupon: 'WELCOME5' })).text(), /already used/);
  assert.match(await (await staff('mk1').get('/admin/coupons')).text(), /1 \//);
});

test('MA-04 review only after delivery; pending until approved; public API hides the e-mail', async () => {
  const b = ctx.b;
  assert.doesNotMatch(await (await b('/shop/account')).text(), /Write a review/);
  await api.form(`/admin/orders/${ctx.id}/payment`, { kind: 'balance', amount: String(ctx.total) });
  const ship = flash(await api.form(`/admin/orders/${ctx.id}/ship`, { mode: 'express', carrier: 'DHL', tracking_no: 'MK0001', sku_0: 'YR-HB-U2', qty_0: '50' })).path.split('/').pop();
  flash(await api.form(`/admin/shipments/${ship}/event`, { status: 'in_transit', location: 'LA' }));
  flash(await api.form(`/admin/shipments/${ship}/event`, { status: 'delivered', location: 'Austin' }));
  assert.match(await (await b('/shop/account')).text(), /Write a review/);
  // a stranger cannot review
  const s = client();
  await s.form('/shop/account/register', { email: 'stranger@buyer.test', password: 'Passw0rd99' });
  assert.match(flash(await s.form('/shop/account/review', { productId: 'YR-HB-U2', rating: '5', body: 'I never bought this lamp.' })).err, /delivered orders/);
  assert.match(flash(await b.form('/shop/account/review', { productId: 'YR-HB-U2', rating: '5', body: 'short' })).err, /10 characters/);
  assert.match(flash(await b.form('/shop/account/review', { productId: 'YR-HB-U2', rating: '5', title: 'Bright', body: 'Very bright and well packed, arrived on time.' })).ok, /after moderation/);
  assert.equal((await (await api.get('/api/shop/reviews/YR-HB-U2')).json()).count, 0);
  const mk = staff('mk1');
  const list = await (await mk.get('/admin/reviews')).text();
  assert.match(list, /maria@buyer\.test/);
  const id = list.match(/\/admin\/reviews\/([\w-]+)/)[1];
  assert.equal((await staff('sales1').form(`/admin/reviews/${id}`, { status: 'approved' })).status, 403);
  assert.match(flash(await mk.form(`/admin/reviews/${id}`, { status: 'approved', reply: 'Thank you Maria!' })).ok, /已更新/);
  const pub = await (await api.get('/api/shop/reviews/YR-HB-U2')).json();
  assert.equal(pub.count, 1);
  assert.equal(pub.average, 5);
  assert.equal(pub.reviews[0].author, 'Maria'); // first name only (no country on the account)
  assert.equal(pub.reviews[0].reply, 'Thank you Maria!');
  assert.doesNotMatch(JSON.stringify(pub), /@/);
  assert.doesNotMatch(await (await b('/shop/account')).text(), /Write a review/); // once per product
});

test('MA-05 wishlist API: JSON only, login required, toggle, unknown product 404, cross-site refused; shown on account page', async () => {
  const b = ctx.b;
  assert.equal((await b('/api/shop/wishlist', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"productId":"YR-HB-U2"}' })).status, 415);
  assert.equal((await client().json('/api/shop/wishlist', { productId: 'YR-HB-U2' })).status, 401);
  assert.deepEqual(await (await client()('/api/shop/wishlist')).json(), { loggedIn: false, ids: [] });
  assert.deepEqual(await (await b.json('/api/shop/wishlist', { productId: 'YR-HB-U2' })).json(), { saved: true });
  assert.deepEqual(await (await b('/api/shop/wishlist')).json(), { loggedIn: true, ids: ['YR-HB-U2'] });
  assert.match(await (await b('/shop/account')).text(), /Saved products[\s\S]*UFO High Bay U2/);
  assert.equal((await b.json('/api/shop/wishlist', { productId: 'NOPE' })).status, 404);
  assert.equal((await b.json('/api/shop/wishlist', { productId: 'YR-HB-U2' }, { origin: 'https://evil.test' })).status, 403);
  assert.deepEqual(await (await b.json('/api/shop/wishlist', { productId: 'YR-HB-U2' })).json(), { saved: false });
});

test('MA-06 search page: keyword, category filter, price sort, no results, escaping', async () => {
  const hb = await (await api.get('/shop/search?q=high+bay')).text();
  assert.match(hb, /UFO High Bay U2/);
  const cat = await (await api.get('/shop/search?category=flood')).text();
  assert.doesNotMatch(cat, /UFO High Bay U2/);
  assert.equal((await api.get('/shop/search?q=high&sort=price_asc')).status, 200);
  const xss = await (await api.get('/shop/search?q=%3Cscript%3Ealert(1)%3C/script%3E')).text();
  assert.doesNotMatch(xss, /<script>alert\(1\)/);
  assert.match(await (await api.get('/shop/search?q=zzqqxx')).text(), /0 results/);
});

test('MA-07 related products API and dashboard numbers reflect the paid order', async () => {
  const rel = await (await api.get('/api/shop/related/YR-HB-U2')).json();
  assert.ok(rel.length > 0 && rel.length <= 4);
  assert.ok(!rel.some((p) => p.id === 'YR-HB-U2'));
  assert.deepEqual(await (await api.get('/api/shop/related/NOPE')).json(), []);
  const d = await (await staff('sales1').get('/admin/dashboard')).text();
  assert.match(d, /经营看板/);
  assert.match(d, /YR-HB-U2/); // top products
  assert.match(d, /<svg/); // daily bars
});
