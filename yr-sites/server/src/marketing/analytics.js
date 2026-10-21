// First-party website analytics (运营数据) and campaign attribution (推广活动).
// - The site sends one small beacon per page view (/api/t). No third-party scripts, no personal data: a visitor is a daily
//   hash of IP + browser, so unique visitors are counted per day and cannot be followed across days.
// - Arriving through a campaign link (?utm_campaign=…) sets a first-party cookie for 30 days; inquiries and orders placed
//   while it is set are attributed to that campaign. Add-to-cart, checkout and orders are recorded on the server.
// - Campaigns: name, code (utm_campaign), channel, landing page, spend → visitors, inquiries, orders, revenue, ROI,
//   cost per lead and per customer.
import { createHash } from 'node:crypto';
import { db } from '../db.js';
import { config } from '../config.js';
import { migrate, addColumn } from '../migrate.js';
import { actorName } from '../auth.js';
import '../ops/service.js'; // orders / leads tables exist before the columns below are added

migrate([{
  id: '2026-11-06-analytics',
  up: () => {
    db.exec(`CREATE TABLE analytics_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, path TEXT, product_id TEXT, visitor TEXT,
        campaign TEXT, source TEXT, medium TEXT, ref_host TEXT, value REAL);
      CREATE INDEX ae_day ON analytics_events(day, kind);
      CREATE INDEX ae_product ON analytics_events(product_id, kind);
      CREATE INDEX ae_campaign ON analytics_events(campaign);
      CREATE TABLE campaigns (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, code TEXT UNIQUE NOT NULL, source TEXT, medium TEXT, landing TEXT, spend REAL DEFAULT 0,
        starts_at TEXT, ends_at TEXT, notes TEXT, created_by TEXT, created_at TEXT);`);
    addColumn('leads', 'campaign', 'TEXT');
    addColumn('orders', 'campaign', 'TEXT');
  },
}]);
export const CAMPAIGN_COOKIE = 'yr_cmp';
const now = () => new Date().toISOString();
const day = (iso = now()) => iso.slice(0, 10);
const clean = (s, n = 80) => String(s || '').replace(/[^\w.\-+ /:@]/g, '').slice(0, n);
export const visitorId = (ip, ua, d = day()) => createHash('sha256').update(`${ip}|${ua}|${d}|${config.site}`).digest('hex').slice(0, 16);

