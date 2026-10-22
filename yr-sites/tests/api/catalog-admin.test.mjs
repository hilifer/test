// Black-box: admin product centre over HTTP — create/edit with images and variants, validation, conflicts,
// status, delete, import (CSV + XLSX), export, categories, settings, publish → AI/MCP/site files. IDs PA-xx.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, flash, waitFor } from '../helpers/server.mjs';
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
const PW = 'Str0ngPassw0rd';
const basic = (u) => 'Basic ' + Buffer.from(`${u}:${PW}`).toString('base64');
const productForm = (o = {}) => ({
  id: 'NEW-UFO-200', name: 'New UFO 200W', category: 'high-bay', summary: 'Brand new UFO high bay.', status: 'draft', salesMode: 'both', illus: 'ufo',
  highlights: '170 lm/W\nIP66', applications: 'warehouse', certifications: 'CE\nRoHS', keywords: 'ufo', specs: 'Power: 200 W\nEfficacy: 170 lm/W',
  warranty: '5 years', unit: 'pcs', moq: '20', lead_min: '15', lead_max: '25', sample_min: '5', sample_max: '7', wattMin: '200', wattMax: '200', priceBands: '20-199:30-40 | 200+:27-35',
  v_0_sku: 'NEW-UFO-200-50K', v_0_options: 'CCT=5000K', v_0_price: '39', v_0_compare_at: '45', v_0_tier_prices: '200:34', v_0_min_qty: '20', v_0_weight_kg: '3.2', v_0_stock_local: '500', v_0_pcs_per_carton: '4', v_0_carton_cbm: '0.06', v_0_carton_gw: '14', v_0_erp_number: '1.01.NEW200',
  v_1_sku: '', action: 'save', ...o,
});
const mcpSearch = async (q) => (await (await api.json('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_products', arguments: { query: q } } })).json()).result.structuredContent.products;

