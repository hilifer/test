// Modules: server/src/marketing/analytics.js (events, funnel, product data, campaigns) and promotions.js (flash sales and
// spend-and-save, applied at checkout). IDs GR-xx.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempEnv } from '../helpers/env.mjs';

useTempEnv({ site: 'led', ERP_MODE: 'local' });
const A = await import('../../server/src/marketing/analytics.js');
const P = await import('../../server/src/marketing/promotions.js');
const C = await import('../../server/src/catalog/store.js');
const Cart = await import('../../server/src/shop/cart.js');
const CO = await import('../../server/src/shop/checkout.js');
const F = await import('../../server/src/shop/freight.js');
const S = await import('../../server/src/ops/service.js');
const { db, insertLead } = await import('../../server/src/db.js');

C.saveProduct({ id: 'PROMO-1', name: 'Promo Lamp', category: 'indoor', summary: 'Test lamp.', warranty: '2 years', unit: 'pcs', moq: 1, leadTimeDays: [5, 10], sampleDays: [2, 3], specs: 'Power: 10 W' }, {
  isNew: true, status: 'published', salesMode: 'both', variants: [{ sku: 'PROMO-1-A', price: '100', min_qty: '1', weight_kg: '0.5', stock_local: '100' }],
});
C.saveProduct({ id: 'OTHER-1', name: 'Other Lamp', category: 'flood', summary: 'Test lamp.', warranty: '2 years', unit: 'pcs', moq: 1, leadTimeDays: [5, 10], sampleDays: [2, 3], specs: 'Power: 10 W' }, {
  isNew: true, status: 'published', salesMode: 'both', variants: [{ sku: 'OTHER-1-A', price: '50', min_qty: '1', weight_kg: '0.5', stock_local: '100' }],
});
C.publishCatalog();
const addr = { name: 'Jane', phone: '+1 555', line1: '1 Main St', city: 'Austin', country: 'US' };
const usZone = () => F.quoteShipping({ country: 'US', weightKg: 1, subtotal: 0 })[0].zoneId;
const cart = (items) => { const c = Cart.createCart(); for (const [sku, q] of items) Cart.setItem(c.id, sku, q, { set: true }); return c; };
const iso = (h) => new Date(Date.now() + h * 3600e3).toISOString();

describe('analytics', () => {
  const v1 = A.visitorId('1.1.1.1', 'Firefox'), v2 = A.visitorId('2.2.2.2', 'Safari');
  test('GR-01a the visitor id for the same IP and browser changes every day', () => {
    assert.notEqual(A.visitorId('1.1.1.1', 'Firefox', '2026-01-01'), A.visitorId('1.1.1.1', 'Firefox', '2026-01-02'), 'a new id every day');
  });
  test('GR-01b funnel counts unique visitors, views, product views, carts and inquiries; no orders yet', () => {
    A.track('view', { path: '/', visitor: v1, ref: 'https://www.google.com/search?q=x', source: '' });
    A.track('view', { path: '/products/promo-lamp/', productId: 'PROMO-1', visitor: v1 });
    A.track('view', { path: '/products/promo-lamp/', productId: 'PROMO-1', visitor: v2, campaign: 'fb-q4', source: 'facebook' });
    A.track('cart', { productId: 'PROMO-1', visitor: v2 });
    insertLead({ email: 'f@x.test', grade: 'C', score: 10, consent: true });
    const f = A.funnel(1);
    assert.deepEqual([f.visitors, f.views, f.productViews, f.carts, f.leads], [2, 3, 2, 1, 1]);
    assert.equal(f.orders, 0);
    assert.equal(f.conversion, 0);
  });
  test('GR-01c top sources come from the referrer host or the source tag', () => {
    const src = Object.fromEntries(A.topSources(30).map((r) => [r.src, r.visitors]));
    assert.equal(src['www.google.com'], 1);
    assert.equal(src.facebook, 1);
  });
  test('GR-01d top pages are ordered by views', () => {
    assert.equal(A.topPages(30)[0].path, '/products/promo-lamp/');
  });
  test('GR-01e the daily series has one row per day with today\'s visitors', () => {
    const series = A.dailySeries(7);
    assert.equal(series.length, 7);
    assert.equal(series.at(-1).visitors, 2);
  });
  let o2, s2;
  test('GR-02a product stats count views, carts, orders (from order lines) and units', () => {
    const c = cart([['PROMO-1-A', 3]]);
    o2 = CO.placeOrder({ cartId: c.id, email: 'buyer@x.test', address: addr, zoneId: usZone(), payment: 'tt' });
    S.recordPayment(o2.id, { kind: 'balance', amount: o2.total });
    s2 = A.productStats(30).get('PROMO-1');
    assert.deepEqual([s2.views, s2.carts, s2.orders, s2.units], [2, 1, 1, 3]);
  });
  test('GR-02b product stats give revenue and conversion (orders / views)', () => {
    assert.equal(s2.revenue, 300);
    assert.equal(s2.conversion, 0.5);
  });
  test('GR-02c the funnel counts the paid order and its revenue', () => {
    const f = A.funnel(1);
    assert.equal(f.orders, 1);
    assert.equal(f.revenue, o2.total);
  });
});

