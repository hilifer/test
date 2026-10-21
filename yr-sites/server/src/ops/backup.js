// Database backups: a consistent online snapshot (VACUUM INTO — safe while the site is serving), gzip, integrity check of
// the snapshot, rotation, and an optional off-site copy command (BACKUP_CMD, e.g. "rclone copy {file} remote:yr-backups").
// Runs daily at BACKUP_HOUR (server local time) and on demand from /admin/system.
import { mkdirSync, readdirSync, statSync, rmSync, createReadStream, createWriteStream, existsSync, statfsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { db } from '../db.js';
import { config } from '../config.js';
import { migrate } from '../migrate.js';
import { alertOps } from '../alerts.js';
import { registerJob, dailyAt } from '../jobs.js';

migrate([{ id: '2026-10-27-backups', up: () => db.exec('CREATE TABLE backup_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, file TEXT, bytes INTEGER, ok INTEGER, detail TEXT, seconds REAL)') }]);

export const backupConfig = () => ({
  dir: process.env.BACKUP_DIR || join(dirname(config.dbPath), 'backups'),
  keep: Math.max(1, Number(process.env.BACKUP_KEEP || 14)),
  hour: Number(process.env.BACKUP_HOUR ?? 3),
  cmd: process.env.BACKUP_CMD || '',
  enabled: process.env.BACKUP_ENABLED !== 'false',
});
const NAME = /^yr-[a-z]+-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}\.sqlite\.gz$/; // millisecond stamps: names sort by time

export function listBackups() {
  const { dir } = backupConfig();
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => NAME.test(f)).sort().reverse().map((f) => ({ file: f, bytes: statSync(join(dir, f)).size, ts: statSync(join(dir, f)).mtime.toISOString() }));
}
export const backupPath = (file) => (NAME.test(String(file)) ? join(backupConfig().dir, basename(file)) : null);
export const backupRuns = (n = 20) => db.prepare('SELECT * FROM backup_runs ORDER BY id DESC LIMIT ?').all(n);

function runCmd(cmd, file) {
  return new Promise((resolve) => {
    const p = spawn(cmd.replaceAll('{file}', JSON.stringify(file)), { shell: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
    const t = setTimeout(() => p.kill(), 10 * 60e3);
    p.on('close', (code) => { clearTimeout(t); resolve({ ok: code === 0, out: out.slice(-500) }); });
  });
}

/** Restore-test a backup file: decompress to a temp file, open it, PRAGMA integrity_check, count key tables. */
export async function verifyBackup(file) {
  const tmp = join(tmpdir(), `yr-verify-${process.pid}-${Date.now()}.sqlite`);
  try {
    await pipeline(createReadStream(file), createGunzip(), createWriteStream(tmp));
    const d = new DatabaseSync(tmp, { readOnly: true });
    try {
      const integrity = d.prepare('PRAGMA integrity_check').get().integrity_check;
      const count = (t) => { try { return d.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n; } catch { return null; } };
      return { ok: integrity === 'ok', integrity, tables: { products: count('products'), orders: count('orders'), customers: count('customers'), leads: count('leads'), migrations: count('schema_migrations') } };
    } finally { d.close(); }
  } finally { rmSync(tmp, { force: true }); }
}

let running = null;
/** Make a backup now. Returns { ok, file, bytes, verify, offsite }. Concurrent calls share one run. */
export function backupNow() {
  if (running) return running;
  running = (async () => {
    const started = Date.now();
    const c = backupConfig();
    mkdirSync(c.dir, { recursive: true });
    let t = Date.now();
    const nameAt = (ms) => `yr-${config.site}-${new Date(ms).toISOString().slice(0, 23).replace(/[:.]/g, '-')}.sqlite.gz`;
    while (existsSync(join(c.dir, nameAt(t))) || listBackups().some((b) => b.file >= nameAt(t))) t++; // strictly newer than any existing backup
    const name = nameAt(t);
    const raw = join(c.dir, `.${name}.tmp`);
    const out = join(c.dir, name);
    try {
      db.exec(`VACUUM INTO '${raw.replace(/'/g, "''")}'`);
      await pipeline(createReadStream(raw), createGzip({ level: 6 }), createWriteStream(`${out}.part`));
      rmSync(raw, { force: true });
      const { renameSync } = await import('node:fs');
      renameSync(`${out}.part`, out);
      const verify = await verifyBackup(out);
      if (!verify.ok) throw new Error(`integrity check failed: ${verify.integrity}`);
      const offsite = c.cmd ? await runCmd(c.cmd, out) : null;
      const all = listBackups();
      for (const b of all.slice(c.keep)) rmSync(join(c.dir, b.file), { force: true });
      const bytes = statSync(out).size;
      const detail = { verify, offsite, pruned: Math.max(0, all.length - c.keep) };
      db.prepare('INSERT INTO backup_runs (ts, file, bytes, ok, detail, seconds) VALUES (?,?,?,?,?,?)').run(new Date().toISOString(), name, bytes, offsite && !offsite.ok ? 0 : 1, JSON.stringify(detail), (Date.now() - started) / 1000);
      if (offsite && !offsite.ok) alertOps('数据库备份异地复制失败', [name, offsite.out]).catch(() => {});
      return { ok: !offsite || offsite.ok, file: name, bytes, verify, offsite };
    } catch (e) {
      for (const f of [raw, `${out}.part`]) rmSync(f, { force: true });
      db.prepare('INSERT INTO backup_runs (ts, file, bytes, ok, detail, seconds) VALUES (?,?,?,?,?,?)').run(new Date().toISOString(), name, 0, 0, JSON.stringify({ error: e.message }), (Date.now() - started) / 1000);
      alertOps('数据库备份失败', [e.message]).catch(() => {});
      return { ok: false, error: e.message };
    } finally { running = null; }
  })();
  return running;
}

export function startBackupJob() {
  const c = backupConfig();
  registerJob({ id: 'backup', name: '数据库备份', schedule: dailyAt(c.hour), enabled: () => c.enabled, note: 'BACKUP_ENABLED',
    run: async () => { const r = await backupNow(); if (!r.ok) throw new Error(r.error || r.offsite?.out || '备份失败'); return `${r.file}（${(r.bytes / 1048576).toFixed(1)} MB）`; } });
}

/** Numbers for the system page. */
export function systemStatus() {
  const size = (f) => { try { return statSync(f).size; } catch { return 0; } };
  let disk = null;
  try { const s = statfsSync(dirname(config.dbPath)); disk = { free: s.bavail * s.bsize, total: s.blocks * s.bsize }; } catch { /* not supported */ }
  return {
    version: process.env.APP_VERSION || 'dev', node: process.version, uptimeSec: Math.round(process.uptime()), rssMb: Math.round(process.memoryUsage().rss / 1048576),
    db: { path: config.dbPath, bytes: size(config.dbPath), wal: size(`${config.dbPath}-wal`) }, disk,
    migrations: db.prepare('SELECT id, applied_at FROM schema_migrations ORDER BY id').all(),
  };
}
