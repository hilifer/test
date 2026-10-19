// Versioned schema migrations. Each migration runs once, in order, inside a transaction, and is
// recorded in schema_migrations — so a running production database is upgraded safely on deploy.
import { db } from './db.js';

db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT)');

export const hasColumn = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
export const addColumn = (table, col, type) => { if (!hasColumn(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); };

/** migrations: [{ id: '2026-10-20-products', up: () => {...} }] */
export function migrate(migrations) {
  const done = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id));
  for (const m of migrations) {
    if (done.has(m.id)) continue;
    db.exec('BEGIN');
    try {
      m.up(db);
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(m.id, new Date().toISOString());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${m.id} failed: ${e.message}`);
    }
  }
}
