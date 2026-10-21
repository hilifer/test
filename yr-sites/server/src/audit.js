// Unified operation log: every change made in the admin (who, when, which page/record, what was submitted, result, IP),
// plus logins and logouts. Passwords and secrets are never stored. Read-only pages are not logged.
import { db } from './db.js';
import { migrate } from './migrate.js';

migrate([{
  id: '2026-10-29-audit-log',
  up: () => db.exec(`CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, username TEXT, roles TEXT, action TEXT, method TEXT, path TEXT,
      entity TEXT, entity_id TEXT, status INTEGER, ok INTEGER, message TEXT, fields TEXT, ip TEXT);
    CREATE INDEX idx_audit_ts ON audit_log(ts); CREATE INDEX idx_audit_user ON audit_log(username, ts); CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);`),
}]);

const SECRET = /pass|password|secret|token|key$|_key|signature/i;
/** Form fields worth recording: no secrets, short values, at most 30 fields. */
export function cleanFields(fields = {}) {
  const out = {};
  for (const [k, v] of Object.entries(fields).slice(0, 30)) {
    if (SECRET.test(k)) { out[k] = '***'; continue; }
    const val = Array.isArray(v) ? v.map((x) => (typeof x === 'object' ? `[file ${x?.name || ''}]` : String(x))).join(', ') : typeof v === 'object' && v ? `[file ${v.name || ''}]` : String(v ?? '');
    out[k] = val.length > 200 ? `${val.slice(0, 200)}…` : val;
  }
  return out;
}

/** /admin/orders/abc/payment → { entity: 'orders', id: 'abc', action: 'payment' } */
export function describePath(path) {
  const parts = String(path).replace(/^\/admin\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const [entity = 'admin', id = '', ...rest] = parts;
  if (parts.length === 1) return { entity, id: '', action: 'post' };
  if (parts.length === 2 && /^(new|bulk|publish|import|backup|lang|floors|policy|settings|template|featured-max|erp|sheet|text|run)$/.test(id)) return { entity, id: '', action: id };
  return { entity, id, action: rest.join('/') || 'save' };
}

export function record({ username, roles = '', method = 'POST', path, status = 200, message = '', fields = {}, ip = '', action = null }) {
  const d = describePath(path);
  db.prepare('INSERT INTO audit_log (ts, username, roles, action, method, path, entity, entity_id, status, ok, message, fields, ip) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(new Date().toISOString(), username || '', roles, action || d.action, method, String(path).slice(0, 300), d.entity, d.id, status, status < 400 && !/^e=/.test(message) ? 1 : 0,
      String(message || '').slice(0, 500), JSON.stringify(cleanFields(fields)), String(ip || '').slice(0, 64));
}

export function search({ user = '', entity = '', q = '', from = '', to = '', ok = '', limit = 200, offset = 0 } = {}) {
  const where = [], args = [];
  if (user) { where.push('username = ?'); args.push(user); }
  if (entity) { where.push('entity = ?'); args.push(entity); }
  if (q) { where.push('(path LIKE ? OR entity_id LIKE ? OR message LIKE ? OR fields LIKE ?)'); args.push(...Array(4).fill(`%${q}%`)); }
  if (from) { where.push('ts >= ?'); args.push(from); }
  if (to) { where.push('ts <= ?'); args.push(`${to}T23:59:59.999Z`); }
  if (ok === '1' || ok === '0') { where.push('ok = ?'); args.push(Number(ok)); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return {
    total: db.prepare(`SELECT COUNT(*) n FROM audit_log ${w}`).get(...args).n,
    rows: db.prepare(`SELECT * FROM audit_log ${w} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset),
  };
}
export const auditUsers = () => db.prepare('SELECT DISTINCT username FROM audit_log ORDER BY username').all().map((r) => r.username);
export const auditEntities = () => db.prepare('SELECT DISTINCT entity FROM audit_log ORDER BY entity').all().map((r) => r.entity);
