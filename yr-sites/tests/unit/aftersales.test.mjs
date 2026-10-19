// Modules: server/src/shop/{tracking,refunds,notify}.js — 17TRACK sync, refunds to the original payment method,
// shipping e-mails. IDs AS-xx.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempEnv } from '../helpers/env.mjs';
import { mockServer } from '../helpers/mock-http.mjs';

const track = new Map(); // number → 17TRACK status
const prov = await mockServer((call) => {
  if (call.url === '/track/v2.2/register') return { json: { code: 0, data: { accepted: call.body.filter((x) => x.number !== 'BAD').map((x) => ({ number: x.number })), rejected: call.body.filter((x) => x.number === 'BAD').map((x) => ({ number: x.number, error: { code: -1, message: 'invalid number' } })) } } };
  if (call.url === '/track/v2.2/gettrackinfo') return { json: { code: 0, data: { accepted: call.body.filter((x) => track.has(x.number)).map((x) => ({ number: x.number, track_info: { latest_status: { status: track.get(x.number) }, latest_event: { description: `Status ${track.get(x.number)}`, location: 'Los Angeles' } } })) } } };
  if (call.url === '/v1/refunds') return call.body.includes('amount=1') && new URLSearchParams(call.body).get('amount') === '1' ? { status: 402, json: { error: { message: 'insufficient balance' } } } : { json: { id: 're_' + prov.calls.length } };
  if (call.url === '/v1/oauth2/token') return { json: { access_token: 'T' } };
  if (/\/v2\/payments\/captures\/.+\/refund/.test(call.url)) return { json: { id: 'PPR1', status: 'COMPLETED' } };
  return { status: 404, text: '' };
});
after(() => prov.close());

useTempEnv({ site: 'led', ERP_MODE: 'local', TRACK17_KEY: 'k17', TRACK17_API_BASE: prov.url, STRIPE_SECRET_KEY: 'sk', STRIPE_WEBHOOK_SECRET: 'wh', STRIPE_API_BASE: prov.url, PAYPAL_CLIENT_ID: 'i', PAYPAL_CLIENT_SECRET: 's', PAYPAL_API_BASE: prov.url });
const S = await import('../../server/src/ops/service.js');
const T = await import('../../server/src/shop/tracking.js');
const R = await import('../../server/src/shop/refunds.js');
await import('../../server/src/shop/notify.js');
const Cart = await import('../../server/src/shop/cart.js');
const CO = await import('../../server/src/shop/checkout.js');
const F = await import('../../server/src/shop/freight.js');
const { db } = await import('../../server/src/db.js');

db.prepare("UPDATE skus SET stock_local = 100000, weight_kg = 3.5 WHERE sku = 'YR-HB-U2'").run();
const zone = F.quoteShipping({ country: 'US', weightKg: 1 })[0].zoneId;
function shopOrder({ paidVia = null } = {}) {
  const c = Cart.createCart();
  Cart.setItem(c.id, 'YR-HB-U2', 50);
  const o = CO.placeOrder({ cartId: c.id, email: 'buyer@aftersales.test', address: { name: 'B', phone: '1', line1: 'x', city: 'y', country: 'US' }, zoneId: zone, payment: paidVia === 'paypal' ? 'paypal' : paidVia === 'stripe' ? 'stripe' : 'tt' });
  if (paidVia) {
    db.prepare("INSERT INTO payment_intents (id, order_id, provider, provider_ref, amount, currency, status, created_at, updated_at, capture_ref) VALUES (?,?,?,?,?,?,'paid',?,?,?)")
      .run(`pi-${o.id}`, o.id, paidVia, `ref-${o.id}`, o.total, o.currency, new Date().toISOString(), new Date().toISOString(), paidVia === 'stripe' ? 'pi_123' : 'CAP-9');
  }
  S.recordPayment(o.id, { kind: paidVia ? 'online' : 'balance', amount: o.total });
  return S.getOrder(o.id);
}
const mails = (to) => db.prepare('SELECT subject, body FROM mail_outbox WHERE to_addr = ? ORDER BY id').all(to);

