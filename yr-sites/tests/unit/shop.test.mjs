// Modules: server/src/shop/* — freight, pricing, cart, checkout & stock reservation, expiry, Stripe/PayPal
// verification and settlement, customer accounts. IDs SH-xx.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { useTempEnv } from '../helpers/env.mjs';
import { mockServer } from '../helpers/mock-http.mjs';

const pp = { captureStatus: 'COMPLETED', amount: null };
const mock = await mockServer((call) => {
  if (call.url === '/v1/oauth2/token') return { json: { access_token: 'PPTOKEN', expires_in: 3600 } };
  if (call.url === '/v2/checkout/orders') return { json: { id: `PP-${call.body.purchase_units[0].reference_id}`, links: [{ rel: 'approve', href: 'https://paypal.test/approve' }] } };
  const m = call.url.match(/^\/v2\/checkout\/orders\/(.+)\/capture$/);
  if (m) return { json: { status: pp.captureStatus, purchase_units: [{ payments: { captures: [{ id: `CAP-${m[1]}`, status: pp.captureStatus, amount: { value: String(pp.amount), currency_code: 'USD' } }] } }] } };
  if (call.url === '/v1/checkout/sessions') return { json: { id: `cs_${call.body}`.slice(0, 40).replace(/[^\w]/g, ''), url: 'https://stripe.test/pay' } };
  return { status: 404, text: '' };
});
after(() => mock.close());

useTempEnv({ site: 'led', ERP_MODE: 'local', STRIPE_SECRET_KEY: 'sk_test', STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_API_BASE: mock.url, PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_API_BASE: mock.url });
const F = await import('../../server/src/shop/freight.js');
const Cart = await import('../../server/src/shop/cart.js');
const CO = await import('../../server/src/shop/checkout.js');
const P = await import('../../server/src/shop/payments.js');
const A = await import('../../server/src/shop/accounts.js');
const S = await import('../../server/src/ops/service.js');
const C = await import('../../server/src/catalog/store.js');
const { db } = await import('../../server/src/db.js');

// a shop product with limited stock
C.saveProduct({ id: 'SHOP-1', name: 'Shop Lamp', category: 'indoor', summary: 'Test lamp.', warranty: '2 years', unit: 'pcs', moq: 2, leadTimeDays: [5, 10], sampleDays: [2, 3], specs: 'Power: 10 W' }, {
  isNew: true, status: 'published', salesMode: 'both',
  variants: [{ sku: 'SHOP-1-A', price: '10', min_qty: '2', weight_kg: '0.5', stock_local: '10', tier_prices: '5:9 | 8:8', pcs_per_carton: '10', carton_cbm: '0.1', carton_gw: '6' }],
});
C.saveProduct({ id: 'ASK-1', name: 'Ask Lamp', category: 'indoor', summary: 'Quote only.', warranty: '2 years', unit: 'pcs', moq: 1, leadTimeDays: [5, 10], sampleDays: [2, 3], specs: 'Power: 10 W' }, { isNew: true, status: 'published', salesMode: 'inquiry', variants: [{ sku: 'ASK-1-A', price: '', min_qty: '1' }] });
C.publishCatalog();
const addr = { name: 'Jane', phone: '+1 555', line1: '1 Main St', city: 'Austin', country: 'US' };
const usZone = () => F.quoteShipping({ country: 'US', weightKg: 1, subtotal: 0 })[0].zoneId;
const cartWith = (qty, sku = 'SHOP-1-A') => { const c = Cart.createCart(); Cart.setItem(c.id, sku, qty, { set: true }); return c; };

