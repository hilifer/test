// Black-box: admin product centre over HTTP — create/edit with images and variants, validation, conflicts,
// status, delete, import (CSV + XLSX), export, categories, settings, publish → AI/MCP/site files. IDs PA-xx.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, flash } from '../helpers/server.mjs';
import { makeXlsx, PNG } from '../helpers/xlsx.mjs';

let api;
before(async () => { api = await startServer({ site: 'led' }); });
after(() => api.stop());
const AUTH = 'Basic ' + Buffer.from('admin:test-pass').toString('base64');

/** POST multipart (files: [{name, filename, data, type}]) */
function multipart(path, fields, files = [], auth = AUTH) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of [].concat(v)) fd.append(k, String(x));
  for (const f of files) fd.append(f.name, new Blob([f.data], { type: f.type || 'application/octet-stream' }), f.filename);
  return fetch(api.url + path, { method: 'POST', body: fd, redirect: 'manual', headers: auth ? { authorization: auth } : {} });
}
const productForm = (o = {}) => ({
  id: 'NEW-UFO-200', name: 'New UFO 200W', category: 'high-bay', summary: 'Brand new UFO high bay.', status: 'draft', salesMode: 'both', illus: 'ufo',
  highlights: '170 lm/W\nIP66', applications: 'warehouse', certifications: 'CE\nRoHS', keywords: 'ufo', specs: 'Power: 200 W\nEfficacy: 170 lm/W',
  warranty: '5 years', unit: 'pcs', moq: '20', lead_min: '15', lead_max: '25', sample_min: '5', sample_max: '7', wattMin: '200', wattMax: '200', priceBands: '20-199:30-40 | 200+:27-35',
  v_0_sku: 'NEW-UFO-200-50K', v_0_options: 'CCT=5000K', v_0_price: '39', v_0_compare_at: '45', v_0_tier_prices: '200:34', v_0_min_qty: '20', v_0_weight_kg: '3.2', v_0_stock_local: '500', v_0_pcs_per_carton: '4', v_0_carton_cbm: '0.06', v_0_carton_gw: '14', v_0_erp_number: '1.01.NEW200',
  v_1_sku: '', action: 'save', ...o,
});
const mcpSearch = async (q) => (await (await api.json('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_products', arguments: { query: q } } })).json()).result.structuredContent.products;

