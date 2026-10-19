// Freight templates: zone (list of ISO country codes, "*" = rest of world) × method, first-weight + per-kg,
// volumetric weight from carton data, free shipping threshold, delivery days. Edited in /admin/shop/freight.
import { db } from '../db.js';
import './schema.js';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const listZones = ({ all = false } = {}) => db.prepare(`SELECT * FROM freight_zones ${all ? '' : 'WHERE active = 1'} ORDER BY sort, id`).all();

export function saveZone(z) {
  const countries = String(z.countries || '').toUpperCase().split(/[\s,;，]+/).filter(Boolean);
  const errors = [];
  if (!String(z.name || '').trim()) errors.push('名称必填');
  if (!countries.length || countries.some((c) => c !== '*' && !/^[A-Z]{2}$/.test(c))) errors.push('国家代码用两位 ISO 代码，逗号分隔；"*" 表示其他所有国家');
  const n = (k, { req = true } = {}) => { const v = z[k] === '' || z[k] == null ? null : Number(z[k]); if ((req && v == null) || (v != null && !(v >= 0))) errors.push(`${k} 必须是 ≥0 的数字`); return v; };
  const row = { name: String(z.name || '').trim(), countries: countries.join(','), method: String(z.method || 'express'), first_kg: n('first_kg'), first_fee: n('first_fee'), extra_fee_per_kg: n('extra_fee_per_kg'),
    volumetric_divisor: n('volumetric_divisor', { req: false }) || 5000, free_over: n('free_over', { req: false }), days_min: n('days_min'), days_max: n('days_max'), active: z.active === false || z.active === '0' ? 0 : 1, sort: Number(z.sort) || 0 };
  if (row.days_min != null && row.days_max != null && row.days_min > row.days_max) errors.push('时效最短天数不能大于最长天数');
  if (!(row.first_kg > 0)) errors.push('首重必须大于 0');
  if (errors.length) throw Object.assign(new Error(errors.join('；')), { errors });
  if (z.id) db.prepare('UPDATE freight_zones SET name=@name, countries=@countries, method=@method, first_kg=@first_kg, first_fee=@first_fee, extra_fee_per_kg=@extra_fee_per_kg, volumetric_divisor=@volumetric_divisor, free_over=@free_over, days_min=@days_min, days_max=@days_max, active=@active, sort=@sort WHERE id=@id').run({ ...row, id: Number(z.id) });
  else db.prepare('INSERT INTO freight_zones (name, countries, method, first_kg, first_fee, extra_fee_per_kg, volumetric_divisor, free_over, days_min, days_max, active, sort) VALUES (@name,@countries,@method,@first_kg,@first_fee,@extra_fee_per_kg,@volumetric_divisor,@free_over,@days_min,@days_max,@active,@sort)').run(row);
}
export const deleteZone = (id) => db.prepare('DELETE FROM freight_zones WHERE id = ?').run(Number(id));

/**
 * Shipping options for a parcel. parcel = { country, weightKg, cbm, subtotal }.
 * Chargeable weight = max(actual, volumetric = cbm × 1,000,000 / divisor). Returns cheapest first.
 */
export function quoteShipping({ country, weightKg, cbm = 0, subtotal = 0 }) {
  const cc = String(country || '').toUpperCase();
  const zones = listZones();
  let match = zones.filter((z) => z.countries.split(',').includes(cc));
  if (!match.length) match = zones.filter((z) => z.countries.split(',').includes('*'));
  return match.map((z) => {
    const vol = cbm > 0 ? (cbm * 1e6) / (z.volumetric_divisor || 5000) : 0;
    const chargeable = Math.max(Number(weightKg) || 0, vol);
    const free = z.free_over != null && subtotal >= z.free_over;
    const fee = free ? 0 : r2(z.first_fee + Math.max(0, Math.ceil(chargeable - z.first_kg)) * z.extra_fee_per_kg);
    return { zoneId: z.id, name: z.name, method: z.method, fee, free, chargeableKg: r2(chargeable), days: [z.days_min, z.days_max], freeOver: z.free_over };
  }).sort((a, b) => a.fee - b.fee);
}
