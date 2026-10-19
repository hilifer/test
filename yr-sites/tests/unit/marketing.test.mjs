// Modules: server/src/shop/marketing.js — coupons, verified-buyer reviews, wishlist, search, related products,
// abandoned-cart reminders, operations dashboard. IDs MK-xx.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempEnv } from '../helpers/env.mjs';

useTempEnv({ site: 'led', ERP_MODE: 'local' });
const M = await import('../../server/src/shop/marketing.js');
const Cart = await import('../../server/src/shop/cart.js');
const CO = await import('../../server/src/shop/checkout.js');
const F = await import('../../server/src/shop/freight.js');
const A = await import('../../server/src/shop/accounts.js');
const S = await import('../../server/src/ops/service.js');
const C = await import('../../server/src/catalog/store.js');
const { db } = await import('../../server/src/db.js');

const base = { category: 'indoor', summary: 'Marketing test lamp.', warranty: '2 years', unit: 'pcs', moq: 1, leadTimeDays: [5, 10], sampleDays: [2, 3], specs: 'Power: 10 W' };
C.saveProduct({ ...base, id: 'MK-A', name: 'Alpha Panel Light', keywords: ['panel'], certifications: ['UL'] }, { isNew: true, status: 'published', salesMode: 'both', variants: [{ sku: 'MK-A-1', price: '20', min_qty: '1', weight_kg: '1', stock_local: '1000' }] });
C.saveProduct({ ...base, id: 'MK-B', name: 'Beta Panel Light', certifications: ['CE'] }, { isNew: true, status: 'published', salesMode: 'both', variants: [{ sku: 'MK-B-1', price: '50', min_qty: '1', weight_kg: '1', stock_local: '5' }] });
C.saveProduct({ ...base, id: 'MK-C', name: 'Gamma Flood', category: 'flood', certifications: ['CE'] }, { isNew: true, status: 'published', salesMode: 'both', variants: [{ sku: 'MK-C-1', price: '100', min_qty: '1', weight_kg: '1', stock_local: '1000' }] });
C.publishCatalog();
S.seedSkus();

const zone = F.quoteShipping({ country: 'US', weightKg: 1 })[0].zoneId;
const addr = { name: 'Jane Doe', phone: '+1 555', line1: '1 Main St', city: 'Austin', country: 'US' };
const cartOf = (items) => { const c = Cart.createCart(); for (const [sku, q] of items) Cart.setItem(c.id, sku, q, { set: true }); return c; };
const order = (items, extra = {}) => CO.placeOrder({ cartId: cartOf(items).id, email: 'buyer@mk.test', address: addr, zoneId: zone, payment: 'tt', ...extra });

