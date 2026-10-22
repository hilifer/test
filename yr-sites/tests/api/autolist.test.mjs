// Black-box: AI auto-listing admin over HTTP (rule mode — no LLM configured on this server): pull Kingdee (simulated)
// materials, upload a spec sheet, paste text, process the queue, review the draft, publish → GEO promotion; roles. IDs LS-A-xx.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, flash } from '../helpers/server.mjs';

let api;
before(async () => { api = await startServer({ site: 'led' }); });
after(async () => { await api.stop(); });

const PW = 'Str0ngPassw0rd';
const as = (u) => ({ authorization: 'Basic ' + Buffer.from(`${u}:${PW}`).toString('base64') });
const upload = (path, name, text, headers = {}) => { const fd = new FormData(); fd.append('file', new Blob([text], { type: 'text/csv' }), name); return fetch(api.url + path, { method: 'POST', body: fd, redirect: 'manual', headers }); };

test('LS-A01a roles: a content (catalog) user can open auto-listing', async () => {
  for (const [u, role] of [['cnt1', 'content'], ['sales1', 'sales'], ['wh01', 'warehouse']]) await api.form('/admin/users/new', { username: u, role, password: PW });
  assert.equal((await fetch(`${api.url}/admin/products/autolist`, { headers: as('cnt1') })).status, 200);
});
test('LS-A01b roles: a sales user can view auto-listing (catalog.view)', async () => {
  assert.equal((await fetch(`${api.url}/admin/products/autolist`, { headers: as('sales1') })).status, 200); // catalog.view
});
test('LS-A01c roles: sales and warehouse users cannot pull Kingdee materials (403)', async () => {
  for (const u of ['sales1', 'wh01']) assert.equal((await fetch(`${api.url}/admin/products/autolist/erp`, { method: 'POST', redirect: 'manual', headers: as(u) })).status, 403, u);
});
test('LS-A01d roles: a sales user cannot upload a spec sheet (403)', async () => {
  assert.equal((await upload('/admin/products/autolist/sheet', 'x.csv', 'model,name\nA1,B', as('sales1'))).status, 403);
});
test('LS-A01e auto-listing needs a login (401)', async () => {
  assert.equal((await api.get('/admin/products/autolist')).status, 401);
});

test('LS-A02a the first Kingdee (simulated) pull queues two new materials', async () => {
  assert.match(flash(await api.form('/admin/products/autolist/erp', {})).ok, /已加入 2 个新物料/);
});
test('LS-A02b a second Kingdee pull adds no materials', async () => {
  assert.match(flash(await api.form('/admin/products/autolist/erp', {})).ok, /没有新的物料/);
});
test('LS-A02c the queue lists the pulled material', async () => {
  const page = await (await api.admin('/admin/products/autolist')).text();
  assert.match(page, /MAT-LED-9001/);
});
test('LS-A02d the auto-listing page says that no LLM is configured (rule mode)', async () => {
  const page = await (await api.admin('/admin/products/autolist')).text();
  assert.match(page, /未配置大模型/);
});

const csv = '﻿型号,名称,功率,防护等级,售价,重量\nYR-TP-40,Tri-proof light 40W,40W,IP65,16.8,1.1\nYR-TP-60,Tri-proof light 60W,60W,IP65,,\n';
test('LS-A03a uploading a supplier spec sheet (CSV) queues one product per row', async () => {
  assert.match(flash(await upload('/admin/products/autolist/sheet', 'tri.csv', csv, { authorization: 'Basic ' + Buffer.from('admin:test-pass').toString('base64') })).ok, /已加入 2 个产品/);
});
test('LS-A03b uploading the same spec sheet again finds no new product rows', async () => {
  assert.match(flash(await upload('/admin/products/autolist/sheet', 'tri.csv', csv, { authorization: 'Basic ' + Buffer.from('admin:test-pass').toString('base64') })).err, /没有新的产品行/);
});
test('LS-A03c pasted text that is too short is refused', async () => {
  assert.match(flash(await api.form('/admin/products/autolist/text', { text: 'short' })).err, /太短/);
});
test('LS-A03d pasted product text is queued', async () => {
  assert.match(flash(await api.form('/admin/products/autolist/text', { text: 'YR-SL-77 Solar street light 60W\nBattery: LiFePO4 12.8V 30Ah\nIP65' })).ok, /已加入队列/);
});

