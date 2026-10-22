// Black-box: ops over HTTP — roles and the ops workbench, error log (real 500s), service checks, both-sites status with the
// shared token, logins / sessions / force logout / new-IP alert, configuration check, website version rollback,
// scheduled jobs (run now, pause), restore drill. Mock WeCom, Stripe and peer site. IDs OP-xx.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, flash, waitFor } from '../helpers/server.mjs';
import { mockServer } from '../helpers/mock-http.mjs';
import { tempDir } from '../helpers/env.mjs';

let api, wecom, ext;
const hooks = [];
const rel = tempDir('yr-rel-');
before(async () => {
  wecom = await mockServer((call) => { hooks.push(call.body); return { json: { errcode: 0 } }; });
  ext = await mockServer((call) => {
    if (call.url === '/v1/balance') return { json: { livemode: false } };
    if (call.url.startsWith('/api/health')) return call.headers['x-ops-token'] === 'shared' ? { json: { ok: true, site: 'grid', version: 'g-9', uptimeSec: 7200, rssMb: 99, diskFree: 5e9, backup: { ok: true, ts: '2026-10-21T01:00:00Z' }, errors24h: 3, failingServices: [] } } : { json: { ok: true, site: 'grid' } };
    return { status: 404 };
  });
  for (const n of ['2026-10-20T08-00-00-000Z', '2026-10-21T08-00-00-000Z']) { mkdirSync(join(rel, 'releases', n), { recursive: true }); writeFileSync(join(rel, 'releases', n, 'index.html'), n); }
  symlinkSync(join('releases', '2026-10-21T08-00-00-000Z'), join(rel, 'current'));
  api = await startServer({ site: 'led', env: { ERROR_TEST_ROUTE: 'true', WECOM_WEBHOOK_URL: wecom.url, STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_API_BASE: ext.url, PEER_SITES: `grid|${ext.url}`, OPS_TOKEN: 'shared', RELEASES_DIR: rel, APP_VERSION: 'led-7' } });
  for (const [u, role] of [['opsa', 'ops'], ['sam', 'sales']]) await api.form('/admin/users/new', { username: u, role, password: PW });
});
after(async () => { await api.stop(); await wecom.close(); await ext.close(); });

