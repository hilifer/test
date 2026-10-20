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

test('SY-01 only admins see the system page; it warns that there is no backup yet and no off-site copy', async () => {
  for (const [u, role] of [['fin1', 'finance'], ['sales1', 'sales']]) await api.form('/admin/users/new', { username: u, role, password: PW });
  assert.equal((await as('fin1')('/admin/system')).status, 403);
  assert.equal((await as('sales1')('/admin/system/backup', { method: 'POST' })).status, 403);
  assert.equal((await api.get('/admin/system')).status, 401);
  const page = await (await api.admin('/admin/system')).text();
  assert.match(page, /test-1\.2\.3/);
  assert.match(page, /最近 36 小时没有成功的数据库备份/);
  assert.match(page, /尚未配置异地复制/);
  assert.match(page, /2026-10-27-backups/);
});

test('SY-02 backup button → verified backup listed; download is a gzip of a real SQLite database', async () => {
  const r = flash(await api.form('/admin/system/backup', {}));
  assert.match(r.ok, /备份完成：yr-led-.+\.sqlite\.gz.*恢复校验通过/);
  const page = await (await api.admin('/admin/system')).text();
  assert.doesNotMatch(page, /最近 36 小时没有成功/);
  const file = page.match(/\/admin\/system\/backups\/(yr-led-[\w-]+\.sqlite\.gz)/)[1];
  const dl = await api.admin(`/admin/system/backups/${file}`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /attachment/);
  assert.equal(gunzipSync(Buffer.from(await dl.arrayBuffer())).subarray(0, 15).toString(), 'SQLite format 3');
  assert.equal((await as('fin1')(`/admin/system/backups/${file}`)).status, 403);
});

test('SY-03 downloads refuse anything that is not a listed backup file', async () => {
  for (const p of ['..%2F..%2Fetc%2Fpasswd', 'db.sqlite', 'yr-led-2020-01-01T00-00-00-000.sqlite.gz']) assert.equal((await api.admin(`/admin/system/backups/${p}`)).status, 404, p);
  assert.equal((await fetch(`${api.url}/admin/system/backup`, { method: 'POST', redirect: 'manual', headers: { authorization: 'Basic ' + Buffer.from('admin:test-pass').toString('base64'), origin: 'https://evil.test' } })).status, 403);
});
