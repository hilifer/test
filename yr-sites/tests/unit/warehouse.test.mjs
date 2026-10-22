// Module: server/src/warehouse/warehouse.js — stock movements and automatic deduction on shipping (local stock),
// reservations, safety stock and reminders, picking lists, bulk shipping, carrier comparison. IDs WH-xx.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempEnv } from '../helpers/env.mjs';
import { mockServer } from '../helpers/mock-http.mjs';

const hooks = [];
const wecom = await mockServer((call) => { hooks.push(call.body); return { json: { errcode: 0 } }; });
useTempEnv({ site: 'led', ERP_MODE: 'local', WECOM_WEBHOOK_URL: wecom.url });
const W = await import('../../server/src/warehouse/warehouse.js');
const S = await import('../../server/src/ops/service.js');
const { config } = await import('../../server/src/config.js');
const { db } = await import('../../server/src/db.js');
after(() => wecom.close());
const settle = () => new Promise((r) => setTimeout(r, 150));
const stock = (sku) => S.stockView().find((s) => s.sku === sku);

function readyOrder(lines, company = 'Buyer') {
  const q = S.createQuote({ customer: { email: `${Math.random().toString(36).slice(2)}@x.test`, company }, lines, payment_terms: 'tt100' });
  S.setQuoteStatus(q.id, 'sent');
  const o = S.acceptQuote(q.id);
  S.setOrderStatus(o.id, 'ready_to_ship', { force: true });
  return S.getOrder(o.id);
}
const SKU = 'YR-HB-U2';
S.saveSku({ ...S.getSku(SKU), stock_local: 100, pcs_per_carton: 4, carton_cbm: 0.05, carton_gw: 10 });

describe('stock', () => {
  test('WH-01a goods in add to the stock and return the new balance', () => {
    assert.deepEqual(W.moveStock(SKU, { kind: 'in', qty: 50, ref: 'PO-1' }, 'wes'), { sku: SKU, delta: 50, balance: 150 });
  });
  test('WH-01b goods out reduce the stock', () => {
    assert.equal(W.moveStock(SKU, { kind: 'out', qty: 20, note: 'sample' }).balance, 130);
  });
  test('WH-01c returns add to the stock', () => {
    assert.equal(W.moveStock(SKU, { kind: 'return', qty: 2 }).balance, 132);
  });
  test('WH-01d a stock count sets the balance and records the difference', () => {
    assert.deepEqual(W.moveStock(SKU, { kind: 'adjust', qty: 128 }), { sku: SKU, delta: -4, balance: 128 });
  });
  test('WH-01e taking out more than is in stock is refused', () => {
    assert.throws(() => W.moveStock(SKU, { kind: 'out', qty: 500 }), /库存只有 128/);
  });
  test('WH-01f a quantity that is not a positive integer is refused', () => {
    assert.throws(() => W.moveStock(SKU, { kind: 'in', qty: 0 }), /正整数/);
  });
  test('WH-01g an unknown movement kind is refused', () => {
    assert.throws(() => W.moveStock(SKU, { kind: 'teleport', qty: 1 }), /类型无效/);
  });
  test('WH-01h a movement for an unknown SKU is refused', () => {
    assert.throws(() => W.moveStock('NOPE', { kind: 'in', qty: 1 }), /不存在/);
  });
  test('WH-01i movements are logged newest first with quantity, balance and who made them', () => {
    assert.deepEqual(W.stockMoves({ sku: SKU }).map((m) => [m.kind, m.qty, m.balance]), [['adjust', -4, 128], ['return', 2, 132], ['out', -20, 130], ['in', 50, 150]]);
    assert.equal(W.stockMoves({ sku: SKU })[3].by, 'wes');
  });
  test('WH-01j movements are refused when the ERP owns the stock', () => {
    config.erp.mode = 'mock';
    try { assert.throws(() => W.moveStock(SKU, { kind: 'in', qty: 1 }), /金蝶/); } finally { config.erp.mode = 'local'; }
  });
  let before2, after2, sh2;
  test('WH-02a shipping deducts the shipped quantity from stock on hand', () => {
    const o = readyOrder([{ sku: SKU, qty: 10, unit_price: 50 }]);
    before2 = stock(SKU);
    assert.equal(before2.on_hand, 128);
    sh2 = S.createShipment({ order_id: o.id, lines: [{ sku: SKU, qty: 6 }] });
    after2 = stock(SKU);
    assert.equal(after2.on_hand, 122);
  });
  test('WH-02b a part-shipped order reserves only what is left; available does not change', () => {
    assert.equal(after2.reserved, before2.reserved - 6, 'the 6 shipped are no longer reserved');
    assert.equal(after2.available, before2.available, 'available does not change: reserved goods left the building');
  });
  test('WH-02c the shipping deduction is logged with the shipment number', () => {
    const m = W.stockMoves({ sku: SKU, kind: 'ship' })[0];
    assert.deepEqual([m.qty, m.ref, m.balance], [-6, sh2.number, 122]);
  });
  test('WH-03a a negative safety stock is refused', () => {
    W.setSafetyStock(SKU, 200);
    assert.throws(() => W.setSafetyStock(SKU, -1), /不小于 0/);
  });
  test('WH-03b a SKU below its own safety stock is on the low stock list', () => {
    const low = W.lowStock();
    assert.equal(low[0].sku, SKU);
    assert.equal(low[0].safety, 200);
  });
  test('WH-03c the low stock reminder is sent once, not again', () => {
    hooks.length = 0;
    assert.ok(W.lowStockReminder() >= 1);
    assert.equal(W.lowStockReminder(), 0, 'not again');
  });
  test('WH-03d the reminder names the SKU, its available stock and safety stock', async () => {
    await settle();
    assert.match(hooks[0].markdown.content, new RegExp(`${SKU} 可售 \\d+（安全库存 200）`));
  });
  test('WH-03e an empty safety stock falls back to the default', () => {
    W.setSafetyStock(SKU, '');
    assert.ok(!W.lowStock().some((s) => s.sku === SKU && s.safety === 200), 'empty = default');
  });
});

