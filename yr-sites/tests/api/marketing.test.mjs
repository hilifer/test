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

test('MA-01a the content role can open coupons and reviews', async () => {
  for (const [u, role] of [['mk1', 'content'], ['sales1', 'sales'], ['wh01', 'warehouse']]) assert.ok(flash(await api.form('/admin/users/new', { username: u, role, password: PW })).ok, u);
  const mk = staff('mk1');
  assert.equal((await mk.get('/admin/coupons')).status, 200);
  assert.equal((await mk.get('/admin/reviews')).status, 200);
});

test('MA-01b sales can neither open nor create coupons (403)', async () => {
  const sales = staff('sales1');
  assert.equal((await sales.get('/admin/coupons')).status, 403);
  assert.equal((await sales.form('/admin/coupons', { code: 'HACK', kind: 'percent', value: '50' })).status, 403);
});

test('MA-01c sales sees the operations dashboard; content does not (403)', async () => {
  assert.equal((await staff('sales1').get('/admin/dashboard')).status, 200);
  assert.equal((await staff('mk1').get('/admin/dashboard')).status, 403);
});

test('MA-01d warehouse sees the dashboard (orders.view) but not reviews (403)', async () => {
  const wh = staff('wh01');
  assert.equal((await wh.get('/admin/dashboard')).status, 200); // orders.view
  assert.equal((await wh.get('/admin/reviews')).status, 403);
});

test('MA-01e anonymous visitors cannot open coupons (401)', async () => {
  assert.equal((await api.get('/admin/coupons')).status, 401);
});

test('MA-02a creating a coupon saves it with the code upper-cased', async () => {
  assert.match(flash(await staff('mk1').form('/admin/coupons', { code: 'welcome5', kind: 'fixed', value: '5', min_subtotal: '100', per_customer: '1', active: '1', note: 'first order' })).ok, /已保存 WELCOME5/);
});

test('MA-02b a percentage coupon above 90% is rejected', async () => {
  assert.match(flash(await staff('mk1').form('/admin/coupons', { code: 'BAD', kind: 'percent', value: '99' })).err, /90/);
});

test('MA-02c a too-short coupon code is rejected', async () => {
  assert.match(flash(await staff('mk1').form('/admin/coupons', { code: 'X', kind: 'percent', value: '10' })).err, /券码/);
});

test('MA-02d saving an existing code edits that coupon and keeps a single row', async () => {
  const mk = staff('mk1');
  assert.match(flash(await mk.form('/admin/coupons', { code: 'WELCOME5', kind: 'fixed', value: '25', min_subtotal: '100', per_customer: '1', active: '1' })).ok, /WELCOME5/);
  const html = await (await mk.get('/admin/coupons')).text();
  assert.equal(html.match(/<b>WELCOME5<\/b>/g).length, 1);
  assert.match(html, /25/);
});

test('MA-02e a coupon saved with the active checkbox unticked is created (inactive)', async () => {
  assert.match(flash(await staff('mk1').form('/admin/coupons', { code: 'OFF1', kind: 'fixed', value: '5' })).ok, /OFF1/); // checkbox unticked → inactive
});

test('MA-02f a cross-site coupon post is refused (403)', async () => {
  const evil = await fetch(`${api.url}/admin/coupons`, { method: 'POST', redirect: 'manual', headers: { authorization: 'Basic ' + Buffer.from(`mk1:${PW}`).toString('base64'), origin: 'https://evil.test', 'content-type': 'application/x-www-form-urlencoded' }, body: 'code=EVIL&kind=percent&value=90' });
  assert.equal(evil.status, 403);
});

test('MA-03a checkout with an unknown or inactive coupon re-renders the form with an error', async () => {
  const b = client();
  assert.equal((await b.form('/shop/account/register', { email: 'maria@buyer.test', password: 'Passw0rd99', name: 'Maria Lopez' })).status, 302);
  await b.json('/api/shop/cart', { sku: 'YR-HB-U2', qty: 50 });
  ctx.zone = (await (await b('/shop/checkout?country=US')).text()).match(/name="zone" value="(\d+)"/)[1];
  ctx.b = b;
  for (const [code, msg] of [['NOPE', /not valid/], ['OFF1', /not valid/]]) {
    const r = await b.form('/shop/checkout', { ...ADDR, zone: ctx.zone, payment: 'tt', coupon: code });
    assert.equal(r.status, 200);
    assert.match(await r.text(), msg);
  }
});

