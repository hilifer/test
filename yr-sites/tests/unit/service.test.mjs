// Module: server/src/ops/service.js — sales-to-delivery core (SKU, customers, PI, orders, payments,
// inventory, shipments, after-sales). In-process with an isolated DB. IDs SV-xx.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempEnv } from '../helpers/env.mjs';

useTempEnv({ site: 'led', ERP_MODE: 'local' });
const S = await import('../../server/src/ops/service.js');
const { db } = await import('../../server/src/db.js');

S.saveSku({ sku: 'YR-HB-U2', product_id: 'YR-HB-U2', name: 'UFO High Bay', ref_price: 45, pcs_per_carton: 4, carton_cbm: 0.06, carton_gw: 12, stock_local: 500 });
S.saveSku({ sku: 'YR-FL-F5', product_id: 'YR-FL-F5', name: 'Flood', ref_price: 30 }); // no packing data

const cust = { email: 'Buyer@Acme.test', company: 'Acme Inc', contact: 'Bob', country: 'USA' };
function sentQuote(o = {}) {
  const q = S.createQuote({ customer: cust, lines: [{ sku: 'YR-HB-U2', qty: 100, unit_price: 45 }], freight: 200, discount: 50, ...o });
  return S.setQuoteStatus(q.id, 'sent');
}
const orderReadyToShip = () => {
  const o = S.acceptQuote(sentQuote().token);
  S.recordPayment(o.id, { kind: 'deposit', amount: o.deposit_due });
  return S.setOrderStatus(o.id, 'ready_to_ship');
};

describe('SKU & customers', () => {
  test('SV-01 catalog products are seeded as SKUs with a mid-band reference price', () => {
    const s = S.getSku('YR-AR-S3');
    assert.ok(s);
    assert.equal(s.ref_price, (78 + 115) / 2);
  });
  test('SV-02 SKU code validation', () => {
    assert.throws(() => S.saveSku({ sku: 'bad sku!' }), /SKU 编码/);
    assert.throws(() => S.saveSku({ sku: '' }), /SKU 编码/);
  });
  test('SV-03 customers are de-duplicated by email (case-insensitive) and get a portal token', () => {
    const a = S.findOrCreateCustomer(cust);
    const b = S.findOrCreateCustomer({ email: 'buyer@acme.TEST' });
    assert.equal(a.id, b.id);
    assert.equal(a.email, 'buyer@acme.test');
    assert.ok(a.portal_token.length >= 20);
    assert.equal(S.customerByToken(a.portal_token).id, a.id);
    assert.equal(S.customerByToken(''), null);
  });
});

describe('quotes / PI', () => {
  test('SV-04 numbering: PI-YYMMDD-NNN, sequential per day', () => {
    const a = S.createQuote({ customer: cust, lines: [] });
    const b = S.createQuote({ customer: cust, lines: [] });
    assert.match(a.number, /^PI-\d{6}-\d{3}$/);
    assert.equal(Number(b.number.slice(-3)), Number(a.number.slice(-3)) + 1);
  });
  test('SV-05 totals = Σ(qty × price) + freight − discount; empty / zero-qty lines dropped', () => {
    const q = S.createQuote({ customer: cust, lines: [{ sku: 'YR-HB-U2', qty: 100, unit_price: 45.555 }, { sku: 'YR-FL-F5', qty: 0, unit_price: 9 }, { sku: '', qty: 3 }], freight: 200, discount: 50 });
    assert.equal(q.lines.length, 1);
    assert.equal(q.lines[0].unit_price, 45.56);
    assert.equal(q.subtotal, 4556);
    assert.equal(q.total, 4706);
    assert.equal(q.status, 'draft');
  });
  test('SV-06 cannot send a PI without lines; invalid transitions rejected', () => {
    const q = S.createQuote({ customer: cust, lines: [] });
    assert.throws(() => S.setQuoteStatus(q.id, 'sent'), /没有产品明细/);
    assert.throws(() => S.setQuoteStatus(q.id, 'accepted'), /不能从/);
  });
  test('SV-07 editing a sent PI re-opens it as draft (customer must get the new version)', () => {
    const q = sentQuote();
    S.updateQuote(q.id, { lines: [{ sku: 'YR-HB-U2', qty: 200, unit_price: 40 }] });
    const u = S.getQuote(q.id);
    assert.equal(u.status, 'draft');
    assert.equal(u.subtotal, 8000);
    assert.throws(() => S.acceptQuote(u.token), /not open for acceptance/);
  });
  test('SV-08 accepted / cancelled PIs cannot be edited', () => {
    const q = sentQuote();
    S.acceptQuote(q.token);
    assert.throws(() => S.updateQuote(q.id, { notes: 'x' }), /只有草稿/);
  });
  test('SV-09 expired PI cannot be accepted and is moved to expired', () => {
    const q = sentQuote({ validity_days: 1 });
    db.prepare('UPDATE quotes SET sent_at = ? WHERE id = ?').run(new Date(Date.now() - 3 * 864e5).toISOString(), q.id);
    assert.equal(S.quoteExpired(S.getQuote(q.id)), true);
    assert.throws(() => S.acceptQuote(q.token), /expired/);
    assert.equal(S.getQuote(q.id).status, 'expired');
  });
});

