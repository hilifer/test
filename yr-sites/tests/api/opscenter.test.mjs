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

test('OP-01 ops sees every ops page and an ops workbench; sales has no access', async () => {
  for (const p of ['/admin/system', '/admin/system/services', '/admin/system/errors', '/admin/system/sites', '/admin/system/security', '/admin/system/config', '/admin/system/releases', '/admin/system/jobs']) {
    assert.equal((await fetch(api.url + p, { headers: auth('opsa') })).status, 200, p);
    assert.equal((await fetch(api.url + p, { headers: auth('sam') })).status, 403, p);
  }
  const home = await page('/admin/home');
  for (const k of ['运维：系统', '站点在线', '最近备份', '磁盘剩余', '24 小时错误', '外部服务异常', '最近 36 小时没有成功的数据库备份', '超过 90 天没有做恢复演练']) assert.ok(home.includes(k), k);
});

test('OP-02 a server error is logged with a count, pushed to WeCom once, can be viewed, exported and resolved', async () => {
  hooks.length = 0;
  for (const n of [1, 2]) assert.equal((await fetch(`${api.url}/api/__error?n=${n}`)).status, 500);
  const html = await page('/admin/system/errors');
  assert.match(html, /GET \/api\/__error<\/td><td><a href="\/admin\/system\/errors\/(\d+)">test error 2<\/a><\/td><td>2<\/td>/);
  const id = html.match(/\/admin\/system\/errors\/(\d+)/)[1];
  await waitFor(() => hooks.length);
  assert.equal(hooks.length, 1);
  assert.match(hooks[0].markdown.content, /服务器新错误[\s\S]*GET \/api\/__error[\s\S]*test error 1/);
  assert.match(await page(`/admin/system/errors/${id}`), /at [\s\S]*index\.js/);
  const csv = await (await fetch(`${api.url}/admin/system/errors.csv?status=all`, { headers: auth('opsa') })).text();
  assert.match(csv.replace(/^﻿/, ''), /^last_at,first_at,source,method,path,message,count,resolved\r\n.*request,GET,\/api\/__error,test error 2,2,0/s);
  assert.match(flash(await form(auth('opsa'), '/admin/system/errors/resolve', { ids: id })).ok, /已标记 1 条/);
  assert.doesNotMatch(await page('/admin/system/errors'), /test error/);
  assert.match(await page('/admin/system/errors?status=resolved'), /已解决 <span class="mute">opsa<\/span>/);
});

test('OP-03 service checks: test one, test all, results with last success; unconfigured services shown as such', async () => {
  const r = await form(auth('opsa'), '/admin/system/services/check', { id: 'stripe' });
  assert.match(flash(r).ok, /正常：密钥有效（测试模式）/);
  const all = await form(auth('opsa'), '/admin/system/services/check', { id: 'all' });
  assert.ok(flash(all).ok || flash(all).err);
  const html = await page('/admin/system/services');
  assert.match(html, /<b>Stripe<\/b>[\s\S]*?正常[\s\S]*?密钥有效/);
  assert.match(html, /<b>站点 grid<\/b>[\s\S]*?在线 · 版本 g-9/);
  assert.match(html, /<b>大模型<\/b>[\s\S]*?未配置/);
  assert.match(flash(await form(auth('opsa'), '/admin/system/services/check', { id: 'llm' })).err, /未配置/);
});

test('OP-04 both sites on one page; health details only with the shared token', async () => {
  const html = await page('/admin/system/sites');
  assert.match(html, /led（本站）[\s\S]*led-7/);
  assert.match(html, /<b>grid<\/b>[\s\S]*g-9[\s\S]*2 小时[\s\S]*99 MB[\s\S]*4\.7 GB/);
  assert.equal((await (await fetch(`${api.url}/api/health?detail=1`)).json()).version, undefined);
  const d = await (await fetch(`${api.url}/api/health?detail=1`, { headers: { 'x-ops-token': 'shared' } })).json();
  assert.equal(d.version, 'led-7');
  assert.ok('errors24h' in d && 'backup' in d);
});

