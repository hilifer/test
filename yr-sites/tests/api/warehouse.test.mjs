// Black-box: warehouse over HTTP — roles, shipping desk, picking list, bulk shipping by form and by pasted lines, stock
// movements and safety stock, carriers, warehouse workbench, English. IDs WA-xx.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, flash } from '../helpers/server.mjs';

let api;
const ctx = {};
before(async () => {
  api = await startServer({ site: 'led', env: { ERP_MODE: 'local' } });
  for (const [u, role] of [['wes', 'warehouse'], ['sam', 'sales']]) await api.form('/admin/users/new', { username: u, role, password: PW });
});
after(() => api.stop());

const PW = 'Str0ngPassw0rd';
const auth = (u) => ({ authorization: 'Basic ' + Buffer.from(`${u}:${PW}`).toString('base64') });
const ADMIN = { authorization: 'Basic ' + Buffer.from('admin:test-pass').toString('base64') };
const form = (h, path, data) => fetch(api.url + path, { method: 'POST', redirect: 'manual', headers: { ...h, 'content-type': 'application/x-www-form-urlencoded' }, body: data instanceof URLSearchParams ? data : new URLSearchParams(data) });
const page = async (path, h = auth('wes')) => (await fetch(api.url + path, { headers: h })).text();
/** Inquiry → PI → accepted → paid in full → ready to ship. */
async function readyOrder(email) {
  await api.json('/api/leads', { email, company: `${email.split('@')[0]} Ltd`, product_id: 'YR-HB-U2', quantity: 100, consent: true });
  const lead = (await page(`/admin?scope=all&q=${encodeURIComponent(email)}`, ADMIN)).match(/\/admin\/lead\/([\w-]+)"/)[1];
  const q = flash(await fetch(`${api.url}/admin/quotes/new?lead=${lead}`, { headers: ADMIN, redirect: 'manual' })).path.split('/').pop();
  await form(ADMIN, `/admin/quotes/${q}/status`, { to: 'sent' });
  const token = (await page(`/admin/quotes/${q}`, ADMIN)).match(/\/portal\/pi\/([\w-]+)/)[1];
  await fetch(`${api.url}/portal/pi/${token}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '' });
  const row = (await page('/admin/orders', ADMIN)).split('<tr>').find((r) => r.includes(email.split('@')[0]));
  const id = row.match(/\/admin\/orders\/([\w-]+)/)[1], number = row.match(/<b>([^<]+)<\/b>/)[1];
  const o = await page(`/admin/orders/${id}`, ADMIN);
  const total = o.match(/合计[^\d]*([\d,]+(?:\.\d+)?)/)[1].replace(/,/g, ''); // tt30 terms: paying it all moves the order to production
  await form(ADMIN, `/admin/orders/${id}/payment`, { kind: 'deposit', amount: total });
  await form(ADMIN, `/admin/orders/${id}/status`, { to: 'ready_to_ship' });
  return { id, number };
}

test('WA-01 roles: warehouse uses the shipping desk, stock and carriers; sales has no access', async () => {
  ctx.a = await readyOrder('alpha@buyer.test');
  ctx.b = await readyOrder('beta@buyer.test');
  ctx.c = await readyOrder('gamma@buyer.test');
  for (const p of ['/admin/warehouse', '/admin/warehouse/stock', '/admin/warehouse/carriers']) {
    assert.equal((await fetch(api.url + p, { headers: auth('wes') })).status, 200, p);
    assert.equal((await fetch(api.url + p, { headers: auth('sam') })).status, 403, p);
  }
  const desk = await page('/admin/warehouse');
  for (const o of [ctx.a, ctx.b, ctx.c]) assert.ok(desk.includes(o.number), o.number);
});

test('WA-02 picking list for selected orders: totals by SKU and per order', async () => {
  const html = await page(`/admin/warehouse/picking?ids=${ctx.a.id}&ids=${ctx.b.id}`);
  assert.match(html, /<h1>拣货单<\/h1>/);
  assert.match(html, /2 个订单 · 200 件/);
  assert.match(html, /<b>YR-HB-U2<\/b>[\s\S]*?<td class="n"><b>200<\/b><\/td>/);
  assert.match(html, new RegExp(`${ctx.a.number}[\\s\\S]*${ctx.b.number}`));
  assert.equal((await fetch(`${api.url}/admin/warehouse/picking`, { headers: auth('wes'), redirect: 'manual' })).status, 302);
});

test('WA-03 bulk shipping from the desk form and from pasted lines; results per order; stock goes down', async () => {
  const before = Number((await page('/admin/warehouse/stock')).match(/<b>YR-HB-U2<\/b><\/a><\/td><td>[^<]*<span class="mute">[^<]*<\/span><\/td><td class="n">(-?\d+)<\/td>/)[1]);
  const body = new URLSearchParams([[`carrier_${ctx.a.id}`, 'DHL'], [`tracking_${ctx.a.id}`, 'DHL-001'], [`mode_${ctx.a.id}`, 'express'], [`carrier_${ctx.b.id}`, ''], [`tracking_${ctx.b.id}`, '']]);
  const html = await (await form(auth('wes'), '/admin/warehouse/ship', body)).text();
  assert.match(html, /批量发货结果：成功 1，失败 0/);
  assert.match(html, new RegExp(`${ctx.a.number}：已发货，发货单 SH-`));
  assert.match(await page(`/admin/orders/${ctx.a.id}`, ADMIN), /已发货/);
  const imp = await (await form(auth('wes'), '/admin/warehouse/import', { lines: `order, carrier, tracking\n${ctx.b.number}, UPS, 1Z-77, express\nSO-NOPE, UPS, 9` })).text();
  assert.match(imp, /成功 1，失败 1/);
  assert.match(imp, /SO-NOPE：<b style="color:#c62828">订单不存在<\/b>/);
  const after = Number((await page('/admin/warehouse/stock')).match(/<b>YR-HB-U2<\/b><\/a><\/td><td>[^<]*<span class="mute">[^<]*<\/span><\/td><td class="n">(-?\d+)<\/td>/)[1]);
  assert.equal(after, before - 200);
  assert.match(await page('/admin/warehouse/stock?kind=ship'), /发货<\/td><td class="n" style="color:#c62828">-100<\/td>/);
  assert.match(flash(await form(auth('wes'), '/admin/warehouse/ship', { x: '1' })).err, /至少填写一个运单号/);
});

test('WA-04 stock: record goods in and a stock count; safety stock with default; low stock shows on the workbench', async () => {
  assert.match(flash(await form(auth('wes'), '/admin/warehouse/move', { sku: 'YR-HB-U2', kind: 'in', qty: '1000', ref: 'PO-9', note: 'container' })).ok, /已登记，YR-HB-U2 结存/);
  assert.match(flash(await form(auth('wes'), '/admin/warehouse/move', { sku: 'YR-HB-U2', kind: 'adjust', qty: '900' })).ok, /结存 900/);
  assert.match(flash(await form(auth('wes'), '/admin/warehouse/move', { sku: 'YR-HB-U2', kind: 'out', qty: '5000' })).err, /库存只有 900/);
  assert.match(flash(await form(auth('wes'), '/admin/warehouse/safety', { default: '10', 'safety_YR-HB-U2': '5000' })).ok, /安全库存/);
  const html = await page('/admin/warehouse/stock');
  assert.match(html, /<tr style="background:#fdecea"><td><a href="\?sku=YR-HB-U2"><b>YR-HB-U2<\/b>/);
  assert.match(await page('/admin/home'), /YR-HB-U2 可售 \d+，低于安全库存 5000/);
  assert.match(flash(await form(auth('wes'), '/admin/warehouse/safety', { default: '-1' })).err, /不小于 0/);
});

test('WA-05 carriers: quotes for a destination and real performance per carrier', async () => {
  const html = await page('/admin/warehouse/carriers?country=US&kg=5');
  assert.match(html, /运费模板报价：US · 5 kg/);
  assert.match(html, /<b>DHL<\/b><\/td><td>快递<\/td><td class="n">1<\/td>/);
  assert.match(html, /<b>UPS<\/b>/);
});

test('WA-06 English warehouse pages and workbench', async () => {
  const EN = { ...auth('wes'), cookie: 'yr_admin_lang=en' };
  for (const p of ['/admin/warehouse', '/admin/warehouse/stock', '/admin/warehouse/carriers?country=US&kg=5']) {
    const text = (await page(p, EN)).replace(/<textarea[\s\S]*?<\/textarea>|<script[\s\S]*?<\/script>|<[^>]+>/g, ' ');
    const left = text.match(/[^\s]{0,20}[一-鿿]+[^\s]{0,20}/);
    assert.equal(left, null, `${p}: ${left?.[0]}`);
  }
  const home = await page('/admin/home');
  for (const k of ['待发货订单', '今日已发', '在途', '物流异常', '低库存 SKU', '待处理补发']) assert.ok(home.includes(k), k);
});