describe('freight', () => {
  test('SH-01 zone by country, fallback to "*", first weight + per-kg rounding up', () => {
    const us = F.quoteShipping({ country: 'us', weightKg: 3.2, subtotal: 0 })[0];
    assert.match(us.name, /North America/);
    assert.equal(us.fee, 35 + 3 * 9);
    assert.match(F.quoteShipping({ country: 'ZZ', weightKg: 1 })[0].name, /Rest of world/);
  });
  test('SH-02 volumetric weight counts when bigger than actual weight', () => {
    const o = F.quoteShipping({ country: 'US', weightKg: 1, cbm: 0.1, subtotal: 0 })[0]; // 0.1 m³ / 5000 → 20 kg
    assert.equal(o.chargeableKg, 20);
    assert.equal(o.fee, 35 + 19 * 9);
  });
  test('SH-03 free shipping above the threshold; cheapest option first', () => {
    assert.equal(F.quoteShipping({ country: 'US', weightKg: 5, subtotal: 3000 })[0].fee, 0);
    F.saveZone({ name: 'US Sea', countries: 'US', method: 'sea', first_kg: 50, first_fee: 20, extra_fee_per_kg: 0.5, days_min: 25, days_max: 40 });
    const opts = F.quoteShipping({ country: 'US', weightKg: 60, subtotal: 0 });
    assert.equal(opts[0].name, 'US Sea');
    assert.ok(opts[0].fee <= opts[1].fee);
  });
  test('SH-04 template validation', () => {
    assert.throws(() => F.saveZone({ name: '', countries: 'USA', first_kg: 0 }), /名称必填|ISO|首重/);
    assert.throws(() => F.saveZone({ name: 'x', countries: 'US', first_kg: 1, first_fee: 1, extra_fee_per_kg: 1, days_min: 9, days_max: 3 }), /时效/);
  });
});

describe('pricing & cart', () => {
  test('SH-05 tier price by quantity', () => {
    const v = { price: 10, tiers: [{ minQty: 5, price: 9 }, { minQty: 8, price: 8 }] };
    assert.deepEqual([1, 4, 5, 7, 8, 100].map((q) => Cart.unitPrice(v, q)), [10, 10, 9, 9, 8, 8]);
  });
  test('SH-06 only published, online-sellable SKUs can be added; quote-only and unknown are refused', () => {
    const c = Cart.createCart();
    assert.throws(() => Cart.setItem(c.id, 'ASK-1-A', 1), /not_available/);
    assert.throws(() => Cart.setItem(c.id, 'NOPE', 1), /not_available/);
    assert.throws(() => Cart.setItem(c.id, 'SHOP-1-A', 'abc'), /bad_qty/);
  });
  test('SH-07 quantity below MOQ is raised to the MOQ; adding accumulates; 0 removes', () => {
    const c = Cart.createCart();
    assert.deepEqual(Cart.setItem(c.id, 'SHOP-1-A', 1), { qty: 2, raisedToMoq: true });
    assert.equal(Cart.setItem(c.id, 'SHOP-1-A', 3).qty, 5);
    const v = Cart.viewCart(c.id);
    assert.equal(v.items[0].unitPrice, 9);
    assert.equal(v.subtotal, 45);
    assert.equal(v.weightKg, 2.5);
    assert.equal(v.cbm, 0.1, '1 carton of 10');
    assert.equal(Cart.setItem(c.id, 'SHOP-1-A', 0, { set: true }).qty, 0);
    assert.equal(Cart.viewCart(c.id).items.length, 0);
  });
  test('SH-08 cart problems: more than available stock, product withdrawn', () => {
    const c = cartWith(11);
    assert.deepEqual(Cart.viewCart(c.id).items[0].problems, ['out_of_stock']);
    db.prepare("INSERT INTO cart_items (cart_id, sku, qty, added_at) VALUES (?, 'GONE-1', 1, 'x')").run(c.id);
    const v = Cart.viewCart(c.id);
    assert.deepEqual(v.items[1].problems, ['not_available']);
    assert.equal(v.ok, false);
  });
  test('SH-09 guest cart is merged into the customer cart on login', () => {
    const cust = S.findOrCreateCustomer({ email: 'merge@shop.test' });
    const mine = Cart.createCart(cust.id);
    Cart.setItem(mine.id, 'SHOP-1-A', 2);
    const guest = cartWith(3);
    const r = Cart.resolveCart(guest.id, cust);
    assert.equal(r.id, mine.id);
    assert.equal(Cart.viewCart(mine.id).items[0].qty, 5);
    assert.equal(Cart.getCart(guest.id), null);
  });
});

