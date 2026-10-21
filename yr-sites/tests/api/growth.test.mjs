// Black-box: operations over HTTP — page-view beacon (bots and admin pages ignored), campaign cookie and attribution of
// inquiries and orders, analytics and product data pages, CSV with headers in the admin language, campaigns, automatic
// promotions in the buy-box API, the home page zone and checkout. IDs GA-xx.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, flash } from '../helpers/server.mjs';

let api;
before(async () => { api = await startServer({ site: 'led', env: { TRUSTED_PROXY_HOPS: '0' } }); await api.form('/admin/users/new', { username: 'mkt', role: 'content', password: PW }); await api.form('/admin/users/new', { username: 'wes', role: 'warehouse', password: PW }); });
after(() => api.stop());

const PW = 'Str0ngPassw0rd';
const auth = (u) => ({ authorization: 'Basic ' + Buffer.from(`${u}:${PW}`).toString('base64') });
const UA = 'Mozilla/5.0 (Macintosh) Safari/605';
const form = (h, path, data) => fetch(api.url + path, { method: 'POST', redirect: 'manual', headers: { ...h, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data) });
const page = async (path, h = auth('mkt')) => (await fetch(api.url + path, { headers: h })).text();
const beacon = (body, headers = {}) => fetch(`${api.url}/api/t`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA, ...headers }, body: JSON.stringify(body) });
/** A visitor with a cookie jar. */
function visitor(ua = UA) {
  const jar = new Map();
  const send = async (path, opts = {}) => {
    const r = await fetch(api.url + path, { redirect: 'manual', ...opts, headers: { 'user-agent': ua, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(opts.headers || {}) } });
    for (const sc of r.headers.getSetCookie()) { const [kv] = sc.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    return r;
  };
  send.json = (path, body) => send(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  send.form = (path, data) => send(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data) });
  send.jar = jar;
  return send;
}
const ADDR = { name: 'Jane Buyer', phone: '+1 512 555 0100', line1: '1 Congress Ave', city: 'Austin', state: 'TX', postcode: '78701', country: 'US' };

test('GA-01 the beacon records page and product views; bots and admin pages are ignored; a campaign link sets a 30-day cookie', async () => {
  assert.equal((await beacon({ p: '/', r: 'https://www.bing.com/' })).status, 204);
  assert.equal((await beacon({ p: '/products/ufo-high-bay-u2/', product: 'YR-HB-U2' })).status, 204);
  await beacon({ p: '/' }, { 'user-agent': 'Googlebot/2.1' });
  await beacon({ p: '/admin/home' });
  const r = await beacon({ p: '/', q: '?utm_source=google&utm_medium=cpc&utm_campaign=g-uk' }, { 'user-agent': 'Mozilla/5.0 Chrome/130' });
  assert.match(r.headers.get('set-cookie'), /yr_cmp=g-uk; Path=\/; Max-Age=2592000; SameSite=Lax/);
  const html = await page('/admin/marketing');
  assert.match(html, /<span>访客<\/span><strong>2<\/strong>/);
  assert.match(html, /<span>页面浏览<\/span><strong>3<\/strong>/);
  assert.match(html, /<span>商品浏览<\/span><strong>1<\/strong>/);
  assert.match(html, /www\.bing\.com/);
  assert.match(html, /google/);
});

test('GA-02 inquiries and shop orders made with the campaign cookie are attributed; campaign page shows results, ROI and the link', async () => {
  const id = await form(auth('mkt'), '/admin/marketing/campaigns', { name: 'Google UK', code: 'g-uk', source: 'google', medium: 'cpc', landing: '/products/ufo-high-bay-u2/', spend: '100' });
  assert.match(flash(id).ok, /活动已创建/);
  const v = visitor('Mozilla/5.0 Firefox/131');
  await v.json('/api/t', { p: '/products/ufo-high-bay-u2/', q: '?utm_campaign=g-uk&utm_source=google', product: 'YR-HB-U2' });
  assert.equal(v.jar.get('yr_cmp'), 'g-uk');
  assert.equal((await v.json('/api/leads', { email: 'uk@buyer.test', company: 'UK Buyer', consent: true })).status, 200);
  await v.json('/api/shop/cart', { sku: 'YR-HB-U2', qty: 2 });
  const co = await (await v('/shop/checkout?country=US')).text();
  const zone = co.match(/name="zone" value="(\d+)"/)[1];
  const placed = await v.form('/shop/checkout', { email: 'uk-shop@buyer.test', ...ADDR, zone, payment: 'tt' });
  assert.equal(placed.status, 302);
  const html = await page('/admin/marketing/campaigns');
  assert.match(html, /<b>Google UK<\/b>[\s\S]*?value="https?:\/\/[^"]*\/products\/ufo-high-bay-u2\/\?utm_source=google&amp;utm_medium=cpc&amp;utm_campaign=g-uk"/);
  assert.match(html, /<b>Google UK<\/b>[\s\S]*?<td class="n">2<\/td><td class="n">1<\/td><td class="n">1<\/td>/, 'visitors / inquiries / orders');
  assert.match(html, /USD 100<\/td><td class="n">-100\.0%<\/td><td class="n">USD 100<\/td>/, 'nothing received yet: ROI -100 %, cost per inquiry 100');
  assert.match(flash(await form(auth('mkt'), '/admin/marketing/campaigns', { name: 'dup', code: 'g-uk' })).err, /已被使用/);
  const zh = await (await fetch(`${api.url}/admin/marketing/campaigns.csv`, { headers: auth('mkt') })).text();
  assert.match(zh.replace(/^﻿/, ''), /^活动,代码,访客,询价,订单,成交额,花费,投入产出比,获客成本\r\nGoogle UK,g-uk,2,1,1,0,100,-100\.0%,/);
  const en = await (await fetch(`${api.url}/admin/marketing/campaigns.csv`, { headers: { ...auth('mkt'), cookie: 'yr_admin_lang=en' } })).text();
  assert.match(en.replace(/^﻿/, ''), /^Campaign,Code,Visitors,Inquiries,Orders,Revenue,Spend,ROI,Cost per customer\r\n/);
});

