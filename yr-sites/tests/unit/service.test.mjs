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
  let a3;
  test('SV-03a customers are de-duplicated by email (case-insensitive) and stored lower case', () => {
    a3 = S.findOrCreateCustomer(cust);
    const b = S.findOrCreateCustomer({ email: 'buyer@acme.TEST' });
    assert.equal(a3.id, b.id);
    assert.equal(a3.email, 'buyer@acme.test');
  });
  test('SV-03b a customer gets a portal token that finds them', () => {
    assert.ok(a3.portal_token.length >= 20);
    assert.equal(S.customerByToken(a3.portal_token).id, a3.id);
  });
  test('SV-03c an empty portal token finds nobody', () => {
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
  let q5;
  test('SV-05a empty and zero-quantity lines are dropped', () => {
    q5 = S.createQuote({ customer: cust, lines: [{ sku: 'YR-HB-U2', qty: 100, unit_price: 45.555 }, { sku: 'YR-FL-F5', qty: 0, unit_price: 9 }, { sku: '', qty: 3 }], freight: 200, discount: 50 });
    assert.equal(q5.lines.length, 1);
  });
  test('SV-05b unit prices are rounded to cents', () => {
    assert.equal(q5.lines[0].unit_price, 45.56);
  });
  test('SV-05c totals = Σ(qty × price) + freight − discount', () => {
    assert.equal(q5.subtotal, 4556);
    assert.equal(q5.total, 4706);
  });
  test('SV-05d a new PI is a draft', () => {
    assert.equal(q5.status, 'draft');
  });
  let q6;
  test('SV-06a a PI without lines cannot be sent', () => {
    q6 = S.createQuote({ customer: cust, lines: [] });
    assert.throws(() => S.setQuoteStatus(q6.id, 'sent'), /没有产品明细/);
  });
  test('SV-06b an invalid PI status transition is rejected', () => {
    assert.throws(() => S.setQuoteStatus(q6.id, 'accepted'), /不能从/);
  });
  let u7;
  test('SV-07a editing a sent PI re-opens it as draft with the new totals', () => {
    const q = sentQuote();
    S.updateQuote(q.id, { lines: [{ sku: 'YR-HB-U2', qty: 200, unit_price: 40 }] });
    u7 = S.getQuote(q.id);
    assert.equal(u7.status, 'draft');
    assert.equal(u7.subtotal, 8000);
  });
  test('SV-07b a re-opened PI cannot be accepted until it is sent again', () => {
    assert.throws(() => S.acceptQuote(u7.token), /not open for acceptance/);
  });
  test('SV-08 accepted / cancelled PIs cannot be edited', () => {
    const q = sentQuote();
    S.acceptQuote(q.token);
    assert.throws(() => S.updateQuote(q.id, { notes: 'x' }), /只有草稿/);
  });
  let q9;
  test('SV-09a a PI past its validity is detected as expired', () => {
    q9 = sentQuote({ validity_days: 1 });
    db.prepare('UPDATE quotes SET sent_at = ? WHERE id = ?').run(new Date(Date.now() - 3 * 864e5).toISOString(), q9.id);
    assert.equal(S.quoteExpired(S.getQuote(q9.id)), true);
  });
  test('SV-09b an expired PI cannot be accepted and is moved to expired', () => {
    assert.throws(() => S.acceptQuote(q9.token), /expired/);
    assert.equal(S.getQuote(q9.id).status, 'expired');
  });
});