describe('shipping', () => {
  let p4;
  test('WH-04a the picking list totals each SKU across orders, counting only what is left to ship', () => {
    const a = readyOrder([{ sku: SKU, qty: 8, unit_price: 50 }], 'Alpha');
    const b = readyOrder([{ sku: SKU, qty: 5, unit_price: 50 }], 'Beta');
    S.createShipment({ order_id: b.id, lines: [{ sku: SKU, qty: 1 }] });
    p4 = W.pickingList([a.id, b.id]);
    assert.equal(p4.skus[0].sku, SKU);
    assert.equal(p4.skus[0].qty, 12);
    assert.equal(p4.skus[0].orders, 2);
  });
  test('WH-04b the picking list gives the number of cartons', () => {
    assert.equal(p4.skus[0].cartons, 3);
  });
  test('WH-04c the picking list has the lines per order', () => {
    assert.deepEqual(p4.orders.map((o) => [o.company, o.lines[0].qty]), [['Alpha', 8], ['Beta', 4]]);
  });
  test('WH-04d a picking list without orders is refused', () => {
    assert.throws(() => W.pickingList([]), /勾选订单/);
  });
  let a5, rows5, r5;
  test('WH-05a bulk shipping lines are parsed one row per line', () => {
    a5 = readyOrder([{ sku: SKU, qty: 2, unit_price: 50 }], 'Gamma');
    const done = readyOrder([{ sku: SKU, qty: 1, unit_price: 50 }], 'Done');
    S.createShipment({ order_id: done.id });
    rows5 = W.parseShipLines(`order, carrier, tracking, mode\n${a5.number}, DHL, 1Z999, express\nSO-NOPE, UPS, 1\n${done.number}, DHL, 2\n${a5.number}, DHL, , express\n${a5.number}, X, 3, rocket`);
    assert.equal(rows5.length, 5);
  });
  test('WH-05b a good line ships everything left and marks it in transit', () => {
    r5 = W.bulkShip(rows5, 'wes');
    assert.equal(r5[0].ok, true);
    assert.match(r5[0].shipment, /^SH-/);
    assert.equal(S.getOrder(a5.id).status, 'shipped');
    const sh = S.shipmentsFor(a5.id)[0];
    assert.deepEqual([sh.carrier, sh.tracking_no, sh.status], ['DHL', '1Z999', 'in_transit']);
  });
  test('WH-05c a line with an unknown order reports the error', () => {
    assert.match(r5[1].error, /订单不存在/);
  });
  test('WH-05d a line for an order with nothing left to ship reports the error', () => {
    assert.match(r5[2].error, /全部发出|没有可发/);
  });
  test('WH-05e a line without a tracking number reports the error', () => {
    assert.match(r5[3].error, /缺少运单号/);
  });
  test('WH-05f a line with an unknown shipping mode reports the error', () => {
    assert.match(r5[4].error, /运输方式/);
  });
  let r6;
  test('WH-06a carrier comparison quotes a destination, cheapest first', () => {
    const o = readyOrder([{ sku: SKU, qty: 1, unit_price: 50 }], 'Delta');
    const sh = S.createShipment({ order_id: o.id, carrier: 'FedEx', tracking_no: 'F1', mode: 'express' });
    const ev = [{ ts: '2026-10-01T00:00:00Z', status: 'booked' }, { ts: '2026-10-02T00:00:00Z', status: 'in_transit' }, { ts: '2026-10-06T12:00:00Z', status: 'delivered' }];
    db.prepare("UPDATE shipments SET events = ?, status = 'delivered' WHERE id = ?").run(JSON.stringify(ev), sh.id);
    r6 = W.carrierComparison({ country: 'US', weightKg: 5 });
    assert.ok(r6.quotes.length >= 1);
    assert.ok(r6.quotes.every((q, i) => !i || q.fee >= r6.quotes[i - 1].fee), 'cheapest first');
  });
  test('WH-06b per carrier: shipments, delivered, average transit days and exceptions', () => {
    const fx = r6.carriers.find((x) => x.carrier === 'FedEx');
    assert.deepEqual([fx.shipments, fx.delivered, fx.avgDays, fx.exceptions], [1, 1, 4.5, 0]);
  });
  test('WH-06c every carrier used is listed', () => {
    assert.ok(r6.carriers.find((x) => x.carrier === 'DHL').shipments >= 1);
  });
});