test('MA-03b checkout with a valid coupon (any case) places the order with the discount line', async () => {
  const b = ctx.b;
  const r = await b.form('/shop/checkout', { ...ADDR, zone: ctx.zone, payment: 'tt', coupon: 'welcome5' });
  assert.equal(r.status, 302);
  ctx.orderUrl = r.headers.get('location');
  ctx.no = ctx.orderUrl.match(/SO-\d{6}-\d{3}/)[0];
  const page = await (await b(ctx.orderUrl)).text();
  assert.match(page, /Discount <span class="mute">WELCOME5<\/span><\/td><td class="n">−US\$25/);
  ctx.total = Number(page.match(/Balance due<\/td><td class="n">US\$([\d,.]+)/)[1].replace(/,/g, ''));
  ctx.id = (await (await api.admin('/admin/orders')).text()).match(new RegExp(`/admin/orders/([\\w-]+)"><b>${ctx.no}`))[1];
});

test('MA-03c the same customer cannot use a once-per-customer coupon twice', async () => {
  const b = ctx.b;
  await b.json('/api/shop/cart', { sku: 'YR-HB-U2', qty: 50 });
  assert.match(await (await b.form('/shop/checkout', { ...ADDR, zone: ctx.zone, payment: 'tt', coupon: 'WELCOME5' })).text(), /already used/);
});