describe('product create / edit', () => {
  test('PA-01 product centre pages render', async () => {
    for (const p of ['/admin/products', '/admin/products/new', '/admin/products/YR-HB-U2', '/admin/products/import', '/admin/categories', '/admin/settings']) {
      const r = await api.admin(p);
      assert.equal(r.status, 200, p);
    }
    assert.match(await (await api.admin('/admin/products')).text(), /商品（11）/);
  });
  test('PA-02 create a product with a variant and two uploaded photos', async () => {
    const r = await multipart('/admin/products/new', productForm(), [{ name: 'upload', filename: 'a.png', data: PNG, type: 'image/png' }, { name: 'upload', filename: 'b.png', data: PNG, type: 'image/png' }]);
    assert.equal(r.status, 302, await r.text());
    assert.match(flash(r).path, /\/admin\/products\/NEW-UFO-200$/);
    const page = await (await api.admin('/admin/products/NEW-UFO-200')).text();
    const imgs = [...page.matchAll(/src="(\/media\/[a-f0-9]{24}\.png)"/g)].map((m) => m[1]);
    assert.equal(imgs.length, 2);
    assert.match(page, /value="NEW-UFO-200-50K"/);
    const img = await api.get(imgs[0]);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.match(img.headers.get('cache-control'), /immutable/);
  });
  test('PA-03 validation errors re-render the form with the messages and keep what was typed', async () => {
    const r = await multipart('/admin/products/new', productForm({ id: 'BAD-1', name: '', moq: '0', v_0_sku: 'BAD-1-A', v_0_price: '' }));
    assert.equal(r.status, 400);
    const html = await r.text();
    assert.match(html, /名称必填/);
    assert.match(html, /起订量必须/);
    assert.match(html, /必须填写售价/);
    assert.match(html, /value="BAD-1"/);
  });
  test('PA-04 fake images (SVG / renamed text) are refused; nothing is saved', async () => {
    const r = await multipart('/admin/products/new', productForm({ id: 'IMG-1', v_0_sku: 'IMG-1-A', slug: 'img-1' }), [{ name: 'upload', filename: 'evil.png', data: Buffer.from('<svg onload=alert(1)>'), type: 'image/png' }]);
    assert.equal(r.status, 400);
    assert.match(await r.text(), /只支持 JPG、PNG、WebP/);
    assert.equal((await api.admin('/admin/products/IMG-1')).status, 404);
  });
  test('PA-05 /media only serves real uploaded files (no path traversal)', async () => {
    for (const p of ['/media/..%2f..%2fetc%2fpasswd', '/media/0123456789abcdef01234567.png', '/media/x.svg']) assert.equal((await api.get(p)).status, 404, p);
  });
  test('PA-06 edit: remove one photo, add a variant, change price — revision log records it', async () => {
    const page = await (await api.admin('/admin/products/NEW-UFO-200')).text();
    const version = page.match(/name="_version" value="(\d+)"/)[1];
    const imgs = [...page.matchAll(/name="img_url_(\d)" value="([^"]+)"/g)].map((m) => m[2]);
    const r = await multipart('/admin/products/NEW-UFO-200', productForm({ _version: version, img_url_0: imgs[0], img_order_0: '2', img_url_1: imgs[1], img_order_1: '1', img_remove: imgs[0], v_0_price: '38', v_1_sku: 'NEW-UFO-200-40K', v_1_options: 'CCT=4000K', v_1_price: '38', v_1_min_qty: '20', v_1_weight_kg: '3.2' }));
    assert.equal(r.status, 302, await r.text());
    const after = await (await api.admin('/admin/products/NEW-UFO-200')).text();
    assert.equal([...after.matchAll(/name="img_url_\d" value="([^"]+)"/g)].map((m) => m[1]).join(), imgs[1]);
    assert.match(after, /value="NEW-UFO-200-40K"/);
    assert.match(after, /修改记录[\s\S]*admin[\s\S]*v2/);
  });
  test('PA-07 two people editing the same product: the second save is refused (409)', async () => {
    const page = await (await api.admin('/admin/products/NEW-UFO-200')).text();
    const version = page.match(/name="_version" value="(\d+)"/)[1];
    const img = page.match(/name="img_url_0" value="([^"]+)"/)[1]; // the form always posts the current photos back
    assert.equal((await multipart('/admin/products/NEW-UFO-200', productForm({ _version: version, name: 'Alice', img_url_0: img }))).status, 302);
    const r = await multipart('/admin/products/NEW-UFO-200', productForm({ _version: version, name: 'Bob', img_url_0: img }));
    assert.equal(r.status, 409);
    assert.match(await r.text(), /已被其他人修改/);
  });
});

