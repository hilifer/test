// Parcel / container tracking via 17TRACK (one API for 3,000+ carriers: DHL, FedEx, UPS, sea lines…).
// Shipments with a tracking number are registered automatically and polled every 2 hours; status changes are
// written to the shipment (which cascades to the order) and e-mailed to the buyer.
// ⚠ Field names follow 17TRACK API v2.2 — verify against the current 17TRACK docs when connecting the real key.
import { db } from '../db.js';
import { migrate, addColumn } from '../migrate.js';
import { getShipment, addShipmentEvent } from '../ops/service.js';
import { canMove } from '../../../shared/dictionary.js';
import './schema.js';
import { registerJob, every } from '../jobs.js';

migrate([{ id: '2026-10-22-tracking', up: () => { for (const [c, t] of [['track_registered', 'INTEGER DEFAULT 0'], ['track_status', 'TEXT'], ['track_checked_at', 'TEXT'], ['track_error', 'TEXT']]) addColumn('shipments', c, t); } }]);

const key = () => process.env.TRACK17_KEY || '';
const base = () => (process.env.TRACK17_API_BASE || 'https://api.17track.net').replace(/\/$/, '');
export const trackingEnabled = () => Boolean(key());

/** 17TRACK status → our shipment status (null = no change). */
export function mapStatus(s) {
  return ({ InTransit: 'in_transit', OutForDelivery: 'in_transit', AvailableForPickup: 'arrived', Delivered: 'delivered', Exception: 'exception', DeliveryFailure: 'exception', Expired: 'exception' })[s] || null;
}

async function call(path, body) {
  const r = await fetch(`${base()}/track/v2.2/${path}`, { method: 'POST', headers: { '17token': key(), 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.code !== 0) throw new Error(`17TRACK ${path}: ${j.data?.errors?.[0]?.message || j.message || r.status}`);
  return j.data || {};
}

/** Move a shipment to `to`, stepping through in_transit when needed (booked → delivered is not a legal jump). */
function advance(s, to, note, location) {
  if (s.status === to) return false;
  if (!canMove('shipment', s.status, to) && canMove('shipment', s.status, 'in_transit') && canMove('shipment', 'in_transit', to)) addShipmentEvent(s.id, { status: 'in_transit', note: 'auto' }, 'system');
  const cur = getShipment(s.id);
  if (!canMove('shipment', cur.status, to)) return false;
  addShipmentEvent(s.id, { status: to, location: location || '', note: note || '' }, 'system');
  return true;
}

export async function syncTracking({ ids = null } = {}) {
  if (!trackingEnabled()) return { skipped: true };
  const rows = ids
    ? ids.map(getShipment).filter(Boolean)
    : db.prepare("SELECT id FROM shipments WHERE tracking_no != '' AND status NOT IN ('delivered') AND created_at > ?").all(new Date(Date.now() - 120 * 864e5).toISOString()).map((r) => getShipment(r.id));
  const todo = rows.filter((s) => s.tracking_no);
  if (!todo.length) return { checked: 0, changed: 0 };
  const now = new Date().toISOString();
  const unregistered = todo.filter((s) => !s.track_registered);
  if (unregistered.length) {
    const d = await call('register', unregistered.map((s) => ({ number: s.tracking_no })));
    for (const a of d.accepted || []) db.prepare('UPDATE shipments SET track_registered = 1, track_error = NULL WHERE tracking_no = ?').run(a.number);
    for (const x of d.rejected || []) {
      // -18019901 = already registered: fine
      if (String(x.error?.code) === '-18019901') db.prepare('UPDATE shipments SET track_registered = 1 WHERE tracking_no = ?').run(x.number);
      else db.prepare('UPDATE shipments SET track_error = ? WHERE tracking_no = ?').run(String(x.error?.message || 'rejected').slice(0, 200), x.number);
    }
  }
  const d = await call('gettrackinfo', todo.map((s) => ({ number: s.tracking_no })));
  let changed = 0;
  for (const a of d.accepted || []) {
    const info = a.track_info || {};
    const raw = info.latest_status?.status;
    const ev = info.latest_event || info.tracking?.providers?.[0]?.events?.[0] || {};
    for (const s of todo.filter((x) => x.tracking_no === a.number)) {
      db.prepare('UPDATE shipments SET track_status = ?, track_checked_at = ? WHERE id = ?').run(raw || null, now, s.id);
      const to = mapStatus(raw);
      if (to && advance(getShipment(s.id), to, ev.description, ev.location)) changed++;
    }
  }
  return { checked: todo.length, changed };
}

export function startTrackingJob() {
  registerJob({ id: 'tracking', name: '17TRACK 物流轨迹同步', schedule: every(2 * 3600e3, { initialDelay: 30e3 }), enabled: trackingEnabled, note: 'TRACK17_KEY',
    run: async () => { const r = await syncTracking(); return `查询 ${r.checked}，更新 ${r.changed}`; } });
}