const PW = 'Str0ngPassw0rd';
const auth = (u) => ({ authorization: 'Basic ' + Buffer.from(`${u}:${PW}`).toString('base64') });
const form = (h, path, data) => fetch(api.url + path, { method: 'POST', redirect: 'manual', headers: { ...h, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data) });
const page = async (path, h = auth('opsa')) => (await fetch(api.url + path, { headers: h })).text();
async function session(username, ip) {
  const r = await fetch(`${api.url}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': ip }, body: new URLSearchParams({ username, password: PW }) });
  const cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  return { status: r.status, get: (p) => fetch(api.url + p, { redirect: 'manual', headers: { cookie } }) };
}

const OPS_PAGES = ['/admin/system', '/admin/system/services', '/admin/system/errors', '/admin/system/sites', '/admin/system/security', '/admin/system/config', '/admin/system/releases', '/admin/system/jobs'];
const ctx = {};

test('OP-01a the ops role can open every ops page', async () => {
  for (const p of OPS_PAGES) assert.equal((await fetch(api.url + p, { headers: auth('opsa') })).status, 200, p);
});

test('OP-01b the sales role is refused every ops page (403)', async () => {
  for (const p of OPS_PAGES) assert.equal((await fetch(api.url + p, { headers: auth('sam') })).status, 403, p);
});

test('OP-01c the ops workbench shows the system board (sites online, last backup, disk, errors, failing services)', async () => {
  ctx.home = await page('/admin/home');
  for (const k of ['运维：系统', '站点在线', '最近备份', '磁盘剩余', '24 小时错误', '外部服务异常']) assert.ok(ctx.home.includes(k), k);
});

test('OP-01d the ops workbench lists a to-do when there was no successful backup in 36 hours', async () => {
  ctx.home ??= await page('/admin/home');
  assert.ok(ctx.home.includes('最近 36 小时没有成功的数据库备份'), '最近 36 小时没有成功的数据库备份');
});

test('OP-01e the ops workbench lists a to-do when no restore drill was done for 90 days', async () => {
  ctx.home ??= await page('/admin/home');
  assert.ok(ctx.home.includes('超过 90 天没有做恢复演练'), '超过 90 天没有做恢复演练');
});

test('OP-02a two identical server errors are logged as one row with count 2', async () => {
  hooks.length = 0;
  for (const n of [1, 2]) assert.equal((await fetch(`${api.url}/api/__error?n=${n}`)).status, 500);
  const html = await page('/admin/system/errors');
  assert.match(html, /GET \/api\/__error<\/td><td><a href="\/admin\/system\/errors\/(\d+)">test error 2<\/a><\/td><td>2<\/td>/);
  ctx.errorId = html.match(/\/admin\/system\/errors\/(\d+)/)[1];
});

test('OP-02b a new server error is pushed to WeCom only once', async () => {
  await waitFor(() => hooks.length);
  assert.equal(hooks.length, 1);
  assert.match(hooks[0].markdown.content, /服务器新错误[\s\S]*GET \/api\/__error[\s\S]*test error 1/);
});

test('OP-02c the error detail page shows the stack trace', async () => {
  assert.match(await page(`/admin/system/errors/${ctx.errorId}`), /at [\s\S]*index\.js/);
});

test('OP-02d the error log exports as CSV', async () => {
  const csv = await (await fetch(`${api.url}/admin/system/errors.csv?status=all`, { headers: auth('opsa') })).text();
  assert.match(csv.replace(/^﻿/, ''), /^last_at,first_at,source,method,path,message,count,resolved\r\n.*request,GET,\/api\/__error,test error 2,2,0/s);
});

test('OP-02e marking an error resolved hides it from the open list and shows it as resolved by whom', async () => {
  assert.match(flash(await form(auth('opsa'), '/admin/system/errors/resolve', { ids: ctx.errorId })).ok, /已标记 1 条/);
  assert.doesNotMatch(await page('/admin/system/errors'), /test error/);
  assert.match(await page('/admin/system/errors?status=resolved'), /已解决 <span class="mute">opsa<\/span>/);
});

test('OP-03a testing one service (Stripe) reports it is working', async () => {
  const r = await form(auth('opsa'), '/admin/system/services/check', { id: 'stripe' });
  assert.match(flash(r).ok, /正常：密钥有效（测试模式）/);
});

test('OP-03b testing all services reports a result', async () => {
  const all = await form(auth('opsa'), '/admin/system/services/check', { id: 'all' });
  assert.ok(flash(all).ok || flash(all).err);
});

test('OP-03c the services page lists the latest results (Stripe working, peer site online with its version)', async () => {
  const html = await page('/admin/system/services');
  assert.match(html, /<b>Stripe<\/b>[\s\S]*?正常[\s\S]*?密钥有效/);
  assert.match(html, /<b>站点 grid<\/b>[\s\S]*?在线 · 版本 g-9/);
});

test('OP-03d an unconfigured service is shown as such and testing it says it is not configured', async () => {
  assert.match(await page('/admin/system/services'), /<b>大模型<\/b>[\s\S]*?未配置/);
  assert.match(flash(await form(auth('opsa'), '/admin/system/services/check', { id: 'llm' })).err, /未配置/);
});

test('OP-04a both sites are on one page with version, uptime, memory and disk of the peer', async () => {
  const html = await page('/admin/system/sites');
  assert.match(html, /led（本站）[\s\S]*led-7/);
  assert.match(html, /<b>grid<\/b>[\s\S]*g-9[\s\S]*2 小时[\s\S]*99 MB[\s\S]*4\.7 GB/);
});

test('OP-04b health details are hidden without the shared token', async () => {
  assert.equal((await (await fetch(`${api.url}/api/health?detail=1`)).json()).version, undefined);
});

test('OP-04c health details are returned with the shared token', async () => {
  const d = await (await fetch(`${api.url}/api/health?detail=1`, { headers: { 'x-ops-token': 'shared' } })).json();
  assert.equal(d.version, 'led-7');
  assert.ok('errors24h' in d && 'backup' in d);
});

test('OP-05a a staff login through the login page starts a working session', async () => {
  ctx.s1 = await session('sam', '10.0.0.1');
  assert.equal(ctx.s1.status, 302);
  assert.equal((await ctx.s1.get('/admin/home')).status, 200);
});

test('OP-05b a login from a new IP is alerted to WeCom', async () => {
  hooks.length = 0;
  await session('sam', '10.0.0.2');
  await waitFor(() => hooks.some((h) => /新的 IP 登录/.test(h.markdown?.content || '')));
  assert.match(hooks.find((h) => /新的 IP 登录/.test(h.markdown?.content || '')).markdown.content, /sam[\s\S]*10\.0\.0\.2/);
});

test('OP-05c the security page records logins per user and failed logins with their IP', async () => {
  await fetch(`${api.url}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '10.0.0.9' }, body: new URLSearchParams({ username: 'sam', password: 'wrong' }) });
  const html = await page('/admin/system/security');
  assert.match(html, /<b>sam<\/b>[\s\S]*?10\.0\.0\.2<\/td><td>2<\/td><td><b style="color:#c62828">1<\/b><\/td><td>2<\/td>/);
  assert.match(html, /登录失败<\/b><\/td><td>10\.0\.0\.9/);
  ctx.sid = html.match(/<tr><td><b>sam<\/b>[^<]*<span class="mute">[^<]*<\/span><\/td><td>10\.0\.0\.1<\/td>.*?\/admin\/system\/sessions\/(\d+)\/kick/)[1];
});

test('OP-05d ops forces an online session to log out and the page records it', async () => {
  assert.match(flash(await form(auth('opsa'), `/admin/system/sessions/${ctx.sid}/kick`, {})).ok, /已强制 sam 下线/);
  assert.match(await page('/admin/system/security'), /被强制下线/);
});

