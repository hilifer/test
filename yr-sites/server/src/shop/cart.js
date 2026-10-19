// Shopping cart (guest via cookie, merged into the account on login). Prices, MOQ and stock are always
// recomputed on the server from the published catalog — nothing the browser sends is trusted.
import { randomBytes } from 'node:crypto';
import { db } from '../db.js';
import { config } from '../config.js';
import { stockView, getSku } from '../ops/service.js';
import './schema.js';

const now = () => new Date().toISOString();
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const MAX_QTY = 100000;

/** Live catalog lookup: the SKU must belong to a published product that is sold online. */
export function sellable(sku) {
  for (const p of config.catalog.products) {
    const v = (p.variants || []).find((x) => x.sku === sku);
    if (v) return p.salesMode !== 'inquiry' && v.price > 0 ? { product: p, variant: v } : null;
  }
  return null;
}
/** Unit price for a quantity: the highest tier the quantity reaches, otherwise the base price. */
export function unitPrice(variant, qty) {
  let price = variant.price;
  for (const t of variant.tiers || []) if (qty >= t.minQty) price = t.price;
  return price;
}
export const availableBySku = () => new Map(stockView().map((s) => [s.sku, s.available]));

export function getCart(id) { return (id && db.prepare('SELECT * FROM carts WHERE id = ? AND converted_order_id IS NULL').get(id)) || null; }
export function createCart(customerId = null) {
  const id = randomBytes(18).toString('base64url');
  db.prepare('INSERT INTO carts (id, customer_id, created_at, updated_at) VALUES (?,?,?,?)').run(id, customerId, now(), now());
  return getCart(id);
}
/** The customer's open cart (if logged in), else the cookie cart, else a new one. */
export function resolveCart(cookieId, customer) {
  if (customer) {
    let mine = db.prepare('SELECT * FROM carts WHERE customer_id = ? AND converted_order_id IS NULL ORDER BY updated_at DESC LIMIT 1').get(customer.id);
    const guest = getCart(cookieId);
    if (guest && !guest.customer_id && (!mine || guest.id !== mine.id)) {
      if (!mine) { db.prepare('UPDATE carts SET customer_id = ? WHERE id = ?').run(customer.id, guest.id); return getCart(guest.id); }
      mergeInto(guest.id, mine.id);
    }
    return mine || createCart(customer.id);
  }
  const c = getCart(cookieId);
  return c && !c.customer_id ? c : null;
}
function mergeInto(fromId, toId) {
  for (const it of db.prepare('SELECT * FROM cart_items WHERE cart_id = ?').all(fromId)) {
    db.prepare('INSERT INTO cart_items (cart_id, sku, qty, added_at) VALUES (?,?,?,?) ON CONFLICT(cart_id, sku) DO UPDATE SET qty = MIN(?, cart_items.qty + excluded.qty)').run(toId, it.sku, it.qty, it.added_at, MAX_QTY);
  }
  db.prepare('DELETE FROM cart_items WHERE cart_id = ?').run(fromId);
  db.prepare('DELETE FROM carts WHERE id = ?').run(fromId);
  db.prepare('UPDATE carts SET updated_at = ? WHERE id = ?').run(now(), toId);
}

/** Add (or with set:true replace) a quantity. Below-MOQ quantities are raised to the MOQ. */
export function setItem(cartId, sku, qty, { set = false } = {}) {
  const s = sellable(String(sku || ''));
  if (!s) throw Object.assign(new Error('not_available'), { code: 'not_available' });
  let q = Math.floor(Number(qty));
  if (!Number.isFinite(q)) throw Object.assign(new Error('bad_qty'), { code: 'bad_qty' });
  const cur = db.prepare('SELECT qty FROM cart_items WHERE cart_id = ? AND sku = ?').get(cartId, sku)?.qty || 0;
  if (!set) q += cur;
  if (q <= 0) { db.prepare('DELETE FROM cart_items WHERE cart_id = ? AND sku = ?').run(cartId, sku); return { qty: 0 }; }
  q = Math.min(Math.max(q, s.variant.minQty || 1), MAX_QTY);
  db.prepare('INSERT INTO cart_items (cart_id, sku, qty, added_at) VALUES (?,?,?,?) ON CONFLICT(cart_id, sku) DO UPDATE SET qty = excluded.qty').run(cartId, sku, q, now());
  db.prepare('UPDATE carts SET updated_at = ? WHERE id = ?').run(now(), cartId);
  return { qty: q, raisedToMoq: q === (s.variant.minQty || 1) && Number(qty) + (set ? 0 : cur) < q };
}
export const removeItem = (cartId, sku) => db.prepare('DELETE FROM cart_items WHERE cart_id = ? AND sku = ?').run(cartId, sku);

/** Full priced view. problems: not_available | out_of_stock | no_weight */
export function viewCart(cartId) {
  const rows = cartId ? db.prepare('SELECT * FROM cart_items WHERE cart_id = ? ORDER BY added_at').all(cartId) : [];
  const avail = availableBySku();
  let subtotal = 0, weightKg = 0, cbm = 0;
  const items = rows.map((r) => {
    const s = sellable(r.sku);
    if (!s) return { sku: r.sku, qty: r.qty, problems: ['not_available'] };
    const { product: p, variant: v } = s;
    const unit = unitPrice(v, r.qty);
    const line = r2(unit * r.qty);
    const problems = [];
    const available = avail.get(r.sku) ?? 0;
    if (r.qty > available) problems.push('out_of_stock');
    if (v.weightKg == null) problems.push('no_weight');
    subtotal += line;
    weightKg += (v.weightKg || 0) * r.qty;
    const k = getSku(r.sku);
    if (k?.pcs_per_carton && k?.carton_cbm) cbm += Math.ceil(r.qty / k.pcs_per_carton) * k.carton_cbm;
    return { sku: r.sku, productId: p.id, slug: p.slug, name: p.name, nameZh: p.nameZh, label: v.label, image: v.image || p.image || null, qty: r.qty, minQty: v.minQty || 1,
      unitPrice: unit, basePrice: v.price, lineTotal: line, available, unit: p.unit || 'pcs', problems };
  });
  return { items, count: items.reduce((a, i) => a + (i.problems.includes('not_available') ? 0 : 1), 0), subtotal: r2(subtotal), weightKg: r2(weightKg), cbm: r2(cbm),
    currency: config.catalog.currency || 'USD', ok: items.length > 0 && items.every((i) => !i.problems.length) };
}
