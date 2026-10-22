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

const ctx = {};
test('GA-01a the beacon accepts page and product views (204)', async () => {
  assert.equal((await beacon({ p: '/', r: 'https://www.bing.com/' })).status, 204);
  assert.equal((await beacon({ p: '/products/ufo-high-bay-u2/', product: 'YR-HB-U2' })).status, 204);
});
test('GA-01b bot and admin-page beacons are ignored in the visitor and view counts', async () => {
  await beacon({ p: '/' }, { 'user-agent': 'Googlebot/2.1' });
  await beacon({ p: '/admin/home' });
  const r = await beacon({ p: '/', q: '?utm_source=google&utm_medium=cpc&utm_campaign=g-uk' }, { 'user-agent': 'Mozilla/5.0 Chrome/130' });
  ctx.cmpCookie = r.headers.get('set-cookie');
  const html = ctx.mkt = await page('/admin/marketing');
  assert.match(html, /<span>访客<\/span><strong>2<\/strong>/);
  assert.match(html, /<span>页面浏览<\/span><strong>3<\/strong>/);
  assert.match(html, /<span>商品浏览<\/span><strong>1<\/strong>/);
});
test('GA-01c a campaign link sets a 30-day campaign cookie', async () => {
  assert.match(ctx.cmpCookie, /yr_cmp=g-uk; Path=\/; Max-Age=2592000; SameSite=Lax/);
});
test('GA-01d the analytics page lists the referrer and the campaign source', async () => {
  assert.match(ctx.mkt, /www\.bing\.com/);
  assert.match(ctx.mkt, /google/);
});

test('GA-02a a campaign is created in the admin', async () => {
  const id = await form(auth('mkt'), '/admin/marketing/campaigns', { name: 'Google UK', code: 'g-uk', source: 'google', medium: 'cpc', landing: '/products/ufo-high-bay-u2/', spend: '100' });
  assert.match(flash(id).ok, /活动已创建/);
});
test('GA-02b a visitor arriving through the campaign link gets the campaign cookie', async () => {
  const v = ctx.v = visitor('Mozilla/5.0 Firefox/131');
  await v.json('/api/t', { p: '/products/ufo-high-bay-u2/', q: '?utm_campaign=g-uk&utm_source=google', product: 'YR-HB-U2' });
  assert.equal(v.jar.get('yr_cmp'), 'g-uk');
});
test('GA-02c the campaign visitor can send an inquiry', async () => {
  assert.equal((await ctx.v.json('/api/leads', { email: 'uk@buyer.test', company: 'UK Buyer', consent: true })).status, 200);
});
test('GA-02d the campaign visitor can place a shop order', async () => {
  const v = ctx.v;
  await v.json('/api/shop/cart', { sku: 'YR-HB-U2', qty: 2 });
  const co = await (await v('/shop/checkout?country=US')).text();
  const zone = co.match(/name="zone" value="(\d+)"/)[1];
  const placed = await v.form('/shop/checkout', { email: 'uk-shop@buyer.test', ...ADDR, zone, payment: 'tt' });
  assert.equal(placed.status, 302);
});
test('GA-02e the campaign page shows the tracking link with UTM parameters', async () => {
  const html = ctx.cmp = await page('/admin/marketing/campaigns');
  assert.match(html, /<b>Google UK<\/b>[\s\S]*?value="https?:\/\/[^"]*\/products\/ufo-high-bay-u2\/\?utm_source=google&amp;utm_medium=cpc&amp;utm_campaign=g-uk"/);
});
test('GA-02f the campaign page attributes visitors, inquiries and orders to the campaign', async () => {
  assert.match(ctx.cmp, /<b>Google UK<\/b>[\s\S]*?<td class="n">2<\/td><td class="n">1<\/td><td class="n">1<\/td>/, 'visitors / inquiries / orders');
});
test('GA-02g the campaign page computes ROI and cost per inquiry from the spend', async () => {
  assert.match(ctx.cmp, /USD 100<\/td><td class="n">-100\.0%<\/td><td class="n">USD 100<\/td>/, 'nothing received yet: ROI -100 %, cost per inquiry 100');
});
test('GA-02h a campaign code that is already used is rejected', async () => {
  assert.match(flash(await form(auth('mkt'), '/admin/marketing/campaigns', { name: 'dup', code: 'g-uk' })).err, /已被使用/);
});
test('GA-02i the campaign CSV has Chinese headers and the campaign row in the Chinese admin', async () => {
  const zh = await (await fetch(`${api.url}/admin/marketing/campaigns.csv`, { headers: auth('mkt') })).text();
  assert.match(zh.replace(/^﻿/, ''), /^活动,代码,访客,询价,订单,成交额,花费,投入产出比,获客成本\r\nGoogle UK,g-uk,2,1,1,0,100,-100\.0%,/);
});
test('GA-02j the campaign CSV has English headers in the English admin', async () => {
  const en = await (await fetch(`${api.url}/admin/marketing/campaigns.csv`, { headers: { ...auth('mkt'), cookie: 'yr_admin_lang=en' } })).text();
  assert.match(en.replace(/^﻿/, ''), /^Campaign,Code,Visitors,Inquiries,Orders,Revenue,Spend,ROI,Cost per customer\r\n/);
});

