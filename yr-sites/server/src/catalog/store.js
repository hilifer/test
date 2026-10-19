// Product centre data layer: products, categories, SKU variants, media, settings, revisions, publishing.
// The database is the source of truth. "Publish" rebuilds the in-memory catalog used by the AI agent,
// MCP and quotes immediately, writes catalog.json / site.json for the static site and rebuilds it.
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db.js';
import { config } from '../config.js';
import { migrate, addColumn } from '../migrate.js';
import { actorName } from '../auth.js';
import { validateProduct, validateCategory, imageType, ID_RE } from './validate.js';

const here = dirname(fileURLToPath(import.meta.url));
const now = () => new Date().toISOString();
const J = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

migrate([{
  id: '2026-10-20-product-centre',
  up: () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS skus (sku TEXT PRIMARY KEY, product_id TEXT, name TEXT, variant TEXT, unit TEXT, ref_price REAL, pcs_per_carton INTEGER,
        carton_cbm REAL, carton_gw REAL, hs_code TEXT, erp_number TEXT, stock_local INTEGER DEFAULT 0, active INTEGER DEFAULT 1, updated_at TEXT);
      CREATE TABLE products (id TEXT PRIMARY KEY, status TEXT NOT NULL, sales_mode TEXT NOT NULL DEFAULT 'both', data TEXT NOT NULL, sort INTEGER DEFAULT 0,
        version INTEGER DEFAULT 1, created_at TEXT, updated_at TEXT, published_at TEXT, updated_by TEXT);
      CREATE TABLE categories (id TEXT PRIMARY KEY, data TEXT NOT NULL, sort INTEGER DEFAULT 0, updated_at TEXT);
      CREATE TABLE product_revisions (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id TEXT, version INTEGER, ts TEXT, actor TEXT, summary TEXT, data TEXT);
      CREATE INDEX idx_rev_product ON product_revisions(product_id, id);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT, updated_by TEXT);
      CREATE TABLE media (id TEXT PRIMARY KEY, file TEXT, mime TEXT, bytes INTEGER, original_name TEXT, created_at TEXT, created_by TEXT);`);
    for (const [c, t] of [['price', 'REAL'], ['compare_at', 'REAL'], ['tier_prices', 'TEXT'], ['weight_kg', 'REAL'], ['options', 'TEXT'], ['image', 'TEXT'], ['min_qty', 'INTEGER DEFAULT 1'], ['sort', 'INTEGER DEFAULT 0']]) addColumn('skus', c, t);
  },
}]);

// ---------------------------------------------------------------- settings
export const getSetting = (key, d = null) => J(db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value, d);
export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by')
    .run(key, JSON.stringify(value), now(), actorName('system'));
}
const markDirty = () => setSetting('catalog_dirty', true);
export const isDirty = () => Boolean(getSetting('catalog_dirty', false));

// ---------------------------------------------------------------- seed (first start only)
// SAMPLE shipping weights per product type, so the demo shop can quote freight. Replace with real weights in the admin.
const SAMPLE_WEIGHT_KG = { ufo: 3.5, 'linear-hb': 4.5, shoebox: 8, street: 7, solar: 12, flood: 5, sports: 18, wallpack: 3, canopy: 2.5, panel: 2.8, triproof: 1.8,
  cabinet: 2400, 'cabinet-small': 900, 'home-battery': 40, inverter: 30, module: 28, wallbox: 6, 'dc-charger': 380 };
function seed() {
  if (db.prepare('SELECT COUNT(*) n FROM products').get().n) return;
  const file = config.catalog;
  const { products = [], categories = [], ...meta } = file;
  db.exec('BEGIN');
  try {
    categories.forEach((c, i) => db.prepare('INSERT INTO categories (id, data, sort, updated_at) VALUES (?,?,?,?)').run(c.id, JSON.stringify(c), i, now()));
    products.forEach((p, i) => {
      db.prepare('INSERT INTO products (id, status, sales_mode, data, sort, created_at, updated_at, published_at, updated_by) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(p.id, 'published', 'both', JSON.stringify(p), i, now(), now(), now(), 'seed');
      // one default SKU per product; shop price = top of the first reference band (SAMPLE until finance sets real prices)
      const b = p.priceBands || [];
      db.prepare(`INSERT INTO skus (sku, product_id, name, variant, unit, ref_price, price, tier_prices, min_qty, weight_kg, active, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,?)
        ON CONFLICT(sku) DO UPDATE SET price = COALESCE(skus.price, excluded.price), tier_prices = COALESCE(skus.tier_prices, excluded.tier_prices), min_qty = excluded.min_qty, weight_kg = COALESCE(skus.weight_kg, excluded.weight_kg)`)
        .run(p.id, p.id, p.name, '', p.unit || 'pcs', b[0] ? r2((b[0].low + b[0].high) / 2) : null, b[0] ? b[0].high : null, JSON.stringify(b.slice(1).map((x) => ({ minQty: x.minQty, price: x.high }))), p.moq || 1, SAMPLE_WEIGHT_KG[p.illus] ?? null, now());
    });
    setSetting('catalog_meta', meta);
    const siteFile = process.env.SITE_JSON || resolve(here, `../../../sites/${config.site}/src/data/site.json`);
    if (existsSync(siteFile)) setSetting('site', JSON.parse(readFileSync(siteFile, 'utf8')));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ---------------------------------------------------------------- categories
export const listCategories = () => db.prepare('SELECT * FROM categories ORDER BY sort, id').all().map((r) => ({ ...J(r.data, {}), id: r.id, sort: r.sort }));
export function saveCategory(input, { isNew = false } = {}) {
  const existing = listCategories();
  const { category, errors } = validateCategory(input, { existing, isNew });
  if (errors.length) { const e = new Error(errors.join('；')); e.errors = errors; throw e; }
  const sort = Number(input.sort) || (isNew ? existing.length : existing.find((c) => c.id === category.id)?.sort || 0);
  const { sort: _s, ...data } = category;
  if (!isNew && !existing.some((c) => c.id === category.id)) throw new Error('品类不存在');
  db.prepare('INSERT INTO categories (id, data, sort, updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, sort = excluded.sort, updated_at = excluded.updated_at')
    .run(category.id, JSON.stringify(data), sort, now());
  markDirty();
  return category;
}
export function deleteCategory(id) {
  const n = db.prepare("SELECT COUNT(*) n FROM products WHERE json_extract(data, '$.category') = ? AND status != 'archived'").get(id).n;
  if (n) throw new Error(`该品类下还有 ${n} 个商品，请先移走或下架`);
  db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  markDirty();
}

// ---------------------------------------------------------------- SKUs (variants)
export const parseOptions = (v) => (v && typeof v === 'object' ? v : Object.fromEntries(String(v || '').split(/\s*[;；]\s*/).map((kv) => kv.split(/\s*[=:：]\s*/)).filter(([k, val]) => k && val)));
export const optionsText = (o) => Object.entries(o || {}).map(([k, v]) => `${k}=${v}`).join('; ');
export const parseTiers = (v) => (Array.isArray(v) ? v : String(v || '').split(/\s*[|,]\s*/).filter(Boolean).map((t) => { const [q, p] = t.split(/\s*[:：]\s*/); return { minQty: Number(q), price: Number(p) }; }));
export const tiersText = (t) => (t || []).map((x) => `${x.minQty}:${x.price}`).join(' | ');

export function skusFor(productId, { all = false } = {}) {
  return db.prepare(`SELECT * FROM skus WHERE product_id = ? ${all ? '' : 'AND active = 1'} ORDER BY sort, sku`).all(productId)
    .map((s) => ({ ...s, options: J(s.options, {}), tier_prices: J(s.tier_prices, []) }));
}

function validateVariants(variants, productId, salesMode) {
  const errors = [];
  const seen = new Set();
  variants.forEach((v, i) => {
    const n = `规格 ${i + 1}（${v.sku || '无编码'}）`;
    if (!ID_RE.test(v.sku || '')) errors.push(`${n}：SKU 编码只能包含字母、数字、点、横线和下划线`);
    if (seen.has(v.sku)) errors.push(`${n}：SKU 编码重复`);
    seen.add(v.sku);
    const other = db.prepare('SELECT product_id FROM skus WHERE sku = ?').get(v.sku || '');
    if (other && other.product_id !== productId) errors.push(`${n}：SKU 已属于商品 ${other.product_id}`);
    if (salesMode !== 'inquiry' && !(v.price > 0)) errors.push(`${n}：在线销售的商品必须填写售价`);
    if (v.price != null && Number.isNaN(v.price)) errors.push(`${n}：售价必须是数字`);
    if (v.compare_at != null && v.price != null && v.compare_at < v.price) errors.push(`${n}：划线价不能低于售价`);
    if (!(Number.isInteger(v.min_qty) && v.min_qty >= 1)) errors.push(`${n}：起订量必须是 ≥1 的整数`);
    if (v.weight_kg != null && !(v.weight_kg >= 0)) errors.push(`${n}：重量必须是数字`);
    if (!(v.stock_local >= 0)) errors.push(`${n}：库存必须是 ≥0 的整数`);
    let prevQ = v.min_qty;
    for (const t of v.tier_prices) {
      if (!(t.minQty > prevQ) || !(t.price > 0)) { errors.push(`${n}：阶梯价格式应为"100:35 | 500:32"，数量递增且价格大于 0`); break; }
      if (v.price && t.price > v.price) { errors.push(`${n}：阶梯价不应高于基础售价`); break; }
      prevQ = t.minQty;
    }
  });
  if (!variants.length) errors.push('至少需要一个规格（SKU）');
  return errors;
}

const normVariant = (v, i) => ({
  sku: String(v.sku || '').trim(), options: parseOptions(v.options), price: v.price === '' || v.price == null ? null : Number(v.price),
  compare_at: v.compare_at === '' || v.compare_at == null ? null : Number(v.compare_at), tier_prices: parseTiers(v.tier_prices),
  min_qty: v.min_qty === '' || v.min_qty == null ? 1 : Number(v.min_qty), weight_kg: v.weight_kg === '' || v.weight_kg == null ? null : Number(v.weight_kg),
  stock_local: v.stock_local === '' || v.stock_local == null ? 0 : Number(v.stock_local), pcs_per_carton: Number(v.pcs_per_carton) || null,
  carton_cbm: Number(v.carton_cbm) || null, carton_gw: Number(v.carton_gw) || null, erp_number: String(v.erp_number || '').trim(), image: String(v.image || '').trim() || null, sort: i,
});

const skuReferenced = (sku) => Boolean(db.prepare("SELECT 1 FROM orders WHERE lines LIKE ? UNION SELECT 1 FROM quotes WHERE lines LIKE ? LIMIT 1").get(`%"sku":"${sku}"%`, `%"sku":"${sku}"%`));

// ---------------------------------------------------------------- products
function row(r) {
  if (!r) return null;
  return { ...J(r.data, {}), id: r.id, _status: r.status, _salesMode: r.sales_mode, _version: r.version, _sort: r.sort, _updatedAt: r.updated_at, _updatedBy: r.updated_by, _publishedAt: r.published_at };
}
export const getProduct = (id) => row(db.prepare('SELECT * FROM products WHERE id = ?').get(id));

export function listProducts({ q = '', category = '', status = '', page = 1, pageSize = 50 } = {}) {
  const where = [];
  const args = [];
  if (status) { where.push('status = ?'); args.push(status); }
  if (category) { where.push("json_extract(data, '$.category') = ?"); args.push(category); }
  if (q) { where.push("(id LIKE ? OR json_extract(data, '$.name') LIKE ? OR json_extract(data, '$.nameZh') LIKE ?)"); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) n FROM products ${w}`).get(...args).n;
  const rows = db.prepare(`SELECT * FROM products ${w} ORDER BY sort, id LIMIT ? OFFSET ?`).all(...args, pageSize, (Math.max(1, page) - 1) * pageSize).map(row);
  return { total, page, pageSize, rows };
}

