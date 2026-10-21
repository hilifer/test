// Marketing: coupons, verified-buyer reviews (moderated), wishlist, related products, search, abandoned-cart
// reminders (opt-in only), low-stock alerts and the operations dashboard numbers.
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { config } from '../config.js';
import { migrate } from '../migrate.js';
import { getCustomer, stockView } from '../ops/service.js';
import { actorName } from '../auth.js';
import { sendMail } from './mailer.js';
import { viewCart } from './cart.js';
import { alertOps } from '../alerts.js';
import './schema.js';
import { registerJob, every } from '../jobs.js';

migrate([{
  id: '2026-10-23-marketing',
  up: () => db.exec(`
    CREATE TABLE coupons (code TEXT PRIMARY KEY, kind TEXT, value REAL, min_subtotal REAL DEFAULT 0, max_uses INTEGER, per_customer INTEGER DEFAULT 1,
      starts_at TEXT, ends_at TEXT, categories TEXT DEFAULT '[]', active INTEGER DEFAULT 1, note TEXT, created_at TEXT, created_by TEXT);
    CREATE TABLE reviews (id TEXT PRIMARY KEY, product_id TEXT, customer_id TEXT, order_id TEXT, rating INTEGER, title TEXT, body TEXT, status TEXT,
      reply TEXT, created_at TEXT, moderated_by TEXT, moderated_at TEXT);
    CREATE UNIQUE INDEX idx_review_once ON reviews(product_id, customer_id);
    CREATE TABLE wishlist (customer_id TEXT, product_id TEXT, added_at TEXT, PRIMARY KEY (customer_id, product_id));
    CREATE TABLE cart_reminders (cart_id TEXT PRIMARY KEY, sent_at TEXT);`),
}]);

const now = () => new Date().toISOString();
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const J = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

// ---------------------------------------------------------------- coupons
export const listCoupons = () => db.prepare('SELECT * FROM coupons ORDER BY created_at DESC').all().map((c) => ({ ...c, categories: J(c.categories, []), used: couponUses(c.code) }));
const couponUses = (code, customerId = null) => db.prepare(`SELECT COUNT(*) n FROM orders WHERE coupon = ? AND status != 'cancelled' ${customerId ? 'AND customer_id = ?' : ''}`).get(...[code, customerId].filter(Boolean)).n;

export function saveCoupon(c) {
  const code = String(c.code || '').trim().toUpperCase();
  const errors = [];
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) errors.push('券码：3–32 位字母、数字、横线或下划线');
  if (!['percent', 'fixed'].includes(c.kind)) errors.push('类型无效');
  const value = Number(c.value);
  if (!(value > 0) || (c.kind === 'percent' && value > 90)) errors.push('优惠值必须大于 0，百分比不超过 90');
  const num = (v) => (v === '' || v == null ? null : Number(v));
  const row = { code, kind: c.kind, value, min_subtotal: num(c.min_subtotal) || 0, max_uses: num(c.max_uses), per_customer: num(c.per_customer) ?? 1,
    starts_at: c.starts_at || null, ends_at: c.ends_at || null, categories: JSON.stringify(String(c.categories || '').split(/[\s,，]+/).filter(Boolean)), active: c.active === false || c.active === '0' ? 0 : 1, note: String(c.note || '').slice(0, 200) };
  if (row.starts_at && row.ends_at && row.starts_at > row.ends_at) errors.push('开始时间不能晚于结束时间');
  if (errors.length) throw Object.assign(new Error(errors.join('；')), { errors });
  db.prepare(`INSERT INTO coupons (code, kind, value, min_subtotal, max_uses, per_customer, starts_at, ends_at, categories, active, note, created_at, created_by)
    VALUES (@code,@kind,@value,@min_subtotal,@max_uses,@per_customer,@starts_at,@ends_at,@categories,@active,@note,@ts,@by)
    ON CONFLICT(code) DO UPDATE SET kind=@kind, value=@value, min_subtotal=@min_subtotal, max_uses=@max_uses, per_customer=@per_customer, starts_at=@starts_at, ends_at=@ends_at, categories=@categories, active=@active, note=@note`)
    .run({ ...row, ts: now(), by: actorName('system') });
  return code;
}

/**
 * Validate a coupon for a cart. cart = viewCart(...), customer may be null (guest: per-customer limit uses the e-mail's customer).
 * Returns { code, discount } or throws Error with a customer-facing message.
 */