test('GA-03a the product data page shows views, add-to-cart, orders and conversion per product', async () => {
  const html = await page('/admin/marketing/products?days=30&sort=carts');
  assert.match(html, /<b>UFO High Bay U2<\/b>[\s\S]*?<td class="n">2<\/td><td class="n">1<\/td><td class="n">50\.0%<\/td><td class="n">1<\/td><td class="n">50\.0%<\/td>/);
});
test('GA-03b the product list has a 30-day data column with views / carts / orders and conversion', async () => {
  const list = ctx.list = await page('/admin/products?dsort=views');
  assert.match(list, /数据（30 天）/);
  assert.match(list, /2 \/ 1 \/ 1<div class="mute">50\.0%<\/div>/);
});
test('GA-03c the product list can be sorted by views (most viewed first)', async () => {
  const list = ctx.list;
  assert.match(list.slice(list.indexOf('<tbody id="rows">')), /^<tbody id="rows"><tr draggable="true" data-id="YR-HB-U2"/, 'most viewed first');
});
test('GA-03d the product data CSV has headers and the product row', async () => {
  const csv = await (await fetch(`${api.url}/admin/marketing/products.csv`, { headers: auth('mkt') })).text();
  assert.match(csv, /型号,名称,浏览,加购,订单,件数,销售额,转化率/);
  assert.match(csv, /YR-HB-U2,UFO High Bay U2,2,1,1,50,/);
});

const local = (h) => { const d = new Date(Date.now() + h * 3600e3); return new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 16); };
test('GA-04a a percentage promotion is created in the admin', async () => {
  assert.match(flash(await form(auth('mkt'), '/admin/marketing/promotions', { name: '工矿灯特价', name_en: 'High bay sale', kind: 'percent', value: '15', products: 'YR-HB-U2', starts_at: local(-1), ends_at: local(48) })).ok, /已保存/);
});
test('GA-04b a percentage outside 1–99 is rejected', async () => {
  assert.match(flash(await form(auth('mkt'), '/admin/marketing/promotions', { name: 'x', kind: 'percent', value: '150', starts_at: local(-1), ends_at: local(1) })).err, /1–99/);
});
test('GA-04c the promotion list shows the promotion as running with its discount and products', async () => {
  const admin = ctx.promoAdmin = await page('/admin/marketing/promotions');
  assert.match(admin, /<b>工矿灯特价<\/b>[\s\S]*?减 15%[\s\S]*?YR-HB-U2[\s\S]*?进行中/);
});
test('GA-04d the buy-box API shows the English promotion label', async () => {
  const p = await (await fetch(`${api.url}/api/shop/product/YR-HB-U2`)).json();
  assert.equal(p.promo.label, 'High bay sale: 15% off');
});
test('GA-04e the buy-box API shows the Chinese promotion label for lang=zh', async () => {
  assert.equal((await (await fetch(`${api.url}/api/shop/product/YR-HB-U2?lang=zh`)).json()).promo.label, '工矿灯特价：8.5 折');
});
test('GA-04f the home page promotions zone API lists the promoted product', async () => {
  const zone = await (await fetch(`${api.url}/api/shop/promotions`)).json();
  assert.equal(zone[0].products[0].id, 'YR-HB-U2');
});
test('GA-04g the cart shows the promotion discount', async () => {
  const v = ctx.pv = visitor();
  await v.json('/api/shop/cart', { sku: 'YR-HB-U2', qty: 2 });
  const cartPage = await (await v('/shop/cart')).text();
  assert.match(cartPage, /High bay sale: 15% off: −/);
});
test('GA-04h checkout shows the promotion discount line', async () => {
  const co = ctx.co = await (await ctx.pv('/shop/checkout?country=US')).text();
  assert.match(co, /<td>High bay sale: 15% off<\/td><td class="n" style="color:#c62828">−/);
});
test('GA-04i the placed order carries the discount', async () => {
  const v = ctx.pv;
  const zoneId = ctx.co.match(/name="zone" value="(\d+)"/)[1];
  const placed = await v.form('/shop/checkout', { email: 'promo@buyer.test', ...ADDR, zone: zoneId, payment: 'tt' });
  const orderPage = await (await v(placed.headers.get('location'))).text();
  assert.match(orderPage, /−|Discount|discount/);
  const ord = await page('/admin/orders', auth('mkt'));
  assert.ok(ord.length > 0);
});
test('GA-04j a stopped promotion disappears from the buy-box API', async () => {
  const id = ctx.promoAdmin.match(/\/admin\/marketing\/promotions\/(\d+)\/stop/)[1];
  assert.match(flash(await form(auth('mkt'), `/admin/marketing/promotions/${id}/stop`, {})).ok, /已停用/);
  assert.equal((await (await fetch(`${api.url}/api/shop/product/YR-HB-U2`)).json()).promo, null);
});
test('GA-04k a stopped promotion disappears from the home page promotions zone', async () => {
  assert.deepEqual(await (await fetch(`${api.url}/api/shop/promotions`)).json(), []);
});