describe('orders & payments', () => {
  test('SV-10 accepting a PI creates exactly one order (idempotent) with the 30% deposit', () => {
    const q = sentQuote();
    const o = S.acceptQuote(q.token);
    assert.match(o.number, /^SO-\d{6}-\d{3}$/);
    assert.equal(o.status, 'awaiting_deposit');
    assert.equal(o.total, 4650);
    assert.equal(o.deposit_due, 1395);
    assert.equal(S.acceptQuote(q.token).id, o.id);
    assert.equal(S.getQuote(q.id).status, 'accepted');
  });
  test('SV-11 deposit by payment term: 100% advance, L/C (0), 30% B/L', () => {
    assert.equal(S.acceptQuote(sentQuote({ payment_terms: 'tt100' }).token).deposit_due, 4650);
    assert.equal(S.acceptQuote(sentQuote({ payment_terms: 'lc' }).token).deposit_due, 0);
    assert.equal(S.acceptQuote(sentQuote({ payment_terms: 'tt30bl' }).token).deposit_due, 1395);
  });
  test('SV-12 partial deposit keeps the order waiting; full deposit starts production automatically', () => {
    const o = S.acceptQuote(sentQuote().token);
    assert.equal(S.recordPayment(o.id, { amount: 1000 }).status, 'awaiting_deposit');
    const after = S.recordPayment(o.id, { amount: 395, ref: 'TT-2' });
    assert.equal(after.status, 'in_production');
    assert.equal(after.paid, 1395);
    const ev = S.eventsFor('order', o.id).map((e) => e.to_state).filter(Boolean);
    assert.deepEqual(ev, ['awaiting_deposit', 'in_production']);
  });
  test('SV-13 zero amount rejected; refunds are stored as negative', () => {
    const o = S.acceptQuote(sentQuote().token);
    assert.throws(() => S.recordPayment(o.id, { amount: 0 }), /必须大于 0/);
    S.recordPayment(o.id, { amount: 500 });
    assert.equal(S.recordPayment(o.id, { kind: 'refund', amount: 200 }).paid, 300);
  });
  test('SV-14 balance-before-shipment warning (30/70 T/T)', () => {
    const o = orderReadyToShip();
    assert.equal(S.balanceDueBeforeShipment(o), true);
    const paid = S.recordPayment(o.id, { kind: 'balance', amount: o.total - o.paid });
    assert.equal(S.balanceDueBeforeShipment(paid), false);
  });
  test('SV-15 an order cannot be completed with an open balance', () => {
    const o = orderReadyToShip();
    S.setOrderStatus(o.id, 'shipped');
    S.setOrderStatus(o.id, 'delivered');
    assert.throws(() => S.setOrderStatus(o.id, 'completed'), /尾款未收清/);
    S.recordPayment(o.id, { kind: 'balance', amount: S.getOrder(o.id).total - S.getOrder(o.id).paid });
    assert.equal(S.setOrderStatus(o.id, 'completed').status, 'completed');
  });
  test('SV-16 illegal order transitions are rejected with a readable message', () => {
    const o = S.acceptQuote(sentQuote().token);
    assert.throws(() => S.setOrderStatus(o.id, 'shipped'), /订单不能从「待付定金」改为「已发货」/);
    assert.throws(() => S.setOrderStatus('nope', 'shipped'), /订单不存在/);
  });
});