export function applyCoupon(codeIn, cart, { customerId = null, lang = 'en' } = {}) {
  const zh = lang === 'zh';
  const code = String(codeIn || '').trim().toUpperCase();
  const c = db.prepare('SELECT * FROM coupons WHERE code = ?').get(code);
  const fail = (en, cn) => { throw Object.assign(new Error(zh ? cn : en), { code: 'coupon' }); };
  if (!c || !c.active) fail('This coupon code is not valid.', '优惠码无效。');
  const t = now();
  if ((c.starts_at && t < c.starts_at) || (c.ends_at && t > c.ends_at)) fail('This coupon has expired or is not active yet.', '优惠码不在有效期内。');
  if (c.max_uses != null && couponUses(code) >= c.max_uses) fail('This coupon has been fully used.', '优惠码已被领完。');
  if (customerId && c.per_customer != null && couponUses(code, customerId) >= c.per_customer) fail('You have already used this coupon.', '您已使用过该优惠码。');
  const cats = J(c.categories, []);
  const eligible = cart.items.filter((i) => !cats.length || cats.includes(config.catalog.products.find((p) => p.id === i.productId)?.category));
  const base = r2(eligible.reduce((a, i) => a + i.lineTotal, 0));
  if (!base) fail('This coupon does not apply to the items in your cart.', '购物车中没有适用该优惠码的商品。');
  if (cart.subtotal < c.min_subtotal) fail(`Spend at least ${c.min_subtotal} to use this coupon.`, `满 ${c.min_subtotal} 才能使用该优惠码。`);
  const discount = r2(Math.min(base, c.kind === 'percent' ? base * c.value / 100 : c.value));
  return { code, discount };
}

