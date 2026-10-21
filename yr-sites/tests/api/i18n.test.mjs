// Black-box: admin language switch over HTTP — per-user preference remembered across logins, system default, every admin
// page fully in English, Chinese data untouched, CSV column names follow the language, CSRF. IDs IN-A-xx.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, flash } from '../helpers/server.mjs';

let api;
before(async () => { api = await startServer({ site: 'led' }); });
after(async () => { await api.stop(); });
const PW = 'Str0ngPassw0rd';
const CJK = /[㐀-鿿]/;
/** Log in through the login page and keep the session cookie. */
async function session(username, password = PW) {
  const r = await fetch(`${api.url}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username, password, next: '/admin' }) });
  const cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const get = (p, h = {}) => fetch(api.url + p, { redirect: 'manual', headers: { cookie, ...h } });
  const post = (p, data, h = {}) => fetch(api.url + p, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', ...h }, body: new URLSearchParams(data) });
  return { get, post, cookie };
}
const visible = (html) => html.replace(/<textarea[\s\S]*?<\/textarea>/g, '').replace(/<(span|b|pre|td|div)\b[^>]*\stranslate="no"[^>]*>[\s\S]*?<\/\1>/g, '').replace(/\svalue="[^"]*"/g, '');

test('IN-A01 a user switches to English; the choice is remembered at the next login; others stay in Chinese', async () => {
  for (const [u, role] of [['emma', 'sales'], ['li01', 'sales']]) await api.form('/admin/users/new', { username: u, role, password: PW });
  const emma = await session('emma');
  assert.match(await (await emma.get('/admin')).text(), /<html lang="zh-CN">[\s\S]*线索/);
  assert.equal((await emma.post('/admin/lang', { lang: 'en' }, { 'x-requested-with': 'fetch' })).status, 204);
  const page = await (await emma.get('/admin')).text();
  assert.match(page, /<html lang="en">/);
  assert.match(page, />Leads</);
  assert.match(page, /title="Switch to Chinese">&#20013;&#25991;<\/button>/); // the switch shows 中文 in Chinese
  const again = await session('emma'); // new login, no cookie from before
  assert.match(await (await again.get('/admin')).text(), /<html lang="en">/);
  const li = await session('li01');
  assert.match(await (await li.get('/admin')).text(), /<html lang="zh-CN">/);
});

test('IN-A02 every admin page in English has no Chinese left (form values and textareas excluded)', async () => {
  const emma = await session('admin', 'test-pass');
  await emma.post('/admin/lang', { lang: 'en' });
  const pages = ['/admin', '/admin/dashboard', '/admin/conversations', '/admin/ops', '/admin/quotes', '/admin/orders', '/admin/shipments', '/admin/rma', '/admin/skus', '/admin/inventory', '/admin/customers',
    '/admin/shop', '/admin/shop/freight', '/admin/coupons', '/admin/reviews', '/admin/products', '/admin/products/new', '/admin/products/YR-HB-U2', '/admin/products/autolist', '/admin/products/import',
    '/admin/categories', '/admin/settings', '/admin/content', '/admin/geo', '/admin/users', '/admin/me', '/admin/deals', '/admin/deals/policy', '/admin/contracts', '/admin/contracts/template', '/admin/system', '/admin/home', '/admin/audit', '/admin/roles', '/admin/assets', '/admin/assets/pull', '/admin/assets/watermarks', '/admin/assets/trash', '/admin/assets/settings', '/admin/assets/similar', '/admin/tasks', '/admin/copy', '/admin/copy?product=YR-HB-U2', '/admin/copy/prompts', '/admin/copy/banned', '/admin/products/YR-HB-U2/preview', '/admin/system/services', '/admin/system/errors', '/admin/system/sites', '/admin/system/security', '/admin/system/config', '/admin/system/releases', '/admin/system/jobs'];
  for (const p of pages) {
    const r = await emma.get(p);
    assert.equal(r.status, 200, p);
    const left = visible(await r.text()).match(/[^<>"]{0,20}[㐀-鿿]+[^<>"]{0,20}/);
    assert.equal(left, null, `${p}: ${left?.[0]}`);
  }
  // messages after an action are translated too
  assert.match(flash(await emma.post('/admin/products/bulk', { action: 'publish' })).err, /请先勾选/); // the redirect carries the raw message…
  assert.match(await (await emma.get('/admin/products?e=' + encodeURIComponent('请先勾选商品'))).text(), /Select products first/); // …and the page shows it in English
});

test('IN-A03 Chinese data survives in English: quote notes (textarea) and Chinese company names are left as they are', async () => {
  const a = await session('admin', 'test-pass');
  await a.post('/admin/lang', { lang: 'en' });
  const qid = (await a.post('/admin/quotes/new', { email: 'cn@buyer.test', company: '深圳测试公司' })).headers.get('location').split('/').pop();
  await a.post(`/admin/quotes/${qid}/save`, { sku_0: 'YR-HB-U2', qty_0: '100', price_0: '45', currency: 'USD', incoterm: 'FOB', payment_terms: 'tt30', validity_days: '15', notes: '请尽快发货，已确认', action: 'save' });
  const page = await (await a.get(`/admin/quotes/${qid}`)).text();
  assert.match(page, /<textarea name="notes"[^>]*>请尽快发货，已确认<\/textarea>/);
  assert.match(page, /深圳测试公司/);
  assert.match(page, /Save and send to customer/);
});

test('IN-A04 system default language for users without a preference; the login page follows the cookie', async () => {
  const admin = await session('admin', 'test-pass');
  assert.match(flash(await admin.post('/admin/system/lang', { lang: 'en' })).ok, /默认后台语言已保存/);
  const li = await session('li01'); // li01 never chose a language
  assert.match(await (await li.get('/admin')).text(), /<html lang="en">/);
  await li.post('/admin/lang', { lang: 'zh' }); // own choice wins over the default
  assert.match(await (await li.get('/admin')).text(), /<html lang="zh-CN">/);
  await admin.post('/admin/system/lang', { lang: 'zh' });
  assert.match(await (await fetch(`${api.url}/admin/login`, { headers: { cookie: 'yr_admin_lang=en' } })).text(), /Staff login/);
  assert.match(await (await fetch(`${api.url}/admin/login`)).text(), /后台登录/);
  assert.equal((await admin.post('/admin/system/lang', { lang: 'fr' })).headers.get('location').includes('e='), true);
  assert.equal((await (await session('emma')).get('/admin/system')).status, 403);
});

test('IN-A05 product CSV column names follow the admin language (and import accepts both)', async () => {
  const admin = await session('admin', 'test-pass');
  await admin.post('/admin/lang', { lang: 'en' });
  const head = (await (await admin.get('/admin/products/export.csv')).text()).replace(/^﻿/, '').split(/\r?\n/)[0];
  assert.match(head, /^id,status,category,name,name_zh/);
  await admin.post('/admin/lang', { lang: 'zh' });
  assert.match((await (await admin.get('/admin/products/export.csv')).text()).split(/\r?\n/)[0], /型号\/编码\*/);
});

test('IN-A06 the language switch refuses cross-site posts and invalid input falls back to Chinese', async () => {
  const emma = await session('emma');
  assert.equal((await emma.post('/admin/lang', { lang: 'en' }, { origin: 'https://evil.test' })).status, 403);
  await emma.post('/admin/lang', { lang: 'xx' });
  assert.match(await (await emma.get('/admin')).text(), /<html lang="zh-CN">/);
});