test('OP-05e the kicked session is logged out (401)', async () => {
  assert.equal((await ctx.s1.get('/admin/home')).status, 401, 'the kicked session is logged out');
});

test('OP-06a the configuration check lists which settings are configured and which are not', async () => {
  ctx.config = await page('/admin/system/config');
  assert.match(ctx.config, /<code>STRIPE_SECRET_KEY<\/code><\/td><td><span class="pill" style="background:#e3f2e5">已配置/);
  assert.match(ctx.config, /<code>SMTP_URL<\/code><\/td><td><span class="pill" style="background:#eceff1">未配置/);
  assert.match(ctx.config, /<code>PUBLIC_BASE_URL<\/code><\/td><td><span class="pill" style="background:#e3f2e5">已配置/);
});

test('OP-06b the configuration check warns about a Stripe test key', async () => {
  assert.match(ctx.config, /Stripe 使用的是测试密钥/);
});

test('OP-06c the configuration check never shows secret values', async () => {
  assert.ok(!ctx.config.includes('sk_test_x'));
});

test('OP-07a the website versions page marks the live version', async () => {
  const html = await page('/admin/system/releases');
  assert.match(html, /2026-10-21T08-00-00-000Z<\/code><\/td><td>[^<]*<\/td><td><span class="pill" style="background:#e3f2e5">线上/);
});

test('OP-07b switching back to an older version swaps the live link', async () => {
  const r = await form(auth('opsa'), '/admin/system/releases/rollback', { name: '2026-10-20T08-00-00-000Z' });
  assert.match(flash(r).ok, /网站已切换到 2026-10-20T08-00-00-000Z/);
  assert.equal(readlinkSync(join(rel, 'current')), join('releases', '2026-10-20T08-00-00-000Z'));
});

test('OP-07c after switching the older version is marked live', async () => {
  const html = await page('/admin/system/releases');
  assert.match(html, /2026-10-20T08-00-00-000Z<\/code><\/td><td>[^<]*<\/td><td><span class="pill" style="background:#e3f2e5">线上/);
});

test('OP-07d switching to a version that does not exist is refused', async () => {
  assert.match(flash(await form(auth('opsa'), '/admin/system/releases/rollback', { name: 'nope' })).err, /不存在/);
});

test('OP-08a all background jobs are listed with their schedule', async () => {
  const html = await page('/admin/system/jobs');
  for (const k of ['数据库备份', '超时未付款订单自动取消', '弃购提醒邮件', '素材回收站到期清理', '外部服务连通性检查', '备份到期检查', '内容智能体写稿', 'GEO 监测', '金蝶库存同步']) assert.ok(html.includes(k), k);
  assert.match(html, /<b>数据库备份<\/b>[\s\S]*?每天 \d+:00/);
});

test('OP-08b "run now" runs a job and the run is recorded as manual', async () => {
  const r = await form(auth('opsa'), '/admin/system/jobs/backup/run', {});
  assert.match(flash(r).ok, /已运行：yr-led-.*\.sqlite\.gz/);
  const html = await page('/admin/system/jobs?job=backup');
  assert.match(html, /数据库备份 <span class="mute">（opsa 手动）<\/span><\/td><td>成功/);
});

test('OP-08c pausing a job is confirmed and shown on the workbench', async () => {
  assert.match(flash(await form(auth('opsa'), '/admin/system/jobs/cart-reminders/pause', {})).ok, /已暂停/);
  assert.match(await page('/admin/home'), /定时任务已暂停：弃购提醒邮件/);
});

test('OP-08d a paused job can be resumed', async () => {
  assert.match(flash(await form(auth('opsa'), '/admin/system/jobs/cart-reminders/resume', {})).ok, /已继续/);
});

test('OP-08e running a job that does not exist is refused', async () => {
  assert.match(flash(await form(auth('opsa'), '/admin/system/jobs/nope/run', {})).err, /不存在/);
});

test('OP-09a a restore drill on a real backup passes with counts and is listed on the system page', async () => {
  const html = await page('/admin/system');
  const file = html.match(/name="file" value="(yr-led-[^"]+)"/)[1];
  const r = await form(auth('opsa'), '/admin/system/drill', { file });
  assert.match(flash(r).ok, /恢复演练通过：.*商品 \d+，订单 \d+，客户 \d+/);
  assert.match(await page('/admin/system'), /<td>通过<\/td><td>商品 \d+ · 订单/);
});

test('OP-09b after a backup and a drill the overdue reminders are gone from the workbench', async () => {
  const home = await page('/admin/home');
  assert.doesNotMatch(home, /超过 90 天没有做恢复演练/);
  assert.doesNotMatch(home, /最近 36 小时没有成功的数据库备份/);
});

test('OP-09c a drill on a file that does not exist is refused', async () => {
  assert.match(flash(await form(auth('opsa'), '/admin/system/drill', { file: 'x.gz' })).err, /不存在/);
});