describe('orders & payments', () => {
  let q10, o10;
  test('SV-10a accepting a PI creates an order awaiting the deposit', () => {
    q10 = sentQuote();
    o10 = S.acceptQuote(q10.token);
    assert.match(o10.number, /^SO-\d{6}-\d{3}$/);
    assert.equal(o10.status, 'awaiting_deposit');
  });
  test('SV-10b the order carries the PI total and a 30% deposit', () => {
    assert.equal(o10.total, 4650);
    assert.equal(o10.deposit_due, 1395);
  });
  test('SV-10c accepting the same PI again returns the same order', () => {
    assert.equal(S.acceptQuote(q10.token).id, o10.id);
  });
  test('SV-10d the accepted PI is marked accepted', () => {
    assert.equal(S.getQuote(q10.id).status, 'accepted');
  });
  test('SV-11a 100% T/T in advance: the deposit is the full total', () => {
    assert.equal(S.acceptQuote(sentQuote({ payment_terms: 'tt100' }).token).deposit_due, 4650);
  });
  test('SV-11b L/C: no deposit', () => {
    assert.equal(S.acceptQuote(sentQuote({ payment_terms: 'lc' }).token).deposit_due, 0);
  });
  test('SV-11c 30% against B/L: a 30% deposit', () => {
    assert.equal(S.acceptQuote(sentQuote({ payment_terms: 'tt30bl' }).token).deposit_due, 1395);
  });
  let o12;
  test('SV-12a a partial deposit keeps the order waiting', () => {
    o12 = S.acceptQuote(sentQuote().token);
    assert.equal(S.recordPayment(o12.id, { amount: 1000 }).status, 'awaiting_deposit');
  });
  test('SV-12b the full deposit starts production automatically', () => {
    const after = S.recordPayment(o12.id, { amount: 395, ref: 'TT-2' });
    assert.equal(after.status, 'in_production');
    assert.equal(after.paid, 1395);
  });
  test('SV-12c the status changes are recorded as order events', () => {
    const ev = S.eventsFor('order', o12.id).map((e) => e.to_state).filter(Boolean);
    assert.deepEqual(ev, ['awaiting_deposit', 'in_production']);
  });
  let o13;
  test('SV-13a a zero payment amount is rejected', () => {
    o13 = S.acceptQuote(sentQuote().token);
    assert.throws(() => S.recordPayment(o13.id, { amount: 0 }), /必须大于 0/);
  });
  test('SV-13b refunds are stored as negative and reduce the paid amount', () => {
    S.recordPayment(o13.id, { amount: 500 });
    assert.equal(S.recordPayment(o13.id, { kind: 'refund', amount: 200 }).paid, 300);
  });
  let o14;
  test('SV-14a a ready-to-ship 30/70 T/T order warns that the balance is due before shipment', () => {
    o14 = orderReadyToShip();
    assert.equal(S.balanceDueBeforeShipment(o14), true);
  });
  test('SV-14b paying the balance clears the warning', () => {
    const paid = S.recordPayment(o14.id, { kind: 'balance', amount: o14.total - o14.paid });
    assert.equal(S.balanceDueBeforeShipment(paid), false);
  });
  let o15;
  test('SV-15a a delivered order cannot be completed with an open balance', () => {
    o15 = orderReadyToShip();
    S.setOrderStatus(o15.id, 'shipped');
    S.setOrderStatus(o15.id, 'delivered');
    assert.throws(() => S.setOrderStatus(o15.id, 'completed'), /尾款未收清/);
  });
  test('SV-15b once the balance is paid the order can be completed', () => {
    S.recordPayment(o15.id, { kind: 'balance', amount: S.getOrder(o15.id).total - S.getOrder(o15.id).paid });
    assert.equal(S.setOrderStatus(o15.id, 'completed').status, 'completed');
  });
  test('SV-16a an illegal order transition is rejected with a readable message', () => {
    const o = S.acceptQuote(sentQuote().token);
    assert.throws(() => S.setOrderStatus(o.id, 'shipped'), /订单不能从「待付定金」改为「已发货」/);
  });
  test('SV-16b changing the status of an unknown order is rejected', () => {
    assert.throws(() => S.setOrderStatus('nope', 'shipped'), /订单不存在/);
  });
});