describe('campaigns', () => {
  test('GR-03a a saved campaign\'s link carries the UTM parameters', () => {
    const id = A.saveCampaign({ name: 'Facebook Q4', code: 'fb-q4', source: 'facebook', medium: 'paid-social', landing: '/products/promo-lamp/', spend: 200 });
    assert.equal(A.campaignLink(A.getCampaign(id)), 'https://example.test/products/promo-lamp/?utm_source=facebook&utm_medium=paid-social&utm_campaign=fb-q4');
  });
  test('GR-03b an invalid campaign code is rejected', () => {
    assert.throws(() => A.saveCampaign({ name: 'x', code: 'FB Q4!' }), /活动代码/);
  });
  test('GR-03c a campaign code already in use is rejected', () => {
    assert.throws(() => A.saveCampaign({ name: 'dup', code: 'fb-q4' }), /已被使用/);
  });
  test('GR-03d a landing page on another site is rejected', () => {
    assert.throws(() => A.saveCampaign({ name: 'x', code: 'ok-1', landing: 'https://evil.test' }), /落地页/);
  });
  test('GR-03e a negative spend is rejected', () => {
    assert.throws(() => A.saveCampaign({ name: 'x', code: 'ok-2', spend: -1 }), /花费/);
  });
  test('GR-03f campaign codes seen in traffic but not registered are listed', () => {
    A.track('view', { path: '/', visitor: 'zz', campaign: 'trade-show' });
    assert.deepEqual(A.unregisteredCodes().map((r) => r.code), ['trade-show']);
  });
  let s4, o4b;
  test('GR-04a campaign results count visitors, inquiries, shop orders plus orders from its inquiries, and customers', () => {
    const leadId = insertLead({ email: 'camp@x.test', company: 'Camp Co', grade: 'B', score: 50, consent: true });
    db.prepare("UPDATE leads SET campaign = 'fb-q4' WHERE id = ?").run(leadId);
    const q = S.createQuote({ customer: { email: 'camp@x.test' }, lead_id: leadId, lines: [{ sku: 'PROMO-1-A', qty: 10, unit_price: 80 }] });
    S.setQuoteStatus(q.id, 'sent');
    const o1 = S.acceptQuote(q.id);
    S.recordPayment(o1.id, { kind: 'deposit', amount: 300 });
    const c = cart([['OTHER-1-A', 2]]);
    o4b = CO.placeOrder({ cartId: c.id, email: 'shop@x.test', address: addr, zoneId: usZone(), payment: 'tt' });
    db.prepare("UPDATE orders SET campaign = 'fb-q4' WHERE id = ?").run(o4b.id);
    S.recordPayment(o4b.id, { kind: 'balance', amount: o4b.total });
    s4 = A.campaignStats('fb-q4', 200);
    assert.deepEqual([s4.visitors, s4.leads, s4.orders, s4.customers], [1, 1, 2, 2]);
  });
  test('GR-04b campaign revenue is the money received, not the order totals', () => {
    assert.equal(s4.revenue, 300 + o4b.total);
  });
  test('GR-04c campaign ROI is (revenue − spend) / spend', () => {
    assert.equal(s4.roi, (s4.revenue - 200) / 200);
  });
  test('GR-04d cost per lead and cost per customer divide the spend', () => {
    assert.equal(s4.costPerLead, 200);
    assert.equal(s4.cac, 100);
  });
  test('GR-04e ROI is null when there is no spend', () => {
    assert.equal(A.campaignStats('none', 0).roi, null);
  });
});