test('MA-03d the coupon admin shows the coupon has been used once', async () => {
  assert.match(await (await staff('mk1').get('/admin/coupons')).text(), /1 \//);
});

test('MA-04a the account page offers no review before the order is delivered', async () => {
  assert.doesNotMatch(await (await ctx.b('/shop/account')).text(), /Write a review/);
});

test('MA-04b once the order is paid and delivered the account page offers a review', async () => {
  await api.form(`/admin/orders/${ctx.id}/payment`, { kind: 'balance', amount: String(ctx.total) });
  const ship = flash(await api.form(`/admin/orders/${ctx.id}/ship`, { mode: 'express', carrier: 'DHL', tracking_no: 'MK0001', sku_0: 'YR-HB-U2', qty_0: '50' })).path.split('/').pop();
  flash(await api.form(`/admin/shipments/${ship}/event`, { status: 'in_transit', location: 'LA' }));
  flash(await api.form(`/admin/shipments/${ship}/event`, { status: 'delivered', location: 'Austin' }));
  assert.match(await (await ctx.b('/shop/account')).text(), /Write a review/);
});

test('MA-04c a customer without a delivered order cannot review', async () => {
  const s = client();
  await s.form('/shop/account/register', { email: 'stranger@buyer.test', password: 'Passw0rd99' });
  assert.match(flash(await s.form('/shop/account/review', { productId: 'YR-HB-U2', rating: '5', body: 'I never bought this lamp.' })).err, /delivered orders/);
});

test('MA-04d a review shorter than 10 characters is rejected', async () => {
  assert.match(flash(await ctx.b.form('/shop/account/review', { productId: 'YR-HB-U2', rating: '5', body: 'short' })).err, /10 characters/);
});

test('MA-04e a valid review is accepted but stays hidden until moderation', async () => {
  assert.match(flash(await ctx.b.form('/shop/account/review', { productId: 'YR-HB-U2', rating: '5', title: 'Bright', body: 'Very bright and well packed, arrived on time.' })).ok, /after moderation/);
  assert.equal((await (await api.get('/api/shop/reviews/YR-HB-U2')).json()).count, 0);
});

test('MA-04f the review moderation list shows the reviewer e-mail', async () => {
  const list = await (await staff('mk1').get('/admin/reviews')).text();
  assert.match(list, /maria@buyer\.test/);
  ctx.reviewId = list.match(/\/admin\/reviews\/([\w-]+)/)[1];
});

test('MA-04g sales cannot moderate a review (403)', async () => {
  assert.equal((await staff('sales1').form(`/admin/reviews/${ctx.reviewId}`, { status: 'approved' })).status, 403);
});

test('MA-04h content approves the review with a reply', async () => {
  assert.match(flash(await staff('mk1').form(`/admin/reviews/${ctx.reviewId}`, { status: 'approved', reply: 'Thank you Maria!' })).ok, /已更新/);
});

test('MA-04i the public reviews API shows the approved review with average, first name and reply', async () => {
  ctx.pub = await (await api.get('/api/shop/reviews/YR-HB-U2')).json();
  assert.equal(ctx.pub.count, 1);
  assert.equal(ctx.pub.average, 5);
  assert.equal(ctx.pub.reviews[0].author, 'Maria'); // first name only (no country on the account)
  assert.equal(ctx.pub.reviews[0].reply, 'Thank you Maria!');
});

test('MA-04j the public reviews API hides the reviewer e-mail', async () => {
  assert.doesNotMatch(JSON.stringify(ctx.pub), /@/);
});

test('MA-04k after reviewing a product the account page no longer offers a review for it', async () => {
  assert.doesNotMatch(await (await ctx.b('/shop/account')).text(), /Write a review/); // once per product
});

test('MA-05a the wishlist API accepts JSON only (415 otherwise)', async () => {
  assert.equal((await ctx.b('/api/shop/wishlist', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"productId":"YR-HB-U2"}' })).status, 415);
});

test('MA-05b the wishlist needs a login: saving answers 401, reading answers logged-out and empty', async () => {
  assert.equal((await client().json('/api/shop/wishlist', { productId: 'YR-HB-U2' })).status, 401);
  assert.deepEqual(await (await client()('/api/shop/wishlist')).json(), { loggedIn: false, ids: [] });
});

test('MA-05c saving a product adds it to the wishlist', async () => {
  assert.deepEqual(await (await ctx.b.json('/api/shop/wishlist', { productId: 'YR-HB-U2' })).json(), { saved: true });
  assert.deepEqual(await (await ctx.b('/api/shop/wishlist')).json(), { loggedIn: true, ids: ['YR-HB-U2'] });
});

test('MA-05d saved products are shown on the account page', async () => {
  assert.match(await (await ctx.b('/shop/account')).text(), /Saved products[\s\S]*UFO High Bay U2/);
});

test('MA-05e saving an unknown product answers 404', async () => {
  assert.equal((await ctx.b.json('/api/shop/wishlist', { productId: 'NOPE' })).status, 404);
});

test('MA-05f a cross-site wishlist post is refused (403)', async () => {
  assert.equal((await ctx.b.json('/api/shop/wishlist', { productId: 'YR-HB-U2' }, { origin: 'https://evil.test' })).status, 403);
});

test('MA-05g saving the same product again removes it (toggle)', async () => {
  assert.deepEqual(await (await ctx.b.json('/api/shop/wishlist', { productId: 'YR-HB-U2' })).json(), { saved: false });
});

test('MA-06a search by keyword finds the matching product', async () => {
  assert.match(await (await api.get('/shop/search?q=high+bay')).text(), /UFO High Bay U2/);
});

test('MA-06b the category filter leaves out products of other categories', async () => {
  assert.doesNotMatch(await (await api.get('/shop/search?category=flood')).text(), /UFO High Bay U2/);
});

test('MA-06c search sorted by price works', async () => {
  assert.equal((await api.get('/shop/search?q=high&sort=price_asc')).status, 200);
});

test('MA-06d the search keyword is escaped in the page', async () => {
  const xss = await (await api.get('/shop/search?q=%3Cscript%3Ealert(1)%3C/script%3E')).text();
  assert.doesNotMatch(xss, /<script>alert\(1\)/);
});

test('MA-06e a search without matches says 0 results', async () => {
  assert.match(await (await api.get('/shop/search?q=zzqqxx')).text(), /0 results/);
});

test('MA-07a the related products API returns 1–4 other products', async () => {
  const rel = await (await api.get('/api/shop/related/YR-HB-U2')).json();
  assert.ok(rel.length > 0 && rel.length <= 4);
  assert.ok(!rel.some((p) => p.id === 'YR-HB-U2'));
});

test('MA-07b the related products API returns an empty list for an unknown product', async () => {
  assert.deepEqual(await (await api.get('/api/shop/related/NOPE')).json(), []);
});

test('MA-07c the operations dashboard reflects the paid order (top products, daily bars)', async () => {
  const d = await (await staff('sales1').get('/admin/dashboard')).text();
  assert.match(d, /经营看板/);
  assert.match(d, /YR-HB-U2/); // top products
  assert.match(d, /<svg/); // daily bars
});