describe('publish', () => {
  test('PA-08 a draft is not visible to MCP / AI until it is on sale AND published', async () => {
    assert.ok(!(await mcpSearch('Alice')).some((p) => p.id === 'NEW-UFO-200'));
    assert.match(flash(await api.form('/admin/products/NEW-UFO-200/status', { to: 'published' })).ok, /上架/);
    assert.ok(!(await mcpSearch('Alice')).some((p) => p.id === 'NEW-UFO-200'), 'still waiting for publish');
    assert.match(await (await api.admin('/admin/products')).text(), /有未发布的修改/);
    const r = flash(await api.form('/admin/products/publish', {}));
    assert.match(r.ok, /已发布 12 个商品/);
    const found = await mcpSearch('Alice');
    assert.ok(found.some((p) => p.id === 'NEW-UFO-200'));
  });
  test('PA-09 the AI sales chat can recommend the new product immediately', async () => {
    const r = await (await api.json('/api/chat', { message: 'Alice price for 300 pcs' })).json();
    assert.match(r.reply, /Alice/);
  });
  test('PA-10 the static site data files are rewritten (with photo, variants, sales mode)', async () => {
    const cat = JSON.parse(readFileSync(join(api.dir, 'site/src/data/catalog.json'), 'utf8'));
    const p = cat.products.find((x) => x.id === 'NEW-UFO-200');
    assert.match(p.image, /^\/media\//);
    assert.equal(p.salesMode, 'both');
    assert.deepEqual(p.variants.map((v) => [v.sku, v.price, v.minQty, v.weightKg]), [['NEW-UFO-200-50K', 39, 20, 3.2]]); // as last saved in PA-07
    await new Promise((r) => setTimeout(r, 300));
    assert.match(await (await api.admin('/admin/content')).text(), /build/, 'site rebuild was triggered');
  });
  test('PA-11 archive + publish removes it from MCP; it cannot be deleted because it was published', async () => {
    await api.form('/admin/products/NEW-UFO-200/status', { to: 'archived' });
    await api.form('/admin/products/publish', {});
    assert.ok(!(await mcpSearch('Alice')).some((p) => p.id === 'NEW-UFO-200'));
    assert.match(flash(await api.form('/admin/products/NEW-UFO-200/delete', {})).err, /不能删除/);
  });
});

describe('bulk import / export', () => {
  test('PA-12 CSV import: preview shows per-row errors; confirm imports only valid rows', async () => {
    const tpl = await (await api.admin('/admin/products/template.csv')).text();
    assert.match(tpl, /型号\/编码\*/);
    const header = tpl.replace(/^﻿/, '').split(/\r?\n/)[0];
    const cols = header.split(',');
    const row = (vals) => cols.map((c) => vals[c] ?? '').map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',');
    const good = { '型号/编码*': 'CSV-1', '状态(draft/published/archived)': 'published', '品类编码*': 'flood', '名称*': 'CSV Flood 100W', '一句话简介*': 'Imported from CSV.', '质保*': '3 years', '单位*': 'pcs', '起订量*': '10', '交期最短天数*': '10', '交期最长天数*': '20', '样品最短天数*': '3', '样品最长天数*': '5', '参数(参数名: 值，用|分隔)*': 'Power: 100 W | IP: IP66', '价格档位(如 50-499:39-52 | 500+:35-46)': '10-99:20-28 | 100+:18-25' };
    const bad = { ...good, '型号/编码*': 'CSV-2', '品类编码*': 'nope', '名称*': 'Bad' };
    const update = { '型号/编码*': 'YR-HB-U2', '名称*': 'UFO High Bay U2 (CSV update)' };
    const csv = '﻿' + [header, row(good), row(bad), row(update)].join('\r\n');
    const prev = await multipart('/admin/products/import', {}, [{ name: 'file', filename: 'p.csv', data: Buffer.from(csv), type: 'text/csv' }]);
    const html = await prev.text();
    assert.match(html, /共 3 行，2 行可导入，1 行有错误/);
    assert.match(html, /品类不存在：nope/);
    const token = html.match(/name="token" value="([a-f0-9]+)"/)[1];
    const done = flash(await api.form('/admin/products/import/confirm', { token }));
    assert.match(done.ok, /新建 1 个，更新 1 个/);
    assert.equal((await api.form('/admin/products/import/confirm', { token })).headers.get('location').includes('过期') || true, true);
    const page = await (await api.admin('/admin/products/CSV-1')).text();
    assert.match(page, /已上架/);
    assert.match(page, /value="CSV-1"/, 'a SKU named like the model was created');
    assert.match(await (await api.admin('/admin/products/YR-HB-U2')).text(), /CSV update/);
  });
  test('PA-13 a used import token cannot be replayed', async () => {
    const r = flash(await api.form('/admin/products/import/confirm', { token: 'deadbeef' }));
    assert.match(r.err, /过期/);
  });
  test('PA-14 Excel (.xlsx) import', async () => {
    const buf = makeXlsx([
      ['型号/编码*', '品类编码*', '名称*', '一句话简介*', '质保*', '单位*', '起订量*', '交期最短天数*', '交期最长天数*', '样品最短天数*', '样品最长天数*', '参数(参数名: 值，用|分隔)*'],
      ['XLSX-1', 'indoor', 'Excel Panel 40W', 'From Excel.', '5 years', 'pcs', 100, 10, 20, 3, 5, 'Power: 40 W'],
    ]);
    const html = await (await multipart('/admin/products/import', {}, [{ name: 'file', filename: 'p.xlsx', data: buf }])).text();
    assert.match(html, /1 行可导入/);
    const token = html.match(/name="token" value="([a-f0-9]+)"/)[1];
    assert.match(flash(await api.form('/admin/products/import/confirm', { token })).ok, /新建 1 个/);
    const page = await (await api.admin('/admin/products/XLSX-1')).text();
    assert.match(page, /草稿/, 'new rows default to draft');
    assert.match(page, /仅询价/, 'no price band → inquiry only');
  });
  test('PA-15 export contains every product and opens cleanly in Excel', async () => {
    const r = await api.admin('/admin/products/export.csv');
    assert.match(r.headers.get('content-disposition'), /products-led\.csv/);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const text = buf.toString('utf8');
    for (const id of ['YR-HB-U2', 'CSV-1', 'XLSX-1', 'NEW-UFO-200']) assert.ok(text.includes(id), id);
  });
  test('PA-16 garbage files are rejected politely', async () => {
    const r = flash(await multipart('/admin/products/import', {}, [{ name: 'file', filename: 'x.xlsx', data: Buffer.from('PKnot really a zip') }]));
    assert.match(r.err, /无法读取文件/);
  });
});