describe('checkout', () => {
  test('SH-10 order totals are computed on the server; cart is closed', () => {
    const c = cartWith(5);
    const o = CO.placeOrder({ cartId: c.id, email: 'Buyer@Shop.test', address: addr, zoneId: usZone(), payment: 'tt' });
    assert.equal(o.channel, 'shop');
    assert.equal(o.status, 'pending_payment');
    assert.equal(o.subtotal, 45);
    assert.equal(o.total, 45 + o.shipping_fee);
    assert.equal(o.deposit_due, o.total);
    assert.equal(o.lines[0].unit_price, 9);
    assert.ok(o.access_token.length > 20);
    assert.equal(Cart.getCart(c.id), null);
    assert.equal(S.getCustomer(o.customer_id).email, 'buyer@shop.test');
  });
  test('SH-11 stock is reserved: the second buyer cannot take units that are already sold', () => {
    // 10 in stock, 5 reserved by SH-10 → 5 left
    const a = cartWith(5), b = cartWith(5);
    CO.placeOrder({ cartId: a.id, email: 'a@shop.test', address: addr, zoneId: usZone(), payment: 'tt' });
    assert.throws(() => CO.placeOrder({ cartId: b.id, email: 'b@shop.test', address: addr, zoneId: usZone(), payment: 'tt' }), (e) => e.code === 'cart_problems' && e.items[0].problems.includes('out_of_stock'));
  });
  test('SH-12 unpaid orders expire, are cancelled and release their stock', () => {
    db.prepare("UPDATE orders SET expires_at = '2000-01-01T00:00:00Z' WHERE channel = 'shop' AND status = 'pending_payment'").run();
    assert.equal(CO.expireUnpaid(), 2);
    assert.equal(S.stockView().find((s) => s.sku === 'SHOP-1-A').available, 10);
  });
  test('SH-13 checkout validation: address, e-mail, payment method, shipping option, empty cart', () => {
    const c = cartWith(2);
    assert.throws(() => CO.placeOrder({ cartId: c.id, email: 'x@shop.test', address: { ...addr, phone: '' }, zoneId: usZone(), payment: 'tt' }), /Phone/);
    assert.throws(() => CO.placeOrder({ cartId: c.id, email: 'bad', address: addr, zoneId: usZone(), payment: 'tt' }), /e-mail/);
    assert.throws(() => CO.placeOrder({ cartId: c.id, email: 'x@shop.test', address: addr, zoneId: usZone(), payment: 'bitcoin' }), /payment/);
    assert.throws(() => CO.placeOrder({ cartId: c.id, email: 'x@shop.test', address: addr, zoneId: 99999, payment: 'tt' }), /shipping/);
    assert.throws(() => CO.placeOrder({ cartId: Cart.createCart().id, email: 'x@shop.test', address: addr, zoneId: usZone(), payment: 'tt' }), /empty/);
  });
  test('SH-14 finance confirming a bank transfer moves the order to ready to ship', () => {
    const o = CO.placeOrder({ cartId: cartWith(2).id, email: 'tt@shop.test', address: addr, zoneId: usZone(), payment: 'tt' });
    assert.equal(S.recordPayment(o.id, { kind: 'balance', amount: o.total, ref: 'TT-9' }).status, 'ready_to_ship');
  });
});