test('GA-03 product data: views, add-to-cart, orders and conversion on the data page and in the product list (sortable)', async () => {
  const html = await page('/admin/marketing/products?days=30&sort=carts');
  assert.match(html, /<b>UFO High Bay U2<\/b>[\s\S]*?<td class="n">2<\/td><td class="n">1<\/td><td class="n">50\.0%<\/td><td class="n">1<\/td><td class="n">50\.0%<\/td>/);
  const list = await page('/admin/products?dsort=views');
  assert.match(list, /数据（30 天）/);
  assert.match(list.slice(list.indexOf('<tbody id="rows">')), /^<tbody id="rows"><tr draggable="true" data-id="YR-HB-U2"/, 'most viewed first');
  assert.match(list, /2 \/ 1 \/ 1<div class="mute">50\.0%<\/div>/);
  const csv = await (await fetch(`${api.url}/admin/marketing/products.csv`, { headers: auth('mkt') })).text();
  assert.match(csv, /型号,名称,浏览,加购,订单,件数,销售额,转化率/);
  assert.match(csv, /YR-HB-U2,UFO High Bay U2,2,1,1,50,/);
});

test('GA-04 promotions: created in the admin, shown in the buy-box API and the home page zone, applied at checkout; can be switched off', async () => {
  const local = (h) => { const d = new Date(Date.now() + h * 3600e3); return new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 16); };
  assert.match(flash(await form(auth('mkt'), '/admin/marketing/promotions', { name: '工矿灯特价', name_en: 'High bay sale', kind: 'percent', value: '15', products: 'YR-HB-U2', starts_at: local(-1), ends_at: local(48) })).ok, /已保存/);
  assert.match(flash(await form(auth('mkt'), '/admin/marketing/promotions', { name: 'x', kind: 'percent', value: '150', starts_at: local(-1), ends_at: local(1) })).err, /1–99/);
  const admin = await page('/admin/marketing/promotions');
  assert.match(admin, /<b>工矿灯特价<\/b>[\s\S]*?减 15%[\s\S]*?YR-HB-U2[\s\S]*?进行中/);
  const p = await (await fetch(`${api.url}/api/shop/product/YR-HB-U2`)).json();
  assert.equal(p.promo.label, 'High bay sale: 15% off');
  assert.equal((await (await fetch(`${api.url}/api/shop/product/YR-HB-U2?lang=zh`)).json()).promo.label, '工矿灯特价：8.5 折');
  const zone = await (await fetch(`${api.url}/api/shop/promotions`)).json();
  assert.equal(zone[0].products[0].id, 'YR-HB-U2');
  const v = visitor();
  await v.json('/api/shop/cart', { sku: 'YR-HB-U2', qty: 2 });
  const cartPage = await (await v('/shop/cart')).text();
  assert.match(cartPage, /High bay sale: 15% off: −/);
  const co = await (await v('/shop/checkout?country=US')).text();
  assert.match(co, /<td>High bay sale: 15% off<\/td><td class="n" style="color:#c62828">−/);
  const zoneId = co.match(/name="zone" value="(\d+)"/)[1];
  const placed = await v.form('/shop/checkout', { email: 'promo@buyer.test', ...ADDR, zone: zoneId, payment: 'tt' });
  const orderPage = await (await v(placed.headers.get('location'))).text();
  assert.match(orderPage, /−|Discount|discount/);
  const ord = await page('/admin/orders', auth('mkt'));
  assert.ok(ord.length > 0);
  const id = admin.match(/\/admin\/marketing\/promotions\/(\d+)\/stop/)[1];
  assert.match(flash(await form(auth('mkt'), `/admin/marketing/promotions/${id}/stop`, {})).ok, /已停用/);
  assert.equal((await (await fetch(`${api.url}/api/shop/product/YR-HB-U2`)).json()).promo, null);
  assert.deepEqual(await (await fetch(`${api.url}/api/shop/promotions`)).json(), []);
});

test('GA-05 roles and the marketing workbench', async () => {
  assert.equal((await fetch(`${api.url}/admin/marketing`, { headers: auth('wes') })).status, 403);
  assert.equal((await form(auth('wes'), '/admin/marketing/campaigns', { name: 'x', code: 'xx' })).status, 403);
  const home = await page('/admin/home');
  for (const k of ['今日访客', '商品浏览', '加购', '下单转化率', '在线成交额', '待审核评价', '待发布文章']) assert.ok(home.includes(k), k);
});