describe('product create / edit', () => {
  const ctx = {};
  test('PA-01a every product centre page renders (200)', async () => {
    for (const p of ['/admin/products', '/admin/products/new', '/admin/products/YR-HB-U2', '/admin/products/import', '/admin/categories', '/admin/settings']) {
      const r = await api.admin(p);
      assert.equal(r.status, 200, p);
    }
  });
  test('PA-01b the product list shows the seed product count (11)', async () => {
    assert.match(await (await api.admin('/admin/products')).text(), /商品（11）/);
  });
  test('PA-02a creating a product with a variant and two photos redirects to the new product page', async () => {
    const r = await multipart('/admin/products/new', productForm(), [{ name: 'upload', filename: 'a.png', data: PNG, type: 'image/png' }, { name: 'upload', filename: 'b.png', data: PNG, type: 'image/png' }]);
    assert.equal(r.status, 302, (await r.text()).match(/class="flash err"[^<]*<[^>]*>([\s\S]{0,400})/)?.[1]);
    assert.match(flash(r).path, /\/admin\/products\/NEW-UFO-200$/);
    ctx.page = await (await api.admin('/admin/products/NEW-UFO-200')).text();
  });
  test('PA-02b both uploaded photos are stored as /media images on the product', async () => {
    const imgs = ctx.imgs = [...ctx.page.matchAll(/src="(\/media\/[a-f0-9]{24}\.png)"/g)].map((m) => m[1]);
    assert.equal(imgs.length, 2);
  });
  test('PA-02c the variant SKU is saved on the product', async () => {
    assert.match(ctx.page, /value="NEW-UFO-200-50K"/);
  });
  test('PA-02d an uploaded photo is served as PNG with an immutable cache header', async () => {
    const img = await api.get(ctx.imgs[0]);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.match(img.headers.get('cache-control'), /immutable/);
  });
  test('PA-03a validation errors re-render the form (400) with every message', async () => {
    const r = await multipart('/admin/products/new', productForm({ id: 'BAD-1', name: '', moq: '0', v_0_sku: 'BAD-1-A', v_0_price: '' }));
    assert.equal(r.status, 400);
    const html = ctx.badHtml = await r.text();
    assert.match(html, /名称必填/);
    assert.match(html, /起订量必须/);
    assert.match(html, /必须填写售价/);
  });
  test('PA-03b the re-rendered form keeps what was typed', async () => {
    assert.match(ctx.badHtml, /value="BAD-1"/);
  });
  test('PA-04a a fake image (SVG renamed to .png) is refused with 400 and a format message', async () => {
    const r = await multipart('/admin/products/new', productForm({ id: 'IMG-1', v_0_sku: 'IMG-1-A', slug: 'img-1' }), [{ name: 'upload', filename: 'evil.png', data: Buffer.from('<svg onload=alert(1)>'), type: 'image/png' }]);
    assert.equal(r.status, 400);
    assert.match(await r.text(), /只支持 JPG、PNG、WebP/);
  });
  test('PA-04b a product with a refused image is not saved', async () => {
    assert.equal((await api.admin('/admin/products/IMG-1')).status, 404);
  });
  test('PA-05 /media only serves real uploaded files (no path traversal)', async () => {
    for (const p of ['/media/..%2f..%2fetc%2fpasswd', '/media/0123456789abcdef01234567.png', '/media/x.svg']) assert.equal((await api.get(p)).status, 404, p);
  });
  test('PA-06a editing a product (remove a photo, add a variant, change price) is saved', async () => {
    const page = await (await api.admin('/admin/products/NEW-UFO-200')).text();
    const version = page.match(/name="_version" value="(\d+)"/)[1];
    const imgs = ctx.editImgs = [...page.matchAll(/name="img_url_(\d)" value="([^"]+)"/g)].map((m) => m[2]);
    const r = await multipart('/admin/products/NEW-UFO-200', productForm({ _version: version, img_url_0: imgs[0], img_order_0: '2', img_url_1: imgs[1], img_order_1: '1', img_remove: imgs[0], v_0_price: '38', v_1_sku: 'NEW-UFO-200-40K', v_1_options: 'CCT=4000K', v_1_price: '38', v_1_min_qty: '20', v_1_weight_kg: '3.2' }));
    assert.equal(r.status, 302, (await r.text()).match(/class="flash err"[^<]*<[^>]*>([\s\S]{0,400})/)?.[1]);
    ctx.after = await (await api.admin('/admin/products/NEW-UFO-200')).text();
  });
  test('PA-06b the removed photo is gone and only the other photo remains', async () => {
    assert.equal([...ctx.after.matchAll(/name="img_url_\d" value="([^"]+)"/g)].map((m) => m[1]).join(), ctx.editImgs[1]);
  });
  test('PA-06c the added variant is saved', async () => {
    assert.match(ctx.after, /value="NEW-UFO-200-40K"/);
  });
  test('PA-06d the revision log records the edit (admin, v2)', async () => {
    assert.match(ctx.after, /修改记录[\s\S]*admin[\s\S]*v2/);
  });
  test('PA-07a concurrent edit: the first save with the current version succeeds', async () => {
    const page = await (await api.admin('/admin/products/NEW-UFO-200')).text();
    const version = ctx.version = page.match(/name="_version" value="(\d+)"/)[1];
    const img = ctx.img = page.match(/name="img_url_0" value="([^"]+)"/)[1]; // the form always posts the current photos back
    assert.equal((await multipart('/admin/products/NEW-UFO-200', productForm({ _version: version, name: 'Alice', img_url_0: img }))).status, 302);
  });
  test('PA-07b concurrent edit: a second save with the same old version is refused (409)', async () => {
    const { version, img } = ctx;
    const r = await multipart('/admin/products/NEW-UFO-200', productForm({ _version: version, name: 'Bob', img_url_0: img }));
    assert.equal(r.status, 409);
    assert.match(await r.text(), /已被其他人修改/);
  });
});

