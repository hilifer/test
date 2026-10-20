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
  test('BK-01 backup = consistent snapshot, gzip, restore-checked; real SQLite inside with our data', async () => {
    db.prepare("INSERT INTO leads (id, site, created_at, email, grade) VALUES ('bk-lead', 'led', ?, 'bk@test.test', 'A')").run(new Date().toISOString());
    const r = await B.backupNow();
    assert.equal(r.ok, true);
    assert.equal(r.verify.integrity, 'ok');
    assert.ok(r.verify.tables.products > 0);
    assert.equal(r.verify.tables.leads, 1);
    const raw = gunzipSync(readFileSync(join(dir, r.file)));
    assert.equal(raw.subarray(0, 15).toString(), 'SQLite format 3');
    assert.deepEqual(B.listBackups().map((b) => b.file), [r.file]);
    assert.equal(B.backupRuns()[0].ok, 1);
  });
  test('BK-02 concurrent requests share one run; rotation keeps the newest BACKUP_KEEP files', async () => {
    const [a, b] = await Promise.all([B.backupNow(), B.backupNow()]);
    assert.equal(a.file, b.file);
    await B.backupNow();
    const files = B.listBackups();
    assert.equal(files.length, 2);
    assert.ok(files.some((f) => f.file === B.backupRuns()[0].file)); // the newest is always kept, even within the same second
  });
  test('BK-03 off-site copy command receives the file; a failing command marks the run failed', async () => {
    const script = join(offsite, 'copy.cjs');
    writeFileSync(script, "require('fs').copyFileSync(process.argv[2], require('path').join(__dirname, 'copy.gz'));");
    process.env.BACKUP_CMD = `node ${JSON.stringify(script)} {file}`;
    const ok = await B.backupNow();
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(ok.offsite.ok, true);
    assert.ok(existsSync(join(offsite, 'copy.gz')));
    process.env.BACKUP_CMD = 'node -e "process.exit(3)"';
    const bad = await B.backupNow();
    assert.equal(bad.ok, false);
    assert.equal(B.backupRuns()[0].ok, 0);
    delete process.env.BACKUP_CMD;
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
  test('BK-05 download paths only accept backup file names (no traversal)', () => {
    assert.equal(B.backupPath('../../etc/passwd'), null);
    assert.equal(B.backupPath('yr-led-2026-01-01T00-00-00-000.sqlite.gz/../x'), null);
    assert.ok(B.backupPath('yr-led-2026-01-01T00-00-00-000.sqlite.gz').startsWith(dir));
  });
  test('BK-06 system status: version, uptime, database and disk size, applied migrations', () => {
    const s = B.systemStatus();
    assert.ok(s.db.bytes > 0);
    assert.ok(s.migrations.some((m) => m.id === '2026-10-27-backups'));
    assert.ok(s.uptimeSec >= 0 && s.rssMb > 0);
  });
});
