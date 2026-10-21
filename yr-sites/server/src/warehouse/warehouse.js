// Warehouse (仓库 / 物流): stock movements (in / out / adjustments, and automatic deduction when goods ship, local stock
// mode), safety stock per SKU with low-stock alerts, picking lists for several orders, bulk shipping (tracking numbers for
// many orders at once, pasted or imported), and a carrier comparison (quoted fees and real transit times).
import { db } from '../db.js';
import { config } from '../config.js';
import { migrate, addColumn } from '../migrate.js';
import { alertOps } from '../alerts.js';
import { actorName } from '../auth.js';
import { getSetting, setSetting } from '../catalog/store.js';
import { registerJob, dailyAt } from '../jobs.js';
import * as S from '../ops/service.js';
import { quoteShipping, listZones } from '../shop/freight.js';

migrate([{
  id: '2026-11-09-warehouse',
  up: () => {
    addColumn('skus', 'safety_stock', 'INTEGER');
    db.exec(`CREATE TABLE stock_moves (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, sku TEXT NOT NULL, qty INTEGER NOT NULL, kind TEXT NOT NULL, ref TEXT, note TEXT, by TEXT, balance INTEGER);
      CREATE INDEX stock_moves_sku ON stock_moves(sku, id);`);
  },
}]);
const now = () => new Date().toISOString();
const J = (s, d = []) => { try { return JSON.parse(s); } catch { return d; } };
export const localStock = () => !['kingdee', 'mock'].includes(config.erp.mode);
export const KINDS = { in: '入库', out: '出库', adjust: '盘点调整', ship: '发货', return: '退货入库' };

// ---------------------------------------------------------------- stock movements
/**
 * Record a movement and update the local stock. kind: in / return (qty added), out / ship (qty taken), adjust (qty is the
 * counted stock, the difference is recorded). Only in local stock mode — with Kingdee the ERP owns the stock.
 */
