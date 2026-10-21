// Refunds back to the original payment method: Stripe Refunds API, PayPal capture refund, or a manual bank refund.
// Never more than what was received; each refund is idempotent at the provider; every refund is logged.
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { migrate, addColumn } from '../migrate.js';
import { getOrder, recordPayment, setRmaStatus, getRma, getCustomer, logEvent } from '../ops/service.js';
import { actorName } from '../auth.js';
import { sendMail } from './mailer.js';
import { config } from '../config.js';
import { gate } from '../gate.js';
import './schema.js';

migrate([{
  id: '2026-10-22-refunds',
  up: () => {
    addColumn('payment_intents', 'capture_ref', 'TEXT');
    db.exec('CREATE TABLE refunds (id TEXT PRIMARY KEY, order_id TEXT, rma_id TEXT, provider TEXT, provider_ref TEXT, amount REAL, currency TEXT, status TEXT, reason TEXT, actor TEXT, created_at TEXT, error TEXT)');
  },
}]);

const env = (k, d = '') => process.env[k] || d;
const cents = (n) => Math.round(Number(n) * 100);
export const refundsFor = (orderId) => db.prepare('SELECT * FROM refunds WHERE order_id = ? ORDER BY created_at').all(orderId);

async function stripeRefund(paymentIntent, amount, idem) {
  const r = await fetch(`${env('STRIPE_API_BASE', 'https://api.stripe.com')}/v1/refunds`, {
    method: 'POST', signal: AbortSignal.timeout(20000),
    headers: { authorization: `Bearer ${env('STRIPE_SECRET_KEY')}`, 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': idem },
    body: new URLSearchParams({ payment_intent: paymentIntent, amount: String(cents(amount)) }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.id) throw new Error(`Stripe 退款失败：${j.error?.message || r.status}`);
  return j.id;
}
async function paypalRefund(captureId, amount, currency, idem) {
  const tok = await fetch(`${env('PAYPAL_API_BASE', 'https://api-m.sandbox.paypal.com')}/v1/oauth2/token`, { method: 'POST', body: 'grant_type=client_credentials', headers: { authorization: 'Basic ' + Buffer.from(`${env('PAYPAL_CLIENT_ID')}:${env('PAYPAL_CLIENT_SECRET')}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' } }).then((r) => r.json());
  const r = await fetch(`${env('PAYPAL_API_BASE', 'https://api-m.sandbox.paypal.com')}/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
    method: 'POST', signal: AbortSignal.timeout(20000),
    headers: { authorization: `Bearer ${tok.access_token}`, 'content-type': 'application/json', 'paypal-request-id': idem },
    body: JSON.stringify({ amount: { value: Number(amount).toFixed(2), currency_code: currency } }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.id) throw new Error(`PayPal 退款失败：${j.message || j.name || r.status}`);
  return j.id;
}

/** Refund an order (optionally for an RMA). method: 'auto' = back to the online payment if there was one, else manual. */
export async function refundOrder(orderId, { amount, reason = '', rmaId = null, method = 'auto' } = {}) {
  const o = getOrder(orderId);
  if (!o) throw new Error('订单不存在');
  const amt = Math.round(Number(amount) * 100) / 100;
  if (!(amt > 0)) throw new Error('退款金额必须大于 0');
  if (amt > o.paid + 0.001) throw new Error(`退款金额不能超过已收金额 ${o.currency} ${o.paid}`);
  gate('refund', { ref: o.id, label: `订单 ${o.number} 退款`, amount: amt, currency: o.currency, detail: `${o.currency} ${amt}${reason ? ` · ${String(reason).slice(0, 100)}` : ''}` });
  const intent = db.prepare("SELECT * FROM payment_intents WHERE order_id = ? AND status = 'paid' ORDER BY updated_at DESC LIMIT 1").get(o.id);
  const id = randomUUID();
  const provider = method === 'manual' || !intent ? 'manual' : intent.provider;
  db.prepare('INSERT INTO refunds (id, order_id, rma_id, provider, amount, currency, status, reason, actor, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, o.id, rmaId, provider, amt, o.currency, 'pending', String(reason).slice(0, 500), actorName('system'), new Date().toISOString());
  let ref = '';
  try {
    if (provider === 'stripe') ref = await stripeRefund(intent.capture_ref, amt, `refund-${id}`);
    else if (provider === 'paypal') ref = await paypalRefund(intent.capture_ref, amt, o.currency, `refund-${id}`);
    else ref = 'manual';
  } catch (e) {
    db.prepare("UPDATE refunds SET status = 'failed', error = ? WHERE id = ?").run(e.message.slice(0, 500), id);
    throw e;
  }
  db.prepare("UPDATE refunds SET status = 'done', provider_ref = ? WHERE id = ?").run(ref, id);
  recordPayment(o.id, { kind: 'refund', amount: amt, ref: `${provider} ${ref}`.trim() });
  if (rmaId) {
    const r = getRma(rmaId);
    if (r && ['approved', 'in_progress'].includes(r.status)) setRmaStatus(rmaId, 'resolved', { resolution: 'refund', note: `退款 ${o.currency} ${amt}` });
  }
  logEvent('order', o.id, 'refund', { note: `${provider} ${o.currency} ${amt} ${reason}`.trim() });
  const c = getCustomer(o.customer_id);
  sendMail(c.email, `${config.profile.brand}: refund for ${o.number}`, `We have refunded ${o.currency} ${amt} for order ${o.number}${provider === 'manual' ? ' by bank transfer' : ' to your original payment method'}. It can take 5–10 business days to appear on your statement.`).catch(() => {});
  return { id, provider, ref, amount: amt };
}
