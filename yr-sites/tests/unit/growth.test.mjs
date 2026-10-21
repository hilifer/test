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
  test('GR-01 funnel: visitors are unique per day, product views, carts, inquiries, orders and paid revenue', () => {
    const v1 = A.visitorId('1.1.1.1', 'Firefox'), v2 = A.visitorId('2.2.2.2', 'Safari');
    assert.notEqual(A.visitorId('1.1.1.1', 'Firefox', '2026-01-01'), A.visitorId('1.1.1.1', 'Firefox', '2026-01-02'), 'a new id every day');
    A.track('view', { path: '/', visitor: v1, ref: 'https://www.google.com/search?q=x', source: '' });
    A.track('view', { path: '/products/promo-lamp/', productId: 'PROMO-1', visitor: v1 });
    A.track('view', { path: '/products/promo-lamp/', productId: 'PROMO-1', visitor: v2, campaign: 'fb-q4', source: 'facebook' });
    A.track('cart', { productId: 'PROMO-1', visitor: v2 });
    insertLead({ email: 'f@x.test', grade: 'C', score: 10, consent: true });
    const f = A.funnel(1);
    assert.deepEqual([f.visitors, f.views, f.productViews, f.carts, f.leads], [2, 3, 2, 1, 1]);
    assert.equal(f.orders, 0);
    assert.equal(f.conversion, 0);
    const src = Object.fromEntries(A.topSources(30).map((r) => [r.src, r.visitors]));
    assert.equal(src['www.google.com'], 1);
    assert.equal(src.facebook, 1);
    assert.equal(A.topPages(30)[0].path, '/products/promo-lamp/');
    const series = A.dailySeries(7);
    assert.equal(series.length, 7);
    assert.equal(series.at(-1).visitors, 2);
  });
  test('GR-02 product data: views, carts, orders (from order lines), units, revenue, conversion', () => {
    const c = cart([['PROMO-1-A', 3]]);
    const o = CO.placeOrder({ cartId: c.id, email: 'buyer@x.test', address: addr, zoneId: usZone(), payment: 'tt' });
    S.recordPayment(o.id, { kind: 'balance', amount: o.total });
    const s = A.productStats(30).get('PROMO-1');
    assert.deepEqual([s.views, s.carts, s.orders, s.units], [2, 1, 1, 3]);
    assert.equal(s.revenue, 300);
    assert.equal(s.conversion, 0.5);
    const f = A.funnel(1);
    assert.equal(f.orders, 1);
    assert.equal(f.revenue, o.total);
  });
});

describe('campaigns', () => {
  test('GR-03 create with validation; the link carries UTM parameters; unregistered codes are listed', () => {
    const id = A.saveCampaign({ name: 'Facebook Q4', code: 'fb-q4', source: 'facebook', medium: 'paid-social', landing: '/products/promo-lamp/', spend: 200 });
    assert.equal(A.campaignLink(A.getCampaign(id)), 'https://example.test/products/promo-lamp/?utm_source=facebook&utm_medium=paid-social&utm_campaign=fb-q4');
    assert.throws(() => A.saveCampaign({ name: 'x', code: 'FB Q4!' }), /活动代码/);
    assert.throws(() => A.saveCampaign({ name: 'dup', code: 'fb-q4' }), /已被使用/);
    assert.throws(() => A.saveCampaign({ name: 'x', code: 'ok-1', landing: 'https://evil.test' }), /落地页/);
    assert.throws(() => A.saveCampaign({ name: 'x', code: 'ok-2', spend: -1 }), /花费/);
    A.track('view', { path: '/', visitor: 'zz', campaign: 'trade-show' });
    assert.deepEqual(A.unregisteredCodes().map((r) => r.code), ['trade-show']);
  });
  test('GR-04 results: visitors, inquiries, shop orders and orders from its inquiries; revenue = money received; ROI, cost per lead, per customer', () => {
    const leadId = insertLead({ email: 'camp@x.test', company: 'Camp Co', grade: 'B', score: 50, consent: true });
    db.prepare("UPDATE leads SET campaign = 'fb-q4' WHERE id = ?").run(leadId);
    const q = S.createQuote({ customer: { email: 'camp@x.test' }, lead_id: leadId, lines: [{ sku: 'PROMO-1-A', qty: 10, unit_price: 80 }] });
    S.setQuoteStatus(q.id, 'sent');
    const o1 = S.acceptQuote(q.id);
    S.recordPayment(o1.id, { kind: 'deposit', amount: 300 });
    const c = cart([['OTHER-1-A', 2]]);
    const o2 = CO.placeOrder({ cartId: c.id, email: 'shop@x.test', address: addr, zoneId: usZone(), payment: 'tt' });
    db.prepare("UPDATE orders SET campaign = 'fb-q4' WHERE id = ?").run(o2.id);
    S.recordPayment(o2.id, { kind: 'balance', amount: o2.total });
    const s = A.campaignStats('fb-q4', 200);
    assert.deepEqual([s.visitors, s.leads, s.orders, s.customers], [1, 1, 2, 2]);
    assert.equal(s.revenue, 300 + o2.total);
    assert.equal(s.roi, (s.revenue - 200) / 200);
    assert.equal(s.costPerLead, 200);
    assert.equal(s.cac, 100);
    assert.equal(A.campaignStats('none', 0).roi, null);
  });
});