describe('coupons', () => {
  test('MK-01 validation: code format, kind, value range, date order', () => {
    assert.throws(() => M.saveCoupon({ code: 'a', kind: 'percent', value: 10 }), /券码/);
    assert.throws(() => M.saveCoupon({ code: 'OK10', kind: 'bogus', value: 10 }), /类型/);
    assert.throws(() => M.saveCoupon({ code: 'OK10', kind: 'percent', value: 95 }), /90/);
    assert.throws(() => M.saveCoupon({ code: 'OK10', kind: 'fixed', value: 0 }), /大于 0/);
    assert.throws(() => M.saveCoupon({ code: 'OK10', kind: 'fixed', value: 5, starts_at: '2027-01-02', ends_at: '2027-01-01' }), /开始时间/);
  });
  test('MK-02 create normalises the code to upper case; saving again updates (upsert)', () => {
    assert.equal(M.saveCoupon({ code: 'save10', kind: 'percent', value: 10 }), 'SAVE10');
    M.saveCoupon({ code: 'SAVE10', kind: 'percent', value: 15, note: 'raised' });
    const c = M.listCoupons().filter((x) => x.code === 'SAVE10');
    assert.equal(c.length, 1);
    assert.equal(c[0].value, 15);
    assert.equal(c[0].note, 'raised');
  });
  test('MK-03 percent and fixed discounts; fixed never exceeds the eligible amount', () => {
    const v = Cart.viewCart(cartOf([['MK-A-1', 2]]).id); // 40
    assert.deepEqual(M.applyCoupon('save10', v), { code: 'SAVE10', discount: 6 });
    M.saveCoupon({ code: 'BIG', kind: 'fixed', value: 500 });
    assert.equal(M.applyCoupon('BIG', v).discount, 40);
  });
  test('MK-04 unknown, inactive, expired, not-yet-started codes are refused (EN/ZH messages)', () => {
    const v = Cart.viewCart(cartOf([['MK-A-1', 1]]).id);
    assert.throws(() => M.applyCoupon('NOPE', v), /not valid/);
    assert.throws(() => M.applyCoupon('NOPE', v, { lang: 'zh' }), /优惠码无效/);
    M.saveCoupon({ code: 'OFF', kind: 'fixed', value: 1, active: '0' });
    assert.throws(() => M.applyCoupon('OFF', v), /not valid/);
    M.saveCoupon({ code: 'OLD', kind: 'fixed', value: 1, ends_at: '2020-01-01T00:00:00Z' });
    assert.throws(() => M.applyCoupon('OLD', v), /expired/);
    M.saveCoupon({ code: 'SOON', kind: 'fixed', value: 1, starts_at: '2099-01-01T00:00:00Z' });
    assert.throws(() => M.applyCoupon('SOON', v), /not active yet/);
  });
  test('MK-05 minimum spend and category restriction', () => {
    M.saveCoupon({ code: 'MIN100', kind: 'fixed', value: 5, min_subtotal: 100 });
    assert.throws(() => M.applyCoupon('MIN100', Cart.viewCart(cartOf([['MK-A-1', 1]]).id)), /at least 100/);
    assert.equal(M.applyCoupon('MIN100', Cart.viewCart(cartOf([['MK-A-1', 5]]).id)).discount, 5);
    M.saveCoupon({ code: 'OUTDOOR', kind: 'percent', value: 50, categories: 'flood' });
    assert.throws(() => M.applyCoupon('OUTDOOR', Cart.viewCart(cartOf([['MK-A-1', 1]]).id)), /does not apply/);
    // only the outdoor line is discounted: 50% of 100, not of 120
    assert.equal(M.applyCoupon('OUTDOOR', Cart.viewCart(cartOf([['MK-A-1', 1], ['MK-C-1', 1]]).id)).discount, 50);
  });
  test('MK-06 checkout applies the coupon: total = subtotal − discount + shipping; stored on the order', () => {
    M.saveCoupon({ code: 'TEN', kind: 'fixed', value: 10 });
    const o = order([['MK-A-1', 3]], { coupon: 'ten' });
    assert.equal(o.coupon, 'TEN');
    assert.equal(o.discount, 10);
    assert.equal(o.total, Math.round((60 - 10 + o.shipping_fee) * 100) / 100);
  });
  test('MK-07 per-customer and total usage limits; cancelled orders free the use again', () => {
    M.saveCoupon({ code: 'ONCE', kind: 'fixed', value: 1, per_customer: 1, max_uses: 2 });
    const o1 = order([['MK-A-1', 1]], { coupon: 'ONCE' });
    assert.throws(() => order([['MK-A-1', 1]], { coupon: 'ONCE' }), /already used/);
    S.setOrderStatus(o1.id, 'cancelled');
    order([['MK-A-1', 1]], { coupon: 'ONCE' });
    order([['MK-A-1', 1]], { coupon: 'ONCE', email: 'other@mk.test' });
    assert.throws(() => order([['MK-A-1', 1]], { coupon: 'ONCE', email: 'third@mk.test' }), /fully used/);
    assert.equal(M.listCoupons().find((c) => c.code === 'ONCE').used, 2);
  });
  test('MK-08 a refused coupon rolls back the whole checkout (no order, cart stays open)', () => {
    const c = cartOf([['MK-A-1', 1]]);
    const before = db.prepare('SELECT COUNT(*) n FROM orders').get().n;
    assert.throws(() => CO.placeOrder({ cartId: c.id, email: 'x@mk.test', address: addr, zoneId: zone, payment: 'tt', coupon: 'NOPE' }), /not valid/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM orders').get().n, before);
    assert.ok(Cart.getCart(c.id));
  });
});

describe('reviews', () => {
  let cust;
  test('MK-09 only products from delivered orders are reviewable', () => {
    const o = order([['MK-A-1', 1], ['MK-C-1', 1]], { email: 'reviewer@mk.test' });
    cust = S.getCustomer(o.customer_id);
    assert.deepEqual(M.reviewableProducts(cust.id), []);
    assert.throws(() => M.submitReview(cust.id, { productId: 'MK-A', rating: 5, body: 'Great light, very bright.' }), /delivered orders/);
    db.prepare("UPDATE orders SET status = 'delivered' WHERE id = ?").run(o.id);
    assert.deepEqual(M.reviewableProducts(cust.id).map((x) => x.productId).sort(), ['MK-A', 'MK-C']);
  });
  test('MK-10 rating 1–5 and minimum length enforced', () => {
    assert.throws(() => M.submitReview(cust.id, { productId: 'MK-A', rating: 0, body: 'Great light, very bright.' }), /1–5/);
    assert.throws(() => M.submitReview(cust.id, { productId: 'MK-A', rating: 6, body: 'Great light, very bright.' }), /1–5/);
    assert.throws(() => M.submitReview(cust.id, { productId: 'MK-A', rating: 5, body: 'short' }), /10 characters/);
    assert.throws(() => M.submitReview(cust.id, { productId: 'MK-A', rating: 5, body: '短' }, 'zh'), /10 个字/);
  });
  test('MK-11 new review is pending and not public; once per product', () => {
    const id = M.submitReview(cust.id, { productId: 'MK-A', rating: 4, title: 'Good', body: 'Great light, very bright.' });
    assert.equal(M.listReviews('pending').find((r) => r.id === id).status, 'pending');
    assert.equal(M.publicReviews('MK-A').count, 0);
    assert.throws(() => M.submitReview(cust.id, { productId: 'MK-A', rating: 5, body: 'Second review attempt here.' }), /once per product/);
    assert.deepEqual(M.reviewableProducts(cust.id).map((x) => x.productId), ['MK-C']);
  });
  test('MK-12 approve → public with average, reply, and no e-mail exposed; reject → hidden', () => {
    const r = M.listReviews('pending').find((x) => x.product_id === 'MK-A');
    M.moderateReview(r.id, 'approved', 'Thanks!');
    const pub = M.publicReviews('MK-A');
    assert.equal(pub.count, 1);
    assert.equal(pub.average, 4);
    assert.equal(pub.reviews[0].reply, 'Thanks!');
    assert.equal(pub.reviews[0].author, 'Jane · US');
    assert.doesNotMatch(JSON.stringify(pub), /@/);
    M.moderateReview(r.id, 'rejected');
    assert.equal(M.publicReviews('MK-A').count, 0);
    assert.throws(() => M.moderateReview(r.id, 'deleted'), /状态无效/);
    assert.throws(() => M.moderateReview('nope', 'approved'), /不存在/);
  });
});

describe('wishlist, search, related', () => {
  test('MK-13 wishlist toggles on/off; unknown product refused; list keeps catalog order of adds', () => {
    const c = S.getCustomer(db.prepare("SELECT customer_id FROM orders LIMIT 1").get().customer_id);
    assert.equal(M.toggleWishlist(c.id, 'MK-B'), true);
    assert.equal(M.toggleWishlist(c.id, 'MK-C'), true);
    assert.deepEqual(M.wishlist(c.id).map((p) => p.id).sort(), ['MK-B', 'MK-C']);
    assert.equal(M.toggleWishlist(c.id, 'MK-B'), false);
    assert.deepEqual(M.wishlist(c.id).map((p) => p.id), ['MK-C']);
    assert.throws(() => M.toggleWishlist(c.id, 'NOPE'), /not_found/);
  });
  test('MK-14 search: keyword (name match ranks first), category, certification, price range, sort', () => {
    const ids = (r) => r.map((x) => x.id).filter((id) => id.startsWith('MK-'));
    assert.deepEqual(ids(M.searchShop({ q: 'panel' })).sort(), ['MK-A', 'MK-B']);
    assert.equal(M.searchShop({ q: 'alpha panel' })[0].id, 'MK-A'); // two name hits rank first
    assert.ok(ids(M.searchShop({ category: 'flood' })).includes('MK-C'));
    assert.ok(!ids(M.searchShop({ category: 'flood' })).includes('MK-A'));
    assert.ok(ids(M.searchShop({ q: 'panel', cert: 'ul' })).includes('MK-A'));
    assert.ok(!ids(M.searchShop({ q: 'panel', cert: 'ul' })).includes('MK-B'));
    assert.deepEqual(ids(M.searchShop({ q: 'panel flood', minPrice: 30, maxPrice: 60 })), ['MK-B']);
    const asc = M.searchShop({ q: 'panel flood', sort: 'price_asc' }).map((x) => x.price);
    assert.deepEqual(asc, [...asc].sort((a, b) => a - b));
    assert.equal(M.searchShop({ q: 'zzzqqq' }).length, 0);
  });
  test('MK-15 related: bought-together first, then same category; never the product itself', () => {
    const r = M.related('MK-A').map((x) => x.id);
    assert.equal(r[0], 'MK-C'); // bought together in MK-09 / MK-05 orders
    assert.ok(r.includes('MK-B'));
    assert.ok(!r.includes('MK-A'));
    assert.deepEqual(M.related('NOPE'), []);
  });
});

describe('abandoned carts & dashboard', () => {
  test('MK-16 reminder only to opted-in customers, once, only for carts idle > 24 h and < 14 days', async () => {
    const yes = (await A.register({ email: 'optin@mk.test', password: 'Passw0rd123', marketing: true })).customer || S.findOrCreateCustomer?.({ email: 'optin@mk.test' });
    const no = (await A.register({ email: 'optout@mk.test', password: 'Passw0rd123', marketing: false })).customer || null;
    const cid = (e) => db.prepare('SELECT id FROM customers WHERE email = ?').get(e).id;
    const old = new Date(Date.now() - 30 * 3600e3).toISOString();
    const ancient = new Date(Date.now() - 20 * 864e5).toISOString();
    const mk = (email, ts) => { const c = Cart.createCart(cid(email)); Cart.setItem(c.id, 'MK-A-1', 2); db.prepare('UPDATE carts SET updated_at = ? WHERE id = ?').run(ts, c.id); return c; };
    mk('optin@mk.test', old);
    mk('optout@mk.test', old);
    mk('optin@mk.test', ancient);
    mk('optin@mk.test', new Date().toISOString());
    void yes; void no;
    assert.equal(await M.remindAbandonedCarts(), 1);
    assert.equal(await M.remindAbandonedCarts(), 0);
    const mail = db.prepare("SELECT subject, body FROM mail_outbox WHERE to_addr = 'optin@mk.test' AND subject LIKE '%cart%'").all();
    assert.equal(mail.length, 1);
    assert.match(mail[0].body, /2 × Alpha Panel Light/);
    assert.match(mail[0].body, /unsubscribe/);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM mail_outbox WHERE to_addr = 'optout@mk.test' AND subject LIKE '%cart%'").get().n, 0);
  });
  test('MK-17 dashboard: GMV/orders count paid orders only; to-do counts; low stock; top products', () => {
    const before = M.dashboardStats();
    const o = order([['MK-B-1', 2]], { email: 'dash@mk.test' });
    assert.equal(M.dashboardStats().today.gmv, before.today.gmv); // pending_payment is not revenue
    assert.equal(M.dashboardStats().todo.unpaid, before.todo.unpaid + 1);
    S.recordPayment(o.id, { kind: 'balance', amount: o.total });
    const after = M.dashboardStats();
    assert.equal(after.today.orders, before.today.orders + 1);
    assert.equal(Math.round((after.today.gmv - before.today.gmv) * 100) / 100, o.total);
    assert.equal(after.todo.toShip, before.todo.toShip + 1);
    assert.ok(after.top.some((t) => t.sku === 'MK-B-1' && t.qty >= 2));
    assert.ok(after.lowStock.some((s) => s.sku === 'MK-B-1')); // 5 in stock, below the default 20
    assert.ok(!after.lowStock.some((s) => s.sku === 'MK-A-1'));
    assert.ok(after.month.aov > 0);
    assert.ok(after.daily.length >= 1);
  });
});
