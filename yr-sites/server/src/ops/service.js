// Sales-to-delivery core: SKU centre, customers, quotes (PI), orders, payments,
// inventory, shipments and after-sales (RMA). All state changes go through the
// data dictionary (shared/dictionary.js) and are written to the events log.
import { randomBytes, randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { config } from '../config.js';
import { DICT, canMove, label } from '../../../shared/dictionary.js';

db.exec(`
CREATE TABLE IF NOT EXISTS skus (
  sku TEXT PRIMARY KEY, product_id TEXT, name TEXT, variant TEXT, unit TEXT,
  ref_price REAL, pcs_per_carton INTEGER, carton_cbm REAL, carton_gw REAL, hs_code TEXT,
  erp_number TEXT, stock_local INTEGER DEFAULT 0, active INTEGER DEFAULT 1, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY, created_at TEXT, company TEXT, contact TEXT, email TEXT, phone TEXT, whatsapp TEXT,
  country TEXT, address TEXT, lead_id TEXT, erp_number TEXT, portal_token TEXT UNIQUE, lang TEXT DEFAULT 'en'
);
CREATE INDEX IF NOT EXISTS idx_cust_email ON customers(email);
CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY, number TEXT UNIQUE, customer_id TEXT, lead_id TEXT, status TEXT, currency TEXT,
  incoterm TEXT, port TEXT, payment_terms TEXT, validity_days INTEGER, freight REAL DEFAULT 0, discount REAL DEFAULT 0,
  notes TEXT, lines TEXT, subtotal REAL, total REAL, created_at TEXT, sent_at TEXT, accepted_at TEXT, token TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, number TEXT UNIQUE, quote_id TEXT, customer_id TEXT, status TEXT, currency TEXT,
  lines TEXT, total REAL, paid REAL DEFAULT 0, deposit_due REAL, incoterm TEXT, port TEXT, payment_terms TEXT,
  promised_date TEXT, created_at TEXT, updated_at TEXT, erp_bill_no TEXT, erp_synced_at TEXT, erp_error TEXT, notes TEXT
);
CREATE TABLE IF NOT EXISTS payments (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT, kind TEXT, amount REAL, currency TEXT, ref TEXT, ts TEXT);
CREATE TABLE IF NOT EXISTS inventory (sku TEXT, warehouse TEXT, qty REAL, synced_at TEXT, PRIMARY KEY (sku, warehouse));
CREATE TABLE IF NOT EXISTS shipments (
  id TEXT PRIMARY KEY, number TEXT UNIQUE, order_id TEXT, rma_id TEXT, status TEXT, mode TEXT, carrier TEXT,
  tracking_no TEXT, container_no TEXT, bl_no TEXT, etd TEXT, eta TEXT, lines TEXT, packing TEXT, events TEXT,
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS rmas (
  id TEXT PRIMARY KEY, number TEXT UNIQUE, order_id TEXT, customer_id TEXT, sku TEXT, qty INTEGER, issue TEXT,
  description TEXT, photos TEXT, status TEXT, resolution TEXT, resolution_note TEXT, source TEXT, created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT, entity_id TEXT, ts TEXT, actor TEXT, action TEXT, from_state TEXT, to_state TEXT, note TEXT);
CREATE INDEX IF NOT EXISTS idx_ev ON events(entity, entity_id);
`);

const now = () => new Date().toISOString();
const token = () => randomBytes(18).toString('base64url');
const J = (s, d = []) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export function nextNumber(entity) {
  const prefix = DICT[entity].prefix;
  const d = new Date();
  const ymd = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const table = { quote: 'quotes', order: 'orders', shipment: 'shipments', rma: 'rmas' }[entity];
  const n = db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE number LIKE ?`).get(`${prefix}-${ymd}-%`).n + 1;
  return `${prefix}-${ymd}-${String(n).padStart(3, '0')}`;
}

export function logEvent(entity, id, action, { from = null, to = null, actor = 'system', note = '' } = {}) {
  db.prepare('INSERT INTO events (entity, entity_id, ts, actor, action, from_state, to_state, note) VALUES (?,?,?,?,?,?,?,?)').run(entity, id, now(), actor, action, from, to, note);
}
export const eventsFor = (entity, id) => db.prepare('SELECT * FROM events WHERE entity = ? AND entity_id = ? ORDER BY id').all(entity, id);

// ---------------------------------------------------------------- SKU centre
export function seedSkus() {
  const c = config.catalog;
  const ins = db.prepare('INSERT OR IGNORE INTO skus (sku, product_id, name, variant, unit, ref_price, updated_at) VALUES (?,?,?,?,?,?,?)');
  for (const p of c.products) {
    const b = p.priceBands?.[0];
    ins.run(p.id, p.id, p.name, '', p.unit || 'pcs', b ? r2((b.low + b.high) / 2) : null, now());
  }
}
export const listSkus = () => db.prepare('SELECT * FROM skus ORDER BY product_id, sku').all();
export const getSku = (sku) => db.prepare('SELECT * FROM skus WHERE sku = ?').get(sku);
export function saveSku(s) {
  if (!/^[\w.-]{2,40}$/.test(s.sku || '')) throw new Error('SKU 编码只能包含字母、数字、点、横线和下划线');
  db.prepare(`INSERT INTO skus (sku, product_id, name, variant, unit, ref_price, pcs_per_carton, carton_cbm, carton_gw, hs_code, erp_number, stock_local, active, updated_at)
    VALUES (@sku,@product_id,@name,@variant,@unit,@ref_price,@pcs_per_carton,@carton_cbm,@carton_gw,@hs_code,@erp_number,@stock_local,@active,@updated_at)
    ON CONFLICT(sku) DO UPDATE SET product_id=@product_id,name=@name,variant=@variant,unit=@unit,ref_price=@ref_price,pcs_per_carton=@pcs_per_carton,carton_cbm=@carton_cbm,carton_gw=@carton_gw,hs_code=@hs_code,erp_number=@erp_number,stock_local=@stock_local,active=@active,updated_at=@updated_at`).run({
    sku: s.sku, product_id: s.product_id || '', name: s.name || s.sku, variant: s.variant || '', unit: s.unit || 'pcs',
    ref_price: s.ref_price === '' || s.ref_price == null ? null : Number(s.ref_price),
    pcs_per_carton: Number(s.pcs_per_carton) || null, carton_cbm: Number(s.carton_cbm) || null, carton_gw: Number(s.carton_gw) || null,
    hs_code: s.hs_code || '', erp_number: s.erp_number || '', stock_local: Number(s.stock_local) || 0, active: s.active === false || s.active === '0' ? 0 : 1, updated_at: now(),
  });
}

// ---------------------------------------------------------------- inventory
/** Stock on hand (ERP or local), reserved by open orders, and available to promise. */
export function stockView() {
  const erp = config.erp.mode !== 'none' && config.erp.mode !== 'local';
  const onHand = new Map();
  if (erp) for (const r of db.prepare('SELECT sku, SUM(qty) q, MAX(synced_at) s FROM inventory GROUP BY sku').all()) onHand.set(r.sku, { q: r.q, s: r.s });
  const reserved = new Map();
  for (const o of db.prepare("SELECT lines FROM orders WHERE status IN ('awaiting_deposit','in_production','ready_to_ship')").all())
    for (const l of J(o.lines)) reserved.set(l.sku, (reserved.get(l.sku) || 0) + Number(l.qty || 0));
  return listSkus().map((s) => {
    const oh = erp ? onHand.get(s.sku)?.q ?? 0 : s.stock_local || 0;
    const rs = reserved.get(s.sku) || 0;
    return { ...s, on_hand: oh, reserved: rs, available: oh - rs, synced_at: erp ? onHand.get(s.sku)?.s || null : null };
  });
}
export function replaceInventory(rows) {
  const del = db.prepare('DELETE FROM inventory');
  const ins = db.prepare('INSERT OR REPLACE INTO inventory (sku, warehouse, qty, synced_at) VALUES (?,?,?,?)');
  const t = now();
  db.exec('BEGIN');
  try { del.run(); for (const r of rows) ins.run(r.sku, r.warehouse || '默认仓', Number(r.qty) || 0, t); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ---------------------------------------------------------------- customers
export function findOrCreateCustomer(c) {
  const email = String(c.email || '').trim().toLowerCase();
  let row = email ? db.prepare('SELECT * FROM customers WHERE lower(email) = ?').get(email) : null;
  if (row) return row;
  const id = randomUUID();
  db.prepare('INSERT INTO customers (id, created_at, company, contact, email, phone, whatsapp, country, address, lead_id, portal_token, lang) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
    id, now(), c.company || '', c.contact || c.name || '', email, c.phone || '', c.whatsapp || '', c.country || '', c.address || '', c.lead_id || '', token(), c.lang || 'en');
  logEvent('customer', id, 'created', { note: c.company || email });
  return getCustomer(id);
}
export const getCustomer = (id) => db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
export const customerByToken = (t) => (t ? db.prepare('SELECT * FROM customers WHERE portal_token = ?').get(t) : null);
export const listCustomers = () => db.prepare('SELECT c.*, (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id) orders, (SELECT COALESCE(SUM(total),0) FROM orders o WHERE o.customer_id = c.id AND o.status != \'cancelled\') revenue FROM customers c ORDER BY created_at DESC').all();
export function updateCustomer(id, f) {
  db.prepare('UPDATE customers SET company=?, contact=?, email=?, phone=?, whatsapp=?, country=?, address=?, erp_number=?, lang=? WHERE id=?').run(f.company || '', f.contact || '', String(f.email || '').toLowerCase(), f.phone || '', f.whatsapp || '', f.country || '', f.address || '', f.erp_number || '', f.lang || 'en', id);
}

// ---------------------------------------------------------------- quotes / PI
export function computeLines(lines) {
  const clean = (lines || []).filter((l) => l.sku && Number(l.qty) > 0).map((l) => {
    const s = getSku(l.sku);
    const qty = Math.round(Number(l.qty));
    const unit_price = r2(l.unit_price);
    return { sku: l.sku, name: l.name || s?.name || l.sku, variant: l.variant ?? s?.variant ?? '', unit: s?.unit || 'pcs', qty, unit_price, amount: r2(qty * unit_price) };
  });
  return { lines: clean, subtotal: r2(clean.reduce((a, l) => a + l.amount, 0)) };
}

export function createQuote({ customer, lead_id = '', lines = [], currency, incoterm = 'FOB', port = '', payment_terms = 'tt30', validity_days = 15, freight = 0, discount = 0, notes = '' }) {
  const cust = customer.id ? customer : findOrCreateCustomer({ ...customer, lead_id });
  const { lines: L, subtotal } = computeLines(lines);
  const id = randomUUID();
  const number = nextNumber('quote');
  db.prepare(`INSERT INTO quotes (id, number, customer_id, lead_id, status, currency, incoterm, port, payment_terms, validity_days, freight, discount, notes, lines, subtotal, total, created_at, token)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, number, cust.id, lead_id, 'draft', currency || config.catalog.currency, incoterm, port, payment_terms, Number(validity_days) || 15, r2(freight), r2(discount), notes, JSON.stringify(L), subtotal, r2(subtotal + r2(freight) - r2(discount)), now(), token());
  logEvent('quote', id, 'created', { to: 'draft', note: number });
  return getQuote(id);
}
export function updateQuote(id, f) {
  const q = getQuote(id);
  if (!q || !['draft', 'sent', 'expired'].includes(q.status)) throw new Error('只有草稿、已发送或已过期的报价可以修改');
  const { lines: L, subtotal } = computeLines(f.lines ?? q.lines);
  const freight = r2(f.freight ?? q.freight), discount = r2(f.discount ?? q.discount);
  db.prepare('UPDATE quotes SET currency=?, incoterm=?, port=?, payment_terms=?, validity_days=?, freight=?, discount=?, notes=?, lines=?, subtotal=?, total=?, status=? WHERE id=?').run(
    f.currency || q.currency, f.incoterm || q.incoterm, f.port ?? q.port, f.payment_terms || q.payment_terms, Number(f.validity_days) || q.validity_days, freight, discount, f.notes ?? q.notes, JSON.stringify(L), subtotal, r2(subtotal + freight - discount), q.status === 'sent' ? 'draft' : q.status === 'expired' ? 'draft' : q.status, id);
  if (q.status !== 'draft') logEvent('quote', id, 'reopened', { from: q.status, to: 'draft' });
}
export function getQuote(id) {
  const q = db.prepare('SELECT * FROM quotes WHERE id = ? OR number = ?').get(id, id);
  return q ? { ...q, lines: J(q.lines) } : null;
}
export const quoteByToken = (t) => { const q = t ? db.prepare('SELECT id FROM quotes WHERE token = ?').get(t) : null; return q ? getQuote(q.id) : null; };
export const quotesForCustomer = (cid) => db.prepare("SELECT * FROM quotes WHERE customer_id = ? AND status NOT IN ('draft','cancelled') ORDER BY created_at DESC").all(cid);
export const listQuotes = () => db.prepare('SELECT q.*, c.company, c.email FROM quotes q LEFT JOIN customers c ON c.id = q.customer_id ORDER BY q.created_at DESC').all().map((q) => ({ ...q, lines: J(q.lines) }));
export function quoteExpired(q) {
  if (q.status !== 'sent' || !q.sent_at) return false;
  return Date.now() > new Date(q.sent_at).getTime() + q.validity_days * 864e5;
}
export function setQuoteStatus(id, to, actor = 'admin') {
  const q = getQuote(id);
  if (!q) throw new Error('报价不存在');
  if (!canMove('quote', q.status, to)) throw new Error(`报价不能从「${label('quote', q.status)}」改为「${label('quote', to)}」`);
  if (to === 'sent' && !q.lines.length) throw new Error('报价没有产品明细');
  db.prepare('UPDATE quotes SET status = ?, sent_at = COALESCE(?, sent_at) WHERE id = ?').run(to, to === 'sent' ? now() : null, id);
  logEvent('quote', id, 'status', { from: q.status, to, actor });
  return getQuote(id);
}

