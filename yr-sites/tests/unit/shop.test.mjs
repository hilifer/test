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
  test('SH-01a the shipping zone is found by country code (case-insensitive)', () => {
    assert.match(F.quoteShipping({ country: 'us', weightKg: 3.2, subtotal: 0 })[0].name, /North America/);
  });
  test('SH-01b the fee is the first weight plus each extra kg, rounded up', () => {
    assert.equal(F.quoteShipping({ country: 'us', weightKg: 3.2, subtotal: 0 })[0].fee, 35 + 3 * 9);
  });
  test('SH-01c an unlisted country falls back to the "*" zone', () => {
    assert.match(F.quoteShipping({ country: 'ZZ', weightKg: 1 })[0].name, /Rest of world/);
  });
  test('SH-02 volumetric weight counts when bigger than actual weight', () => {
    const o = F.quoteShipping({ country: 'US', weightKg: 1, cbm: 0.1, subtotal: 0 })[0]; // 0.1 m³ / 5000 → 20 kg
    assert.equal(o.chargeableKg, 20);
    assert.equal(o.fee, 35 + 19 * 9);
  });
  test('SH-03a shipping is free above the threshold', () => {
    assert.equal(F.quoteShipping({ country: 'US', weightKg: 5, subtotal: 3000 })[0].fee, 0);
  });
  test('SH-03b the cheapest shipping option is listed first', () => {
    F.saveZone({ name: 'US Sea', countries: 'US', method: 'sea', first_kg: 50, first_fee: 20, extra_fee_per_kg: 0.5, days_min: 25, days_max: 40 });
    const opts = F.quoteShipping({ country: 'US', weightKg: 60, subtotal: 0 });
    assert.equal(opts[0].name, 'US Sea');
    assert.ok(opts[0].fee <= opts[1].fee);
  });
  test('SH-04a a template without name, with a bad country code or no first weight is refused', () => {
    assert.throws(() => F.saveZone({ name: '', countries: 'USA', first_kg: 0 }), /名称必填|ISO|首重/);
  });
  test('SH-04b a template whose minimum days exceed the maximum is refused', () => {
    assert.throws(() => F.saveZone({ name: 'x', countries: 'US', first_kg: 1, first_fee: 1, extra_fee_per_kg: 1, days_min: 9, days_max: 3 }), /时效/);
  });
});

