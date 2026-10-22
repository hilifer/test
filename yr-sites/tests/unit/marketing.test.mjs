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
  test('MK-01a a too-short coupon code is rejected', () => {
    assert.throws(() => M.saveCoupon({ code: 'a', kind: 'percent', value: 10 }), /券码/);
  });
  test('MK-01b an unknown coupon kind is rejected', () => {
    assert.throws(() => M.saveCoupon({ code: 'OK10', kind: 'bogus', value: 10 }), /类型/);
  });
  test('MK-01c a percentage above 90 is rejected', () => {
    assert.throws(() => M.saveCoupon({ code: 'OK10', kind: 'percent', value: 95 }), /90/);
  });
  test('MK-01d a fixed value of 0 is rejected', () => {
    assert.throws(() => M.saveCoupon({ code: 'OK10', kind: 'fixed', value: 0 }), /大于 0/);
  });
  test('MK-01e an end date before the start date is rejected', () => {
    assert.throws(() => M.saveCoupon({ code: 'OK10', kind: 'fixed', value: 5, starts_at: '2027-01-02', ends_at: '2027-01-01' }), /开始时间/);
  });
  test('MK-02a creating a coupon normalises the code to upper case', () => {
    assert.equal(M.saveCoupon({ code: 'save10', kind: 'percent', value: 10 }), 'SAVE10');
  });
  test('MK-02b saving the same code again updates the coupon instead of adding one', () => {
    M.saveCoupon({ code: 'SAVE10', kind: 'percent', value: 15, note: 'raised' });
    const c = M.listCoupons().filter((x) => x.code === 'SAVE10');
    assert.equal(c.length, 1);
    assert.equal(c[0].value, 15);
    assert.equal(c[0].note, 'raised');
  });
  let v3;
  test('MK-03a a percent coupon discounts that share of the cart', () => {
    v3 = Cart.viewCart(cartOf([['MK-A-1', 2]]).id); // 40
    assert.deepEqual(M.applyCoupon('save10', v3), { code: 'SAVE10', discount: 6 });
  });
  test('MK-03b a fixed coupon never exceeds the eligible amount', () => {
    M.saveCoupon({ code: 'BIG', kind: 'fixed', value: 500 });
    assert.equal(M.applyCoupon('BIG', v3).discount, 40);
  });
  let v4;
  test('MK-04a an unknown code is refused with an English or Chinese message', () => {
    v4 = Cart.viewCart(cartOf([['MK-A-1', 1]]).id);
    assert.throws(() => M.applyCoupon('NOPE', v4), /not valid/);
    assert.throws(() => M.applyCoupon('NOPE', v4, { lang: 'zh' }), /优惠码无效/);
  });
  test('MK-04b an inactive code is refused', () => {
    M.saveCoupon({ code: 'OFF', kind: 'fixed', value: 1, active: '0' });
    assert.throws(() => M.applyCoupon('OFF', v4), /not valid/);
  });
  test('MK-04c an expired code is refused', () => {
    M.saveCoupon({ code: 'OLD', kind: 'fixed', value: 1, ends_at: '2020-01-01T00:00:00Z' });
    assert.throws(() => M.applyCoupon('OLD', v4), /expired/);
  });
  test('MK-04d a not-yet-started code is refused', () => {
    M.saveCoupon({ code: 'SOON', kind: 'fixed', value: 1, starts_at: '2099-01-01T00:00:00Z' });
    assert.throws(() => M.applyCoupon('SOON', v4), /not active yet/);
  });
  test('MK-05a a cart under the minimum spend is refused', () => {
    M.saveCoupon({ code: 'MIN100', kind: 'fixed', value: 5, min_subtotal: 100 });
    assert.throws(() => M.applyCoupon('MIN100', Cart.viewCart(cartOf([['MK-A-1', 1]]).id)), /at least 100/);
  });
  test('MK-05b a cart reaching the minimum spend gets the discount', () => {
    assert.equal(M.applyCoupon('MIN100', Cart.viewCart(cartOf([['MK-A-1', 5]]).id)).discount, 5);
  });
  test('MK-05c a category-restricted coupon is refused when no line is in the category', () => {
    M.saveCoupon({ code: 'OUTDOOR', kind: 'percent', value: 50, categories: 'flood' });
    assert.throws(() => M.applyCoupon('OUTDOOR', Cart.viewCart(cartOf([['MK-A-1', 1]]).id)), /does not apply/);
  });
  test('MK-05d a category-restricted coupon discounts only the lines in the category', () => {
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
  let o7;
  test('MK-07a a customer cannot use a once-per-customer coupon twice', () => {
    M.saveCoupon({ code: 'ONCE', kind: 'fixed', value: 1, per_customer: 1, max_uses: 2 });
    o7 = order([['MK-A-1', 1]], { coupon: 'ONCE' });
    assert.throws(() => order([['MK-A-1', 1]], { coupon: 'ONCE' }), /already used/);
  });
  test('MK-07b cancelling the order frees the use again', () => {
    S.setOrderStatus(o7.id, 'cancelled');
    assert.doesNotThrow(() => order([['MK-A-1', 1]], { coupon: 'ONCE' }));
  });
  test('MK-07c the total usage limit refuses further customers', () => {
    order([['MK-A-1', 1]], { coupon: 'ONCE', email: 'other@mk.test' });
    assert.throws(() => order([['MK-A-1', 1]], { coupon: 'ONCE', email: 'third@mk.test' }), /fully used/);
  });
  test('MK-07d the used count excludes the cancelled order', () => {
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
  let cust, o9;
  test('MK-09a products of an undelivered order are not reviewable', () => {
    o9 = order([['MK-A-1', 1], ['MK-C-1', 1]], { email: 'reviewer@mk.test' });
    cust = S.getCustomer(o9.customer_id);
    assert.deepEqual(M.reviewableProducts(cust.id), []);
    assert.throws(() => M.submitReview(cust.id, { productId: 'MK-A', rating: 5, body: 'Great light, very bright.' }), /delivered orders/);
  });
  test('MK-09b products of a delivered order become reviewable', () => {
    db.prepare("UPDATE orders SET status = 'delivered' WHERE id = ?").run(o9.id);
    assert.deepEqual(M.reviewableProducts(cust.id).map((x) => x.productId).sort(), ['MK-A', 'MK-C']);
  });
  test('MK-10a a rating outside 1–5 is refused', () => {
    assert.throws(() => M.submitReview(cust.id, { productId: 'MK-A', rating: 0, body: 'Great light, very bright.' }), /1–5/);
    assert.throws(() => M.submitReview(cust.id, { productId: 'MK-A', rating: 6, body: 'Great light, very bright.' }), /1–5/);
  });
  test('MK-10b a review body under the minimum length is refused (English message)', () => {
    assert.throws(() => M.submitReview(cust.id, { productId: 'MK-A', rating: 5, body: 'short' }), /10 characters/);
  });
  test('MK-10c a review body under the minimum length is refused (Chinese message)', () => {
    assert.throws(() => M.submitReview(cust.id, { productId: 'MK-A', rating: 5, body: '短' }, 'zh'), /10 个字/);
  });
  test('MK-11a a new review is pending and not public', () => {
    const id = M.submitReview(cust.id, { productId: 'MK-A', rating: 4, title: 'Good', body: 'Great light, very bright.' });
    assert.equal(M.listReviews('pending').find((r) => r.id === id).status, 'pending');
    assert.equal(M.publicReviews('MK-A').count, 0);
  });
  test('MK-11b a customer can review a product only once', () => {
    assert.throws(() => M.submitReview(cust.id, { productId: 'MK-A', rating: 5, body: 'Second review attempt here.' }), /once per product/);
  });
  test('MK-11c a reviewed product leaves the reviewable list', () => {
    assert.deepEqual(M.reviewableProducts(cust.id).map((x) => x.productId), ['MK-C']);
  });
  let r12, pub;
  test('MK-12a an approved review is public and counted in the average', () => {
    r12 = M.listReviews('pending').find((x) => x.product_id === 'MK-A');
    M.moderateReview(r12.id, 'approved', 'Thanks!');
    pub = M.publicReviews('MK-A');
    assert.equal(pub.count, 1);
    assert.equal(pub.average, 4);
  });
  test('MK-12b the staff reply is shown with the public review', () => {
    assert.equal(pub.reviews[0].reply, 'Thanks!');
  });
  test('MK-12c the public review shows first name and country and never an e-mail', () => {
    assert.equal(pub.reviews[0].author, 'Jane · US');
    assert.doesNotMatch(JSON.stringify(pub), /@/);
  });
  test('MK-12d a rejected review is hidden', () => {
    M.moderateReview(r12.id, 'rejected');
    assert.equal(M.publicReviews('MK-A').count, 0);
  });
  test('MK-12e an invalid moderation status is refused', () => {
    assert.throws(() => M.moderateReview(r12.id, 'deleted'), /状态无效/);
  });
  test('MK-12f moderating an unknown review is refused', () => {
    assert.throws(() => M.moderateReview('nope', 'approved'), /不存在/);
  });
});

describe('wishlist, search, related', () => {
  let c13;
  test('MK-13a toggling adds products to the wishlist', () => {
    c13 = S.getCustomer(db.prepare("SELECT customer_id FROM orders LIMIT 1").get().customer_id);
    assert.equal(M.toggleWishlist(c13.id, 'MK-B'), true);
    assert.equal(M.toggleWishlist(c13.id, 'MK-C'), true);
    assert.deepEqual(M.wishlist(c13.id).map((p) => p.id).sort(), ['MK-B', 'MK-C']);
  });
  test('MK-13b toggling a listed product removes it', () => {
    assert.equal(M.toggleWishlist(c13.id, 'MK-B'), false);
    assert.deepEqual(M.wishlist(c13.id).map((p) => p.id), ['MK-C']);
  });
  test('MK-13c an unknown product is refused', () => {
    assert.throws(() => M.toggleWishlist(c13.id, 'NOPE'), /not_found/);
  });
  const ids = (r) => r.map((x) => x.id).filter((id) => id.startsWith('MK-'));
  test('MK-14a search by keyword finds matching products', () => {
    assert.deepEqual(ids(M.searchShop({ q: 'panel' })).sort(), ['MK-A', 'MK-B']);
  });
  test('MK-14b products matching more words in the name rank first', () => {
    assert.equal(M.searchShop({ q: 'alpha panel' })[0].id, 'MK-A'); // two name hits rank first
  });
  test('MK-14c search filters by category', () => {
    assert.ok(ids(M.searchShop({ category: 'flood' })).includes('MK-C'));
    assert.ok(!ids(M.searchShop({ category: 'flood' })).includes('MK-A'));
  });
  test('MK-14d search filters by certification', () => {
    assert.ok(ids(M.searchShop({ q: 'panel', cert: 'ul' })).includes('MK-A'));
    assert.ok(!ids(M.searchShop({ q: 'panel', cert: 'ul' })).includes('MK-B'));
  });
  test('MK-14e search filters by price range', () => {
    assert.deepEqual(ids(M.searchShop({ q: 'panel flood', minPrice: 30, maxPrice: 60 })), ['MK-B']);
  });
  test('MK-14f search sorts by price ascending', () => {
    const asc = M.searchShop({ q: 'panel flood', sort: 'price_asc' }).map((x) => x.price);
    assert.deepEqual(asc, [...asc].sort((a, b) => a - b));
  });
  test('MK-14g a keyword with no match returns nothing', () => {
    assert.equal(M.searchShop({ q: 'zzzqqq' }).length, 0);
  });
  const rel = () => M.related('MK-A').map((x) => x.id);
  test('MK-15a related products list bought-together products first', () => {
    assert.equal(rel()[0], 'MK-C'); // bought together in MK-09 / MK-05 orders
  });
  test('MK-15b related products include the same category', () => {
    assert.ok(rel().includes('MK-B'));
  });
  test('MK-15c related products never include the product itself', () => {
    assert.ok(!rel().includes('MK-A'));
  });
  test('MK-15d an unknown product has no related products', () => {
    assert.deepEqual(M.related('NOPE'), []);
  });
});

describe('abandoned carts & dashboard', () => {
  test('MK-16a one reminder goes out, only to the opted-in customer\'s cart idle > 24 h and < 14 days', async () => {
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
  });
  test('MK-16b a cart is reminded only once', async () => {
    assert.equal(await M.remindAbandonedCarts(), 0);
  });
  test('MK-16c the reminder lists the cart lines and an unsubscribe link', () => {
    const mail = db.prepare("SELECT subject, body FROM mail_outbox WHERE to_addr = 'optin@mk.test' AND subject LIKE '%cart%'").all();
    assert.equal(mail.length, 1);
    assert.match(mail[0].body, /2 × Alpha Panel Light/);
    assert.match(mail[0].body, /unsubscribe/);
  });
  test('MK-16d a customer who did not opt in gets no reminder', () => {
    assert.equal(db.prepare("SELECT COUNT(*) n FROM mail_outbox WHERE to_addr = 'optout@mk.test' AND subject LIKE '%cart%'").get().n, 0);
  });
  let before, o17, after;
  test('MK-17a an unpaid order is not revenue but is counted as an unpaid to-do', () => {
    before = M.dashboardStats();
    o17 = order([['MK-B-1', 2]], { email: 'dash@mk.test' });
    assert.equal(M.dashboardStats().today.gmv, before.today.gmv); // pending_payment is not revenue
    assert.equal(M.dashboardStats().todo.unpaid, before.todo.unpaid + 1);
  });
  test('MK-17b a paid order counts towards today\'s orders and GMV', () => {
    S.recordPayment(o17.id, { kind: 'balance', amount: o17.total });
    after = M.dashboardStats();
    assert.equal(after.today.orders, before.today.orders + 1);
    assert.equal(Math.round((after.today.gmv - before.today.gmv) * 100) / 100, o17.total);
  });
  test('MK-17c a paid order is counted as a to-ship to-do', () => {
    assert.equal(after.todo.toShip, before.todo.toShip + 1);
  });
  test('MK-17d top products include the sold SKU', () => {
    assert.ok(after.top.some((t) => t.sku === 'MK-B-1' && t.qty >= 2));
  });
  test('MK-17e low stock lists SKUs below the threshold only', () => {
    assert.ok(after.lowStock.some((s) => s.sku === 'MK-B-1')); // 5 in stock, below the default 20
    assert.ok(!after.lowStock.some((s) => s.sku === 'MK-A-1'));
  });
  test('MK-17f the dashboard has the monthly average order value and a daily series', () => {
    assert.ok(after.month.aov > 0);
    assert.ok(after.daily.length >= 1);
  });
});