describe('tracking (17TRACK)', () => {
  test('AS-01 status mapping', () => {
    assert.deepEqual(['InfoReceived', 'InTransit', 'OutForDelivery', 'AvailableForPickup', 'Delivered', 'Exception', 'Expired'].map(T.mapStatus), [null, 'in_transit', 'in_transit', 'arrived', 'delivered', 'exception', 'exception']);
  });
  test('AS-02 registers new numbers once, then updates shipment and order status from the carrier', async () => {
    const o = shopOrder();
    const s = S.createShipment({ order_id: o.id, carrier: 'DHL', tracking_no: '1234567890' });
    track.set('1234567890', 'InTransit');
    assert.deepEqual(await T.syncTracking(), { checked: 1, changed: 1 });
    assert.equal(S.getShipment(s.id).status, 'in_transit');
    assert.equal(S.getOrder(o.id).status, 'shipped');
    assert.equal(prov.calls.filter((c) => c.url === '/track/v2.2/register').length, 1);
    assert.equal(prov.calls.find((c) => c.url === '/track/v2.2/register').headers['17token'], 'k17');
    track.set('1234567890', 'Delivered');
    await T.syncTracking();
    assert.equal(S.getShipment(s.id).status, 'delivered');
    assert.equal(S.getOrder(o.id).status, 'delivered');
    assert.equal(prov.calls.filter((c) => c.url === '/track/v2.2/register').length, 1, 'not registered twice');
    assert.equal(S.getShipment(s.id).events.at(-1).location, 'Los Angeles');
  });
  test('AS-03 booked → delivered in one poll steps through in_transit (legal transitions only)', async () => {
    const o = shopOrder();
    const s = S.createShipment({ order_id: o.id, tracking_no: 'FAST1' });
    track.set('FAST1', 'Delivered');
    await T.syncTracking({ ids: [s.id] });
    assert.deepEqual(S.getShipment(s.id).events.map((e) => e.status), ['booked', 'in_transit', 'delivered']);
  });
  test('AS-04 rejected numbers are recorded on the shipment', async () => {
    const o = shopOrder();
    const s = S.createShipment({ order_id: o.id, tracking_no: 'BAD' });
    await T.syncTracking({ ids: [s.id] });
    assert.equal(S.getShipment(s.id).track_error, 'invalid number');
  });
  test('AS-05 the buyer is e-mailed when the shipment is created and when it moves', () => {
    const subjects = mails('buyer@aftersales.test').map((m) => m.subject);
    assert.ok(subjects.some((s) => /shipment created/.test(s)));
    assert.ok(subjects.some((s) => /in transit/.test(s)));
    assert.ok(subjects.some((s) => /delivered/.test(s)));
    assert.ok(mails('buyer@aftersales.test').some((m) => /Tracking number: 1234567890/.test(m.body)));
  });
});

describe('refunds', () => {
  test('AS-06 Stripe: refund sent to Stripe (cents, idempotency key) and booked as a negative payment', async () => {
    const o = shopOrder({ paidVia: 'stripe' });
    const r = await R.refundOrder(o.id, { amount: 100, reason: 'damaged' });
    assert.equal(r.provider, 'stripe');
    const call = prov.calls.filter((c) => c.url === '/v1/refunds').at(-1);
    const p = new URLSearchParams(call.body);
    assert.equal(p.get('payment_intent'), 'pi_123');
    assert.equal(p.get('amount'), '10000');
    assert.ok(call.headers['idempotency-key'].startsWith('refund-'));
    assert.equal(S.getOrder(o.id).paid, o.total - 100);
    assert.equal(R.refundsFor(o.id)[0].status, 'done');
  });
  test('AS-07 PayPal: refund against the capture', async () => {
    const o = shopOrder({ paidVia: 'paypal' });
    const r = await R.refundOrder(o.id, { amount: 50 });
    assert.equal(r.ref, 'PPR1');
    assert.ok(prov.calls.some((c) => c.url === '/v2/payments/captures/CAP-9/refund' && c.body.amount.value === '50.00'));
  });
  test('AS-08 bank transfer orders get a manual refund record', async () => {
    const o = shopOrder();
    assert.equal((await R.refundOrder(o.id, { amount: 10 })).provider, 'manual');
  });
  test('AS-09 limits: more than received, zero, unknown order', async () => {
    const o = shopOrder();
    await assert.rejects(R.refundOrder(o.id, { amount: o.total + 1 }), /不能超过已收金额/);
    await assert.rejects(R.refundOrder(o.id, { amount: 0 }), /大于 0/);
    await assert.rejects(R.refundOrder('nope', { amount: 1 }), /订单不存在/);
  });
  test('AS-10 provider failure: nothing booked, refund marked failed with the reason', async () => {
    const o = shopOrder({ paidVia: 'stripe' });
    await assert.rejects(R.refundOrder(o.id, { amount: 0.01 }), /insufficient balance/);
    assert.equal(S.getOrder(o.id).paid, o.total);
    assert.equal(R.refundsFor(o.id)[0].status, 'failed');
  });
  test('AS-11 refund for an approved RMA resolves it; full refund then allows cancelling an unshipped order', async () => {
    const o = shopOrder();
    const s = S.createShipment({ order_id: o.id });
    S.addShipmentEvent(s.id, { status: 'in_transit' });
    const rma = S.createRma({ order_id: o.id, sku: 'YR-HB-U2', qty: 2, issue: 'damage', description: 'broken', source: 'shop' });
    S.setRmaStatus(rma.id, 'approved');
    await R.refundOrder(o.id, { amount: 20, rmaId: rma.id });
    assert.equal(S.getRma(rma.id).status, 'resolved');
    assert.equal(S.getRma(rma.id).resolution, 'refund');
    const o2 = shopOrder();
    assert.throws(() => S.setOrderStatus(o2.id, 'cancelled'), /请先登记退款/);
    await R.refundOrder(o2.id, { amount: o2.total });
    assert.equal(S.setOrderStatus(o2.id, 'cancelled').status, 'cancelled');
    assert.ok(mails('buyer@aftersales.test').some((m) => /refund/.test(m.subject)));
  });
});
