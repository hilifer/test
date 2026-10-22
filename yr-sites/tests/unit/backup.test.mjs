// Modules: server/src/ops/backup.js — online snapshot, gzip, restore check, rotation, off-site copy command, system
// status. IDs BK-xx.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { useTempEnv, tempDir } from '../helpers/env.mjs';

const dir = tempDir('yr-bk-');
const offsite = tempDir('yr-offsite-');
useTempEnv({ site: 'led', BACKUP_DIR: dir, BACKUP_KEEP: '2' });
const B = await import('../../server/src/ops/backup.js');
await import('../../server/src/catalog/store.js'); // products table + seed
const { db } = await import('../../server/src/db.js');

describe('backups', () => {
  const bk = {};
  test('BK-01a a backup run succeeds and its restore check passes with our data inside', async () => {
    db.prepare("INSERT INTO leads (id, site, created_at, email, grade) VALUES ('bk-lead', 'led', ?, 'bk@test.test', 'A')").run(new Date().toISOString());
    const r = bk.r = await B.backupNow();
    assert.equal(r.ok, true);
    assert.equal(r.verify.integrity, 'ok');
    assert.ok(r.verify.tables.products > 0);
    assert.equal(r.verify.tables.leads, 1);
  });
  test('BK-01b the backup file is a gzipped SQLite database', () => {
    const raw = gunzipSync(readFileSync(join(dir, bk.r.file)));
    assert.equal(raw.subarray(0, 15).toString(), 'SQLite format 3');
  });
  test('BK-01c the backup is listed and the run is logged as successful', () => {
    assert.deepEqual(B.listBackups().map((b) => b.file), [bk.r.file]);
    assert.equal(B.backupRuns()[0].ok, 1);
  });
  test('BK-02a concurrent backup requests share one run', async () => {
    const [a, b] = await Promise.all([B.backupNow(), B.backupNow()]);
    assert.equal(a.file, b.file);
  });
  test('BK-02b rotation keeps the newest BACKUP_KEEP files', async () => {
    await B.backupNow();
    const files = B.listBackups();
    assert.equal(files.length, 2);
    assert.ok(files.some((f) => f.file === B.backupRuns()[0].file)); // the newest is always kept, even within the same second
  });
  test('BK-03a the off-site copy command receives the backup file', async () => {
    const script = join(offsite, 'copy.cjs');
    writeFileSync(script, "require('fs').copyFileSync(process.argv[2], require('path').join(__dirname, 'copy.gz'));");
    process.env.BACKUP_CMD = `node ${JSON.stringify(script)} {file}`;
    try {
      const ok = await B.backupNow();
      assert.equal(ok.ok, true, JSON.stringify(ok));
      assert.equal(ok.offsite.ok, true);
      assert.ok(existsSync(join(offsite, 'copy.gz')));
    } finally { delete process.env.BACKUP_CMD; }
  });
  test('BK-03b a failing off-site copy command marks the run failed', async () => {
    process.env.BACKUP_CMD = 'node -e "process.exit(3)"';
    try {
      const bad = await B.backupNow();
      assert.equal(bad.ok, false);
      assert.equal(B.backupRuns()[0].ok, 0);
    } finally { delete process.env.BACKUP_CMD; }
  });
  test('BK-07 rapid back-to-back backups: the newest is never the one rotated out (regression)', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await B.backupNow();
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(B.listBackups()[0].file, r.file);
    }
  });
  test('BK-04 a corrupt backup fails verification', async () => {
    const f = join(dir, 'corrupt.sqlite.gz');
    writeFileSync(f, 'not a gzip');
    await assert.rejects(B.verifyBackup(f));
  });
  test('BK-05a download paths with traversal are rejected', () => {
    assert.equal(B.backupPath('../../etc/passwd'), null);
    assert.equal(B.backupPath('yr-led-2026-01-01T00-00-00-000.sqlite.gz/../x'), null);
  });
  test('BK-05b a valid backup file name resolves inside the backup directory', () => {
    assert.ok(B.backupPath('yr-led-2026-01-01T00-00-00-000.sqlite.gz').startsWith(dir));
  });
  test('BK-06a system status reports the database size', () => {
    assert.ok(B.systemStatus().db.bytes > 0);
  });
  test('BK-06b system status lists the applied migrations', () => {
    assert.ok(B.systemStatus().migrations.some((m) => m.id === '2026-10-27-backups'));
  });
  test('BK-06c system status reports uptime and memory use', () => {
    const s = B.systemStatus();
    assert.ok(s.uptimeSec >= 0 && s.rssMb > 0);
  });
});