describe('pricing & cart', () => {
  test('SH-05 tier price by quantity', () => {
    const v = { price: 10, tiers: [{ minQty: 5, price: 9 }, { minQty: 8, price: 8 }] };
    assert.deepEqual([1, 4, 5, 7, 8, 100].map((q) => Cart.unitPrice(v, q)), [10, 10, 9, 9, 8, 8]);
  });
  test('SH-06a a quote-only SKU cannot be added to the cart', () => {
    assert.throws(() => Cart.setItem(Cart.createCart().id, 'ASK-1-A', 1), /not_available/);
  });
  test('SH-06b an unknown SKU cannot be added to the cart', () => {
    assert.throws(() => Cart.setItem(Cart.createCart().id, 'NOPE', 1), /not_available/);
  });
  test('SH-06c a non-numeric quantity is refused', () => {
    assert.throws(() => Cart.setItem(Cart.createCart().id, 'SHOP-1-A', 'abc'), /bad_qty/);
  });
  let c7;
  test('SH-07a a quantity below the MOQ is raised to the MOQ', () => {
    c7 = Cart.createCart();
    assert.deepEqual(Cart.setItem(c7.id, 'SHOP-1-A', 1), { qty: 2, raisedToMoq: true });
  });
  test('SH-07b adding the same SKU again accumulates the quantity', () => {
    assert.equal(Cart.setItem(c7.id, 'SHOP-1-A', 3).qty, 5);
  });
  test('SH-07c the cart view applies the tier price and sums subtotal, weight and carton volume', () => {
    const v = Cart.viewCart(c7.id);
    assert.equal(v.items[0].unitPrice, 9);
    assert.equal(v.subtotal, 45);
    assert.equal(v.weightKg, 2.5);
    assert.equal(v.cbm, 0.1, '1 carton of 10');
  });
  test('SH-07d setting the quantity to 0 removes the line', () => {
    assert.equal(Cart.setItem(c7.id, 'SHOP-1-A', 0, { set: true }).qty, 0);
    assert.equal(Cart.viewCart(c7.id).items.length, 0);
  });
  let c8;
  test('SH-08a a line over the available stock is flagged out of stock', () => {
    c8 = cartWith(11);
    assert.deepEqual(Cart.viewCart(c8.id).items[0].problems, ['out_of_stock']);
  });
  test('SH-08b a withdrawn product is flagged not available and the cart is not OK', () => {
    db.prepare("INSERT INTO cart_items (cart_id, sku, qty, added_at) VALUES (?, 'GONE-1', 1, 'x')").run(c8.id);
    const v = Cart.viewCart(c8.id);
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
  let c10, o10;
  test('SH-10a placing an order creates a shop order pending payment', () => {
    c10 = cartWith(5);
    o10 = CO.placeOrder({ cartId: c10.id, email: 'Buyer@Shop.test', address: addr, zoneId: usZone(), payment: 'tt' });
    assert.equal(o10.channel, 'shop');
    assert.equal(o10.status, 'pending_payment');
  });
  test('SH-10b order totals are computed on the server (tier price, shipping, full amount due)', () => {
    assert.equal(o10.subtotal, 45);
    assert.equal(o10.total, 45 + o10.shipping_fee);
    assert.equal(o10.deposit_due, o10.total);
    assert.equal(o10.lines[0].unit_price, 9);
  });
  test('SH-10c the order gets a long access token', () => {
    assert.ok(o10.access_token.length > 20);
  });
  test('SH-10d the cart is closed after checkout', () => {
    assert.equal(Cart.getCart(c10.id), null);
  });
  test('SH-10e the customer is stored with a lower-case e-mail', () => {
    assert.equal(S.getCustomer(o10.customer_id).email, 'buyer@shop.test');
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
  let c13;
  test('SH-13a checkout without a phone number is refused', () => {
    c13 = cartWith(2);
    assert.throws(() => CO.placeOrder({ cartId: c13.id, email: 'x@shop.test', address: { ...addr, phone: '' }, zoneId: usZone(), payment: 'tt' }), /Phone/);
  });
  test('SH-13b checkout with an invalid e-mail is refused', () => {
    assert.throws(() => CO.placeOrder({ cartId: c13.id, email: 'bad', address: addr, zoneId: usZone(), payment: 'tt' }), /e-mail/);
  });
  test('SH-13c checkout with an unknown payment method is refused', () => {
    assert.throws(() => CO.placeOrder({ cartId: c13.id, email: 'x@shop.test', address: addr, zoneId: usZone(), payment: 'bitcoin' }), /payment/);
  });
  test('SH-13d checkout with an unknown shipping option is refused', () => {
    assert.throws(() => CO.placeOrder({ cartId: c13.id, email: 'x@shop.test', address: addr, zoneId: 99999, payment: 'tt' }), /shipping/);
  });
  test('SH-13e checkout of an empty cart is refused', () => {
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
  const body15 = '{"a":1}';
  test('SH-15a a valid Stripe signature is accepted', () => {
    assert.equal(P.verifyStripeSignature(body15, sign(body15)), true);
  });
  test('SH-15b a signature made with the wrong secret is rejected', () => {
    assert.equal(P.verifyStripeSignature(body15, sign(body15, 'other')), false);
  });
  test('SH-15c a signature with an old timestamp is rejected', () => {
    assert.equal(P.verifyStripeSignature(body15, sign(body15, 'whsec_test', Math.floor(Date.now() / 1000) - 3600)), false);
  });
  test('SH-15d a tampered body is rejected', () => {
    assert.equal(P.verifyStripeSignature('{"a":2}', sign(body15)), false);
  });
  test('SH-15e a missing signature is rejected', () => {
    assert.equal(P.verifyStripeSignature(body15, ''), false);
  });
  async function stripeOrder(qty = 2) {
    const o = CO.placeOrder({ cartId: cartWith(qty).id, email: 'card@shop.test', address: addr, zoneId: usZone(), payment: 'stripe' });
    await P.stripeCheckout(o, { successUrl: 'https://x/s', cancelUrl: 'https://x/c' });
    const intent = P.intentsFor(o.id)[0];
    return { o, intent, event: (amount = o.total, currency = 'usd') => ({ type: 'checkout.session.completed', data: { object: { id: intent.provider_ref, payment_status: 'paid', amount_total: Math.round(amount * 100), currency, payment_intent: 'pi_1' } } }) };
  }
  let o16, call16;
  test('SH-16a the Stripe Checkout session sends the amount in cents', async () => {
    ({ o: o16 } = await stripeOrder());
    call16 = mock.calls.filter((c) => c.url === '/v1/checkout/sessions').at(-1);
    const params = new URLSearchParams(call16.body);
    assert.equal(params.get('line_items[0][price_data][unit_amount]'), String(Math.round(o16.total * 100)));
  });
  test('SH-16b the Stripe Checkout session carries the order id as metadata', () => {
    assert.equal(new URLSearchParams(call16.body).get('metadata[order_id]'), o16.id);
  });
  test('SH-16c the Stripe request is authorised and has an idempotency key per order', () => {
    assert.equal(call16.headers.authorization, 'Bearer sk_test');
    assert.ok(call16.headers['idempotency-key'].startsWith(o16.id));
  });
  let s17;
  test('SH-17a the Stripe webhook books the payment and the order is ready to ship', async () => {
    s17 = await stripeOrder();
    assert.equal(P.handleStripeEvent(s17.event()), 'paid');
    assert.equal(S.getOrder(s17.o.id).status, 'ready_to_ship');
  });
  test('SH-17b a replayed webhook is ignored and the payment is booked once', () => {
    assert.equal(P.handleStripeEvent(s17.event()), 'duplicate');
    assert.equal(S.getOrder(s17.o.id).paid, s17.o.total);
  });
  test('SH-18a a Stripe amount mismatch is not booked', async () => {
    const { o, event } = await stripeOrder();
    assert.equal(P.handleStripeEvent(event(o.total - 1)), 'mismatch');
    assert.equal(S.getOrder(o.id).paid, 0);
  });
  test('SH-18b a Stripe currency mismatch is not booked', async () => {
    const b = await stripeOrder();
    assert.equal(P.handleStripeEvent(b.event(b.o.total, 'eur')), 'mismatch');
    assert.equal(S.getOrder(b.o.id).paid, 0);
  });
  test('SH-19 payment arriving after the order was cancelled is flagged, not booked', async () => {
    const { o, event } = await stripeOrder();
    S.setOrderStatus(o.id, 'cancelled');
    assert.equal(P.handleStripeEvent(event()), 'order_closed');
    assert.equal(S.getOrder(o.id).paid, 0);
  });
  test('SH-20a unrelated Stripe events are ignored', () => {
    assert.equal(P.handleStripeEvent({ type: 'customer.created', data: { object: {} } }), 'ignored');
  });
  test('SH-20b a completed session that matches no order is reported as unknown', () => {
    assert.equal(P.handleStripeEvent({ type: 'checkout.session.completed', data: { object: { id: 'cs_unknown', payment_status: 'paid' } } }), 'unknown_session');
  });
  let o21;
  test('SH-21a PayPal checkout creates an order for the total and returns the approval link', async () => {
    o21 = CO.placeOrder({ cartId: cartWith(2).id, email: 'pp@shop.test', address: addr, zoneId: usZone(), payment: 'paypal' });
    assert.equal(await P.paypalCheckout(o21, { returnUrl: 'https://x/r', cancelUrl: 'https://x/c' }), 'https://paypal.test/approve');
    const create = mock.calls.find((c) => c.url === '/v2/checkout/orders' && c.body.purchase_units[0].custom_id === o21.id);
    assert.equal(create.body.purchase_units[0].amount.value, o21.total.toFixed(2));
    assert.equal(create.headers.authorization, 'Bearer PPTOKEN');
  });
  test('SH-21b capturing on return books the payment and the order is ready to ship', async () => {
    pp.amount = o21.total;
    assert.equal((await P.paypalCapture(`PP-${o21.number}`)).result, 'paid');
    assert.equal(S.getOrder(o21.id).status, 'ready_to_ship');
  });
  test('SH-21c capturing again is reported as duplicate', async () => {
    assert.equal((await P.paypalCapture(`PP-${o21.number}`)).result, 'duplicate');
  });
  test('SH-21d a declined capture is not booked', async () => {
    const o2 = CO.placeOrder({ cartId: cartWith(2).id, email: 'pp2@shop.test', address: addr, zoneId: usZone(), payment: 'paypal' });
    await P.paypalCheckout(o2, { returnUrl: 'x', cancelUrl: 'y' });
    pp.captureStatus = 'DECLINED';
    try {
      assert.equal((await P.paypalCapture(`PP-${o2.number}`)).result, 'not_completed');
      assert.equal(S.getOrder(o2.id).paid, 0);
    } finally { pp.captureStatus = 'COMPLETED'; }
  });
});

describe('accounts', () => {
  let r22, t22;
  test('SH-22a registering creates the account with a lower-case e-mail', async () => {
    r22 = await A.register({ email: 'New@Shop.test', password: 'Passw0rd!', name: 'New' });
    assert.equal(r22.customer.email, 'new@shop.test');
  });
  test('SH-22b a verification e-mail with a link is queued', () => {
    const mail = db.prepare("SELECT * FROM mail_outbox WHERE to_addr = 'new@shop.test'").get();
    assert.match(mail.body, /\/shop\/account\/verify\?t=/);
    t22 = mail.body.match(/t=([\w-]+)/)[1];
  });
  test('SH-22c the verification link marks the e-mail verified', () => {
    assert.equal(A.verifyEmail(t22).email_verified, 0, 'returns customer before the update');
    assert.equal(S.getCustomer(r22.customer.id).email_verified, 1);
  });
  test('SH-22d the verification link works only once', () => {
    assert.equal(A.verifyEmail(t22), null, 'single use');
  });
  test('SH-23a registering with an existing customer e-mail does NOT give access', async () => {
    S.findOrCreateCustomer({ email: 'b2b@importer.test', company: 'Importer' });
    const r = await A.register({ email: 'b2b@importer.test', password: 'Attack3r!!' });
    assert.deepEqual(r, { emailSent: true });
    assert.equal(A.login('b2b@importer.test', 'Attack3r!!', '1.1.1.1').customer, undefined);
  });
  test('SH-23b the owner of the e-mail gets a link to set the password and can then log in', () => {
    const mail = db.prepare("SELECT * FROM mail_outbox WHERE to_addr = 'b2b@importer.test' ORDER BY id DESC").get();
    const t = mail.body.match(/reset\?t=([\w-]+)/)[1];
    A.resetPassword(t, 'OwnerPassw0rd');
    assert.ok(A.login('b2b@importer.test', 'OwnerPassw0rd', '1.1.1.1').customer);
  });
  test('SH-24 login lockout after 5 failures', () => {
    for (let i = 0; i < 5; i++) A.login('new@shop.test', 'wrong', `2.2.2.${i}`);
    assert.equal(A.login('new@shop.test', 'Passw0rd!', '2.2.2.9').locked, true);
  });
  test('SH-25a a reset request for an unknown e-mail gets the same answer', async () => {
    assert.equal(await A.requestReset('nobody@nowhere.test'), true);
  });
  let t25;
  test('SH-25b a reset to a password under 8 characters is refused', async () => {
    await A.requestReset('merge@shop.test');
    t25 = db.prepare("SELECT body FROM mail_outbox WHERE to_addr = 'merge@shop.test' ORDER BY id DESC").get().body.match(/t=([\w-]+)/)[1];
    assert.throws(() => A.resetPassword(t25, 'short'), /8/);
  });
  test('SH-25c a reset token works only once', () => {
    A.resetPassword(t25, 'Merged1234');
    assert.throws(() => A.resetPassword(t25, 'Merged1234'), /invalid|expired/);
  });
  test('SH-25d an expired reset token is refused', async () => {
    await A.requestReset('merge@shop.test');
    const t2 = db.prepare("SELECT body FROM mail_outbox WHERE to_addr = 'merge@shop.test' ORDER BY id DESC").get().body.match(/t=([\w-]+)/)[1];
    db.prepare('UPDATE customer_tokens SET expires_at = 0 WHERE token = ?').run(t2);
    assert.throws(() => A.resetPassword(t2, 'Merged5678'), /expired/);
  });
  let me26, other26, a26;
  test('SH-26a a session finds its customer until it is ended', () => {
    me26 = S.findOrCreateCustomer({ email: 'merge@shop.test' });
    other26 = S.findOrCreateCustomer({ email: 'other@shop.test' });
    const tok = A.createSession(me26);
    assert.equal(A.sessionCustomer(tok).id, me26.id);
    A.endSession(tok);
    assert.equal(A.sessionCustomer(tok), null);
  });
  test('SH-26b the first saved address becomes the default', () => {
    a26 = A.saveAddress(me26.id, addr);
    assert.equal(a26.is_default, 1, 'first address becomes default');
  });
  test('SH-26c another customer cannot read the address', () => {
    assert.equal(A.getAddress(other26.id, a26.id), undefined);
  });
  test('SH-26d another customer cannot edit the address', () => {
    assert.throws(() => A.saveAddress(other26.id, { ...addr, id: a26.id }), /not found/);
  });
  test('SH-26e another customer cannot delete the address', () => {
    A.deleteAddress(other26.id, a26.id);
    assert.ok(A.getAddress(me26.id, a26.id), 'others cannot delete it');
  });
  test('SH-26f an address without the required fields is refused', () => {
    assert.throws(() => A.saveAddress(me26.id, { name: 'x' }), /Address is required/);
  });
});