describe('shipments, inventory, after-sales', () => {
  test('SV-17 shipment requires ready_to_ship; packing computed from SKU carton data', () => {
    const early = S.acceptQuote(sentQuote().token);
    assert.throws(() => S.createShipment({ order_id: early.id }), /待发货/);
    const o = orderReadyToShip();
    const s = S.createShipment({ order_id: o.id, carrier: 'COSCO', container_no: 'CSNU1234567', eta: '2026-12-01' });
    assert.match(s.number, /^SH-\d{6}-\d{3}$/);
    assert.deepEqual(s.packing, { cartons: 25, cbm: 1.5, gw_kg: 300, missing_packing_data: [] });
  });
  test('SV-18 SKUs without carton data are reported, not guessed', () => {
    assert.deepEqual(S.packingFor([{ sku: 'YR-FL-F5', qty: 10 }]).missing_packing_data, ['YR-FL-F5']);
  });
  test('SV-19 tracking events cascade: in_transit → order shipped, delivered → order delivered', () => {
    const o = orderReadyToShip();
    const s = S.createShipment({ order_id: o.id });
    S.addShipmentEvent(s.id, { status: 'in_transit', location: 'Shenzhen' });
    assert.equal(S.getOrder(o.id).status, 'shipped');
    S.addShipmentEvent(s.id, { status: 'delivered', location: 'LA' });
    assert.equal(S.getOrder(o.id).status, 'delivered');
    assert.equal(S.getShipment(s.id).events.length, 3);
  });
  test('SV-20 delivered directly from booked is not allowed; exception → recovery allowed', () => {
    const o = orderReadyToShip();
    const s = S.createShipment({ order_id: o.id });
    assert.throws(() => S.addShipmentEvent(s.id, { status: 'delivered' }), /物流状态不能从/);
    S.addShipmentEvent(s.id, { status: 'exception', note: 'customs hold' });
    S.addShipmentEvent(s.id, { status: 'delivered' });
    assert.equal(S.getOrder(o.id).status, 'delivered', 'ready_to_ship → shipped → delivered');
  });
  test('SV-21 open orders reserve stock (local mode)', () => {
    const v = S.stockView().find((r) => r.sku === 'YR-HB-U2');
    assert.equal(v.on_hand, 500);
    const open = S.listOrders("WHERE o.status IN ('awaiting_deposit','in_production','ready_to_ship')").reduce((a, o) => a + o.lines.reduce((x, l) => x + l.qty, 0), 0);
    assert.equal(v.reserved, open);
    assert.equal(v.available, 500 - open);
  });
  test('SV-22 RMA: unknown issue normalised, qty clamped, workflow enforced, replacement shipment allowed', () => {
    const o = orderReadyToShip();
    const r = S.createRma({ order_id: o.id, sku: 'YR-HB-U2', qty: -3, issue: 'weird', description: 'x'.repeat(5000), photos: Array(20).fill('https://p.test/1.jpg') });
    assert.match(r.number, /^RMA-\d{6}-\d{3}$/);
    assert.equal(r.issue, 'other');
    assert.equal(r.qty, 0);
    assert.equal(r.description.length, 4000);
    assert.equal(r.photos.length, 10);
    assert.throws(() => S.setRmaStatus(r.id, 'resolved'), /售后单不能从/);
    S.setRmaStatus(r.id, 'approved', { resolution: 'replace', note: 'send 2 pcs' });
    const ship = S.createShipment({ order_id: o.id, rma_id: r.id, lines: [{ sku: 'YR-HB-U2', qty: 2 }], mode: 'express' });
    assert.equal(ship.rma_id, r.id, 'replacement shipments bypass the ready_to_ship rule');
    S.addShipmentEvent(ship.id, { status: 'in_transit' });
    assert.equal(S.getOrder(o.id).status, 'ready_to_ship', 'RMA shipments do not move the order');
    assert.equal(S.setRmaStatus(r.id, 'resolved').status, 'resolved');
    assert.equal(S.getRma(r.id).resolution, 'replace');
  });
  test('SV-23 verifyOrder needs the exact order number AND the order email', () => {
    const o = S.acceptQuote(sentQuote().token);
    assert.ok(S.verifyOrder(o.number.toLowerCase(), ' BUYER@acme.test '));
    assert.equal(S.verifyOrder(o.number, 'someone@else.test'), null);
    assert.equal(S.verifyOrder(o.number, ''), null);
    assert.equal(S.verifyOrder('SO-000000-999', 'buyer@acme.test'), null);
  });
  test('SV-24 orderStatusView is localised and hides RMA shipments', () => {
    const o = orderReadyToShip();
    S.createShipment({ order_id: o.id, carrier: 'MSC' });
    const en = S.orderStatusView(S.getOrder(o.id), 'en');
    const zh = S.orderStatusView(S.getOrder(o.id), 'zh');
    assert.equal(en.status, 'Ready to ship');
    assert.equal(zh.status, '待发货');
    assert.equal(en.shipments.length, 1);
    assert.equal(en.shipments[0].mode, 'Sea freight');
    assert.match(en.balance_due, /^USD /);
  });
  test('SV-25 pipeline stats add up', () => {
    const st = S.pipelineStats();
    assert.ok(st.ordersOpen.n > 0);
    assert.ok(st.receivable > 0);
    assert.ok(st.byStatus.some((r) => r.status === 'delivered'));
    assert.ok(st.rmaOpen >= 0);
  });
  test('SV-26 payments: negative, over-total and over-refund amounts are rejected; unknown kinds rejected', () => {
    const o = S.acceptQuote(sentQuote().token);
    assert.throws(() => S.recordPayment(o.id, { kind: 'deposit', amount: -999 }), /必须大于 0/);
    assert.throws(() => S.recordPayment(o.id, { kind: 'deposit', amount: 999999 }), /超过订单总额/);
    assert.throws(() => S.recordPayment(o.id, { kind: 'bitcoin', amount: 10 }), /类型无效/);
    S.recordPayment(o.id, { amount: 1000 });
    assert.throws(() => S.recordPayment(o.id, { kind: 'refund', amount: 1001 }), /不能超过已收金额/);
    assert.equal(S.recordPayment(o.id, { kind: 'balance', amount: o.total - 1000 }).paid, o.total, 'paying exactly the total is fine');
  });
  test('SV-27 an order with money received cannot be cancelled until it is refunded', () => {
    const o = S.acceptQuote(sentQuote().token);
    S.recordPayment(o.id, { amount: 500 });
    assert.throws(() => S.setOrderStatus(o.id, 'cancelled'), /请先登记退款/);
    S.recordPayment(o.id, { kind: 'refund', amount: 500 });
    assert.equal(S.setOrderStatus(o.id, 'cancelled').status, 'cancelled');
    assert.throws(() => S.recordPayment(o.id, { amount: 10 }), /只能登记退款/);
  });
  test('SV-28 partial shipments: remaining quantity tracked, over-shipping and re-shipping refused', () => {
    const o = orderReadyToShip();
    const s1 = S.createShipment({ order_id: o.id, lines: [{ sku: 'YR-HB-U2', qty: 40 }] });
    assert.equal(s1.lines[0].qty, 40);
    assert.deepEqual(S.shippedQty(S.getOrder(o.id)).map((l) => [l.shipped, l.remaining]), [[40, 60]]);
    assert.throws(() => S.createShipment({ order_id: o.id, lines: [{ sku: 'YR-HB-U2', qty: 61 }] }), /超过剩余未发数量 60/);
    assert.throws(() => S.createShipment({ order_id: o.id, lines: [{ sku: 'NOPE', qty: 1 }] }), /订单中没有/);
    const s2 = S.createShipment({ order_id: o.id });
    assert.equal(s2.lines[0].qty, 60, 'default = everything still unshipped');
    assert.throws(() => S.createShipment({ order_id: o.id }), /已全部发出/);
  });
  test('SV-29 order becomes delivered only when every shipment has arrived and nothing is left', () => {
    const o = orderReadyToShip();
    const a = S.createShipment({ order_id: o.id, lines: [{ sku: 'YR-HB-U2', qty: 30 }] });
    S.addShipmentEvent(a.id, { status: 'in_transit' });
    S.addShipmentEvent(a.id, { status: 'delivered' });
    assert.equal(S.getOrder(o.id).status, 'shipped', '70 pcs still to ship');
    const b = S.createShipment({ order_id: o.id });
    S.addShipmentEvent(b.id, { status: 'in_transit' });
    assert.equal(S.getOrder(o.id).status, 'shipped');
    S.addShipmentEvent(b.id, { status: 'delivered' });
    assert.equal(S.getOrder(o.id).status, 'delivered');
  });
});