export function moveStock(sku, { kind, qty, ref = '', note = '' }, by = actorName('system')) {
  if (!localStock()) throw new Error('已接金蝶，库存以金蝶为准，请在金蝶做出入库');
  const s = S.getSku(sku);
  if (!s) throw new Error(`SKU 不存在：${sku}`);
  if (!KINDS[kind]) throw new Error('出入库类型无效');
  const n = Number(qty);
  if (!Number.isInteger(n) || (kind === 'adjust' ? n < 0 : n <= 0)) throw new Error(kind === 'adjust' ? '盘点数量须为不小于 0 的整数' : '数量须为正整数');
  const cur = Number(s.stock_local) || 0;
  const delta = kind === 'adjust' ? n - cur : ['in', 'return'].includes(kind) ? n : -n;
  if (kind === 'out' && cur + delta < 0) throw new Error(`${sku} 库存只有 ${cur}，不能出库 ${n}`);
  const balance = cur + delta;
  db.prepare('UPDATE skus SET stock_local = ?, updated_at = ? WHERE sku = ?').run(balance, now(), sku);
  db.prepare('INSERT INTO stock_moves (ts, sku, qty, kind, ref, note, by, balance) VALUES (?,?,?,?,?,?,?,?)').run(now(), sku, delta, kind, String(ref).slice(0, 60), String(note).slice(0, 200), by, balance);
  return { sku, delta, balance };
}
export function stockMoves({ sku = '', kind = '', limit = 200 } = {}) {
  const w = [], a = [];
  if (sku) { w.push('sku = ?'); a.push(sku); }
  if (kind) { w.push('kind = ?'); a.push(kind); }
  return db.prepare(`SELECT * FROM stock_moves ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...a, limit);
}
// goods leave the warehouse when a shipment is created (local stock mode); stock may go negative, which shows on the list
S.hooks.shipment.push((kind, sh) => {
  if (kind !== 'created' || !localStock()) return;
  for (const l of sh.lines || []) {
    const s = S.getSku(l.sku);
    if (!s) continue;
    const balance = (Number(s.stock_local) || 0) - Number(l.qty || 0);
    db.prepare('UPDATE skus SET stock_local = ?, updated_at = ? WHERE sku = ?').run(balance, now(), l.sku);
    db.prepare('INSERT INTO stock_moves (ts, sku, qty, kind, ref, note, by, balance) VALUES (?,?,?,?,?,?,?,?)').run(now(), l.sku, -Number(l.qty || 0), 'ship', sh.number, sh.rma_id ? '售后补发' : '', actorName('system'), balance);
  }
});

// ---------------------------------------------------------------- safety stock
export const defaultSafety = () => Number(getSetting('default_safety_stock', 20));
export function setSafetyStock(sku, value) {
  if (!S.getSku(sku)) throw new Error(`SKU 不存在：${sku}`);
  const v = value === '' || value == null ? null : Number(value);
  if (v != null && !(Number.isInteger(v) && v >= 0)) throw new Error('安全库存须为不小于 0 的整数（留空 = 使用默认值）');
  db.prepare('UPDATE skus SET safety_stock = ? WHERE sku = ?').run(v, sku);
}
/** Active SKUs whose available stock is under their safety stock. */
export function lowStock() {
  const d = defaultSafety();
  return S.stockView().filter((s) => s.active).map((s) => ({ ...s, safety: s.safety_stock ?? d })).filter((s) => s.available < s.safety).sort((a, b) => (a.available - a.safety) - (b.available - b.safety));
}
/** Daily: alert SKUs that went under their safety stock (once, until they recover). */
export function lowStockReminder() {
  const low = lowStock();
  const before = new Set(getSetting('low_stock_alerted', []));
  const fresh = low.filter((s) => !before.has(s.sku));
  if (fresh.length) alertOps(`${fresh.length} 个 SKU 低于安全库存`, fresh.slice(0, 15).map((s) => `${s.sku} 可售 ${s.available}（安全库存 ${s.safety}）`)).catch(() => {});
  setSetting('low_stock_alerted', low.map((s) => s.sku));
  return fresh.length;
}

// ---------------------------------------------------------------- picking list
/** What still has to be picked for these orders: per SKU totals and per order lines (remaining quantities). */
export function pickingList(orderIds) {
  const orders = orderIds.map((id) => S.getOrder(id)).filter(Boolean);
  if (!orders.length) throw new Error('请先勾选订单');
  const bySku = new Map();
  const perOrder = orders.map((o) => {
    const lines = S.shippedQty(o).filter((l) => l.remaining > 0).map((l) => ({ sku: l.sku, name: l.name, variant: l.variant, qty: l.remaining, unit: l.unit }));
    for (const l of lines) {
      const k = S.getSku(l.sku) || {};
      const cur = bySku.get(l.sku) || { sku: l.sku, name: l.name || k.name, variant: l.variant, qty: 0, orders: 0, pcsPerCarton: k.pcs_per_carton || null };
      cur.qty += l.qty; cur.orders++;
      bySku.set(l.sku, cur);
    }
    return { id: o.id, number: o.number, company: S.getCustomer(o.customer_id)?.company || '', lines, packing: S.packingFor(lines) };
  });
  const stock = new Map(S.stockView().map((s) => [s.sku, s]));
  const skus = [...bySku.values()].map((x) => ({ ...x, cartons: x.pcsPerCarton ? Math.ceil(x.qty / x.pcsPerCarton) : null, onHand: stock.get(x.sku)?.on_hand ?? null })).sort((a, b) => a.sku.localeCompare(b.sku));
  return { orders: perOrder, skus, totals: { orders: perOrder.length, units: skus.reduce((a, s) => a + s.qty, 0), cartons: perOrder.reduce((a, o) => a + o.packing.cartons, 0), cbm: Math.round(perOrder.reduce((a, o) => a + o.packing.cbm, 0) * 100) / 100 } };
}

// ---------------------------------------------------------------- bulk shipping
/** Parse "order number, carrier, tracking number[, mode]" lines (tabs or commas; header optional). */
export function parseShipLines(text) {
  const rows = [];
  for (const [i, line] of String(text || '').split(/\r?\n/).entries()) {
    const c = line.split(/[,\t]/).map((x) => x.trim());
    if (!c[0] || /^(order|订单)/i.test(c[0])) continue;
    rows.push({ line: i + 1, order: c[0], carrier: c[1] || '', tracking_no: c[2] || '', mode: c[3] || 'express' });
  }
  return rows;
}
/**
 * Ship several orders: for each, a shipment of everything still unshipped with the carrier and tracking number, marked
 * in transit (the customer is told). Each line succeeds or fails on its own. Returns [{ order, ok, shipment | error }].
 */
export function bulkShip(rows, by = actorName('system')) {
  const MODES = ['sea', 'air', 'express', 'rail', 'truck'];
  return rows.map((r) => {
    try {
      const o = S.getOrder(r.order);
      if (!o) throw new Error('订单不存在');
      if (!r.tracking_no) throw new Error('缺少运单号');
      if (!MODES.includes(r.mode)) throw new Error(`运输方式应为 ${MODES.join(' / ')}`);
      const sh = S.createShipment({ order_id: o.id, mode: r.mode, carrier: r.carrier, tracking_no: r.tracking_no }, by);
      S.addShipmentEvent(sh.id, { status: 'in_transit', note: `${r.carrier} ${r.tracking_no}`.trim() }, by);
      return { line: r.line, order: o.number, ok: true, shipment: sh.number };
    } catch (e) { return { line: r.line, order: r.order, ok: false, error: e.message }; }
  });
}
export const readyToShip = () => S.listOrders("WHERE o.status = 'ready_to_ship' OR (o.status = 'shipped' AND o.id IN (SELECT order_id FROM shipments))").filter((o) => S.shippedQty(o).some((l) => l.remaining > 0));

// ---------------------------------------------------------------- carriers
/** Quoted options for a destination / weight, plus each carrier's record: shipments, average transit days, exceptions. */
export function carrierComparison({ country = '', weightKg = 0, cbm = 0 } = {}) {
  const quotes = country ? quoteShipping({ country, weightKg: Number(weightKg) || 0, cbm: Number(cbm) || 0, subtotal: 0 }).sort((a, b) => a.fee - b.fee) : [];
  const stats = new Map();
  for (const s of db.prepare("SELECT carrier, mode, status, events FROM shipments WHERE carrier IS NOT NULL AND carrier != ''").all()) {
    const k = s.carrier.trim();
    const x = stats.get(k) || { carrier: k, modes: new Set(), shipments: 0, delivered: 0, exceptions: 0, transitDays: [] };
    x.shipments++; x.modes.add(s.mode);
    const ev = J(s.events);
    if (ev.some((e) => e.status === 'exception')) x.exceptions++;
    const start = ev.find((e) => e.status === 'in_transit')?.ts, end = ev.find((e) => e.status === 'delivered')?.ts;
    if (end) x.delivered++;
    if (start && end) x.transitDays.push((Date.parse(end) - Date.parse(start)) / 86400e3);
    stats.set(k, x);
  }
  const carriers = [...stats.values()].map((x) => ({ carrier: x.carrier, modes: [...x.modes], shipments: x.shipments, delivered: x.delivered, exceptions: x.exceptions, exceptionRate: x.shipments ? x.exceptions / x.shipments : 0,
    avgDays: x.transitDays.length ? Math.round((x.transitDays.reduce((a, b) => a + b, 0) / x.transitDays.length) * 10) / 10 : null })).sort((a, b) => b.shipments - a.shipments);
  return { quotes, carriers, zones: listZones() };
}

export function startWarehouseJobs() {
  registerJob({ id: 'low-stock', name: '低库存提醒', schedule: dailyAt(8), run: () => `${lowStockReminder()} 个 SKU 新低于安全库存` });
}
