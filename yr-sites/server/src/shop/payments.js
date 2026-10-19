// Online payments: Stripe Checkout (hosted page — card data never touches our server), PayPal Orders v2,
// and bank transfer (T/T, confirmed by finance in the admin).
// Money is only booked from a verified provider confirmation (signed Stripe webhook / PayPal capture), never from
// the browser returning to our site; the paid amount and currency must match the order. Idempotent.
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { config } from '../config.js';
import { getOrder, recordPayment, logEvent, getCustomer } from '../ops/service.js';
import { pushOrder } from '../ops/erp/index.js';
import { alertOps } from '../alerts.js';
import { sendMail } from './mailer.js';
import './schema.js';

const now = () => new Date().toISOString();
const env = (k, d = '') => process.env[k] || d;
const cents = (n) => Math.round(Number(n) * 100);

export const stripeEnabled = () => Boolean(env('STRIPE_SECRET_KEY') && env('STRIPE_WEBHOOK_SECRET'));
export const paypalEnabled = () => Boolean(env('PAYPAL_CLIENT_ID') && env('PAYPAL_CLIENT_SECRET'));
export const enabledMethods = () => [stripeEnabled() && 'stripe', paypalEnabled() && 'paypal', 'tt'].filter(Boolean);

function saveIntent(order, provider, ref, raw) {
  const id = randomUUID();
  db.prepare('INSERT INTO payment_intents (id, order_id, provider, provider_ref, amount, currency, status, created_at, updated_at, raw) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, order.id, provider, ref, order.total, order.currency, 'created', now(), now(), JSON.stringify(raw).slice(0, 4000));
  return id;
}
const intentByRef = (provider, ref) => db.prepare('SELECT * FROM payment_intents WHERE provider = ? AND provider_ref = ?').get(provider, String(ref || ''));
export const intentsFor = (orderId) => db.prepare('SELECT * FROM payment_intents WHERE order_id = ? ORDER BY created_at').all(orderId);

/** Book a confirmed online payment exactly once. Returns 'paid' | 'duplicate' | 'mismatch' | 'order_closed'. */
function settle(intent, { amount, currency, ref, provider }) {
  if (intent.status === 'paid') return 'duplicate';
  const o = getOrder(intent.order_id);
  if (String(currency).toUpperCase() !== String(o.currency).toUpperCase() || cents(amount) !== cents(o.total - o.paid)) {
    db.prepare("UPDATE payment_intents SET status = 'mismatch', updated_at = ? WHERE id = ?").run(now(), intent.id);
    alertOps('在线付款金额与订单不符，未自动入账', [`${o.number}：应收 ${o.currency} ${o.total - o.paid}，实收 ${currency} ${amount}`, `${provider} ${ref}`]).catch(() => {});
    return 'mismatch';
  }
  if (o.status === 'cancelled') {
    db.prepare("UPDATE payment_intents SET status = 'paid_after_cancel', updated_at = ? WHERE id = ?").run(now(), intent.id);
    alertOps('订单已取消后客户才付款，请退款或人工恢复', [`${o.number} · ${currency} ${amount}`, `${provider} ${ref}`]).catch(() => {});
    return 'order_closed';
  }
  db.prepare("UPDATE payment_intents SET status = 'paid', updated_at = ? WHERE id = ?").run(now(), intent.id);
  const after = recordPayment(o.id, { kind: 'online', amount, ref: `${provider} ${ref}` }, 'customer');
  if (config.erp.autoPushOrders) pushOrder(o.id).catch(() => {});
  const c = getCustomer(o.customer_id);
  sendMail(c.email, `${config.profile.brand}: payment received for ${o.number}`, `Thank you — we received ${o.currency} ${amount} for order ${o.number}. We will e-mail you tracking details when it ships.\n\nOrder status: ${config.publicBaseUrl}/shop/order/${encodeURIComponent(o.number)}?t=${o.access_token}`).catch(() => {});
  alertOps('网店订单已付款', [`${o.number} · ${o.currency} ${amount} · ${provider}`, `状态：${after.status}`]).catch(() => {});
  return 'paid';
}

// ---------------------------------------------------------------- Stripe
const stripeBase = () => env('STRIPE_API_BASE', 'https://api.stripe.com');
function form(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v == null) continue;
    if (typeof v === 'object') form(v, key, out); else out.append(key, String(v));
  }
  return out;
}