/** Customer accepts a PI (from the portal) → order is created. */
export function acceptQuote(tokenOrId, actor = 'customer') {
  const q = quoteByToken(tokenOrId) || getQuote(tokenOrId);
  if (!q) throw new Error('PI not found');
  if (q.status === 'accepted') return getOrderByQuote(q.id);
  if (quoteExpired(q)) { setQuoteStatus(q.id, 'expired', 'system'); throw new Error('This PI has expired. Please ask us for an updated quotation.'); }
  if (q.status !== 'sent') throw new Error('This PI is not open for acceptance.');
  db.prepare('UPDATE quotes SET status = ?, accepted_at = ? WHERE id = ?').run('accepted', now(), q.id);
  logEvent('quote', q.id, 'status', { from: 'sent', to: 'accepted', actor });
  const term = DICT.paymentTerms.find((t) => t.id === q.payment_terms);
  const depositPct = term?.id === 'tt100' ? 1 : term?.id === 'lc' ? 0 : 0.3;
  const id = randomUUID();
  const number = nextNumber('order');
  db.prepare(`INSERT INTO orders (id, number, quote_id, customer_id, status, currency, lines, total, paid, deposit_due, incoterm, port, payment_terms, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, number, q.id, q.customer_id, 'awaiting_deposit', q.currency, JSON.stringify(q.lines), q.total, 0, r2(q.total * depositPct), q.incoterm, q.port, q.payment_terms, now(), now());
  logEvent('order', id, 'created', { to: 'awaiting_deposit', actor, note: `${number} ← ${q.number}` });
  return getOrder(id);
}

// ---------------------------------------------------------------- orders
export function getOrder(id) {
  const o = db.prepare('SELECT * FROM orders WHERE id = ? OR number = ?').get(id, id);
  return o ? { ...o, lines: J(o.lines) } : null;
}
export const getOrderByQuote = (qid) => { const o = db.prepare('SELECT id FROM orders WHERE quote_id = ?').get(qid); return o ? getOrder(o.id) : null; };
export const listOrders = (where = '', ...args) => db.prepare(`SELECT o.*, c.company, c.email, c.country FROM orders o LEFT JOIN customers c ON c.id = o.customer_id ${where} ORDER BY o.created_at DESC`).all(...args).map((o) => ({ ...o, lines: J(o.lines) }));
export const ordersForCustomer = (cid) => listOrders('WHERE o.customer_id = ?', cid);
export const paymentsFor = (oid) => db.prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY id').all(oid);

export function setOrderStatus(id, to, { actor = 'admin', note = '', force = false } = {}) {
  const o = getOrder(id);
  if (!o) throw new Error('订单不存在');
  if (o.status === to) return o;
  if (!force && !canMove('order', o.status, to)) throw new Error(`订单不能从「${label('order', o.status)}」改为「${label('order', to)}」`);
  if (!force && to === 'completed' && o.paid < o.total - 0.01) throw new Error(`尾款未收清（待收 ${o.currency} ${r2(o.total - o.paid)}），不能标记为已完成`);
  db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(to, now(), id);
  logEvent('order', id, 'status', { from: o.status, to, actor, note });
  return getOrder(id);
}

/** Payment terms that require full payment before goods leave. */
export function balanceDueBeforeShipment(o) {
  return ['tt30', 'tt100'].includes(o.payment_terms) && ['in_production', 'ready_to_ship'].includes(o.status) && o.paid < o.total - 0.01;
}

export function recordPayment(orderId, { kind = 'deposit', amount, ref = '' }, actor = 'admin') {
  const o = getOrder(orderId);
  if (!o) throw new Error('订单不存在');
  const amt = r2(amount);
  if (!amt) throw new Error('金额不能为 0');
  db.prepare('INSERT INTO payments (order_id, kind, amount, currency, ref, ts) VALUES (?,?,?,?,?,?)').run(orderId, kind, kind === 'refund' ? -Math.abs(amt) : amt, o.currency, ref, now());
  const paid = r2(db.prepare('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE order_id = ?').get(orderId).s);
  db.prepare('UPDATE orders SET paid = ?, updated_at = ? WHERE id = ?').run(paid, now(), orderId);
  logEvent('order', orderId, 'payment', { actor, note: `${label('payment', kind)} ${o.currency} ${amt} ${ref}`.trim() });
  // deposit received → start production automatically
  if (o.status === 'awaiting_deposit' && paid >= o.deposit_due - 0.01) setOrderStatus(orderId, 'in_production', { actor: 'system', note: '定金已到账' });
  return getOrder(orderId);
}
DICT.payment.states = DICT.payment.kinds; // so label('payment', kind) works

export function setOrderErp(id, { bill_no = null, error = null }) {
  db.prepare('UPDATE orders SET erp_bill_no = COALESCE(?, erp_bill_no), erp_synced_at = ?, erp_error = ? WHERE id = ?').run(bill_no, error ? null : now(), error, id);
  logEvent('order', id, error ? 'erp_error' : 'erp_synced', { note: error || bill_no || '' });
}

// ---------------------------------------------------------------- shipments
export function packingFor(lines) {
  let cartons = 0, cbm = 0, gw = 0, unknown = [];
  for (const l of lines) {
    const s = getSku(l.sku);
    if (!s?.pcs_per_carton) { unknown.push(l.sku); continue; }
    const c = Math.ceil(l.qty / s.pcs_per_carton);
    cartons += c; cbm += c * (s.carton_cbm || 0); gw += c * (s.carton_gw || 0);
  }
  return { cartons, cbm: r2(cbm), gw_kg: r2(gw), missing_packing_data: unknown };
}
export function createShipment({ order_id, rma_id = null, lines = null, mode = 'sea', carrier = '', tracking_no = '', container_no = '', bl_no = '', etd = '', eta = '' }, actor = 'admin') {
  const o = getOrder(order_id);
  if (!o) throw new Error('订单不存在');
  if (!rma_id && !['ready_to_ship', 'shipped'].includes(o.status)) throw new Error('订单需要先进入「待发货」才能创建发货单');
  const L = lines || o.lines;
  const id = randomUUID();
  const number = nextNumber('shipment');
  const ev = [{ ts: now(), status: 'booked', location: '', note: carrier ? `${carrier} ${tracking_no}`.trim() : '' }];
  db.prepare(`INSERT INTO shipments (id, number, order_id, rma_id, status, mode, carrier, tracking_no, container_no, bl_no, etd, eta, lines, packing, events, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, number, order_id, rma_id, 'booked', mode, carrier, tracking_no, container_no, bl_no, etd, eta, JSON.stringify(L), JSON.stringify(packingFor(L)), JSON.stringify(ev), now(), now());
  logEvent('shipment', id, 'created', { to: 'booked', actor, note: `${number} / ${o.number}` });
  return getShipment(id);
}
export function getShipment(id) {
  const s = db.prepare('SELECT * FROM shipments WHERE id = ? OR number = ?').get(id, id);
  return s ? { ...s, lines: J(s.lines), packing: J(s.packing, {}), events: J(s.events) } : null;
}
export const shipmentsFor = (oid) => db.prepare('SELECT id FROM shipments WHERE order_id = ? ORDER BY created_at').all(oid).map((r) => getShipment(r.id));
export const listShipments = () => db.prepare('SELECT s.id FROM shipments s ORDER BY s.created_at DESC').all().map((r) => getShipment(r.id));
export function updateShipment(id, f) {
  const s = getShipment(id);
  db.prepare('UPDATE shipments SET mode=?, carrier=?, tracking_no=?, container_no=?, bl_no=?, etd=?, eta=?, updated_at=? WHERE id=?').run(f.mode || s.mode, f.carrier ?? s.carrier, f.tracking_no ?? s.tracking_no, f.container_no ?? s.container_no, f.bl_no ?? s.bl_no, f.etd ?? s.etd, f.eta ?? s.eta, now(), id);
}
/** Add a tracking event; status changes cascade to the order. */
export function addShipmentEvent(id, { status, location = '', note = '' }, actor = 'admin') {
  const s = getShipment(id);
  if (!s) throw new Error('发货单不存在');
  const to = status || s.status;
  if (to !== s.status && !canMove('shipment', s.status, to)) throw new Error(`物流状态不能从「${label('shipment', s.status)}」改为「${label('shipment', to)}」`);
  const events = [...s.events, { ts: now(), status: to, location, note }];
  db.prepare('UPDATE shipments SET status = ?, events = ?, updated_at = ? WHERE id = ?').run(to, JSON.stringify(events), now(), id);
  logEvent('shipment', id, 'tracking', { from: s.status, to, actor, note: [location, note].filter(Boolean).join(' · ') });
  if (!s.rma_id) {
    const o = getOrder(s.order_id);
    if (to === 'in_transit' && o.status === 'ready_to_ship') setOrderStatus(o.id, 'shipped', { actor: 'system', note: s.number });
    if (to === 'delivered' && ['ready_to_ship', 'shipped'].includes(o.status)) { if (o.status === 'ready_to_ship') setOrderStatus(o.id, 'shipped', { actor: 'system' }); setOrderStatus(o.id, 'delivered', { actor: 'system', note: s.number }); }
  }
  return getShipment(id);
}

// ---------------------------------------------------------------- after-sales (RMA)
export function createRma({ order_id, sku = '', qty = 0, issue = 'other', description = '', photos = [], source = 'admin' }) {
  const o = getOrder(order_id);
  if (!o) throw new Error('Order not found');
  if (!DICT.rma.issues[issue]) issue = 'other';
  const id = randomUUID();
  const number = nextNumber('rma');
  db.prepare(`INSERT INTO rmas (id, number, order_id, customer_id, sku, qty, issue, description, photos, status, source, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, number, o.id, o.customer_id, sku, Math.max(0, Math.round(Number(qty) || 0)), issue, String(description).slice(0, 4000), JSON.stringify(photos.slice(0, 10)), 'submitted', source, now(), now());
  logEvent('rma', id, 'created', { to: 'submitted', actor: source, note: `${number} / ${o.number}` });
  return getRma(id);
}
export function getRma(id) { const r = db.prepare('SELECT * FROM rmas WHERE id = ? OR number = ?').get(id, id); return r ? { ...r, photos: J(r.photos) } : null; }
export const listRmas = () => db.prepare('SELECT r.*, o.number order_number, c.company, c.email FROM rmas r LEFT JOIN orders o ON o.id = r.order_id LEFT JOIN customers c ON c.id = r.customer_id ORDER BY r.created_at DESC').all();
export const rmasForCustomer = (cid) => db.prepare('SELECT r.*, o.number order_number FROM rmas r LEFT JOIN orders o ON o.id = r.order_id WHERE r.customer_id = ? ORDER BY r.created_at DESC').all(cid);
export function setRmaStatus(id, to, { resolution = null, note = '', actor = 'admin' } = {}) {
  const r = getRma(id);
  if (!r) throw new Error('售后单不存在');
  if (to !== r.status && !canMove('rma', r.status, to)) throw new Error(`售后单不能从「${label('rma', r.status)}」改为「${label('rma', to)}」`);
  db.prepare('UPDATE rmas SET status = ?, resolution = COALESCE(?, resolution), resolution_note = CASE WHEN ? != \'\' THEN ? ELSE resolution_note END, updated_at = ? WHERE id = ?').run(to, resolution, note, note, now(), id);
  logEvent('rma', id, 'status', { from: r.status, to, actor, note: [resolution ? DICT.rma.resolutions[resolution]?.zh : '', note].filter(Boolean).join(' · ') });
  return getRma(id);
}

// ---------------------------------------------------------------- lookups for AI / portal
/** Verify an order belongs to the person asking: order number + the email on the order. */
export function verifyOrder(number, email) {
  const o = getOrder(String(number || '').trim().toUpperCase());
  if (!o) return null;
  const c = getCustomer(o.customer_id);
  if (!c || !email || c.email.toLowerCase() !== String(email).trim().toLowerCase()) return null;
  return { order: o, customer: c };
}

export function orderStatusView(o, lang = 'en') {
  const ships = shipmentsFor(o.id).filter((s) => !s.rma_id);
  return {
    order_number: o.number,
    status: label('order', o.status, lang),
    status_code: o.status,
    placed: o.created_at.slice(0, 10),
    items: o.lines.map((l) => `${l.qty} × ${l.name}${l.variant ? ' ' + l.variant : ''}`),
    total: `${o.currency} ${o.total.toLocaleString('en-US')}`,
    paid: `${o.currency} ${o.paid.toLocaleString('en-US')}`,
    balance_due: `${o.currency} ${r2(o.total - o.paid).toLocaleString('en-US')}`,
    shipments: ships.map((s) => ({ number: s.number, mode: DICT.shipment.modes[s.mode]?.[lang] || s.mode, carrier: s.carrier, tracking_no: s.tracking_no, container_no: s.container_no, status: label('shipment', s.status, lang), etd: s.etd, eta: s.eta, latest: s.events.at(-1) })),
  };
}

export function pipelineStats() {
  const g = (sql, ...a) => db.prepare(sql).get(...a);
  return {
    leads30: g("SELECT COUNT(*) n FROM leads WHERE created_at >= datetime('now','-30 days')").n,
    quotesOpen: g("SELECT COUNT(*) n, COALESCE(SUM(total),0) v FROM quotes WHERE status IN ('draft','sent')"),
    quotesSent30: g("SELECT COUNT(*) n FROM quotes WHERE sent_at >= datetime('now','-30 days')").n,
    accepted30: g("SELECT COUNT(*) n FROM quotes WHERE accepted_at >= datetime('now','-30 days')").n,
    ordersOpen: g("SELECT COUNT(*) n, COALESCE(SUM(total),0) v FROM orders WHERE status NOT IN ('completed','cancelled')"),
    receivable: g("SELECT COALESCE(SUM(total - paid),0) v FROM orders WHERE status NOT IN ('cancelled')").v,
    byStatus: db.prepare("SELECT status, COUNT(*) n FROM orders GROUP BY status").all(),
    inTransit: g("SELECT COUNT(*) n FROM shipments WHERE status IN ('booked','in_transit','arrived')").n,
    rmaOpen: g("SELECT COUNT(*) n FROM rmas WHERE status NOT IN ('resolved','rejected')").n,
  };
}

seedSkus();
