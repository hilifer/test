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
  test('WH-01 goods in, out, returns and counts change the stock with a balance; bad input refused; refused when the ERP owns the stock', () => {
    assert.deepEqual(W.moveStock(SKU, { kind: 'in', qty: 50, ref: 'PO-1' }, 'wes'), { sku: SKU, delta: 50, balance: 150 });
    assert.equal(W.moveStock(SKU, { kind: 'out', qty: 20, note: 'sample' }).balance, 130);
    assert.equal(W.moveStock(SKU, { kind: 'return', qty: 2 }).balance, 132);
    assert.deepEqual(W.moveStock(SKU, { kind: 'adjust', qty: 128 }), { sku: SKU, delta: -4, balance: 128 });
    assert.throws(() => W.moveStock(SKU, { kind: 'out', qty: 500 }), /库存只有 128/);
    assert.throws(() => W.moveStock(SKU, { kind: 'in', qty: 0 }), /正整数/);
    assert.throws(() => W.moveStock(SKU, { kind: 'teleport', qty: 1 }), /类型无效/);
    assert.throws(() => W.moveStock('NOPE', { kind: 'in', qty: 1 }), /不存在/);
    assert.deepEqual(W.stockMoves({ sku: SKU }).map((m) => [m.kind, m.qty, m.balance]), [['adjust', -4, 128], ['return', 2, 132], ['out', -20, 130], ['in', 50, 150]]);
    assert.equal(W.stockMoves({ sku: SKU })[3].by, 'wes');
    config.erp.mode = 'mock';
    try { assert.throws(() => W.moveStock(SKU, { kind: 'in', qty: 1 }), /金蝶/); } finally { config.erp.mode = 'local'; }
  });
  test('WH-02 shipping deducts stock and is logged; a part-shipped order reserves only what is left', () => {
    const o = readyOrder([{ sku: SKU, qty: 10, unit_price: 50 }]);
    const before = stock(SKU);
    assert.equal(before.on_hand, 128);
    const sh = S.createShipment({ order_id: o.id, lines: [{ sku: SKU, qty: 6 }] });
    const after = stock(SKU);
    assert.equal(after.on_hand, 122);
    assert.equal(after.reserved, before.reserved - 6, 'the 6 shipped are no longer reserved');
    assert.equal(after.available, before.available, 'available does not change: reserved goods left the building');
    const m = W.stockMoves({ sku: SKU, kind: 'ship' })[0];
    assert.deepEqual([m.qty, m.ref, m.balance], [-6, sh.number, 122]);
  });
  test('WH-03 safety stock (own or default), low stock list, reminder once until it recovers', async () => {
    W.setSafetyStock(SKU, 200);
    assert.throws(() => W.setSafetyStock(SKU, -1), /不小于 0/);
    const low = W.lowStock();
    assert.equal(low[0].sku, SKU);
    assert.equal(low[0].safety, 200);
    hooks.length = 0;
    assert.ok(W.lowStockReminder() >= 1);
    assert.equal(W.lowStockReminder(), 0, 'not again');
    await settle();
    assert.match(hooks[0].markdown.content, new RegExp(`${SKU} 可售 \\d+（安全库存 200）`));
    W.setSafetyStock(SKU, '');
    assert.ok(!W.lowStock().some((s) => s.sku === SKU && s.safety === 200), 'empty = default');
  });
});

describe('shipping', () => {
  test('WH-04 picking list: per SKU totals across orders (only what is left to ship), cartons, per order lines', () => {
    const a = readyOrder([{ sku: SKU, qty: 8, unit_price: 50 }], 'Alpha');
    const b = readyOrder([{ sku: SKU, qty: 5, unit_price: 50 }], 'Beta');
    S.createShipment({ order_id: b.id, lines: [{ sku: SKU, qty: 1 }] });
    const p = W.pickingList([a.id, b.id]);
    assert.equal(p.skus[0].sku, SKU);
    assert.equal(p.skus[0].qty, 12);
    assert.equal(p.skus[0].orders, 2);
    assert.equal(p.skus[0].cartons, 3);
    assert.deepEqual(p.orders.map((o) => [o.company, o.lines[0].qty]), [['Alpha', 8], ['Beta', 4]]);
    assert.throws(() => W.pickingList([]), /勾选订单/);
  });
  test('WH-05 bulk shipping: each line ships everything left and marks it in transit; failures are reported per line', () => {
    const a = readyOrder([{ sku: SKU, qty: 2, unit_price: 50 }], 'Gamma');
    const done = readyOrder([{ sku: SKU, qty: 1, unit_price: 50 }], 'Done');
    S.createShipment({ order_id: done.id });
    const rows = W.parseShipLines(`order, carrier, tracking, mode\n${a.number}, DHL, 1Z999, express\nSO-NOPE, UPS, 1\n${done.number}, DHL, 2\n${a.number}, DHL, , express\n${a.number}, X, 3, rocket`);
    assert.equal(rows.length, 5);
    const r = W.bulkShip(rows, 'wes');
    assert.equal(r[0].ok, true);
    assert.match(r[0].shipment, /^SH-/);
    assert.equal(S.getOrder(a.id).status, 'shipped');
    const sh = S.shipmentsFor(a.id)[0];
    assert.deepEqual([sh.carrier, sh.tracking_no, sh.status], ['DHL', '1Z999', 'in_transit']);
    assert.match(r[1].error, /订单不存在/);
    assert.match(r[2].error, /全部发出|没有可发/);
    assert.match(r[3].error, /缺少运单号/);
    assert.match(r[4].error, /运输方式/);
  });
  test('WH-06 carriers: quotes for a destination; shipments, average transit days and exception rate per carrier', () => {
    const o = readyOrder([{ sku: SKU, qty: 1, unit_price: 50 }], 'Delta');
    const sh = S.createShipment({ order_id: o.id, carrier: 'FedEx', tracking_no: 'F1', mode: 'express' });
    const ev = [{ ts: '2026-10-01T00:00:00Z', status: 'booked' }, { ts: '2026-10-02T00:00:00Z', status: 'in_transit' }, { ts: '2026-10-06T12:00:00Z', status: 'delivered' }];
    db.prepare("UPDATE shipments SET events = ?, status = 'delivered' WHERE id = ?").run(JSON.stringify(ev), sh.id);
    const r = W.carrierComparison({ country: 'US', weightKg: 5 });
    assert.ok(r.quotes.length >= 1);
    assert.ok(r.quotes.every((q, i) => !i || q.fee >= r.quotes[i - 1].fee), 'cheapest first');
    const fx = r.carriers.find((x) => x.carrier === 'FedEx');
    assert.deepEqual([fx.shipments, fx.delivered, fx.avgDays, fx.exceptions], [1, 1, 4.5, 0]);
    assert.ok(r.carriers.find((x) => x.carrier === 'DHL').shipments >= 1);
  });
});