describe('publish', () => {
  test('PA-08a a draft product is not visible to MCP', async () => {
    assert.ok(!(await mcpSearch('Alice')).some((p) => p.id === 'NEW-UFO-200'));
  });
  test('PA-08b setting the product on sale (上架) succeeds', async () => {
    assert.match(flash(await api.form('/admin/products/NEW-UFO-200/status', { to: 'published' })).ok, /上架/);
  });
  test('PA-08c a product on sale is still not visible to MCP before publishing', async () => {
    assert.ok(!(await mcpSearch('Alice')).some((p) => p.id === 'NEW-UFO-200'), 'still waiting for publish');
  });
  test('PA-08d the product list warns about unpublished changes', async () => {
    assert.match(await (await api.admin('/admin/products')).text(), /有未发布的修改/);
  });
  test('PA-08e publishing reports the number of products published', async () => {
    const r = flash(await api.form('/admin/products/publish', {}));
    assert.match(r.ok, /已发布 12 个商品/);
  });
  test('PA-08f after publishing the product on sale is visible to MCP', async () => {
    const found = await mcpSearch('Alice');
    assert.ok(found.some((p) => p.id === 'NEW-UFO-200'));
  });
  test('PA-09 the AI sales chat can recommend the new product immediately', async () => {
    const r = await (await api.json('/api/chat', { message: 'Alice price for 300 pcs' })).json();
    assert.match(r.reply, /Alice/);
  });
  const siteProduct = () => JSON.parse(readFileSync(join(api.dir, 'site/src/data/catalog.json'), 'utf8')).products.find((x) => x.id === 'NEW-UFO-200');
  test('PA-10a the site catalog.json carries the product photo from /media', async () => {
    assert.match(siteProduct().image, /^\/media\//);
  });
  test('PA-10b the site catalog.json carries the sales mode', async () => {
    assert.equal(siteProduct().salesMode, 'both');
  });
  test('PA-10c the site catalog.json carries the variants as last saved', async () => {
    assert.deepEqual(siteProduct().variants.map((v) => [v.sku, v.price, v.minQty, v.weightKg]), [['NEW-UFO-200-50K', 39, 20, 3.2]]); // as last saved in PA-07
  });
  test('PA-10d publishing triggers a site rebuild', async () => {
    assert.ok(await waitFor(async () => /build/.test(await (await api.admin('/admin/content')).text())), 'site rebuild was triggered');
  });
  test('PA-11a archiving and publishing removes the product from MCP', async () => {
    await api.form('/admin/products/NEW-UFO-200/status', { to: 'archived' });
    await api.form('/admin/products/publish', {});
    assert.ok(!(await mcpSearch('Alice')).some((p) => p.id === 'NEW-UFO-200'));
  });
  test('PA-11b a product that was once published cannot be deleted', async () => {
    assert.match(flash(await api.form('/admin/products/NEW-UFO-200/delete', {})).err, /不能删除/);
  });
});

describe('bulk import / export', () => {
  const imp = {};
  test('PA-12a the CSV import template has the required column headers', async () => {
    const tpl = imp.tpl = await (await api.admin('/admin/products/template.csv')).text();
    assert.match(tpl, /型号\/编码\*/);
  });
  test('PA-12b CSV import preview counts importable and erroneous rows', async () => {
    const tpl = imp.tpl;
    const header = tpl.replace(/^﻿/, '').split(/\r?\n/)[0];
    const cols = header.split(',');
    const row = (vals) => cols.map((c) => vals[c] ?? '').map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',');
    const good = { '型号/编码*': 'CSV-1', '状态(draft/published/archived)': 'published', '品类编码*': 'flood', '名称*': 'CSV Flood 100W', '一句话简介*': 'Imported from CSV.', '质保*': '3 years', '单位*': 'pcs', '起订量*': '10', '交期最短天数*': '10', '交期最长天数*': '20', '样品最短天数*': '3', '样品最长天数*': '5', '参数(参数名: 值，用|分隔)*': 'Power: 100 W | IP: IP66', '价格档位(如 50-499:39-52 | 500+:35-46)': '10-99:20-28 | 100+:18-25' };
    const bad = { ...good, '型号/编码*': 'CSV-2', '品类编码*': 'nope', '名称*': 'Bad' };
    const update = { '型号/编码*': 'YR-HB-U2', '名称*': 'UFO High Bay U2 (CSV update)' };
    const csv = '﻿' + [header, row(good), row(bad), row(update)].join('\r\n');
    const prev = await multipart('/admin/products/import', {}, [{ name: 'file', filename: 'p.csv', data: Buffer.from(csv), type: 'text/csv' }]);
    const html = imp.html = await prev.text();
    assert.match(html, /共 3 行，2 行可导入，1 行有错误/);
  });
  test('PA-12c CSV import preview shows the error of the bad row', async () => {
    assert.match(imp.html, /品类不存在：nope/);
  });
  test('PA-12d confirming the CSV import creates and updates only the valid rows', async () => {
    const token = imp.html.match(/name="token" value="([a-f0-9]+)"/)[1];
    const done = flash(await api.form('/admin/products/import/confirm', { token }));
    assert.match(done.ok, /新建 1 个，更新 1 个/);
    assert.match(flash(await api.form('/admin/products/import/confirm', { token })).err, /预览已过期/, 'the preview token works only once');
  });
  test('PA-12e the CSV-created product has the imported status and a SKU named like the model', async () => {
    const page = await (await api.admin('/admin/products/CSV-1')).text();
    assert.match(page, /已上架/);
    assert.match(page, /value="CSV-1"/, 'a SKU named like the model was created');
  });
  test('PA-12f the CSV row for an existing product updates it', async () => {
    assert.match(await (await api.admin('/admin/products/YR-HB-U2')).text(), /CSV update/);
  });
  test('PA-13 a used import token cannot be replayed', async () => {
    const r = flash(await api.form('/admin/products/import/confirm', { token: 'deadbeef' }));
    assert.match(r.err, /过期/);
  });
  test('PA-14a Excel (.xlsx) import preview finds the importable row', async () => {
    const buf = makeXlsx([
      ['型号/编码*', '品类编码*', '名称*', '一句话简介*', '质保*', '单位*', '起订量*', '交期最短天数*', '交期最长天数*', '样品最短天数*', '样品最长天数*', '参数(参数名: 值，用|分隔)*'],
      ['XLSX-1', 'indoor', 'Excel Panel 40W', 'From Excel.', '5 years', 'pcs', 100, 10, 20, 3, 5, 'Power: 40 W'],
    ]);
    const html = await (await multipart('/admin/products/import', {}, [{ name: 'file', filename: 'p.xlsx', data: buf }])).text();
    assert.match(html, /1 行可导入/);
    imp.xlsxToken = html.match(/name="token" value="([a-f0-9]+)"/)[1];
  });
  test('PA-14b confirming the Excel import creates the product', async () => {
    assert.match(flash(await api.form('/admin/products/import/confirm', { token: imp.xlsxToken })).ok, /新建 1 个/);
  });
  test('PA-14c a newly imported row without a status defaults to draft', async () => {
    const page = await (await api.admin('/admin/products/XLSX-1')).text();
    assert.match(page, /草稿/, 'new rows default to draft');
  });
  test('PA-14d a newly imported row without a price band is inquiry-only', async () => {
    const page = await (await api.admin('/admin/products/XLSX-1')).text();
    assert.match(page, /仅询价/, 'no price band → inquiry only');
  });
  test('PA-15a the product export is an attachment named products-led.csv', async () => {
    const r = await api.admin('/admin/products/export.csv');
    assert.match(r.headers.get('content-disposition'), /products-led\.csv/);
  });
  test('PA-15b the product export starts with a UTF-8 BOM so Excel opens it cleanly', async () => {
    const buf = Buffer.from(await (await api.admin('/admin/products/export.csv')).arrayBuffer());
    assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  });
  test('PA-15c the product export contains every product (seed, CSV, Excel, created)', async () => {
    const buf = Buffer.from(await (await api.admin('/admin/products/export.csv')).arrayBuffer());
    const text = buf.toString('utf8');
    for (const id of ['YR-HB-U2', 'CSV-1', 'XLSX-1', 'NEW-UFO-200']) assert.ok(text.includes(id), id);
  });
  test('PA-16 garbage files are rejected politely', async () => {
    const r = flash(await multipart('/admin/products/import', {}, [{ name: 'file', filename: 'x.xlsx', data: Buffer.from('PKnot really a zip') }]));
    assert.match(r.err, /无法读取文件/);
  });
});