// ---------------------------------------------------------------- reviews (verified buyers only, moderated)
/** Products the customer bought in a delivered / completed order (eligible to review). */
export function reviewableProducts(customerId) {
  const out = new Map();
  for (const o of db.prepare("SELECT id, lines FROM orders WHERE customer_id = ? AND status IN ('delivered','completed')").all(customerId))
    for (const l of J(o.lines, [])) {
      const p = config.catalog.products.find((x) => (x.variants || []).some((v) => v.sku === l.sku) || x.id === l.sku);
      if (p && !out.has(p.id)) out.set(p.id, { productId: p.id, name: p.name, orderId: o.id });
    }
  const done = new Set(db.prepare('SELECT product_id FROM reviews WHERE customer_id = ?').all(customerId).map((r) => r.product_id));
  return [...out.values()].filter((x) => !done.has(x.productId));
}
export function submitReview(customerId, { productId, rating, title = '', body = '' }, lang = 'en') {
  const zh = lang === 'zh';
  const ok = reviewableProducts(customerId).find((x) => x.productId === productId);
  if (!ok) throw new Error(zh ? '只有已签收订单中的商品才能评价，每个商品评价一次。' : 'You can review products from delivered orders, once per product.');
  const r = Math.round(Number(rating));
  if (!(r >= 1 && r <= 5)) throw new Error(zh ? '请选择 1–5 星' : 'Please choose 1–5 stars');
  if (String(body).trim().length < 10) throw new Error(zh ? '评价内容至少 10 个字' : 'Please write at least 10 characters');
  const id = randomUUID();
  db.prepare('INSERT INTO reviews (id, product_id, customer_id, order_id, rating, title, body, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, productId, customerId, ok.orderId, r, String(title).trim().slice(0, 120), String(body).trim().slice(0, 3000), 'pending', now());
  alertOps('新的商品评价待审核', [`${productId} · ${r} 星`, String(body).slice(0, 120)]).catch(() => {});
  return id;
}
export function moderateReview(id, status, reply = '') {
  if (!['approved', 'rejected', 'pending'].includes(status)) throw new Error('状态无效');
  const r = db.prepare('SELECT * FROM reviews WHERE id = ?').get(id);
  if (!r) throw new Error('评价不存在');
  db.prepare('UPDATE reviews SET status = ?, reply = ?, moderated_by = ?, moderated_at = ? WHERE id = ?').run(status, String(reply || '').slice(0, 2000) || null, actorName('system'), now(), id);
}
export const listReviews = (status = '') => db.prepare(`SELECT r.*, c.email, c.contact FROM reviews r LEFT JOIN customers c ON c.id = r.customer_id ${status ? 'WHERE r.status = ?' : ''} ORDER BY r.created_at DESC`).all(...(status ? [status] : []));
export function publicReviews(productId) {
  const rows = db.prepare("SELECT r.rating, r.title, r.body, r.reply, r.created_at, c.contact, c.country FROM reviews r LEFT JOIN customers c ON c.id = r.customer_id WHERE r.product_id = ? AND r.status = 'approved' ORDER BY r.created_at DESC LIMIT 50").all(productId);
  const count = rows.length;
  // first name + country initial only, never the e-mail
  return { count, average: count ? r2(rows.reduce((a, r) => a + r.rating, 0) / count) : null,
    reviews: rows.map((r) => ({ rating: r.rating, title: r.title, body: r.body, reply: r.reply, date: r.created_at.slice(0, 10), author: `${String(r.contact || 'Verified buyer').split(/\s+/)[0]}${r.country ? ` · ${r.country}` : ''}` })) };
}

// ---------------------------------------------------------------- wishlist
export const wishlist = (cid) => db.prepare('SELECT product_id FROM wishlist WHERE customer_id = ? ORDER BY added_at DESC').all(cid).map((r) => config.catalog.products.find((p) => p.id === r.product_id)).filter(Boolean);
export function toggleWishlist(cid, productId) {
  if (!config.catalog.products.some((p) => p.id === productId)) throw new Error('not_found');
  const has = db.prepare('SELECT 1 FROM wishlist WHERE customer_id = ? AND product_id = ?').get(cid, productId);
  if (has) db.prepare('DELETE FROM wishlist WHERE customer_id = ? AND product_id = ?').run(cid, productId);
  else db.prepare('INSERT INTO wishlist (customer_id, product_id, added_at) VALUES (?,?,?)').run(cid, productId, now());
  return !has;
}

// ---------------------------------------------------------------- search & related
export function searchShop({ q = '', category = '', cert = '', minPrice = null, maxPrice = null, sort = 'relevance' } = {}) {
  const words = String(q).toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  let list = config.catalog.products.map((p) => {
    const prices = (p.variants || []).map((v) => v.price).filter((x) => x > 0);
    const hay = [p.id, p.name, p.nameZh, p.summary, p.category, ...(p.keywords || []), ...(p.applications || []), ...p.certifications].join(' ').toLowerCase();
    const score = words.reduce((a, w) => a + (String(p.name).toLowerCase().includes(w) ? 3 : hay.includes(w) ? 1 : 0), 0);
    return { p, price: prices.length ? Math.min(...prices) : null, score };
  });
  if (words.length) list = list.filter((x) => x.score > 0);
  if (category) list = list.filter((x) => x.p.category === category);
  if (cert) list = list.filter((x) => x.p.certifications.some((c) => c.toLowerCase().includes(String(cert).toLowerCase())));
  if (minPrice != null && minPrice !== '') list = list.filter((x) => x.price != null && x.price >= Number(minPrice));
  if (maxPrice != null && maxPrice !== '') list = list.filter((x) => x.price != null && x.price <= Number(maxPrice));
  const by = { price_asc: (a, b) => (a.price ?? 1e12) - (b.price ?? 1e12), price_desc: (a, b) => (b.price ?? -1) - (a.price ?? -1), name: (a, b) => a.p.name.localeCompare(b.p.name), relevance: (a, b) => b.score - a.score };
  list.sort(by[sort] || by.relevance);
  return list.map(({ p, price }) => ({ id: p.id, slug: p.slug, name: p.name, nameZh: p.nameZh, summary: p.summary, image: p.image || null, category: p.category, price, salesMode: p.salesMode, certifications: p.certifications }));
}
export function related(productId, n = 4) {
  const p = config.catalog.products.find((x) => x.id === productId);
  if (!p) return [];
  // products bought together first, then same category
  const together = new Map();
  const skus = new Set((p.variants || []).map((v) => v.sku).concat(p.id));
  for (const o of db.prepare("SELECT lines FROM orders WHERE status != 'cancelled' ORDER BY created_at DESC LIMIT 500").all()) {
    const ls = J(o.lines, []);
    if (!ls.some((l) => skus.has(l.sku))) continue;
    for (const l of ls) { const q = config.catalog.products.find((x) => x.id !== p.id && ((x.variants || []).some((v) => v.sku === l.sku) || x.id === l.sku)); if (q) together.set(q.id, (together.get(q.id) || 0) + 1); }
  }
  const ranked = [...together].sort((a, b) => b[1] - a[1]).map(([id]) => config.catalog.products.find((x) => x.id === id));
  const same = config.catalog.products.filter((x) => x.id !== p.id && x.category === p.category);
  return [...new Set([...ranked, ...same])].slice(0, n).map((x) => ({ id: x.id, slug: x.slug, name: x.name, nameZh: x.nameZh, image: x.image || null, summary: x.summary }));
}

// ---------------------------------------------------------------- abandoned carts (marketing opt-in only)
export async function remindAbandonedCarts({ olderThanHours = 24 } = {}) {
  const cutoff = new Date(Date.now() - olderThanHours * 3600e3).toISOString();
  const rows = db.prepare(`SELECT ca.id, ca.customer_id FROM carts ca JOIN customers cu ON cu.id = ca.customer_id
    WHERE ca.converted_order_id IS NULL AND ca.updated_at < ? AND ca.updated_at > ? AND cu.marketing_opt_in = 1
    AND NOT EXISTS (SELECT 1 FROM cart_reminders r WHERE r.cart_id = ca.id) AND EXISTS (SELECT 1 FROM cart_items i WHERE i.cart_id = ca.id)`).all(cutoff, new Date(Date.now() - 14 * 864e5).toISOString());
  let sent = 0;
  for (const r of rows) {
    const v = viewCart(r.id);
    if (!v.count) continue;
    const c = getCustomer(r.customer_id);
    await sendMail(c.email, `${config.profile.brand}: you left something in your cart`, `Hi ${c.contact || ''},\n\nYour cart still has ${v.items.map((i) => `${i.qty} × ${i.name}`).join(', ')} (${v.currency} ${v.subtotal}).\nComplete your order: ${config.publicBaseUrl}/shop/cart\n\nPrices and stock are confirmed at checkout. You receive this because you opted in to updates; reply "unsubscribe" to stop.`);
    db.prepare('INSERT INTO cart_reminders (cart_id, sent_at) VALUES (?,?)').run(r.id, now());
    sent++;
  }
  return sent;
}

// ---------------------------------------------------------------- operations dashboard
export function dashboardStats({ days = 30, lowStock = 20 } = {}) {
  const since = (d) => new Date(Date.now() - d * 864e5).toISOString();
  const money = (sql, ...a) => r2(db.prepare(sql).get(...a).v || 0);
  const paidOrders = "status NOT IN ('cancelled','pending_payment','awaiting_deposit')";
  const kpi = (d) => ({
    gmv: money(`SELECT SUM(total) v FROM orders WHERE ${paidOrders} AND created_at >= ?`, since(d)),
    orders: db.prepare(`SELECT COUNT(*) n FROM orders WHERE ${paidOrders} AND created_at >= ?`).get(since(d)).n,
    shopOrders: db.prepare(`SELECT COUNT(*) n FROM orders WHERE channel = 'shop' AND created_at >= ?`).get(since(d)).n,
    carts: db.prepare('SELECT COUNT(*) n FROM carts WHERE created_at >= ?').get(since(d)).n,
  });
  const k1 = kpi(1), k7 = kpi(7), k30 = kpi(days);
  const daily = db.prepare(`SELECT substr(created_at, 1, 10) d, SUM(total) v, COUNT(*) n FROM orders WHERE ${paidOrders} AND created_at >= ? GROUP BY d ORDER BY d`).all(since(days));
  const top = new Map();
  for (const o of db.prepare(`SELECT lines FROM orders WHERE ${paidOrders} AND created_at >= ?`).all(since(days))) for (const l of J(o.lines, [])) { const t = top.get(l.sku) || { sku: l.sku, name: l.name, qty: 0, revenue: 0 }; t.qty += l.qty; t.revenue = r2(t.revenue + l.amount); top.set(l.sku, t); }
  return {
    today: k1, week: k7, month: { ...k30, aov: k30.orders ? r2(k30.gmv / k30.orders) : 0, conversion: k30.carts ? r2((k30.shopOrders / k30.carts) * 100) : 0 },
    daily, top: [...top.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 10),
    lowStock: stockView().filter((s) => s.active && s.price != null && s.available < lowStock).map((s) => ({ sku: s.sku, name: s.name, available: s.available })),
    todo: {
      unpaid: db.prepare("SELECT COUNT(*) n FROM orders WHERE status = 'pending_payment'").get().n,
      toShip: db.prepare("SELECT COUNT(*) n FROM orders WHERE status = 'ready_to_ship'").get().n,
      rma: db.prepare("SELECT COUNT(*) n FROM rmas WHERE status IN ('submitted','reviewing')").get().n,
      reviews: db.prepare("SELECT COUNT(*) n FROM reviews WHERE status = 'pending'").get().n,
    },
  };
}

export function startMarketingJobs() {
  registerJob({ id: 'cart-reminders', name: '弃购提醒邮件', schedule: every(3600e3, { initialDelay: 3600e3 }), quiet: true, run: async () => { const r = await remindAbandonedCarts(); return r == null ? null : String(typeof r === 'object' ? (r.sent ?? JSON.stringify(r)) : r); } });
}
