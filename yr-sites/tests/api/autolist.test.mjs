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

test('LS-A01 roles: content (catalog) can run auto-listing; sales and warehouse may only look; anonymous 401', async () => {
  for (const [u, role] of [['cnt1', 'content'], ['sales1', 'sales'], ['wh01', 'warehouse']]) await api.form('/admin/users/new', { username: u, role, password: PW });
  assert.equal((await fetch(`${api.url}/admin/products/autolist`, { headers: as('cnt1') })).status, 200);
  assert.equal((await fetch(`${api.url}/admin/products/autolist`, { headers: as('sales1') })).status, 200); // catalog.view
  for (const u of ['sales1', 'wh01']) assert.equal((await fetch(`${api.url}/admin/products/autolist/erp`, { method: 'POST', redirect: 'manual', headers: as(u) })).status, 403, u);
  assert.equal((await upload('/admin/products/autolist/sheet', 'x.csv', 'model,name\nA1,B', as('sales1'))).status, 403);
  assert.equal((await api.get('/admin/products/autolist')).status, 401);
});

test('LS-A02 pull new materials from Kingdee (simulated): two queued, second pull adds none', async () => {
  assert.match(flash(await api.form('/admin/products/autolist/erp', {})).ok, /已加入 2 个新物料/);
  assert.match(flash(await api.form('/admin/products/autolist/erp', {})).ok, /没有新的物料/);
  const page = await (await api.admin('/admin/products/autolist')).text();
  assert.match(page, /MAT-LED-9001/);
  assert.match(page, /未配置大模型/);
});

test('LS-A03 upload a supplier spec sheet (CSV) and paste text; empty / bad input refused', async () => {
  const csv = '﻿型号,名称,功率,防护等级,售价,重量\nYR-TP-40,Tri-proof light 40W,40W,IP65,16.8,1.1\nYR-TP-60,Tri-proof light 60W,60W,IP65,,\n';
  assert.match(flash(await upload('/admin/products/autolist/sheet', 'tri.csv', csv, { authorization: 'Basic ' + Buffer.from('admin:test-pass').toString('base64') })).ok, /已加入 2 个产品/);
  assert.match(flash(await upload('/admin/products/autolist/sheet', 'tri.csv', csv, { authorization: 'Basic ' + Buffer.from('admin:test-pass').toString('base64') })).err, /没有新的产品行/);
  assert.match(flash(await api.form('/admin/products/autolist/text', { text: 'short' })).err, /太短/);
  assert.match(flash(await api.form('/admin/products/autolist/text', { text: 'YR-SL-77 Solar street light 60W\nBattery: LiFePO4 12.8V 30Ah\nIP65' })).ok, /已加入队列/);
});

test('LS-A04 process the queue (rule mode): drafts with issues to check, nothing goes live', async () => {
  const r = flash(await api.form('/admin/products/autolist/run', {}));
  assert.match(r.ok, /处理 5 个：0 个已自动上架，5 个草稿待审核/);
  const page = await (await api.admin('/admin/products/autolist?status=drafted')).text();
  assert.match(page, /规则生成/);
  assert.match(page, /审核并上架/);
  const p = await (await api.admin('/admin/products/YR-TP-40')).text();
  assert.match(p, /Tri-proof light 40W/);
  assert.equal((await (await api.get('/api/shop/product/YR-TP-40')).status), 404); // not published
  const mcp = await (await api.json('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_products', arguments: { query: 'tri-proof' } } })).text();
  assert.doesNotMatch(mcp, /YR-TP-40/);
});

test('LS-A05 a person approves the draft (上架) and publishes → live; first publish records a GEO promotion', async () => {
  assert.equal((await api.form('/admin/products/YR-TP-40/status', { to: 'published' })).status, 302);
  await api.form('/admin/products/publish', {});
  assert.equal((await api.get('/api/shop/product/YR-TP-40')).status, 200);
  assert.match(await (await api.json('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_products', arguments: { query: 'tri-proof' } } })).text(), /YR-TP-40/); // AI agents see it now
  let page = '';
  for (let i = 0; i < 50; i++) { page = await (await api.admin('/admin/products/autolist')).text(); if (/YR-TP-40<\/a><\/td><td><div>搜索引擎收录通知/.test(page)) break; await new Promise((r) => setTimeout(r, 50)); }
  assert.match(page, /YR-TP-40<\/a><\/td><td><div>搜索引擎收录通知（未配置 INDEXNOW_KEY，已跳过）/);
  assert.match(page, /GEO 监测问题 \d 个/);
  // publishing again does not promote it a second time
  await api.form('/admin/products/publish', {});
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await (await api.admin('/admin/products/autolist')).text()).match(/>YR-TP-40<\/a><\/td><td><div>搜索引擎/g).length, 1);
});

test('LS-A06 settings: validation errors shown; saved defaults; skip a queued job', async () => {
  assert.match(flash(await api.form('/admin/products/autolist/settings', { warranty: '', unit: 'pcs', moq: '1', lead_min: '5', lead_max: '1', sample_min: '1', sample_max: '2' })).err, /默认质保必填[\s\S]*生产交期/);
  assert.match(flash(await api.form('/admin/products/autolist/settings', { autoPublish: '1', promote: '1', warranty: '5 years', unit: 'pcs', moq: '20', lead_min: '15', lead_max: '25', sample_min: '5', sample_max: '7' })).ok, /设置已保存/);
  const page = await (await api.admin('/admin/products/autolist')).text();
  assert.doesNotMatch(page, /还没有保存过设置/);
  assert.match(page, /name="autoPublish" value="1" checked/);
  await api.form('/admin/products/autolist/text', { text: 'YR-XX-1 Something to skip later\nPower: 10W\nIP20' });
  const id = (await (await api.admin('/admin/products/autolist?status=queued')).text()).match(/\/admin\/products\/autolist\/([\w-]+)\/skip/)[1];
  assert.match(flash(await api.form(`/admin/products/autolist/${id}/skip`, {})).ok, /已跳过/);
  assert.match(await (await api.admin('/admin/products/autolist?status=skipped')).text(), /YR-XX-1/);
});