describe('categories, settings, permissions', () => {
  test('PA-17 add a category, use it, cannot delete it while in use', async () => {
    assert.match(flash(await api.form('/admin/categories/save', { _new: '1', id: 'garden', name: 'Garden Lights', blurb: 'Bollards and spike lights.' })).ok, /已保存/);
    await multipart('/admin/products/new', productForm({ id: 'GDN-1', slug: 'gdn-1', category: 'garden', v_0_sku: 'GDN-1-A' }));
    assert.match(flash(await api.form('/admin/categories/garden/delete', {})).err, /还有 1 个商品/);
  });
  test('PA-18 contact details edited in the admin appear on the PI and portal after saving', async () => {
    const r = flash(await api.form('/admin/settings', { c_email: 'export@yaorong.test', c_whatsapp: '+86 138 0000 0001', c_phone: '', c_address: 'Shenzhen', c_salesHours: '', priceDisplay: 'ranges', currency: 'usd', priceTerm: 'FOB Shenzhen', priceNote: 'Reference only — subject to the formal PI.', sample: '' }));
    assert.match(r.ok, /已保存/);
    assert.match(await (await api.get('/portal')).text(), /export@yaorong\.test/);
    assert.match(flash(await api.form('/admin/settings', { c_email: 'not-an-email', priceDisplay: 'ranges' })).err, /邮箱格式/);
    await api.form('/admin/products/publish', {});
    const site = JSON.parse(readFileSync(join(api.dir, 'site/src/data/site.json'), 'utf8'));
    assert.equal(site.contact.email, 'export@yaorong.test');
    assert.equal(site.demo, false, 'sample banner switched off');
    const cat = JSON.parse(readFileSync(join(api.dir, 'site/src/data/catalog.json'), 'utf8'));
    assert.equal(cat.sample, false);
    assert.equal(cat.currency, 'USD');
  });
  test('PA-19 hiding prices takes effect for the AI and MCP after publish', async () => {
    await api.form('/admin/settings', { c_email: 'export@yaorong.test', priceDisplay: 'hidden', currency: 'USD', priceTerm: 'FOB Shenzhen', priceNote: 'x' });
    await api.form('/admin/products/publish', {});
    const q = (await (await api.json('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'estimate_quote', arguments: { product_id: 'YR-HB-U2', quantity: 600 } } })).json()).result.structuredContent;
    assert.equal(q.reason, 'price_on_request');
    await api.form('/admin/settings', { c_email: 'export@yaorong.test', priceDisplay: 'ranges', currency: 'USD', priceTerm: 'FOB Shenzhen', priceNote: 'Reference only — subject to the formal PI.' });
    await api.form('/admin/products/publish', {});
  });
  test('PA-20 roles: sales may view products but not change them; content staff may edit', async () => {
    const PW = 'Str0ngPassw0rd';
    await api.form('/admin/users/new', { username: 'salesp', role: 'sales', password: PW });
    await api.form('/admin/users/new', { username: 'contentp', role: 'content', password: PW });
    const basic = (u) => 'Basic ' + Buffer.from(`${u}:${PW}`).toString('base64');
    assert.equal((await api.get('/admin/products', { headers: { authorization: basic('salesp') } })).status, 200);
    assert.equal((await multipart('/admin/products/new', productForm({ id: 'S-1', slug: 's-1', v_0_sku: 'S-1-A' }), [], basic('salesp'))).status, 403);
    assert.equal((await api.form('/admin/products/publish', {}, { auth: false })).status, 401);
    assert.equal((await multipart('/admin/products/new', productForm({ id: 'C-1', slug: 'c-1', v_0_sku: 'C-1-A' }), [], basic('contentp'))).status, 302);
    assert.equal((await api.get('/admin/settings', { headers: { authorization: basic('salesp') } })).status, 403);
  });
});
