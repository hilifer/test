// ERP facade: picks the adapter (local / mock / kingdee), pushes orders, syncs stock.
import { config } from '../../config.js';
import { db } from '../../db.js';
import { kingdee } from './kingdee.js';
import { listSkus, getSku, getCustomer, getOrder, getQuote, setOrderErp, replaceInventory, logEvent } from '../service.js';
import { registerJob, every } from '../../jobs.js';

db.exec('CREATE TABLE IF NOT EXISTS erp_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, action TEXT, ok INTEGER, detail TEXT)');
const log = (action, ok, detail) => db.prepare('INSERT INTO erp_log (ts, action, ok, detail) VALUES (?,?,?,?)').run(new Date().toISOString(), action, ok ? 1 : 0, String(detail).slice(0, 2000));
export const erpLog = (n = 50) => db.prepare('SELECT * FROM erp_log ORDER BY id DESC LIMIT ?').all(n);

// Simulated Kingdee — lets the whole loop be exercised before the real ERP is connected.
const mock = {
  mode: 'mock',
  async test() { return '模拟模式：未连接真实金蝶'; },
  async pushCustomer() { return `CUST${String(Date.now()).slice(-6)}`; },
  async pushSalesOrder() { return `XSDD${String(Date.now()).slice(-6)}`; },
  async pullInventory(materialToSku) {
    return listSkus().map((s, i) => ({ sku: s.sku, material: s.erp_number || s.sku, warehouse: i % 2 ? '成品仓' : '外贸仓', qty: 200 + ((i * 137) % 900) })).map((r) => ({ ...r, sku: materialToSku(r.material) || r.sku }));
  },
  // existing SKUs + two materials that are not on the website yet (to demo AI auto-listing)
  async pullMaterials() { return [...listSkus().map((s) => ({ number: s.erp_number || s.sku, name: s.name, spec: s.variant })), ...(MOCK_NEW[config.site] || [])]; },
};
const MOCK_NEW = {
  led: [
    { number: 'MAT-LED-9001', name: 'LED 防爆灯 100W Explosion-proof light', spec: 'Power: 100W; Efficacy: 130lm/W; IP66; CCT: 5000K; Ex d IIC T6 Gb' },
    { number: 'MAT-LED-9002', name: 'LED Tunnel Light 150W', spec: 'Power: 150W; Efficacy: 140lm/W; IP66; IK08; Beam: 30x70' },
  ],
  grid: [
    { number: 'MAT-GRID-9001', name: '户用储能电池 10kWh Home battery', spec: 'Capacity: 10.24kWh; Voltage: 51.2V; Cycles: 6000; LiFePO4; IP65' },
    { number: 'MAT-GRID-9002', name: 'Portable Power Station 2kWh', spec: 'Capacity: 2048Wh; AC output: 2200W; LiFePO4; Weight: 22kg' },
  ],
};

export function adapter() {
  if (config.erp.mode === 'kingdee') return kingdee;
  if (config.erp.mode === 'mock') return mock;
  return null;
}
export const erpLabel = () => ({ kingdee: '金蝶云星空', mock: '金蝶（模拟）', local: '未接 ERP（本地库存）', none: '未接 ERP' })[config.erp.mode] || config.erp.mode;

function materialToSku(material) {
  const s = listSkus().find((x) => (x.erp_number || x.sku) === material);
  return s?.sku || null;
}

export async function testConnection() {
  const a = adapter();
  if (!a) return '当前为本地库存模式（ERP_MODE=local）';
  try { const m = await a.test(); log('test', true, m); return m; } catch (e) { log('test', false, e.message); throw e; }
}

/** Push customer (if needed) + sales order to the ERP. Safe to retry. */
export async function pushOrder(orderId) {
  const a = adapter();
  if (!a) return { skipped: true };
  const o = getOrder(orderId);
  if (o.erp_bill_no) return { already: o.erp_bill_no };
  let c = getCustomer(o.customer_id);
  try {
    if (!c.erp_number) {
      const num = await a.pushCustomer(c);
      db.prepare('UPDATE customers SET erp_number = ? WHERE id = ?').run(num, c.id);
      logEvent('customer', c.id, 'erp_synced', { note: num });
      c = getCustomer(c.id);
    }
    const q = getQuote(o.quote_id);
    const lead = Math.max(0, ...o.lines.map((l) => config.catalog.products.find((p) => l.sku.startsWith(p.id))?.leadTimeDays?.[1] || 0));
    const promised = o.promised_date || new Date(Date.now() + (lead || 30) * 864e5).toISOString().slice(0, 10);
    const bill = await a.pushSalesOrder({ ...o, promised_date: promised, quote_number: q?.number, freight: q?.freight || 0, discount: q?.discount || 0 }, c, getSku);
    setOrderErp(o.id, { bill_no: bill });
    log('push_order', true, `${o.number} → ${bill}`);
    return { bill };
  } catch (e) {
    setOrderErp(o.id, { error: e.message });
    log('push_order', false, `${o.number}: ${e.message}`);
    return { error: e.message };
  }
}

export async function syncInventory() {
  const a = adapter();
  if (!a) return { skipped: true };
  try {
    const rows = await a.pullInventory(materialToSku);
    replaceInventory(rows);
    log('sync_inventory', true, `${rows.length} 行`);
    return { rows: rows.length };
  } catch (e) { log('sync_inventory', false, e.message); return { error: e.message }; }
}

export async function pullMaterials() {
  const a = adapter();
  if (!a) return [];
  return a.pullMaterials();
}

export function startErpSync() {
  registerJob({ id: 'erp-sync', name: '金蝶库存同步', schedule: every(Math.max(5, config.erp.syncMinutes) * 60e3), enabled: () => Boolean(adapter()), note: 'ERP_MODE / KD_*',
    run: async () => { const r = await syncInventory(); if (r?.error) throw new Error(r.error); return `${r?.rows ?? 0} 行`; } });
}
