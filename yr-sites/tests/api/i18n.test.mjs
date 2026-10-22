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
const ctx = {};
/** Log in through the login page and keep the session cookie. */
async function session(username, password = PW) {
  const r = await fetch(`${api.url}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username, password, next: '/admin' }) });
  const cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const get = (p, h = {}) => fetch(api.url + p, { redirect: 'manual', headers: { cookie, ...h } });
  const post = (p, data, h = {}) => fetch(api.url + p, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', ...h }, body: new URLSearchParams(data) });
  return { get, post, cookie };
}
const visible = (html) => html.replace(/<textarea[\s\S]*?<\/textarea>/g, '').replace(/<(span|b|pre|td|div)\b[^>]*\stranslate="no"[^>]*>[\s\S]*?<\/\1>/g, '').replace(/\svalue="[^"]*"/g, '');

test('IN-A01a a new user sees the admin in Chinese by default', async () => {
  for (const [u, role] of [['emma', 'sales'], ['li01', 'sales']]) await api.form('/admin/users/new', { username: u, role, password: PW });
  ctx.emma = await session('emma');
  assert.match(await (await ctx.emma.get('/admin')).text(), /<html lang="zh-CN">[\s\S]*线索/);
});

test('IN-A01b switching to English (fetch) answers 204 and the admin is then in English with a 中文 switch', async () => {
  assert.equal((await ctx.emma.post('/admin/lang', { lang: 'en' }, { 'x-requested-with': 'fetch' })).status, 204);
  const page = await (await ctx.emma.get('/admin')).text();
  assert.match(page, /<html lang="en">/);
  assert.match(page, />Leads</);
  assert.match(page, /title="Switch to Chinese">&#20013;&#25991;<\/button>/); // the switch shows 中文 in Chinese
});

test('IN-A01c the English choice is remembered at the next login', async () => {
  const again = await session('emma'); // new login, no cookie from before
  assert.match(await (await again.get('/admin')).text(), /<html lang="en">/);
});

test('IN-A01d other users stay in Chinese', async () => {
  const li = await session('li01');
  assert.match(await (await li.get('/admin')).text(), /<html lang="zh-CN">/);
});

test('IN-A02a every admin page in English has no Chinese left (form values and textareas excluded)', async () => {
  const emma = await session('admin', 'test-pass');
  await emma.post('/admin/lang', { lang: 'en' });
  const pages = ['/admin', '/admin/dashboard', '/admin/conversations', '/admin/ops', '/admin/quotes', '/admin/orders', '/admin/shipments', '/admin/rma', '/admin/skus', '/admin/inventory', '/admin/customers',
    '/admin/shop', '/admin/shop/freight', '/admin/coupons', '/admin/reviews', '/admin/products', '/admin/products/new', '/admin/products/YR-HB-U2', '/admin/products/autolist', '/admin/products/import',
    '/admin/categories', '/admin/settings', '/admin/content', '/admin/geo', '/admin/users', '/admin/me', '/admin/deals', '/admin/deals/policy', '/admin/contracts', '/admin/contracts/template', '/admin/system', '/admin/home', '/admin/audit', '/admin/roles', '/admin/assets', '/admin/assets/pull', '/admin/assets/watermarks', '/admin/assets/trash', '/admin/assets/settings', '/admin/assets/similar', '/admin/tasks', '/admin/copy', '/admin/copy?product=YR-HB-U2', '/admin/copy/prompts', '/admin/copy/banned', '/admin/products/YR-HB-U2/preview', '/admin/system/services', '/admin/system/errors', '/admin/system/sites', '/admin/system/security', '/admin/system/config', '/admin/system/releases', '/admin/system/jobs', '/admin/sales/settings', '/admin/sales/performance', '/admin/quotes/templates', '/admin?scope=pool', '/admin/marketing', '/admin/marketing/products', '/admin/marketing/campaigns', '/admin/marketing/promotions', '/admin/marketing/zones', '/admin/marketing/emails', '/admin/marketing/seo', '/admin/finance', '/admin/finance/reconcile', '/admin/finance/report', '/admin/warehouse', '/admin/warehouse/stock', '/admin/warehouse/carriers?country=US&kg=5', '/admin/service', '/admin/service/quick-replies', '/admin/service/kb', '/admin/service/kb?test=warranty', '/admin/service/performance', '/admin/board', '/admin/approvals', '/admin/approvals/settings', '/admin/brand', '/admin/brand/templates', '/admin/brand/templates/promo-banner', '/admin/users/notify'];
  for (const p of pages) {
    const r = await emma.get(p);
    assert.equal(r.status, 200, p);
    const left = visible(await r.text()).match(/[^<>"]{0,20}[㐀-鿿]+[^<>"]{0,20}/);
    assert.equal(left, null, `${p}: ${left?.[0]}`);
  }
});

test('IN-A02b a message after an action is shown in English (the redirect carries the raw Chinese message)', async () => {
  const emma = await session('admin', 'test-pass');
  await emma.post('/admin/lang', { lang: 'en' });
  assert.match(flash(await emma.post('/admin/products/bulk', { action: 'publish' })).err, /请先勾选/); // the redirect carries the raw message…
  assert.match(await (await emma.get('/admin/products?e=' + encodeURIComponent('请先勾选商品'))).text(), /Select products first/); // …and the page shows it in English
});

test('IN-A03a in English a quote page keeps the Chinese notes in the textarea while the buttons are English', async () => {
  const a = await session('admin', 'test-pass');
  await a.post('/admin/lang', { lang: 'en' });
  const qid = (await a.post('/admin/quotes/new', { email: 'cn@buyer.test', company: '深圳测试公司' })).headers.get('location').split('/').pop();
  await a.post(`/admin/quotes/${qid}/save`, { sku_0: 'YR-HB-U2', qty_0: '100', price_0: '45', currency: 'USD', incoterm: 'FOB', payment_terms: 'tt30', validity_days: '15', notes: '请尽快发货，已确认', action: 'save' });
  ctx.quotePage = await (await a.get(`/admin/quotes/${qid}`)).text();
  assert.match(ctx.quotePage, /<textarea name="notes"[^>]*>请尽快发货，已确认<\/textarea>/);
  assert.match(ctx.quotePage, /Save and send to customer/);
});

test('IN-A03b in English a Chinese company name is left as it is', async () => {
  assert.match(ctx.quotePage, /深圳测试公司/);
});

test('IN-A04a an administrator saves English as the system default language', async () => {
  ctx.admin = await session('admin', 'test-pass');
  assert.match(flash(await ctx.admin.post('/admin/system/lang', { lang: 'en' })).ok, /默认后台语言已保存/);
});

test('IN-A04b a user without a preference gets the system default language', async () => {
  ctx.li = await session('li01'); // li01 never chose a language
  assert.match(await (await ctx.li.get('/admin')).text(), /<html lang="en">/);
});

test('IN-A04c a user\'s own choice wins over the system default', async () => {
  await ctx.li.post('/admin/lang', { lang: 'zh' });
  assert.match(await (await ctx.li.get('/admin')).text(), /<html lang="zh-CN">/);
});

test('IN-A04d the login page follows the language cookie and is Chinese without it', async () => {
  await ctx.admin.post('/admin/system/lang', { lang: 'zh' });
  assert.match(await (await fetch(`${api.url}/admin/login`, { headers: { cookie: 'yr_admin_lang=en' } })).text(), /Staff login/);
  assert.match(await (await fetch(`${api.url}/admin/login`)).text(), /后台登录/);
});

test('IN-A04e an unsupported system default language is rejected with an error', async () => {
  assert.equal((await ctx.admin.post('/admin/system/lang', { lang: 'fr' })).headers.get('location').includes('e='), true);
});

test('IN-A04f a non-admin cannot open the system page where the default is set (403)', async () => {
  assert.equal((await (await session('emma')).get('/admin/system')).status, 403);
});

test('IN-A05a in English the product CSV export has English column names', async () => {
  ctx.admin = await session('admin', 'test-pass');
  await ctx.admin.post('/admin/lang', { lang: 'en' });
  const head = (await (await ctx.admin.get('/admin/products/export.csv')).text()).replace(/^﻿/, '').split(/\r?\n/)[0];
  assert.match(head, /^id,status,category,name,name_zh/);
});

test('IN-A05b in Chinese the product CSV export has Chinese column names', async () => {
  await ctx.admin.post('/admin/lang', { lang: 'zh' });
  assert.match((await (await ctx.admin.get('/admin/products/export.csv')).text()).split(/\r?\n/)[0], /型号\/编码\*/);
});

test('IN-A06a the language switch refuses cross-site posts (403)', async () => {
  ctx.emma = await session('emma');
  assert.equal((await ctx.emma.post('/admin/lang', { lang: 'en' }, { origin: 'https://evil.test' })).status, 403);
});

test('IN-A06b an invalid language falls back to Chinese', async () => {
  await ctx.emma.post('/admin/lang', { lang: 'xx' });
  assert.match(await (await ctx.emma.get('/admin')).text(), /<html lang="zh-CN">/);
});