describe('promotions', () => {
  test('GR-05 validation and state (scheduled / running / ended / switched off)', () => {
    assert.throws(() => P.savePromotion({ name: 'x', kind: 'percent', value: 120, starts_at: iso(-1), ends_at: iso(1) }), /1–99/);
    assert.throws(() => P.savePromotion({ name: 'x', kind: 'threshold', value: 50, threshold: 40, starts_at: iso(-1), ends_at: iso(1) }), /门槛大于/);
    assert.throws(() => P.savePromotion({ name: 'x', kind: 'percent', value: 10, starts_at: iso(1), ends_at: iso(-1) }), /晚于/);
    assert.throws(() => P.savePromotion({ name: 'x', kind: 'percent', value: 10, products: 'NOPE', starts_at: iso(-1), ends_at: iso(1) }), /商品不存在：NOPE/);
    const later = P.savePromotion({ name: '下周特价', kind: 'percent', value: 30, starts_at: iso(48), ends_at: iso(72) });
    const ended = P.savePromotion({ name: '上周特价', kind: 'percent', value: 30, starts_at: iso(-72), ends_at: iso(-48) });
    assert.equal(P.promoState(P.getPromotion(later)), 'scheduled');
    assert.equal(P.promoState(P.getPromotion(ended)), 'ended');
    assert.equal(P.running().length, 0);
  });
  test('GR-06 the best running promotion is applied: % off on covered products vs spend & save; labels in both languages', () => {
    const flash = P.savePromotion({ name: '室内灯 9 折', name_en: 'Indoor sale', kind: 'percent', value: 10, categories: 'indoor', starts_at: iso(-1), ends_at: iso(24) });
    const spend = P.savePromotion({ name: '满 500 减 80', name_en: 'Big order', kind: 'threshold', value: 80, threshold: 500, starts_at: iso(-1), ends_at: iso(24) });
    const small = Cart.viewCart(cart([['PROMO-1-A', 2], ['OTHER-1-A', 1]]).id); // 200 indoor + 50 flood
    assert.deepEqual(P.bestPromotion(small, { lang: 'en' }), { id: flash, name: 'Indoor sale: 10% off', discount: 20, ends_at: P.getPromotion(flash).ends_at });
    const big = Cart.viewCart(cart([['PROMO-1-A', 6]]).id); // 600 → 10% = 60 < 80
    assert.equal(P.bestPromotion(big, { lang: 'zh' }).name, '满 500 减 80：满 500 减 80');
    assert.equal(P.bestPromotion(big).discount, 80);
    assert.equal(P.bestPromotion(Cart.viewCart(cart([['OTHER-1-A', 2]]).id)), null, 'flood light, under the threshold');
    assert.deepEqual(P.productBadge('PROMO-1', 'zh'), { label: '室内灯 9 折：9 折', ends_at: P.getPromotion(flash).ends_at, kind: 'percent', value: 10 });
    assert.equal(P.productBadge('OTHER-1').label, 'Big order: 80 off orders over 500', 'spend & save covers every product');
    const zone = P.promoZone('en');
    assert.ok(zone.some((z) => z.label === 'Indoor sale: 10% off' && z.products.some((p) => p.id === 'PROMO-1')));
    P.setPromotionActive(spend, false);
    assert.equal(P.bestPromotion(big).discount, 60);
  });
  test('GR-07 checkout applies the promotion on top of a coupon, records it, never discounts more than the goods', () => {
    db.prepare("INSERT INTO coupons (code, kind, value, min_subtotal, active, created_at) VALUES ('BIG', 'fixed', 1000, 0, 1, ?)").run(new Date().toISOString());
    const c1 = cart([['PROMO-1-A', 2]]);
    const o = CO.placeOrder({ cartId: c1.id, email: 'p@x.test', address: addr, zoneId: usZone(), payment: 'tt' });
    const row = db.prepare('SELECT discount, promotion, subtotal, shipping_fee, total FROM orders WHERE id = ?').get(o.id);
    assert.deepEqual([row.discount, row.promotion], [20, 'Indoor sale: 10% off']);
    assert.equal(row.total, row.subtotal - 20 + row.shipping_fee);
    const c2 = cart([['PROMO-1-A', 2]]);
    const o2 = CO.placeOrder({ cartId: c2.id, email: 'q@x.test', address: addr, zoneId: usZone(), payment: 'tt', coupon: 'BIG' });
    const r2 = db.prepare('SELECT discount, subtotal, shipping_fee, total FROM orders WHERE id = ?').get(o2.id);
    assert.equal(r2.discount, r2.subtotal, 'capped at the goods total');
    assert.equal(r2.total, r2.shipping_fee);
  });
});