test('LS-A04a processing the queue in rule mode creates 5 drafts and publishes none', async () => {
  const r = flash(await api.form('/admin/products/autolist/run', {}));
  assert.match(r.ok, /处理 5 个：0 个已自动上架，5 个草稿待审核/);
});
test('LS-A04b drafted jobs are marked as rule-generated with a "review and list" action', async () => {
  const page = await (await api.admin('/admin/products/autolist?status=drafted')).text();
  assert.match(page, /规则生成/);
  assert.match(page, /审核并上架/);
});
test('LS-A04c the draft product is created with the name from the spec sheet', async () => {
  const p = await (await api.admin('/admin/products/YR-TP-40')).text();
  assert.match(p, /Tri-proof light 40W/);
});
test('LS-A04d the draft product is not in the shop API (404)', async () => {
  assert.equal((await (await api.get('/api/shop/product/YR-TP-40')).status), 404); // not published
});
test('LS-A04e the draft product is not found by MCP search_products', async () => {
  const mcp = await (await api.json('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_products', arguments: { query: 'tri-proof' } } })).text();
  assert.doesNotMatch(mcp, /YR-TP-40/);
});

let promoPage = '';
test('LS-A05a an approved (上架) and published draft is live in the shop API', async () => {
  assert.equal((await api.form('/admin/products/YR-TP-40/status', { to: 'published' })).status, 302);
  await api.form('/admin/products/publish', {});
  assert.equal((await api.get('/api/shop/product/YR-TP-40')).status, 200);
});
test('LS-A05b the published product is found by MCP search_products', async () => {
  assert.match(await (await api.json('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_products', arguments: { query: 'tri-proof' } } })).text(), /YR-TP-40/); // AI agents see it now
});
test('LS-A05c the first publish records a search-engine notification (skipped without INDEXNOW_KEY)', async () => {
  let page = '';
  for (let i = 0; i < 200; i++) { page = await (await api.admin('/admin/products/autolist')).text(); if (/YR-TP-40<\/a><\/td><td><div>搜索引擎收录通知/.test(page)) break; await new Promise((r) => setTimeout(r, 50)); }
  promoPage = page;
  assert.match(page, /YR-TP-40<\/a><\/td><td><div>搜索引擎收录通知（未配置 INDEXNOW_KEY，已跳过）/);
});
test('LS-A05d the first publish adds GEO monitoring questions', async () => {
  assert.match(promoPage, /GEO 监测问题 \d 个/);
});
test('LS-A05e publishing again does not promote the product a second time', async () => {
  // publishing again does not promote it a second time
  await api.form('/admin/products/publish', {});
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await (await api.admin('/admin/products/autolist')).text()).match(/>YR-TP-40<\/a><\/td><td><div>搜索引擎/g).length, 1);
});

test('LS-A06a settings: missing warranty and an inverted lead time are reported', async () => {
  assert.match(flash(await api.form('/admin/products/autolist/settings', { warranty: '', unit: 'pcs', moq: '1', lead_min: '5', lead_max: '1', sample_min: '1', sample_max: '2' })).err, /默认质保必填[\s\S]*生产交期/);
});
test('LS-A06b settings: valid defaults are saved and shown on the page', async () => {
  assert.match(flash(await api.form('/admin/products/autolist/settings', { autoPublish: '1', promote: '1', warranty: '5 years', unit: 'pcs', moq: '20', lead_min: '15', lead_max: '25', sample_min: '5', sample_max: '7' })).ok, /设置已保存/);
  const page = await (await api.admin('/admin/products/autolist')).text();
  assert.doesNotMatch(page, /还没有保存过设置/);
  assert.match(page, /name="autoPublish" value="1" checked/);
});
test('LS-A06c a queued job can be skipped and appears under "skipped"', async () => {
  await api.form('/admin/products/autolist/text', { text: 'YR-XX-1 Something to skip later\nPower: 10W\nIP20' });
  const id = (await (await api.admin('/admin/products/autolist?status=queued')).text()).match(/\/admin\/products\/autolist\/([\w-]+)\/skip/)[1];
  assert.match(flash(await api.form(`/admin/products/autolist/${id}/skip`, {})).ok, /已跳过/);
  assert.match(await (await api.admin('/admin/products/autolist?status=skipped')).text(), /YR-XX-1/);
});