describe('shipments, inventory, after-sales', () => {
  test('SV-17a a shipment requires the order to be ready to ship', () => {
    const early = S.acceptQuote(sentQuote().token);
    assert.throws(() => S.createShipment({ order_id: early.id }), /待发货/);
  });
  test('SV-17b a shipment gets a number and packing computed from the SKU carton data', () => {
    const o = orderReadyToShip();
    const s = S.createShipment({ order_id: o.id, carrier: 'COSCO', container_no: 'CSNU1234567', eta: '2026-12-01' });
    assert.match(s.number, /^SH-\d{6}-\d{3}$/);
    assert.deepEqual(s.packing, { cartons: 25, cbm: 1.5, gw_kg: 300, missing_packing_data: [] });
  });
  test('SV-18 SKUs without carton data are reported, not guessed', () => {
    assert.deepEqual(S.packingFor([{ sku: 'YR-FL-F5', qty: 10 }]).missing_packing_data, ['YR-FL-F5']);
  });
  let o19, s19;
  test('SV-19a an in-transit tracking event moves the order to shipped', () => {
    o19 = orderReadyToShip();
    s19 = S.createShipment({ order_id: o19.id });
    S.addShipmentEvent(s19.id, { status: 'in_transit', location: 'Shenzhen' });
    assert.equal(S.getOrder(o19.id).status, 'shipped');
  });
  test('SV-19b a delivered tracking event moves the order to delivered and all events are kept', () => {
    S.addShipmentEvent(s19.id, { status: 'delivered', location: 'LA' });
    assert.equal(S.getOrder(o19.id).status, 'delivered');
    assert.equal(S.getShipment(s19.id).events.length, 3);
  });
  let o20, s20;
  test('SV-20a a booked shipment cannot jump straight to delivered', () => {
    o20 = orderReadyToShip();
    s20 = S.createShipment({ order_id: o20.id });
    assert.throws(() => S.addShipmentEvent(s20.id, { status: 'delivered' }), /物流状态不能从/);
  });
  test('SV-20b a shipment can recover from an exception to delivered', () => {
    S.addShipmentEvent(s20.id, { status: 'exception', note: 'customs hold' });
    S.addShipmentEvent(s20.id, { status: 'delivered' });
    assert.equal(S.getOrder(o20.id).status, 'delivered', 'ready_to_ship → shipped → delivered');
  });
  let v21, open21;
  test('SV-21a stock on hand is the local stock (local mode)', () => {
    v21 = S.stockView().find((r) => r.sku === 'YR-HB-U2');
    assert.equal(v21.on_hand, 500);
  });
  test('SV-21b open orders reserve the quantity they have not shipped yet', () => {
    // what open orders have not shipped yet (part-shipped goods are no longer reserved)
    open21 = S.listOrders("WHERE o.status IN ('awaiting_deposit','in_production','ready_to_ship')").reduce((a, o) => a + S.shippedQty(o).filter((l) => l.sku === 'YR-HB-U2').reduce((x, l) => x + l.remaining, 0), 0);
    assert.equal(v21.reserved, open21);
  });
  test('SV-21c available = on hand − reserved', () => {
    assert.equal(v21.available, 500 - open21);
  });
  let o22, r22, ship22;
  test('SV-22a an RMA gets a number and an unknown issue is normalised to other', () => {
    o22 = orderReadyToShip();
    r22 = S.createRma({ order_id: o22.id, sku: 'YR-HB-U2', qty: -3, issue: 'weird', description: 'x'.repeat(5000), photos: Array(20).fill('https://p.test/1.jpg') });
    assert.match(r22.number, /^RMA-\d{6}-\d{3}$/);
    assert.equal(r22.issue, 'other');
  });
  test('SV-22b a negative RMA quantity is clamped to 0', () => {
    assert.equal(r22.qty, 0);
  });
  test('SV-22c the RMA description and photo list are capped', () => {
    assert.equal(r22.description.length, 4000);
    assert.equal(r22.photos.length, 10);
  });
  test('SV-22d the RMA workflow is enforced (no jump to resolved)', () => {
    assert.throws(() => S.setRmaStatus(r22.id, 'resolved'), /售后单不能从/);
  });
  test('SV-22e an approved RMA allows a replacement shipment that bypasses the ready-to-ship rule', () => {
    S.setRmaStatus(r22.id, 'approved', { resolution: 'replace', note: 'send 2 pcs' });
    ship22 = S.createShipment({ order_id: o22.id, rma_id: r22.id, lines: [{ sku: 'YR-HB-U2', qty: 2 }], mode: 'express' });
    assert.equal(ship22.rma_id, r22.id, 'replacement shipments bypass the ready_to_ship rule');
  });
  test('SV-22f an RMA shipment in transit does not move the order', () => {
    S.addShipmentEvent(ship22.id, { status: 'in_transit' });
    assert.equal(S.getOrder(o22.id).status, 'ready_to_ship', 'RMA shipments do not move the order');
  });
  test('SV-22g resolving the RMA keeps its resolution', () => {
    assert.equal(S.setRmaStatus(r22.id, 'resolved').status, 'resolved');
    assert.equal(S.getRma(r22.id).resolution, 'replace');
  });
  let o23;
  test('SV-23a verifyOrder accepts the order number (any case) with the order e-mail (any case, trimmed)', () => {
    o23 = S.acceptQuote(sentQuote().token);
    assert.ok(S.verifyOrder(o23.number.toLowerCase(), ' BUYER@acme.test '));
  });
  test('SV-23b verifyOrder refuses another e-mail', () => {
    assert.equal(S.verifyOrder(o23.number, 'someone@else.test'), null);
  });
  test('SV-23c verifyOrder refuses an empty e-mail', () => {
    assert.equal(S.verifyOrder(o23.number, ''), null);
  });
  test('SV-23d verifyOrder refuses an unknown order number', () => {
    assert.equal(S.verifyOrder('SO-000000-999', 'buyer@acme.test'), null);
  });
  let en24, zh24;
  test('SV-24a orderStatusView shows the status in English and Chinese', () => {
    const o = orderReadyToShip();
    S.createShipment({ order_id: o.id, carrier: 'MSC' });
    en24 = S.orderStatusView(S.getOrder(o.id), 'en');
    zh24 = S.orderStatusView(S.getOrder(o.id), 'zh');
    assert.equal(en24.status, 'Ready to ship');
    assert.equal(zh24.status, '待发货');
  });
  test('SV-24b orderStatusView lists the order shipments with a readable mode', () => {
    assert.equal(en24.shipments.length, 1);
    assert.equal(en24.shipments[0].mode, 'Sea freight');
  });
  test('SV-24c orderStatusView shows the balance due with its currency', () => {
    assert.match(en24.balance_due, /^USD /);
  });
  let st25;
  test('SV-25a pipeline stats count open orders and receivables', () => {
    st25 = S.pipelineStats();
    assert.ok(st25.ordersOpen.n > 0);
    assert.ok(st25.receivable > 0);
  });
  test('SV-25b pipeline stats break orders down by status', () => {
    assert.ok(st25.byStatus.some((r) => r.status === 'delivered'));
  });
  test('SV-25c pipeline stats count open RMAs', () => {
    assert.ok(st25.rmaOpen >= 0);
  });
  let o26;
  test('SV-26a a negative payment is rejected', () => {
    o26 = S.acceptQuote(sentQuote().token);
    assert.throws(() => S.recordPayment(o26.id, { kind: 'deposit', amount: -999 }), /必须大于 0/);
  });
  test('SV-26b a payment over the order total is rejected', () => {
    assert.throws(() => S.recordPayment(o26.id, { kind: 'deposit', amount: 999999 }), /超过订单总额/);
  });
  test('SV-26c an unknown payment kind is rejected', () => {
    assert.throws(() => S.recordPayment(o26.id, { kind: 'bitcoin', amount: 10 }), /类型无效/);
  });
  test('SV-26d a refund over the money received is rejected', () => {
    S.recordPayment(o26.id, { amount: 1000 });
    assert.throws(() => S.recordPayment(o26.id, { kind: 'refund', amount: 1001 }), /不能超过已收金额/);
  });
  test('SV-26e paying exactly the total is accepted', () => {
    assert.equal(S.recordPayment(o26.id, { kind: 'balance', amount: o26.total - 1000 }).paid, o26.total, 'paying exactly the total is fine');
  });
  let o27;
  test('SV-27a an order with money received cannot be cancelled', () => {
    o27 = S.acceptQuote(sentQuote().token);
    S.recordPayment(o27.id, { amount: 500 });
    assert.throws(() => S.setOrderStatus(o27.id, 'cancelled'), /请先登记退款/);
  });
  test('SV-27b after a full refund the order can be cancelled', () => {
    S.recordPayment(o27.id, { kind: 'refund', amount: 500 });
    assert.equal(S.setOrderStatus(o27.id, 'cancelled').status, 'cancelled');
  });
  test('SV-27c a cancelled order only accepts refunds', () => {
    assert.throws(() => S.recordPayment(o27.id, { amount: 10 }), /只能登记退款/);
  });
  let o28;
  test('SV-28a a partial shipment tracks shipped and remaining quantity', () => {
    o28 = orderReadyToShip();
    const s1 = S.createShipment({ order_id: o28.id, lines: [{ sku: 'YR-HB-U2', qty: 40 }] });
    assert.equal(s1.lines[0].qty, 40);
    assert.deepEqual(S.shippedQty(S.getOrder(o28.id)).map((l) => [l.shipped, l.remaining]), [[40, 60]]);
  });
  test('SV-28b shipping more than the remaining quantity is refused', () => {
    assert.throws(() => S.createShipment({ order_id: o28.id, lines: [{ sku: 'YR-HB-U2', qty: 61 }] }), /超过剩余未发数量 60/);
  });
  test('SV-28c shipping a SKU that is not on the order is refused', () => {
    assert.throws(() => S.createShipment({ order_id: o28.id, lines: [{ sku: 'NOPE', qty: 1 }] }), /订单中没有/);
  });
  test('SV-28d a shipment without lines ships everything still unshipped', () => {
    const s2 = S.createShipment({ order_id: o28.id });
    assert.equal(s2.lines[0].qty, 60, 'default = everything still unshipped');
  });
  test('SV-28e shipping again once everything is shipped is refused', () => {
    assert.throws(() => S.createShipment({ order_id: o28.id }), /已全部发出/);
  });
  let o29, b29;
  test('SV-29a a delivered partial shipment leaves the order shipped while goods remain', () => {
    o29 = orderReadyToShip();
    const a = S.createShipment({ order_id: o29.id, lines: [{ sku: 'YR-HB-U2', qty: 30 }] });
    S.addShipmentEvent(a.id, { status: 'in_transit' });
    S.addShipmentEvent(a.id, { status: 'delivered' });
    assert.equal(S.getOrder(o29.id).status, 'shipped', '70 pcs still to ship');
  });
  test('SV-29b the order stays shipped while the last shipment is in transit', () => {
    b29 = S.createShipment({ order_id: o29.id });
    S.addShipmentEvent(b29.id, { status: 'in_transit' });
    assert.equal(S.getOrder(o29.id).status, 'shipped');
  });
  test('SV-29c the order is delivered once every shipment has arrived and nothing is left', () => {
    S.addShipmentEvent(b29.id, { status: 'delivered' });
    assert.equal(S.getOrder(o29.id).status, 'delivered');
  });
});