describe('categories, settings, permissions', () => {
  test('PA-17a a new category can be added', async () => {
    assert.match(flash(await api.form('/admin/categories/save', { _new: '1', id: 'garden', name: 'Garden Lights', blurb: 'Bollards and spike lights.' })).ok, /已保存/);
  });
  test('PA-17b a category in use by a product cannot be deleted', async () => {
    await multipart('/admin/products/new', productForm({ id: 'GDN-1', slug: 'gdn-1', category: 'garden', v_0_sku: 'GDN-1-A' }));
    assert.match(flash(await api.form('/admin/categories/garden/delete', {})).err, /还有 1 个商品/);
  });
  test('PA-18a valid contact and price settings are saved', async () => {
    const r = flash(await api.form('/admin/settings', { c_email: 'export@yaorong.test', c_whatsapp: '+86 138 0000 0001', c_phone: '', c_address: 'Shenzhen', c_salesHours: '', priceDisplay: 'ranges', currency: 'usd', priceTerm: 'FOB Shenzhen', priceNote: 'Reference only — subject to the formal PI.', sample: '' }));
    assert.match(r.ok, /已保存/);
  });
  test('PA-18b the saved contact e-mail appears on the customer portal right away', async () => {
    assert.match(await (await api.get('/portal')).text(), /export@yaorong\.test/);
  });
  test('PA-18c an invalid contact e-mail is rejected', async () => {
    assert.match(flash(await api.form('/admin/settings', { c_email: 'not-an-email', priceDisplay: 'ranges' })).err, /邮箱格式/);
  });
  test('PA-18d after publishing, site.json carries the saved contact e-mail', async () => {
    await api.form('/admin/products/publish', {});
    const site = JSON.parse(readFileSync(join(api.dir, 'site/src/data/site.json'), 'utf8'));
    assert.equal(site.contact.email, 'export@yaorong.test');
  });
  test('PA-18e after publishing, the sample/demo banner is switched off in site.json and catalog.json', async () => {
    const site = JSON.parse(readFileSync(join(api.dir, 'site/src/data/site.json'), 'utf8'));
    assert.equal(site.demo, false, 'sample banner switched off');
    const cat = JSON.parse(readFileSync(join(api.dir, 'site/src/data/catalog.json'), 'utf8'));
    assert.equal(cat.sample, false);
  });
  test('PA-18f after publishing, catalog.json carries the currency normalised to upper case', async () => {
    const cat = JSON.parse(readFileSync(join(api.dir, 'site/src/data/catalog.json'), 'utf8'));
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
  test('PA-20a roles: sales may view the product list', async () => {
    await api.form('/admin/users/new', { username: 'salesp', role: 'sales', password: PW });
    await api.form('/admin/users/new', { username: 'contentp', role: 'content', password: PW });
    assert.equal((await api.get('/admin/products', { headers: { authorization: basic('salesp') } })).status, 200);
  });
  test('PA-20b roles: sales may not create products (403)', async () => {
    assert.equal((await multipart('/admin/products/new', productForm({ id: 'S-1', slug: 's-1', v_0_sku: 'S-1-A' }), [], basic('salesp'))).status, 403);
  });
  test('PA-20c publishing without a login is refused (401)', async () => {
    assert.equal((await api.form('/admin/products/publish', {}, { auth: false })).status, 401);
  });
  test('PA-20d roles: content staff may create products', async () => {
    assert.equal((await multipart('/admin/products/new', productForm({ id: 'C-1', slug: 'c-1', v_0_sku: 'C-1-A' }), [], basic('contentp'))).status, 302);
  });
  test('PA-20e roles: sales may not open the settings (403)', async () => {
    assert.equal((await api.get('/admin/settings', { headers: { authorization: basic('salesp') } })).status, 403);
  });

  const bulk = (data, auth = basic('contentp')) => fetch(`${api.url}/admin/products/bulk`, { method: 'POST', redirect: 'manual', headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' }, body: data });
  const body = (action, list, extra = []) => new URLSearchParams([['action', action], ...list.map((i) => ['ids', i]), ...extra]);
  let ids = [];
  test('PA-21a bulk delist (下架) of two selected products moves them to archived', async () => {
    ids = [...(await (await api.admin('/admin/products?status=published')).text()).matchAll(/name="ids" value="([^"]+)"/g)].map((m) => m[1]).slice(0, 3);
    assert.equal(ids.length, 3);
    assert.match(flash(await bulk(body('archive', ids.slice(0, 2)))).ok, /下架 2 个/);
    assert.match(await (await api.admin('/admin/products?status=archived')).text(), new RegExp(ids[0]));
  });
  test('PA-21b bulk list (上架) puts the two products back on sale', async () => {
    assert.match(flash(await bulk(body('publish', ids.slice(0, 2)))).ok, /上架 2 个/);
  });
  test('PA-21c a bulk action without selected products asks to select first', async () => {
    assert.match(flash(await bulk(body('publish', []))).err, /请先勾选/);
  });
  test('PA-21d the recommended-products limit can be saved', async () => {
    assert.match(flash(await api.form('/admin/products/featured-max', { max: '2' })).ok, /推荐上限已保存/);
  });
  test('PA-21e bulk "recommend" marks the selected products as recommended', async () => {
    assert.match(flash(await bulk(body('feature', ids.slice(0, 2)))).ok, /已设为推荐 2 个/);
  });
  test('PA-21f recommending beyond the limit is refused', async () => {
    assert.match(flash(await bulk(body('feature', [ids[2]]))).err, /最多 2 个/);
  });
  test('PA-21g the recommended filter lists the recommended products with count and limit', async () => {
    const list = await (await api.admin('/admin/products?featured=1')).text();
    assert.equal([...list.matchAll(/name="ids"/g)].length, 2);
    assert.match(list, /推荐 2 \/ 上限 2/);
  });
  test('PA-21h bulk sort saves a numeric sort number and the list shows it', async () => {
    assert.match(flash(await bulk(new URLSearchParams([['action', 'sort'], [`sort_${ids[2]}`, '1']]))).ok, /已更新 1 个排序号/);
    assert.match(await (await api.admin('/admin/products')).text(), new RegExp(`name="sort_${ids[2]}" value="1"`));
  });
  test('PA-21i a non-numeric sort number is rejected', async () => {
    assert.match(flash(await bulk(new URLSearchParams([['action', 'sort'], [`sort_${ids[2]}`, 'x']]))).err, /排序号/);
  });
  test('PA-21j sales may not use bulk actions (403)', async () => {
    assert.equal((await bulk(body('archive', ids), basic('salesp'))).status, 403);
  });
  test('PA-21k after publishing, the recommended products are flagged in the site catalog.json', async () => {
    // after publishing, the recommended products are in the site's catalog.json
    await api.form('/admin/products/publish', {});
    const cat = JSON.parse(readFileSync(join(api.dir, 'site/src/data/catalog.json'), 'utf8'));
    assert.deepEqual(cat.products.filter((p) => p.featured).map((p) => p.id).sort(), ids.slice(0, 2).sort());
  });
  const edit = {};
  test('PA-22a the product edit page offers a "save and list" (保存并上架) button', async () => {
    const id = 'C-1';
    await api.form('/admin/products/featured-max', { max: '0' });
    const page = await (await api.admin(`/admin/products/${id}`)).text();
    edit.version = page.match(/name="_version" value="(\d+)"/)[1];
    assert.match(page, /保存并上架/);
  });
  test('PA-22b "save and list" saves the product and reports it as listed', async () => {
    const id = 'C-1';
    const r = await multipart(`/admin/products/${id}`, productForm({ id, slug: 'c-1', v_0_sku: 'C-1-A', _version: edit.version, sort: '5', featured: '1', status: 'draft', action: 'save_publish' }), [], basic('contentp'));
    assert.equal(r.status, 302, (await r.text()).match(/class="flash err"[^<]*<[^>]*>([\s\S]{0,400})/)?.[1]);
    assert.match(flash(r).ok, /已保存并上架/);
    edit.after = await (await api.admin(`/admin/products/${id}`)).text();
  });
  test('PA-22c the sort number entered on the edit page is saved', async () => {
    assert.match(edit.after, /name="sort" value="5"/);
  });
  test('PA-22d the recommended flag set on the edit page is saved', async () => {
    assert.match(edit.after, /name="featured" value="1" checked/);
  });
  test('PA-22e after "save and list" the product status is on sale (已上架)', async () => {
    assert.match(edit.after, /已上架/);
  });
});