/** Record an event. kind: view | cart | checkout | order | lead. */
export function track(kind, { path = '', productId = '', visitor = '', campaign = '', source = '', medium = '', ref = '', value = null, ts = now() } = {}) {
  let refHost = '';
  try { refHost = ref ? new URL(ref).hostname : ''; } catch { /* not a URL */ }
  if (refHost && refHost === new URL(config.publicBaseUrl).hostname) refHost = '';
  db.prepare('INSERT INTO analytics_events (ts, day, kind, path, product_id, visitor, campaign, source, medium, ref_host, value) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(ts, day(ts), kind, String(path).slice(0, 200), clean(productId, 40) || null, visitor || null, clean(campaign) || null, clean(source, 40) || null, clean(medium, 40) || null, refHost.slice(0, 100) || null, value);
}
const BOT = /bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|bingpreview/i;

/** Campaign code from the request cookie (set when the visitor arrived through a campaign link). */
export const campaignOf = (c) => { const m = (c.req.header('cookie') || '').match(/(?:^|;\s*)yr_cmp=([^;]+)/); return m ? clean(decodeURIComponent(m[1])) : ''; };
const ipOf = (c) => (c.req.header('x-forwarded-for') || '').split(',')[0].trim() || c.env?.incoming?.socket?.remoteAddress || '';

export function mountTracking(app) {
  // one beacon per page view: { p: path, q: search, r: referrer, product }
  app.post('/api/t', async (c) => {
    const ua = c.req.header('user-agent') || '';
    if (BOT.test(ua)) return c.body(null, 204);
    const b = await c.req.json().catch(() => ({}));
    const path = String(b.p || '/').slice(0, 200);
    if (path.startsWith('/admin')) return c.body(null, 204);
    const q = new URLSearchParams(String(b.q || ''));
    const utm = { campaign: q.get('utm_campaign') || q.get('ref') || '', source: q.get('utm_source') || '', medium: q.get('utm_medium') || '' };
    const campaign = clean(utm.campaign) || campaignOf(c);
    track('view', { path, productId: b.product || '', visitor: visitorId(ipOf(c), ua), campaign, source: utm.source, medium: utm.medium, ref: String(b.r || '') });
    if (utm.campaign) c.header('set-cookie', `${CAMPAIGN_COOKIE}=${encodeURIComponent(clean(utm.campaign))}; Path=/; Max-Age=${30 * 86400}; SameSite=Lax${config.publicBaseUrl.startsWith('https://') ? '; Secure' : ''}`);
    return c.body(null, 204);
  });
}
/** Server-side events with the request's visitor and campaign. */
export function trackRequest(c, kind, extra = {}) {
  try { track(kind, { visitor: visitorId(ipOf(c), c.req.header('user-agent') || ''), campaign: campaignOf(c), path: c.req.path, ...extra }); } catch (e) { console.error('[analytics]', e.message); }
}

// ---------------------------------------------------------------- reports
const sinceDay = (days) => day(new Date(Date.now() - (days - 1) * 86400e3).toISOString());
const paidShopRevenue = (from, to = '9999') => db.prepare("SELECT COALESCE(SUM(total), 0) v, COUNT(*) n FROM orders WHERE channel = 'shop' AND paid >= total - 0.01 AND status != 'cancelled' AND substr(created_at, 1, 10) >= ? AND substr(created_at, 1, 10) <= ?").get(from, to);
/** Visitors → product views → carts → orders, for the last N days (1 = today). */
export function funnel(days = 1) {
  const from = sinceDay(days);
  const g = (sql, ...a) => db.prepare(sql).get(from, ...a);
  const visitors = g('SELECT COUNT(DISTINCT visitor || day) n FROM analytics_events WHERE day >= ? AND kind = ?', 'view').n;
  const views = g('SELECT COUNT(*) n FROM analytics_events WHERE day >= ? AND kind = ?', 'view').n;
  const productViews = g("SELECT COUNT(*) n FROM analytics_events WHERE day >= ? AND kind = 'view' AND product_id IS NOT NULL").n;
  const carts = g("SELECT COUNT(*) n FROM analytics_events WHERE day >= ? AND kind = 'cart'").n;
  const orders = db.prepare("SELECT COUNT(*) n FROM orders WHERE channel = 'shop' AND status != 'cancelled' AND substr(created_at, 1, 10) >= ?").get(from).n;
  const leads = db.prepare('SELECT COUNT(*) n FROM leads WHERE substr(created_at, 1, 10) >= ?').get(from).n;
  const paid = paidShopRevenue(from);
  return { visitors, views, productViews, carts, orders, leads, revenue: paid.v, paidOrders: paid.n, conversion: visitors ? orders / visitors : null, inquiryRate: visitors ? leads / visitors : null };
}
/** Per day for charts. */
export function dailySeries(days = 30) {
  const from = sinceDay(days);
  const rows = new Map(Array.from({ length: days }, (_, i) => { const d = day(new Date(Date.now() - (days - 1 - i) * 86400e3).toISOString()); return [d, { day: d, visitors: 0, views: 0, carts: 0, orders: 0, leads: 0, revenue: 0 }]; }));
  for (const r of db.prepare("SELECT day, COUNT(DISTINCT visitor) visitors, SUM(kind = 'view') views, SUM(kind = 'cart') carts FROM analytics_events WHERE day >= ? GROUP BY day").all(from)) Object.assign(rows.get(r.day) || {}, { visitors: r.visitors, views: r.views, carts: r.carts });
  for (const r of db.prepare("SELECT substr(created_at, 1, 10) d, COUNT(*) n, SUM(CASE WHEN paid >= total - 0.01 THEN total ELSE 0 END) v FROM orders WHERE channel = 'shop' AND status != 'cancelled' AND substr(created_at, 1, 10) >= ? GROUP BY d").all(from)) if (rows.has(r.d)) Object.assign(rows.get(r.d), { orders: r.n, revenue: r.v });
  for (const r of db.prepare('SELECT substr(created_at, 1, 10) d, COUNT(*) n FROM leads WHERE substr(created_at, 1, 10) >= ? GROUP BY d').all(from)) if (rows.has(r.d)) rows.get(r.d).leads = r.n;
  return [...rows.values()];
}
export function topPages(days = 30, n = 10) { return db.prepare("SELECT path, COUNT(*) views, COUNT(DISTINCT visitor) visitors FROM analytics_events WHERE kind = 'view' AND day >= ? GROUP BY path ORDER BY views DESC LIMIT ?").all(sinceDay(days), n); }
export function topSources(days = 30, n = 10) {
  return db.prepare(`SELECT COALESCE(source, ref_host, '直接访问') src, COUNT(DISTINCT visitor || day) visitors FROM analytics_events WHERE kind = 'view' AND day >= ? GROUP BY src ORDER BY visitors DESC LIMIT ?`).all(sinceDay(days), n);
}
/** Per product: views, carts, orders (units and order count), revenue, conversion — for the product list. */
export function productStats(days = 30) {
  const from = sinceDay(days);
  const out = new Map();
  const row = (id) => { if (!out.has(id)) out.set(id, { views: 0, carts: 0, orders: 0, units: 0, revenue: 0 }); return out.get(id); };
  for (const r of db.prepare("SELECT product_id, SUM(kind = 'view') views, SUM(kind = 'cart') carts FROM analytics_events WHERE day >= ? AND product_id IS NOT NULL GROUP BY product_id").all(from)) Object.assign(row(r.product_id), { views: r.views, carts: r.carts });
  const skuToProduct = new Map(db.prepare('SELECT sku, product_id FROM skus').all().map((s) => [s.sku, s.product_id]));
  for (const o of db.prepare("SELECT lines FROM orders WHERE status != 'cancelled' AND substr(created_at, 1, 10) >= ?").all(from)) {
    let lines = []; try { lines = JSON.parse(o.lines || '[]'); } catch { /* bad row */ }
    const seen = new Set();
    for (const l of lines) { const p = skuToProduct.get(l.sku) || l.sku; const r = row(p); r.units += Number(l.qty) || 0; r.revenue += Number(l.amount) || 0; if (!seen.has(p)) { r.orders++; seen.add(p); } }
  }
  for (const r of out.values()) { r.cartRate = r.views ? r.carts / r.views : null; r.conversion = r.views ? r.orders / r.views : null; }
  return out;
}

// ---------------------------------------------------------------- campaigns
export function listCampaigns() { return db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC').all(); }
export const getCampaign = (id) => db.prepare('SELECT * FROM campaigns WHERE id = ?').get(Number(id)) || null;
export function saveCampaign({ id, name, code, source = '', medium = '', landing = '/', spend = 0, starts_at = '', ends_at = '', notes = '' }) {
  const n = String(name || '').trim();
  if (!n) throw new Error('活动名称必填');
  const k = String(code || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,48}$/.test(k)) throw new Error('活动代码：2–49 位小写字母、数字、点、横线或下划线（用于链接里的 utm_campaign）');
  const sp = Number(spend || 0);
  if (!(sp >= 0)) throw new Error('投放花费须为不小于 0 的数字');
  const land = String(landing || '/').trim();
  if (!land.startsWith('/')) throw new Error('落地页填网站内的路径，如 /products/ufo-high-bay-u2/');
  const dup = db.prepare('SELECT id FROM campaigns WHERE code = ?').get(k);
  if (dup && dup.id !== Number(id)) throw new Error(`活动代码 ${k} 已被使用`);
  const vals = [n.slice(0, 80), k, clean(source, 40), clean(medium, 40), land.slice(0, 200), sp, starts_at || null, ends_at || null, String(notes || '').slice(0, 500)];
  if (id) { db.prepare('UPDATE campaigns SET name=?, code=?, source=?, medium=?, landing=?, spend=?, starts_at=?, ends_at=?, notes=? WHERE id=?').run(...vals, Number(id)); return Number(id); }
  return Number(db.prepare('INSERT INTO campaigns (name, code, source, medium, landing, spend, starts_at, ends_at, notes, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(...vals, actorName('system'), now()).lastInsertRowid);
}
export const deleteCampaign = (id) => db.prepare('DELETE FROM campaigns WHERE id = ?').run(Number(id));
export function campaignLink(c) {
  const u = new URL(c.landing || '/', config.publicBaseUrl);
  if (c.source) u.searchParams.set('utm_source', c.source);
  if (c.medium) u.searchParams.set('utm_medium', c.medium);
  u.searchParams.set('utm_campaign', c.code);
  return u.href;
}
/** Results of a campaign (all time). Revenue = paid shop orders + paid amounts on orders that came from its inquiries. */
export function campaignStats(code, spend = 0) {
  const visitors = db.prepare("SELECT COUNT(DISTINCT visitor || day) n FROM analytics_events WHERE kind = 'view' AND campaign = ?").get(code).n;
  const leads = db.prepare('SELECT id FROM leads WHERE campaign = ?').all(code).map((l) => l.id);
  const shop = db.prepare("SELECT id, customer_id, total, paid FROM orders WHERE campaign = ? AND status != 'cancelled'").all(code);
  const fromLeads = leads.length ? db.prepare(`SELECT o.id, o.customer_id, o.total, o.paid FROM orders o JOIN quotes q ON q.id = o.quote_id WHERE o.status != 'cancelled' AND q.lead_id IN (${leads.map(() => '?').join(',')})`).all(...leads) : [];
  const orders = [...new Map([...shop, ...fromLeads].map((o) => [o.id, o])).values()];
  const revenue = orders.reduce((a, o) => a + (Number(o.paid) || 0), 0);
  const customers = new Set(orders.filter((o) => o.paid > 0.01).map((o) => o.customer_id)).size;
  const sp = Number(spend) || 0;
  return { visitors, leads: leads.length, orders: orders.length, customers, revenue, roi: sp ? (revenue - sp) / sp : null, costPerLead: sp && leads.length ? sp / leads.length : null, cac: sp && customers ? sp / customers : null };
}
/** Campaign codes seen in visits that were never registered as campaigns. */
export const unregisteredCodes = () => db.prepare('SELECT campaign code, COUNT(DISTINCT visitor || day) visitors FROM analytics_events WHERE campaign IS NOT NULL AND campaign NOT IN (SELECT code FROM campaigns) GROUP BY campaign ORDER BY visitors DESC LIMIT 20').all();