describe('promotions', () => {
  test('GR-05a a percentage outside 1–99 is rejected', () => {
    assert.throws(() => P.savePromotion({ name: 'x', kind: 'percent', value: 120, starts_at: iso(-1), ends_at: iso(1) }), /1–99/);
  });
  test('GR-05b a spend-and-save threshold not above the discount is rejected', () => {
    assert.throws(() => P.savePromotion({ name: 'x', kind: 'threshold', value: 50, threshold: 40, starts_at: iso(-1), ends_at: iso(1) }), /门槛大于/);
  });
  test('GR-05c an end time before the start time is rejected', () => {
    assert.throws(() => P.savePromotion({ name: 'x', kind: 'percent', value: 10, starts_at: iso(1), ends_at: iso(-1) }), /晚于/);
  });
  test('GR-05d an unknown product is rejected', () => {
    assert.throws(() => P.savePromotion({ name: 'x', kind: 'percent', value: 10, products: 'NOPE', starts_at: iso(-1), ends_at: iso(1) }), /商品不存在：NOPE/);
  });
  test('GR-05e a future promotion is scheduled, a past one ended, and neither is running', () => {
    const later = P.savePromotion({ name: '下周特价', kind: 'percent', value: 30, starts_at: iso(48), ends_at: iso(72) });
    const ended = P.savePromotion({ name: '上周特价', kind: 'percent', value: 30, starts_at: iso(-72), ends_at: iso(-48) });
    assert.equal(P.promoState(P.getPromotion(later)), 'scheduled');
    assert.equal(P.promoState(P.getPromotion(ended)), 'ended');
    assert.equal(P.running().length, 0);
  });
  let flash, spend, big;
  test('GR-06a a % off promotion applies only to covered products, labelled in English', () => {
    flash = P.savePromotion({ name: '室内灯 9 折', name_en: 'Indoor sale', kind: 'percent', value: 10, categories: 'indoor', starts_at: iso(-1), ends_at: iso(24) });
    spend = P.savePromotion({ name: '满 500 减 80', name_en: 'Big order', kind: 'threshold', value: 80, threshold: 500, starts_at: iso(-1), ends_at: iso(24) });
    const small = Cart.viewCart(cart([['PROMO-1-A', 2], ['OTHER-1-A', 1]]).id); // 200 indoor + 50 flood
    assert.deepEqual(P.bestPromotion(small, { lang: 'en' }), { id: flash, name: 'Indoor sale: 10% off', discount: 20, ends_at: P.getPromotion(flash).ends_at });
  });
  test('GR-06b spend & save wins when it saves more, labelled in Chinese', () => {
    big = Cart.viewCart(cart([['PROMO-1-A', 6]]).id); // 600 → 10% = 60 < 80
    assert.equal(P.bestPromotion(big, { lang: 'zh' }).name, '满 500 减 80：满 500 减 80');
    assert.equal(P.bestPromotion(big).discount, 80);
  });
  test('GR-06c an uncovered product under the threshold gets no promotion', () => {
    assert.equal(P.bestPromotion(Cart.viewCart(cart([['OTHER-1-A', 2]]).id)), null, 'flood light, under the threshold');
  });
  test('GR-06d a covered product shows the % off badge', () => {
    assert.deepEqual(P.productBadge('PROMO-1', 'zh'), { label: '室内灯 9 折：9 折', ends_at: P.getPromotion(flash).ends_at, kind: 'percent', value: 10 });
  });
  test('GR-06e spend & save shows a badge on every product', () => {
    assert.equal(P.productBadge('OTHER-1').label, 'Big order: 80 off orders over 500', 'spend & save covers every product');
  });
  test('GR-06f the promotion zone lists each promotion with its products', () => {
    const zone = P.promoZone('en');
    assert.ok(zone.some((z) => z.label === 'Indoor sale: 10% off' && z.products.some((p) => p.id === 'PROMO-1')));
  });
  test('GR-06g a switched-off promotion is no longer applied', () => {
    P.setPromotionActive(spend, false);
    assert.equal(P.bestPromotion(big).discount, 60);
  });
  test('GR-07a checkout applies the promotion and records it on the order', () => {
    db.prepare("INSERT INTO coupons (code, kind, value, min_subtotal, active, created_at) VALUES ('BIG', 'fixed', 1000, 0, 1, ?)").run(new Date().toISOString());
    const c1 = cart([['PROMO-1-A', 2]]);
    const o = CO.placeOrder({ cartId: c1.id, email: 'p@x.test', address: addr, zoneId: usZone(), payment: 'tt' });
    const row = db.prepare('SELECT discount, promotion, subtotal, shipping_fee, total FROM orders WHERE id = ?').get(o.id);
    assert.deepEqual([row.discount, row.promotion], [20, 'Indoor sale: 10% off']);
    assert.equal(row.total, row.subtotal - 20 + row.shipping_fee);
  });
  test('GR-07b a coupon on top of the promotion never discounts more than the goods', () => {
    const c2 = cart([['PROMO-1-A', 2]]);
    const o2 = CO.placeOrder({ cartId: c2.id, email: 'q@x.test', address: addr, zoneId: usZone(), payment: 'tt', coupon: 'BIG' });
    const r2 = db.prepare('SELECT discount, subtotal, shipping_fee, total FROM orders WHERE id = ?').get(o2.id);
    assert.equal(r2.discount, r2.subtotal, 'capped at the goods total');
    assert.equal(r2.total, r2.shipping_fee);
  });
});
