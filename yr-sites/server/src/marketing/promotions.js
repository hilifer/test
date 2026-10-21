// Automatic promotions (限时折扣 / 满减): start and end on their own at the set times, no code needed.
// - percent: X % off the eligible items (all products, some categories or some products) — a flash sale.
// - threshold: spend at least T on eligible items, get A off (满减).
// The cart and checkout apply the best promotion running at that moment (on top of a coupon, never more than the
// subtotal). Product pages show a badge, and the home page shows the running sales in a "promotion zone".
import { db } from '../db.js';
import { config } from '../config.js';
import { migrate, addColumn } from '../migrate.js';
import { actorName } from '../auth.js';
import '../ops/service.js'; // orders / leads tables exist before the columns below are added

migrate([{
  id: '2026-11-06-promotions',
  up: () => {
    db.exec(`CREATE TABLE promotions (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, name_en TEXT, kind TEXT NOT NULL, value REAL NOT NULL, threshold REAL DEFAULT 0,
      products TEXT DEFAULT '[]', categories TEXT DEFAULT '[]', starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, active INTEGER DEFAULT 1, created_by TEXT, created_at TEXT);`);
    addColumn('orders', 'promotion', 'TEXT');
  },
}]);
export const KINDS = { percent: '限时折扣（打折）', threshold: '满减' };
const J = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const r2 = (x) => Math.round(x * 100) / 100;
const row = (p) => p && { ...p, products: J(p.products, []), categories: J(p.categories, []) };
const list = (s) => [...new Set(String(s || '').split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean))];

export const listPromotions = () => db.prepare('SELECT * FROM promotions ORDER BY starts_at DESC').all().map(row);
export const getPromotion = (id) => row(db.prepare('SELECT * FROM promotions WHERE id = ?').get(Number(id)));
export function promoState(p, t = new Date().toISOString()) { return !p.active ? 'off' : t < p.starts_at ? 'scheduled' : t > p.ends_at ? 'ended' : 'running'; }
export const STATES = { running: '进行中', scheduled: '未开始', ended: '已结束', off: '已停用' };

export function savePromotion(f) {
  const name = String(f.name || '').trim();
  if (!name) throw new Error('活动名称必填');
  if (!KINDS[f.kind]) throw new Error('活动类型无效');
  const value = Number(f.value), threshold = Number(f.threshold || 0);
  if (f.kind === 'percent' && !(value > 0 && value < 100)) throw new Error('折扣须在 1–99 之间（例如 15 表示减 15%）');
  if (f.kind === 'threshold' && !(value > 0 && threshold > value)) throw new Error('满减须填写门槛和减免金额，且门槛大于减免金额');
  const s = new Date(f.starts_at), e = new Date(f.ends_at);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) throw new Error('请填写开始和结束时间');
  if (e <= s) throw new Error('结束时间必须晚于开始时间');
  const products = list(f.products), categories = list(f.categories);
  const known = new Set(config.catalog.products.map((p) => p.id));
  const unknown = products.filter((p) => !known.has(p));
  if (unknown.length) throw new Error(`商品不存在：${unknown.join('、')}`);
  const vals = [name.slice(0, 60), String(f.name_en || '').trim().slice(0, 60) || null, f.kind, value, threshold, JSON.stringify(products), JSON.stringify(categories), s.toISOString(), e.toISOString(), f.active === false || f.active === '0' ? 0 : 1];
  if (f.id) { db.prepare('UPDATE promotions SET name=?, name_en=?, kind=?, value=?, threshold=?, products=?, categories=?, starts_at=?, ends_at=?, active=? WHERE id=?').run(...vals, Number(f.id)); return Number(f.id); }
  return Number(db.prepare('INSERT INTO promotions (name, name_en, kind, value, threshold, products, categories, starts_at, ends_at, active, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(...vals, actorName('system'), new Date().toISOString()).lastInsertRowid);
}
export const setPromotionActive = (id, on) => db.prepare('UPDATE promotions SET active = ? WHERE id = ?').run(on ? 1 : 0, Number(id));

const categoryOf = (pid) => config.catalog.products.find((p) => p.id === pid)?.category;
const covers = (p, productId) => (!p.products.length && !p.categories.length) || p.products.includes(productId) || p.categories.includes(categoryOf(productId));
export const running = (t = new Date().toISOString()) => listPromotions().filter((p) => promoState(p, t) === 'running');
/** Customer-facing label. */
export function label(p, lang = 'en') {
  const name = lang === 'zh' ? p.name : p.name_en || p.name;
  if (p.kind === 'percent') return lang === 'zh' ? `${name}：${Math.round((100 - p.value)) / 10} 折` : `${name}: ${p.value}% off`;
  return lang === 'zh' ? `${name}：满 ${p.threshold} 减 ${p.value}` : `${name}: ${p.value} off orders over ${p.threshold}`;
}
/** The best running promotion for a cart (cart = viewCart(...)): { id, name, discount } or null. */
export function bestPromotion(cart, { lang = 'en', t } = {}) {
  let best = null;
  for (const p of running(t)) {
    const base = r2(cart.items.filter((i) => i.productId && covers(p, i.productId)).reduce((a, i) => a + i.lineTotal, 0));
    if (!base) continue;
    const discount = p.kind === 'percent' ? r2(base * p.value / 100) : base >= p.threshold ? p.value : 0;
    if (discount > 0 && (!best || discount > best.discount)) best = { id: p.id, name: label(p, lang), discount: Math.min(discount, base), ends_at: p.ends_at };
  }
  return best;
}
/** Running flash sales covering a product (for the product page badge). */
export function productBadge(productId, lang = 'en') {
  const p = running().filter((x) => covers(x, productId)).sort((a, b) => (b.kind === 'percent' ? b.value : 0) - (a.kind === 'percent' ? a.value : 0))[0];
  return p ? { label: label(p, lang), ends_at: p.ends_at, kind: p.kind, value: p.value } : null;
}
/** For the home page promotion zone: running promotions with their products. */
export function promoZone(lang = 'en') {
  return running().map((p) => ({ label: label(p, lang), ends_at: p.ends_at, products: (p.products.length ? p.products : config.catalog.products.filter((x) => covers(p, x.id)).map((x) => x.id)).slice(0, 8)
    .map((id) => config.catalog.products.find((x) => x.id === id)).filter(Boolean).map((x) => ({ id: x.id, name: lang === 'zh' ? x.nameZh || x.name : x.name, slug: x.slug, image: x.image || null })) }));
}