test('OP-05 logins: records, online sessions, force logout ends the session, a new IP is alerted', async () => {
  const s1 = await session('sam', '10.0.0.1');
  assert.equal(s1.status, 302);
  assert.equal((await s1.get('/admin/home')).status, 200);
  hooks.length = 0;
  await session('sam', '10.0.0.2');
  await waitFor(() => hooks.some((h) => /新的 IP 登录/.test(h.markdown?.content || '')));
  assert.match(hooks.find((h) => /新的 IP 登录/.test(h.markdown?.content || '')).markdown.content, /sam[\s\S]*10\.0\.0\.2/);
  await fetch(`${api.url}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '10.0.0.9' }, body: new URLSearchParams({ username: 'sam', password: 'wrong' }) });
  const html = await page('/admin/system/security');
  assert.match(html, /<b>sam<\/b>[\s\S]*?10\.0\.0\.2<\/td><td>2<\/td><td><b style="color:#c62828">1<\/b><\/td><td>2<\/td>/);
  assert.match(html, /登录失败<\/b><\/td><td>10\.0\.0\.9/);
  const sid = html.match(/<tr><td><b>sam<\/b>[^<]*<span class="mute">[^<]*<\/span><\/td><td>10\.0\.0\.1<\/td>.*?\/admin\/system\/sessions\/(\d+)\/kick/)[1];
  assert.match(flash(await form(auth('opsa'), `/admin/system/sessions/${sid}/kick`, {})).ok, /已强制 sam 下线/);
  const after = await page('/admin/system/security');
  assert.match(after, /被强制下线/);
  assert.equal((await s1.get('/admin/home')).status, 401, 'the kicked session is logged out');
});

test('OP-06 configuration check lists what is set without showing values, with warnings', async () => {
  const html = await page('/admin/system/config');
  assert.match(html, /<code>STRIPE_SECRET_KEY<\/code><\/td><td><span class="pill" style="background:#e3f2e5">已配置/);
  assert.match(html, /<code>SMTP_URL<\/code><\/td><td><span class="pill" style="background:#eceff1">未配置/);
  assert.match(html, /<code>PUBLIC_BASE_URL<\/code><\/td><td><span class="pill" style="background:#e3f2e5">已配置/);
  assert.match(html, /Stripe 使用的是测试密钥/);
  assert.ok(!html.includes('sk_test_x'));
});

test('OP-07 website versions: the live one is marked; switching back swaps the live link', async () => {
  let html = await page('/admin/system/releases');
  assert.match(html, /2026-10-21T08-00-00-000Z<\/code><\/td><td>[^<]*<\/td><td><span class="pill" style="background:#e3f2e5">线上/);
  const r = await form(auth('opsa'), '/admin/system/releases/rollback', { name: '2026-10-20T08-00-00-000Z' });
  assert.match(flash(r).ok, /网站已切换到 2026-10-20T08-00-00-000Z/);
  assert.equal(readlinkSync(join(rel, 'current')), join('releases', '2026-10-20T08-00-00-000Z'));
  html = await page('/admin/system/releases');
  assert.match(html, /2026-10-20T08-00-00-000Z<\/code><\/td><td>[^<]*<\/td><td><span class="pill" style="background:#e3f2e5">线上/);
  assert.match(flash(await form(auth('opsa'), '/admin/system/releases/rollback', { name: 'nope' })).err, /不存在/);
});

test('OP-08 scheduled jobs: all background jobs listed with schedule and next run; run now; pause and resume', async () => {
  let html = await page('/admin/system/jobs');
  for (const k of ['数据库备份', '超时未付款订单自动取消', '弃购提醒邮件', '素材回收站到期清理', '外部服务连通性检查', '备份到期检查', '内容智能体写稿', 'GEO 监测', '金蝶库存同步']) assert.ok(html.includes(k), k);
  assert.match(html, /<b>数据库备份<\/b>[\s\S]*?每天 3:00/);
  const r = await form(auth('opsa'), '/admin/system/jobs/backup/run', {});
  assert.match(flash(r).ok, /已运行：yr-led-.*\.sqlite\.gz/);
  html = await page('/admin/system/jobs?job=backup');
  assert.match(html, /数据库备份 <span class="mute">（opsa 手动）<\/span><\/td><td>成功/);
  assert.match(flash(await form(auth('opsa'), '/admin/system/jobs/cart-reminders/pause', {})).ok, /已暂停/);
  assert.match(await page('/admin/home'), /定时任务已暂停：弃购提醒邮件/);
  assert.match(flash(await form(auth('opsa'), '/admin/system/jobs/cart-reminders/resume', {})).ok, /已继续/);
  assert.match(flash(await form(auth('opsa'), '/admin/system/jobs/nope/run', {})).err, /不存在/);
});

test('OP-09 restore drill on a real backup; results listed; overdue reminders cleared', async () => {
  const html = await page('/admin/system');
  const file = html.match(/name="file" value="(yr-led-[^"]+)"/)[1];
  const r = await form(auth('opsa'), '/admin/system/drill', { file });
  assert.match(flash(r).ok, /恢复演练通过：.*商品 \d+，订单 \d+，客户 \d+/);
  assert.match(await page('/admin/system'), /<td>通过<\/td><td>商品 \d+ · 订单/);
  const home = await page('/admin/home');
  assert.doesNotMatch(home, /超过 90 天没有做恢复演练/);
  assert.doesNotMatch(home, /最近 36 小时没有成功的数据库备份/);
  assert.match(flash(await form(auth('opsa'), '/admin/system/drill', { file: 'x.gz' })).err, /不存在/);
});
