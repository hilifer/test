// Black-box: system status page and database backups over HTTP — admin only, backup button, download is a valid gzip
// SQLite file, no path traversal. IDs SY-xx.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { startServer, flash } from '../helpers/server.mjs';

let api;
before(async () => { api = await startServer({ site: 'led', env: { APP_VERSION: 'test-1.2.3' } }); });
after(async () => { await api.stop(); });
const PW = 'Str0ngPassw0rd';
const as = (u) => (p, opts = {}) => fetch(api.url + p, { redirect: 'manual', ...opts, headers: { authorization: 'Basic ' + Buffer.from(`${u}:${PW}`).toString('base64'), ...(opts.headers || {}) } });
const ctx = {};
/** The admin's system page before any backup is made (fetched once). */
const firstPage = async () => (ctx.page ??= await (await api.admin('/admin/system')).text());

test('SY-01a finance and sales users are refused the system page and the backup button (403)', async () => {
  for (const [u, role] of [['fin1', 'finance'], ['sales1', 'sales']]) await api.form('/admin/users/new', { username: u, role, password: PW });
  assert.equal((await as('fin1')('/admin/system')).status, 403);
  assert.equal((await as('sales1')('/admin/system/backup', { method: 'POST' })).status, 403);
});

test('SY-01b anonymous visitors get 401 on the system page', async () => {
  assert.equal((await api.get('/admin/system')).status, 401);
});

test('SY-01c the system page shows the running app version', async () => {
  assert.match(await firstPage(), /test-1\.2\.3/);
});

test('SY-01d the system page warns that there was no successful backup in the last 36 hours', async () => {
  assert.match(await firstPage(), /最近 36 小时没有成功的数据库备份/);
});

test('SY-01e the system page warns that no off-site copy is configured and links the backup guide', async () => {
  const page = await firstPage();
  assert.match(page, /尚未配置异地复制/);
  assert.match(page, /2026-10-27-backups/);
});

test('SY-02a the backup button reports a finished backup whose restore check passed', async () => {
  const r = flash(await api.form('/admin/system/backup', {}));
  assert.match(r.ok, /备份完成：yr-led-.+\.sqlite\.gz.*恢复校验通过/);
});

test('SY-02b after a backup the stale-backup warning is gone and the file is listed', async () => {
  const page = await (await api.admin('/admin/system')).text();
  assert.doesNotMatch(page, /最近 36 小时没有成功/);
  ctx.file = page.match(/\/admin\/system\/backups\/(yr-led-[\w-]+\.sqlite\.gz)/)[1];
});

test('SY-02c downloading a listed backup returns 200 as an attachment', async () => {
  const dl = await api.admin(`/admin/system/backups/${ctx.file}`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /attachment/);
  ctx.body = Buffer.from(await dl.arrayBuffer());
});

test('SY-02d the downloaded backup is a gzip of a real SQLite database', async () => {
  assert.equal(gunzipSync(ctx.body).subarray(0, 15).toString(), 'SQLite format 3');
});

test('SY-02e a non-admin cannot download a backup file (403)', async () => {
  assert.equal((await as('fin1')(`/admin/system/backups/${ctx.file}`)).status, 403);
});

test('SY-03a downloads refuse path traversal, the raw database and unlisted backup names (404)', async () => {
  for (const p of ['..%2F..%2Fetc%2Fpasswd', 'db.sqlite', 'yr-led-2020-01-01T00-00-00-000.sqlite.gz']) assert.equal((await api.admin(`/admin/system/backups/${p}`)).status, 404, p);
});

test('SY-03b a cross-site POST to the backup button is refused (403)', async () => {
  assert.equal((await fetch(`${api.url}/admin/system/backup`, { method: 'POST', redirect: 'manual', headers: { authorization: 'Basic ' + Buffer.from('admin:test-pass').toString('base64'), origin: 'https://evil.test' } })).status, 403);
});
