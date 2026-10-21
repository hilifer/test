// Turning a cart into an order: re-price, check & reserve stock, freight, order record, unpaid expiry.
import { randomBytes, randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { config } from '../config.js';
import { addColumn, migrate } from '../migrate.js';
import { nextNumber, logEvent, getOrder, setOrderStatus, findOrCreateCustomer } from '../ops/service.js';
import { viewCart } from './cart.js';
import { quoteShipping } from './freight.js';
import { validateAddress } from './accounts.js';
import { alertOps } from '../alerts.js';
import { applyCoupon } from './marketing.js';
import './schema.js';
import { registerJob, every } from '../jobs.js';
import { bestPromotion } from '../marketing/promotions.js';

migrate([{ id: '2026-10-21-order-access', up: () => addColumn('orders', 'access_token', 'TEXT') }]);

const now = () => new Date().toISOString();
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const PAY_METHODS = ['stripe', 'paypal', 'tt'];
export const UNPAID_MINUTES = { stripe: 60, paypal: 60, tt: 72 * 60 };

export class CheckoutError extends Error { constructor(code, message, extra = {}) { super(message || code); this.code = code; Object.assign(this, extra); } }

/**
 * Place an order from a cart. All amounts are computed here. Runs in one IMMEDIATE transaction so two buyers
 * cannot both take the last units.
 * input = { cartId, customer?, email, address, zoneId, payment, note, lang }
 */
export function placeOrder({ cartId, customer = null, email, address, zoneId, payment, note = '', coupon = '', lang = 'en' }) {
  if (!PAY_METHODS.includes(payment)) throw new CheckoutError('bad_payment', 'Choose a payment method');
  const addr = validateAddress(address, lang);
  const mail = String(customer?.email || email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) throw new CheckoutError('bad_email', lang === 'zh' ? '请填写有效的邮箱' : 'Please enter a valid e-mail address');
  db.exec('BEGIN IMMEDIATE');
  try {
    const cart = viewCart(cartId);
    if (!cart.items.length) throw new CheckoutError('empty', 'Your cart is empty');
    const bad = cart.items.filter((i) => i.problems.length);
    if (bad.length) throw new CheckoutError('cart_problems', 'Some items need attention', { items: bad });
    const option = quoteShipping({ country: addr.country, weightKg: cart.weightKg, cbm: cart.cbm, subtotal: cart.subtotal }).find((o) => o.zoneId === Number(zoneId));
    if (!option) throw new CheckoutError('bad_shipping', lang === 'zh' ? '请选择可用的配送方式' : 'Please choose an available shipping method');
    const cust = customer || findOrCreateCustomer({ email: mail, contact: addr.name, company: addr.company, country: addr.country, phone: addr.phone, lang });
    const lines = cart.items.map((i) => ({ sku: i.sku, name: i.name, variant: i.label || '', unit: i.unit, qty: i.qty, unit_price: i.unitPrice, amount: i.lineTotal }));
    const promo = String(coupon || '').trim() ? applyCoupon(coupon, cart, { customerId: cust.id, lang }) : { code: null, discount: 0 };
    const auto = bestPromotion(cart, { lang }) || { discount: 0, name: null }; // automatic flash sale / spend-and-save, on top of a coupon
    const discount = r2(Math.min(cart.subtotal, promo.discount + auto.discount));
    const total = r2(cart.subtotal - discount + option.fee);
    const id = randomUUID();
    const number = nextNumber('order');
    const token = randomBytes(18).toString('base64url');
    const expires = new Date(Date.now() + UNPAID_MINUTES[payment] * 60e3).toISOString();
    db.prepare(`INSERT INTO orders (id, number, quote_id, customer_id, status, currency, lines, total, paid, deposit_due, incoterm, port, payment_terms, created_at, updated_at,
      channel, shipping_address, shipping_fee, shipping_method, subtotal, discount, coupon, payment_method, expires_at, customer_note, access_token)
      VALUES (?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,'shop',?,?,?,?,?,?,?,?,?,?)`).run(
      id, number, null, cust.id, 'pending_payment', cart.currency, JSON.stringify(lines), total, total, 'DAP', addr.city, 'tt100', now(), now(),
      JSON.stringify(addr), option.fee, `${option.name} (${option.days[0]}–${option.days[1]} days)`, cart.subtotal, discount, promo.code, payment, expires, String(note).slice(0, 1000), token);
    if (auto.name) db.prepare('UPDATE orders SET promotion = ? WHERE id = ?').run(auto.name, id);
    db.prepare('UPDATE carts SET converted_order_id = ? WHERE id = ?').run(id, cartId);
    db.exec('COMMIT');
    logEvent('order', id, 'created', { to: 'pending_payment', actor: 'customer', note: `${number} · ${payment}` });
    alertOps('网店新订单（待付款）', [`${number} · ${cart.currency} ${total}`, `客户：${mail} / ${addr.country}`, `付款方式：${payment}`]).catch(() => {});
    return { ...getOrder(id), access_token: token };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already committed or rolled back */ }
    throw e;
  }
}

export function orderByAccess(number, token) {
  const o = getOrder(String(number || ''));
  return o && o.channel === 'shop' && token && o.access_token === token ? o : null;
}
export const ordersOfCustomer = (cid) => db.prepare("SELECT id FROM orders WHERE customer_id = ? ORDER BY created_at DESC").all(cid).map((r) => getOrder(r.id));

/** Cancel unpaid shop orders whose payment window has passed (stock is released automatically). */
export function expireUnpaid() {
  const due = db.prepare("SELECT id, number FROM orders WHERE channel = 'shop' AND status = 'pending_payment' AND paid < 0.01 AND expires_at < ?").all(now());
  for (const o of due) setOrderStatus(o.id, 'cancelled', { actor: 'system', note: '超时未付款，自动取消并释放库存' });
  return due.length;
}
export function startShopJobs() {
  registerJob({ id: 'shop-expire', name: '超时未付款订单自动取消', schedule: every(60e3, { initialDelay: 60e3 }), quiet: true, run: () => String(expireUnpaid() || 0) });
}
