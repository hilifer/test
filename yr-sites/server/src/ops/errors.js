// Error log (错误日志): server errors grouped by fingerprint (where + what), with counts, first / last time and a
// "resolved" flag. A new error — or one that comes back after being marked resolved — is pushed to WeCom, at most once
// per hour per error. Sources: unhandled request errors, failed scheduled jobs, unhandled promise rejections.
import { createHash } from 'node:crypto';
import { db } from '../db.js';
import { migrate } from '../migrate.js';
import { alertOps } from '../alerts.js';

migrate([{
  id: '2026-11-04-app-errors',
  up: () => db.exec(`CREATE TABLE app_errors (id INTEGER PRIMARY KEY AUTOINCREMENT, fingerprint TEXT UNIQUE NOT NULL, source TEXT, method TEXT, path TEXT, message TEXT, stack TEXT,
    count INTEGER NOT NULL DEFAULT 1, first_at TEXT, last_at TEXT, resolved INTEGER NOT NULL DEFAULT 0, resolved_by TEXT, alerted_at TEXT);
    CREATE INDEX app_errors_last ON app_errors(last_at);`),
}]);
const now = () => new Date().toISOString();
// ids, numbers and hashes in paths / messages would make every occurrence look new
const normalise = (s) => String(s || '').replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id').replace(/\b[0-9a-f]{16,}\b/gi, ':hex').replace(/\d+/g, 'N').slice(0, 300);

/** Record an error. source: 'request' | 'job' | 'process'. Returns the row id. */
export function recordError(err, { source = 'request', method = '', path = '' } = {}) {
  const message = String(err?.message || err || 'unknown error').slice(0, 500);
  const stack = String(err?.stack || '').split('\n').slice(0, 12).join('\n').slice(0, 3000);
  const fp = createHash('sha1').update(`${source}|${method}|${normalise(path.split('?')[0])}|${normalise(message)}`).digest('hex').slice(0, 20);
  const ts = now();
  const cur = db.prepare('SELECT * FROM app_errors WHERE fingerprint = ?').get(fp);
  let fresh = false;
  if (!cur) { db.prepare('INSERT INTO app_errors (fingerprint, source, method, path, message, stack, first_at, last_at) VALUES (?,?,?,?,?,?,?,?)').run(fp, source, method, path.slice(0, 300), message, stack, ts, ts); fresh = true; }
  else { fresh = Boolean(cur.resolved); db.prepare('UPDATE app_errors SET count = count + 1, last_at = ?, message = ?, stack = ?, path = ?, resolved = 0 WHERE id = ?').run(ts, message, stack || cur.stack, path.slice(0, 300) || cur.path, cur.id); }
  const row = db.prepare('SELECT * FROM app_errors WHERE fingerprint = ?').get(fp);
  if (fresh && (!row.alerted_at || Date.now() - Date.parse(row.alerted_at) > 3600e3)) {
    db.prepare('UPDATE app_errors SET alerted_at = ? WHERE id = ?').run(ts, row.id);
    alertOps(cur ? '错误再次出现' : '服务器新错误', [`${source === 'job' ? '定时任务' : source === 'process' ? '后台进程' : `${method} ${path}`}`, message.slice(0, 300)]).catch(() => {});
  }
  return row.id;
}

export function searchErrors({ q = '', status = 'open', from = '', to = '', limit = 200 } = {}) {
  const w = [], a = [];
  if (status === 'open') w.push('resolved = 0'); else if (status === 'resolved') w.push('resolved = 1');
  if (q) { w.push('(message LIKE ? OR path LIKE ?)'); a.push(`%${q}%`, `%${q}%`); }
  if (from) { w.push('last_at >= ?'); a.push(from); }
  if (to) { w.push('last_at < ?'); a.push(`${to}T99`); }
  return db.prepare(`SELECT * FROM app_errors ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY last_at DESC LIMIT ?`).all(...a, limit);
}
export const getError = (id) => db.prepare('SELECT * FROM app_errors WHERE id = ?').get(id) || null;
export function resolveErrors(ids, by) { for (const id of ids) db.prepare('UPDATE app_errors SET resolved = 1, resolved_by = ? WHERE id = ?').run(by, Number(id)); }
/** Errors seen in the last N hours (count of distinct errors and of occurrences since they were first seen). */
export function errorStats(hours = 24) {
  const since = new Date(Date.now() - hours * 3600e3).toISOString();
  const r = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(count), 0) total FROM app_errors WHERE last_at >= ?').get(since);
  return { distinct: r.n, open: db.prepare('SELECT COUNT(*) n FROM app_errors WHERE resolved = 0').get().n, occurrences: r.total };
}