describe('payments', () => {
  test('SH-14b (setup) restock the test SKU for the payment cases', () => { db.prepare("UPDATE skus SET stock_local = 1000 WHERE sku = 'SHOP-1-A'").run(); });
  const sign = (payload, secret = 'whsec_test', t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;
  test('SH-15 Stripe signature: valid accepted; wrong secret, old timestamp, tampered body rejected', () => {
    const body = '{"a":1}';
    assert.equal(P.verifyStripeSignature(body, sign(body)), true);
    assert.equal(P.verifyStripeSignature(body, sign(body, 'other')), false);
    assert.equal(P.verifyStripeSignature(body, sign(body, 'whsec_test', Math.floor(Date.now() / 1000) - 3600)), false);
    assert.equal(P.verifyStripeSignature('{"a":2}', sign(body)), false);
    assert.equal(P.verifyStripeSignature(body, ''), false);
  });
  async function stripeOrder(qty = 2) {
    const o = CO.placeOrder({ cartId: cartWith(qty).id, email: 'card@shop.test', address: addr, zoneId: usZone(), payment: 'stripe' });
    await P.stripeCheckout(o, { successUrl: 'https://x/s', cancelUrl: 'https://x/c' });
    const intent = P.intentsFor(o.id)[0];
    return { o, intent, event: (amount = o.total, currency = 'usd') => ({ type: 'checkout.session.completed', data: { object: { id: intent.provider_ref, payment_status: 'paid', amount_total: Math.round(amount * 100), currency, payment_intent: 'pi_1' } } }) };
  }
  test('SH-16 Stripe Checkout session request: amount in cents, metadata, idempotency key', async () => {
    const { o } = await stripeOrder();
    const call = mock.calls.filter((c) => c.url === '/v1/checkout/sessions').at(-1);
    const params = new URLSearchParams(call.body);
    assert.equal(params.get('line_items[0][price_data][unit_amount]'), String(Math.round(o.total * 100)));
    assert.equal(params.get('metadata[order_id]'), o.id);
    assert.equal(call.headers.authorization, 'Bearer sk_test');
    assert.ok(call.headers['idempotency-key'].startsWith(o.id));
  });
  test('SH-17 Stripe webhook books the payment once (replays are ignored)', async () => {
    const { o, event } = await stripeOrder();
    assert.equal(P.handleStripeEvent(event()), 'paid');
    assert.equal(S.getOrder(o.id).status, 'ready_to_ship');
    assert.equal(P.handleStripeEvent(event()), 'duplicate');
    assert.equal(S.getOrder(o.id).paid, o.total);
  });
  test('SH-18 amount or currency mismatch is not booked', async () => {
    const { o, event } = await stripeOrder();
    assert.equal(P.handleStripeEvent(event(o.total - 1)), 'mismatch');
    assert.equal(S.getOrder(o.id).paid, 0);
    const b = await stripeOrder();
    assert.equal(P.handleStripeEvent(b.event(b.o.total, 'eur')), 'mismatch');
  });
  test('SH-19 payment arriving after the order was cancelled is flagged, not booked', async () => {
    const { o, event } = await stripeOrder();
    S.setOrderStatus(o.id, 'cancelled');
    assert.equal(P.handleStripeEvent(event()), 'order_closed');
    assert.equal(S.getOrder(o.id).paid, 0);
  });
  test('SH-20 unrelated events and unknown sessions are ignored', () => {
    assert.equal(P.handleStripeEvent({ type: 'customer.created', data: { object: {} } }), 'ignored');
    assert.equal(P.handleStripeEvent({ type: 'checkout.session.completed', data: { object: { id: 'cs_unknown', payment_status: 'paid' } } }), 'unknown_session');
  });
  test('SH-21 PayPal: create order → capture on return → booked once; failed capture not booked', async () => {
    const o = CO.placeOrder({ cartId: cartWith(2).id, email: 'pp@shop.test', address: addr, zoneId: usZone(), payment: 'paypal' });
    assert.equal(await P.paypalCheckout(o, { returnUrl: 'https://x/r', cancelUrl: 'https://x/c' }), 'https://paypal.test/approve');
    const create = mock.calls.find((c) => c.url === '/v2/checkout/orders' && c.body.purchase_units[0].custom_id === o.id);
    assert.equal(create.body.purchase_units[0].amount.value, o.total.toFixed(2));
    assert.equal(create.headers.authorization, 'Bearer PPTOKEN');
    pp.amount = o.total;
    assert.equal((await P.paypalCapture(`PP-${o.number}`)).result, 'paid');
    assert.equal(S.getOrder(o.id).status, 'ready_to_ship');
    assert.equal((await P.paypalCapture(`PP-${o.number}`)).result, 'duplicate');
    const o2 = CO.placeOrder({ cartId: cartWith(2).id, email: 'pp2@shop.test', address: addr, zoneId: usZone(), payment: 'paypal' });
    await P.paypalCheckout(o2, { returnUrl: 'x', cancelUrl: 'y' });
    pp.captureStatus = 'DECLINED';
    assert.equal((await P.paypalCapture(`PP-${o2.number}`)).result, 'not_completed');
    assert.equal(S.getOrder(o2.id).paid, 0);
    pp.captureStatus = 'COMPLETED';
  });
});

describe('accounts', () => {
  test('SH-22 register: new account created and verification e-mail queued', async () => {
    const r = await A.register({ email: 'New@Shop.test', password: 'Passw0rd!', name: 'New' });
    assert.equal(r.customer.email, 'new@shop.test');
    const mail = db.prepare("SELECT * FROM mail_outbox WHERE to_addr = 'new@shop.test'").get();
    assert.match(mail.body, /\/shop\/account\/verify\?t=/);
    const t = mail.body.match(/t=([\w-]+)/)[1];
    assert.equal(A.verifyEmail(t).email_verified, 0, 'returns customer before the update');
    assert.equal(S.getCustomer(r.customer.id).email_verified, 1);
    assert.equal(A.verifyEmail(t), null, 'single use');
  });
  test('SH-23 registering with an existing customer e-mail does NOT give access — the owner gets a link', async () => {
    S.findOrCreateCustomer({ email: 'b2b@importer.test', company: 'Importer' });
    const r = await A.register({ email: 'b2b@importer.test', password: 'Attack3r!!' });
    assert.deepEqual(r, { emailSent: true });
    assert.equal(A.login('b2b@importer.test', 'Attack3r!!', '1.1.1.1').customer, undefined);
    const mail = db.prepare("SELECT * FROM mail_outbox WHERE to_addr = 'b2b@importer.test' ORDER BY id DESC").get();
    const t = mail.body.match(/reset\?t=([\w-]+)/)[1];
    A.resetPassword(t, 'OwnerPassw0rd');
    assert.ok(A.login('b2b@importer.test', 'OwnerPassw0rd', '1.1.1.1').customer);
  });
  test('SH-24 login lockout after 5 failures', () => {
    for (let i = 0; i < 5; i++) A.login('new@shop.test', 'wrong', `2.2.2.${i}`);
    assert.equal(A.login('new@shop.test', 'Passw0rd!', '2.2.2.9').locked, true);
  });
  test('SH-25 password reset: same answer for unknown e-mails, token expires and is single-use', async () => {
    assert.equal(await A.requestReset('nobody@nowhere.test'), true);
    await A.requestReset('merge@shop.test');
    const t = db.prepare("SELECT body FROM mail_outbox WHERE to_addr = 'merge@shop.test' ORDER BY id DESC").get().body.match(/t=([\w-]+)/)[1];
    assert.throws(() => A.resetPassword(t, 'short'), /8/);
    A.resetPassword(t, 'Merged1234');
    assert.throws(() => A.resetPassword(t, 'Merged1234'), /invalid|expired/);
    await A.requestReset('merge@shop.test');
    const t2 = db.prepare("SELECT body FROM mail_outbox WHERE to_addr = 'merge@shop.test' ORDER BY id DESC").get().body.match(/t=([\w-]+)/)[1];
    db.prepare('UPDATE customer_tokens SET expires_at = 0 WHERE token = ?').run(t2);
    assert.throws(() => A.resetPassword(t2, 'Merged5678'), /expired/);
  });
  test('SH-26 sessions; addresses are private to their owner', () => {
    const me = S.findOrCreateCustomer({ email: 'merge@shop.test' });
    const other = S.findOrCreateCustomer({ email: 'other@shop.test' });
    const tok = A.createSession(me);
    assert.equal(A.sessionCustomer(tok).id, me.id);
    A.endSession(tok);
    assert.equal(A.sessionCustomer(tok), null);
    const a = A.saveAddress(me.id, addr);
    assert.equal(a.is_default, 1, 'first address becomes default');
    assert.equal(A.getAddress(other.id, a.id), undefined);
    assert.throws(() => A.saveAddress(other.id, { ...addr, id: a.id }), /not found/);
    A.deleteAddress(other.id, a.id);
    assert.ok(A.getAddress(me.id, a.id), 'others cannot delete it');
    assert.throws(() => A.saveAddress(me.id, { name: 'x' }), /Address is required/);
  });
});