const strip = (p) => Object.fromEntries(Object.entries(p).filter(([k]) => !k.startsWith('_') && k !== 'variants'));

/**
 * Create or update a product with its SKU variants in one transaction.
 * opts: { isNew, expectVersion (optimistic lock), status, salesMode, variants: [...] }
 * Returns { product, warnings }. Throws Error with .errors[] on validation failure.
 */
export function saveProduct(input, { isNew = false, expectVersion = null, status, salesMode, variants } = {}) {
  const current = input.id ? getProduct(input.id) : null;
  if (!isNew && !current) throw new Error('商品不存在');
  if (!isNew && expectVersion != null && Number(expectVersion) !== current._version) throw Object.assign(new Error('该商品已被其他人修改，请刷新页面后重新编辑'), { conflict: true });
  const existing = new Map(db.prepare('SELECT id, data FROM products').all().map((r) => [r.id, J(r.data, {})]));
  const base = isNew ? {} : strip(current);
  const { product, errors, warnings } = validateProduct({ ...base, ...strip(input) }, { categories: listCategories(), existing, isNew });
  const mode = salesMode || current?._salesMode || 'both';
  if (!['shop', 'inquiry', 'both'].includes(mode)) errors.push('销售方式无效');
  const st = status || current?._status || 'draft';
  if (!['draft', 'published', 'archived'].includes(st)) errors.push('状态无效');
  const vs = variants ? variants.map(normVariant).filter((v) => v.sku || v.price != null) : null;
  if (vs) errors.push(...validateVariants(vs, product.id, mode));
  else if (isNew) errors.push('至少需要一个规格（SKU）');
  if (vs && vs.some((v) => v.weight_kg == null) && mode !== 'inquiry') warnings.push('有规格未填重量，运费将无法自动计算');
  if (errors.length) { const e = new Error(errors.join('；')); e.errors = errors; e.warnings = warnings; throw e; }

  const changed = current ? Object.keys({ ...strip(current), ...product }).filter((k) => JSON.stringify(strip(current)[k]) !== JSON.stringify(product[k])) : ['新建'];
  const actor = actorName('system');
  db.exec('BEGIN');
  try {
    if (isNew) {
      const sort = db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 n FROM products').get().n;
      db.prepare('INSERT INTO products (id, status, sales_mode, data, sort, version, created_at, updated_at, published_at, updated_by) VALUES (?,?,?,?,?,1,?,?,?,?)')
        .run(product.id, st, mode, JSON.stringify(product), sort, now(), now(), st === 'published' ? now() : null, actor);
    } else {
      db.prepare('UPDATE products SET status = ?, sales_mode = ?, data = ?, version = version + 1, updated_at = ?, updated_by = ?, published_at = CASE WHEN ? = \'published\' AND published_at IS NULL THEN ? ELSE published_at END WHERE id = ?')
        .run(st, mode, JSON.stringify(product), now(), actor, st, now(), product.id);
    }
    if (vs) {
      const keep = new Set(vs.map((v) => v.sku));
      for (const v of vs) {
        const label = Object.values(v.options).join(' / ');
        db.prepare(`INSERT INTO skus (sku, product_id, name, variant, unit, ref_price, price, compare_at, tier_prices, min_qty, weight_kg, stock_local, pcs_per_carton, carton_cbm, carton_gw, erp_number, image, options, sort, active, updated_at)
          VALUES (@sku,@product_id,@name,@variant,@unit,@ref_price,@price,@compare_at,@tier_prices,@min_qty,@weight_kg,@stock_local,@pcs_per_carton,@carton_cbm,@carton_gw,@erp_number,@image,@options,@sort,1,@updated_at)
          ON CONFLICT(sku) DO UPDATE SET name=@name, variant=@variant, unit=@unit, ref_price=COALESCE(@ref_price, skus.ref_price), price=@price, compare_at=@compare_at, tier_prices=@tier_prices, min_qty=@min_qty,
            weight_kg=@weight_kg, stock_local=@stock_local, pcs_per_carton=@pcs_per_carton, carton_cbm=@carton_cbm, carton_gw=@carton_gw, erp_number=@erp_number, image=@image, options=@options, sort=@sort, active=1, updated_at=@updated_at`)
          .run({ ...v, product_id: product.id, name: product.name, variant: label, unit: product.unit, ref_price: v.price, tier_prices: JSON.stringify(v.tier_prices), options: JSON.stringify(v.options), updated_at: now() });
      }
      for (const old of skusFor(product.id, { all: true })) {
        if (keep.has(old.sku)) continue;
        if (skuReferenced(old.sku)) db.prepare('UPDATE skus SET active = 0, updated_at = ? WHERE sku = ?').run(now(), old.sku);
        else db.prepare('DELETE FROM skus WHERE sku = ?').run(old.sku);
      }
    }
    const saved = db.prepare('SELECT version FROM products WHERE id = ?').get(product.id);
    db.prepare('INSERT INTO product_revisions (product_id, version, ts, actor, summary, data) VALUES (?,?,?,?,?,?)')
      .run(product.id, saved.version, now(), actor, changed.slice(0, 12).join(', ') + (vs ? '（含规格）' : ''), JSON.stringify({ product, status: st, salesMode: mode, variants: vs }));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  markDirty();
  return { product: getProduct(product.id), warnings };
}

export function setProductStatus(id, status) {
  const p = getProduct(id);
  if (!p) throw new Error('商品不存在');
  if (!['draft', 'published', 'archived'].includes(status)) throw new Error('状态无效');
  if (status === 'published') {
    const { errors } = validateProduct(strip(p), { categories: listCategories(), existing: new Map(), isNew: false });
    if (errors.length) throw new Error(`资料不完整，不能上架：${errors.join('；')}`);
    if (!skusFor(id).length) throw new Error('没有可售规格（SKU），不能上架');
  }
  db.prepare("UPDATE products SET status = ?, version = version + 1, updated_at = ?, updated_by = ?, published_at = CASE WHEN ? = 'published' AND published_at IS NULL THEN ? ELSE published_at END WHERE id = ?")
    .run(status, now(), actorName('system'), status, now(), id);
  db.prepare('INSERT INTO product_revisions (product_id, version, ts, actor, summary, data) VALUES (?,?,?,?,?,?)').run(id, p._version + 1, now(), actorName('system'), `状态 → ${status}`, null);
  markDirty();
}

export function deleteProduct(id) {
  const p = getProduct(id);
  if (!p) throw new Error('商品不存在');
  if (p._publishedAt) throw new Error('上架过的商品不能删除（订单和搜索引擎可能引用它），请改为下架');
  if (skusFor(id, { all: true }).some((s) => skuReferenced(s.sku))) throw new Error('该商品已出现在报价或订单中，不能删除，请改为下架');
  db.exec('BEGIN');
  db.prepare('DELETE FROM skus WHERE product_id = ?').run(id);
  db.prepare('DELETE FROM products WHERE id = ?').run(id);
  db.exec('COMMIT');
  markDirty();
}

export const revisionsFor = (id, n = 30) => db.prepare('SELECT id, version, ts, actor, summary FROM product_revisions WHERE product_id = ? ORDER BY id DESC LIMIT ?').all(id, n);

export function reorderProducts(ids) {
  const st = db.prepare('UPDATE products SET sort = ? WHERE id = ?');
  ids.forEach((id, i) => st.run(i, id));
  markDirty();
}

// ---------------------------------------------------------------- media
export const MEDIA_MAX_BYTES = 5 * 1024 * 1024;
export const mediaDir = () => config.mediaDir;

export function saveMedia(buf, originalName = '') {
  if (!buf?.length) throw new Error('文件为空');
  if (buf.length > MEDIA_MAX_BYTES) throw new Error(`图片不能超过 ${MEDIA_MAX_BYTES / 1024 / 1024} MB`);
  const ext = imageType(buf);
  if (!ext) throw new Error('只支持 JPG、PNG、WebP 图片');
  const id = randomBytes(12).toString('hex');
  const file = `${id}.${ext}`;
  mkdirSync(mediaDir(), { recursive: true });
  writeFileSync(join(mediaDir(), file), buf);
  db.prepare('INSERT INTO media (id, file, mime, bytes, original_name, created_at, created_by) VALUES (?,?,?,?,?,?,?)')
    .run(id, file, { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[ext], buf.length, String(originalName).slice(0, 200), now(), actorName('system'));
  return `/media/${file}`;
}

// ---------------------------------------------------------------- build the public catalog + publish
export function buildCatalog() {
  const meta = getSetting('catalog_meta', {});
  const categories = listCategories().map(({ sort, ...c }) => c);
  const products = db.prepare("SELECT * FROM products WHERE status = 'published' ORDER BY sort, id").all().map((r) => {
    const p = J(r.data, {});
    const variants = skusFor(r.id).map((s) => ({ sku: s.sku, options: s.options, label: s.variant, price: s.price, compareAt: s.compare_at, tiers: s.tier_prices, minQty: s.min_qty, weightKg: s.weight_kg, image: s.image }));
    return { ...p, salesMode: r.sales_mode, variants };
  });
  return { ...meta, categories, products };
}

/**
 * Publishing works on a snapshot: edits stay invisible to customers, the AI agent and MCP until someone
 * presses "publish". The snapshot is stored, so a restart never leaks unpublished edits.
 */
export const publishedCatalog = () => getSetting('published_catalog') || buildCatalog();

/** Snapshot the current database catalog, make it live in memory and write the site's data files. */
export function publishCatalog() {
  const snap = buildCatalog();
  setSetting('published_catalog', snap);
  setSetting('catalog_dirty', false);
  setSetting('last_publish', { ts: now(), actor: actorName('system'), products: snap.products.length });
  config.catalog = snap;
  exportSite();
  return snap;
}

/** Write catalog.json + site.json (from the published snapshot) for the static site build. */
export function exportSite() {
  const dir = join(config.content.siteDir, 'src', 'data');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'catalog.json'), JSON.stringify(publishedCatalog(), null, 2) + '\n');
  const site = getSetting('site');
  if (site) writeFileSync(join(dir, 'site.json'), JSON.stringify(site, null, 2) + '\n');
  return dir;
}

seed();
if (!getSetting('published_catalog')) setSetting('published_catalog', buildCatalog());
config.catalog = publishedCatalog();