export async function stripeCheckout(order, { successUrl, cancelUrl }) {
  if (!stripeEnabled()) throw new Error('Stripe is not configured');
  const c = getCustomer(order.customer_id);
  const body = form({
    mode: 'payment', client_reference_id: order.id, customer_email: c.email, success_url: successUrl, cancel_url: cancelUrl,
    'metadata[order_id]': order.id, 'metadata[order_number]': order.number,
    line_items: { 0: { quantity: 1, price_data: { currency: order.currency.toLowerCase(), unit_amount: cents(order.total - order.paid), product_data: { name: `${config.profile.brand} order ${order.number}` } } } },
    expires_at: Math.floor(Date.now() / 1000) + 60 * 60,
  });
  const r = await fetch(`${stripeBase()}/v1/checkout/sessions`, {
    method: 'POST', body, signal: AbortSignal.timeout(20000),
    headers: { authorization: `Bearer ${env('STRIPE_SECRET_KEY')}`, 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': `${order.id}-${intentsFor(order.id).length}` },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.url) throw new Error(`Stripe: ${j.error?.message || r.status}`);
  saveIntent(order, 'stripe', j.id, { id: j.id });
  logEvent('order', order.id, 'payment_started', { actor: 'customer', note: `stripe ${j.id}` });
  return j.url;
}

/** Verify the Stripe-Signature header (HMAC-SHA256 over "t.payload", 5-minute tolerance). */
export function verifyStripeSignature(payload, header, secret = env('STRIPE_WEBHOOK_SECRET'), toleranceSec = 300) {
  const parts = Object.fromEntries(String(header || '').split(',').map((kv) => kv.split('=')).filter((p) => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const sigs = String(header || '').split(',').filter((p) => p.trim().startsWith('v1=')).map((p) => p.trim().slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length || !secret) return false;
  if (Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${payload}`).digest();
  return sigs.some((s) => { const b = Buffer.from(s, 'hex'); return b.length === expected.length && timingSafeEqual(b, expected); });
}

export function handleStripeEvent(event) {
  const s = event?.data?.object || {};
  if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event?.type) || s.payment_status !== 'paid') return 'ignored';
  const intent = intentByRef('stripe', s.id);
  if (!intent) return 'unknown_session';
  return settle(intent, { amount: s.amount_total / 100, currency: s.currency, ref: s.payment_intent || s.id, provider: 'stripe' });
}

// ---------------------------------------------------------------- PayPal
const paypalBase = () => env('PAYPAL_API_BASE', 'https://api-m.sandbox.paypal.com');
let ppToken = null;
async function paypalToken() {
  if (ppToken && ppToken.exp > Date.now() + 60e3) return ppToken.v;
  const r = await fetch(`${paypalBase()}/v1/oauth2/token`, { method: 'POST', body: 'grant_type=client_credentials', signal: AbortSignal.timeout(20000),
    headers: { authorization: 'Basic ' + Buffer.from(`${env('PAYPAL_CLIENT_ID')}:${env('PAYPAL_CLIENT_SECRET')}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`PayPal auth: ${j.error_description || r.status}`);
  ppToken = { v: j.access_token, exp: Date.now() + (j.expires_in || 300) * 1000 };
  return ppToken.v;
}
async function pp(path, body, requestId) {
  const r = await fetch(`${paypalBase()}${path}`, { method: 'POST', body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000),
    headers: { authorization: `Bearer ${await paypalToken()}`, 'content-type': 'application/json', ...(requestId ? { 'paypal-request-id': requestId } : {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`PayPal: ${j.message || j.name || r.status}`);
  return j;
}

export async function paypalCheckout(order, { returnUrl, cancelUrl }) {
  if (!paypalEnabled()) throw new Error('PayPal is not configured');
  const j = await pp('/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [{ reference_id: order.number, custom_id: order.id, description: `${config.profile.brand} order ${order.number}`, amount: { currency_code: order.currency, value: (order.total - order.paid).toFixed(2) } }],
    application_context: { brand_name: config.profile.brand, user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING', return_url: returnUrl, cancel_url: cancelUrl },
  }, `create-${order.id}-${intentsFor(order.id).length}`);
  const approve = (j.links || []).find((l) => l.rel === 'approve' || l.rel === 'payer-action')?.href;
  if (!approve) throw new Error('PayPal: no approval link');
  saveIntent(order, 'paypal', j.id, { id: j.id });
  logEvent('order', order.id, 'payment_started', { actor: 'customer', note: `paypal ${j.id}` });
  return approve;
}

/** Called when the buyer returns from PayPal: capture server-side, then book. */
export async function paypalCapture(paypalOrderId) {
  const intent = intentByRef('paypal', paypalOrderId);
  if (!intent) return { result: 'unknown_order' };
  if (intent.status === 'paid') return { result: 'duplicate', orderId: intent.order_id };
  const j = await pp(`/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, null, `capture-${paypalOrderId}`);
  const cap = j.purchase_units?.[0]?.payments?.captures?.[0];
  if (j.status !== 'COMPLETED' || !cap || cap.status !== 'COMPLETED') {
    db.prepare("UPDATE payment_intents SET status = ?, updated_at = ? WHERE id = ?").run(`capture_${String(cap?.status || j.status).toLowerCase()}`, now(), intent.id);
    return { result: 'not_completed', orderId: intent.order_id };
  }
  return { result: settle(intent, { amount: Number(cap.amount.value), currency: cap.amount.currency_code, ref: cap.id, provider: 'paypal' }), orderId: intent.order_id };
}