test('GA-05a roles: warehouse cannot open marketing (403)', async () => {
  assert.equal((await fetch(`${api.url}/admin/marketing`, { headers: auth('wes') })).status, 403);
});
test('GA-05b roles: warehouse cannot create a campaign (403)', async () => {
  assert.equal((await form(auth('wes'), '/admin/marketing/campaigns', { name: 'x', code: 'xx' })).status, 403);
});
test('GA-05c the marketing workbench shows visitors, views, carts, conversion, revenue, reviews and articles', async () => {
  const home = await page('/admin/home');
  for (const k of ['今日访客', '商品浏览', '加购', '下单转化率', '在线成交额', '待审核评价', '待发布文章']) assert.ok(home.includes(k), k);
});

test('GA-06a e-mail marketing: a draft e-mail is saved', async () => {
  await visitor().form('/shop/account/register', { email: 'news@buyer.test', password: 'Str0ngPassw0rd!', name: 'News Fan', marketing: '1' });
  await visitor().form('/shop/account/register', { email: 'quiet@buyer.test', password: 'Str0ngPassw0rd!', name: 'Quiet' });
  const saved = await form(auth('mkt'), '/admin/marketing/emails', { subject: 'New UFO high bay', body: 'Hello {{name}},\n\nOur new UFO is out.', tags: '', tier: '', lang: '' });
  assert.match(flash(saved).ok, /草稿已保存/);
  ctx.mail = flash(saved).location.match(/edit=(\d+)/)[1];
});
test('GA-06b the audience counts only customers who opted in to marketing', async () => {
  assert.match(await page(`/admin/marketing/emails?edit=${ctx.mail}`), /有 <b>1<\/b> 位同意接收的客户/);
});
test('GA-06c a test send is recorded', async () => {
  assert.match(flash(await form(auth('mkt'), `/admin/marketing/emails/${ctx.mail}/test`, { to: 'me@company.test' })).ok, /测试邮件已记录/);
});
test('GA-06d sending starts a task in the task center for the opted-in customers', async () => {
  const sent = await form(auth('mkt'), `/admin/marketing/emails/${ctx.mail}/send`, {});
  assert.match(flash(sent).path, /^\/admin\/tasks\//);
  assert.match(flash(sent).ok, /开始发送给 1 位客户/);
});
test('GA-06e the e-mail list shows the e-mail as sent with recipient / sent / opened counts', async () => {
  await new Promise((r) => setTimeout(r, 400));
  const list = await page('/admin/marketing/emails');
  assert.match(list, /New UFO high bay[\s\S]*?已发送[\s\S]*?<td class="n"><a href="\/admin\/marketing\/emails\/\d+">1<\/a><\/td><td class="n">1<\/td><td class="n">0<\/td>/);
});
test('GA-06f the recipient list contains the opted-in customer only', async () => {
  const rec = await page(`/admin/marketing/emails/${ctx.mail}`);
  assert.match(rec, /<td>news@buyer\.test<\/td><td>已发送<\/td>/);
  assert.doesNotMatch(rec, /quiet@buyer\.test/, 'did not opt in');
});
test('GA-06g the open-tracking pixel is served as a GIF even for an unknown token', async () => {
  const pixel = await fetch(`${api.url}/m/o/unknown.gif`);
  assert.equal(pixel.headers.get('content-type'), 'image/gif');
});
test('GA-06h one-click unsubscribe with an unknown token is 404', async () => {
  const un = await fetch(`${api.url}/m/u/unknown`);
  assert.equal(un.status, 404);
});
test('GA-06i an e-mail that was already sent cannot be sent again', async () => {
  assert.match(flash(await form(auth('mkt'), `/admin/marketing/emails/${ctx.mail}/send`, {})).err, /已经发送/);
});

test('GA-07a a keyword to track is added', async () => {
  assert.match(flash(await form(auth('mkt'), '/admin/marketing/seo/keywords', { keyword: 'UFO High Bay', lang: 'en', target_url: '/products/ufo-high-bay-u2/' })).ok, /已添加/);
});
test('GA-07b the same keyword in other letter case is rejected as existing', async () => {
  assert.match(flash(await form(auth('mkt'), '/admin/marketing/seo/keywords', { keyword: 'ufo high bay', lang: 'en' })).err, /已存在/);
});
test('GA-07c a ranking position is recorded for a day', async () => {
  const html = await page('/admin/marketing/seo');
  const kid = ctx.kid = html.match(/name="pos_(\d+)"/)[1];
  assert.match(flash(await form(auth('mkt'), '/admin/marketing/seo/ranks', { engine: 'google', day: '2026-10-01', [`pos_${kid}`]: '15' })).ok, /已保存 1 个排名/);
});
test('GA-07d importing from a rank tracker CSV adds rankings and new keywords', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const imp = await form(auth('mkt'), '/admin/marketing/seo/import', { csv: `ufo high bay, 6, , google, ${today}\nled flood light, , , google, ${today}` });
  assert.match(flash(imp).ok, /导入 2 条排名，新增 1 个关键词/);
  ctx.seo = await page('/admin/marketing/seo');
});
test('GA-07e the keyword list shows the latest position with its trend', async () => {
  assert.match(ctx.seo, /<b translate="no">ufo high bay<\/b>[\s\S]*?<td class="n">6<\/td>[\s\S]*?↑9/);
});
test('GA-07f a keyword without a position is shown as 100+', async () => {
  assert.match(ctx.seo, /<b translate="no">led flood light<\/b>[\s\S]*?<td class="n">100\+<\/td>/);
});
test('GA-07g the SEO page shows the AI-search mention rate', async () => {
  assert.match(ctx.seo, /AI 搜索提及率/);
});
test('GA-07h a position outside 1–100 is rejected', async () => {
  const today = new Date().toISOString().slice(0, 10);
  assert.match(flash(await form(auth('mkt'), '/admin/marketing/seo/ranks', { engine: 'google', day: today, [`pos_${ctx.kid}`]: '500' })).err, /1–100/);
});

test('GA-08a the zones page shows the automatic new-arrivals zone', async () => {
  const html = await page('/admin/marketing/zones');
  assert.match(html, /当前新品区：<a href="\/admin\/products\//);
});
test('GA-08b saving hand-picked new arrivals says it takes effect after publishing', async () => {
  assert.match(flash(await form(auth('mkt'), '/admin/marketing/zones', { mode: 'manual', count: '2', ids: 'YR-AR-S3, YR-HB-U2' })).ok, /发布网站后生效/);
});
test('GA-08c the zones page shows the hand-picked products in order', async () => {
  const html = await page('/admin/marketing/zones');
  assert.match(html, /当前新品区：<a href="\/admin\/products\/YR-AR-S3">[^<]+<\/a>、<a href="\/admin\/products\/YR-HB-U2">/);
});
test('GA-08d hand-picking an unknown product is rejected', async () => {
  assert.match(flash(await form(auth('mkt'), '/admin/marketing/zones', { mode: 'manual', count: '2', ids: 'NOPE' })).err, /商品不存在/);
});
test('GA-08e a zone change marks the product list as having unpublished changes', async () => {
  assert.match(await page('/admin/products'), /有未发布的修改/);
});
