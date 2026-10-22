// Module: server/src/catalog/{validate,store}.js — product centre rules, spreadsheets, variants, versions,
// publish snapshot. IDs PC-xx.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { useTempEnv } from '../helpers/env.mjs';
import { makeXlsx, PNG } from '../helpers/xlsx.mjs';

const { env } = useTempEnv({ site: 'led', MEDIA_DIR: '' });
process.env.MEDIA_DIR = join(env.SITE_DIR, '..', 'media');
const V = await import('../../server/src/catalog/validate.js');
const C = await import('../../server/src/catalog/store.js');
const { config } = await import('../../server/src/config.js');
const S = await import('../../server/src/ops/service.js');

const base = () => ({ id: 'T-100', name: 'Test High Bay 100W', category: 'high-bay', summary: 'A test fixture.', warranty: '5 years', unit: 'pcs', moq: 10, leadTimeDays: [10, 20], sampleDays: [3, 5], specs: 'Power: 100 W\nIP: IP65', priceBands: '10-99:20-25 | 100+:18-22', highlights: 'Bright\nEfficient', certifications: 'CE\nRoHS' });
const variant = (o = {}) => ({ sku: 'T-100-50K', options: 'CCT=5000K', price: '25', min_qty: '10', weight_kg: '2.5', stock_local: '100', tier_prices: '100:22 | 500:20', ...o });
const ctx = (o = {}) => ({ categories: C.listCategories(), existing: new Map(), isNew: true, ...o });

describe('validation', () => {
  test('PC-01a a complete product passes validation and gets a slug from its name', () => {
    const { product, errors } = V.validateProduct(base(), ctx());
    assert.deepEqual(errors, []);
    assert.equal(product.slug, 'test-high-bay-100w');
  });
  test('PC-01b "name: value" spec lines are parsed into an object', () => {
    assert.deepEqual(V.validateProduct(base(), ctx()).product.specs, { Power: '100 W', IP: 'IP65' });
  });
  test('PC-01c price bands are parsed, the last one open-ended', () => {
    assert.deepEqual(V.validateProduct(base(), ctx()).product.priceBands, [{ minQty: 10, maxQty: 99, low: 20, high: 25 }, { minQty: 100, maxQty: null, low: 18, high: 22 }]);
  });
  test('PC-01d line-separated lists (certifications) are parsed into arrays', () => {
    assert.deepEqual(V.validateProduct(base(), ctx()).product.certifications, ['CE', 'RoHS']);
  });
  const incomplete = () => V.validateProduct({ id: 'x y', category: 'nope', moq: 0, leadTimeDays: [9, 3], sampleDays: [], specs: '' }, ctx()).errors;
  test('PC-02a missing required fields are reported (name, summary, warranty, specs)', () => {
    const errors = incomplete();
    for (const k of ['名称必填', '简介必填', '质保必填', '至少填写一项参数']) assert.ok(errors.some((e) => e.includes(k)), k);
  });
  test('PC-02b invalid formats are reported (id, unknown category, MOQ, lead time, sample time)', () => {
    const errors = incomplete();
    for (const k of ['型号/编码', '品类不存在', '起订量', '生产交期', '样品时间']) assert.ok(errors.some((e) => e.includes(k)), k);
  });
  const bad = (b) => V.validateProduct({ ...base(), priceBands: b }, ctx()).errors.join('|');
  test('PC-03a price bands must be contiguous', () => {
    assert.match(bad('10-99:20-25 | 150+:18-22'), /应从 100 开始/);
  });
  test('PC-03b only the last price band may be open-ended', () => {
    assert.match(bad('10+:20-25 | 100+:18-22'), /只有最后一档/);
  });
  test('PC-03c a price band\'s low price may not exceed its high price', () => {
    assert.match(bad('10-99:30-25'), /最低价不能高于最高价/);
  });
  test('PC-03d a malformed price band is reported', () => {
    assert.match(bad('ten:1-2'), /格式错误/);
  });
  test('PC-03e no price bands gives a "quoted per project" warning', () => {
    assert.ok(V.validateProduct({ ...base(), priceBands: '' }, ctx()).warnings.some((w) => w.includes('按项目报价')));
  });
  const dupErrors = () => V.validateProduct(base(), ctx({ existing: new Map([['T-100', { slug: 'other' }], ['T-200', { slug: 'test-high-bay-100w' }]]) })).errors;
  test('PC-04a a duplicate id is rejected', () => {
    assert.ok(dupErrors().some((e) => e.includes('已存在')));
  });
  test('PC-04b a slug used by another product is rejected', () => {
    assert.ok(dupErrors().some((e) => e.includes('已被 T-200 使用')));
  });
  test('PC-05a an image URL that is neither uploaded media nor https is rejected', () => {
    assert.ok(V.validateProduct({ ...base(), images: ['javascript:alert(1)'] }, ctx()).errors.some((e) => e.includes('图片地址无效')));
  });
  test('PC-05b an uploaded media path is accepted as an image', () => {
    assert.deepEqual(V.validateProduct({ ...base(), images: ['/media/0123456789abcdef01234567.png'] }, ctx()).errors, []);
  });
  test('PC-06a PNG and JPEG are recognised by their magic bytes', () => {
    assert.equal(V.imageType(PNG), 'png');
    assert.equal(V.imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'jpg');
  });
  test('PC-06b SVG and GIF are not accepted as images', () => {
    assert.equal(V.imageType(Buffer.from('<svg onload=alert(1)>')), null);
    assert.equal(V.imageType(Buffer.from('GIF89a......')), null);
  });
});

describe('spreadsheets', () => {
  const tricky = () => V.parseCsv('﻿型号/编码*,名称*,参数(参数名: 值，用|分隔)*\r\n"A-1","Lamp, ""Pro""","Power: 100 W | Note: line1\nline2"\r\n');
  test('PC-07a CSV with BOM, CRLF and Chinese headers is read into one row with the id mapped', () => {
    const rows = tricky();
    assert.equal(rows.length, 1);
    assert.equal(V.rowToProduct(rows[0]).product.id, 'A-1');
  });
  test('PC-07b CSV quoted fields keep embedded commas and doubled quotes', () => {
    assert.equal(V.rowToProduct(tricky()[0]).product.name, 'Lamp, "Pro"');
  });
  test('PC-07c CSV quoted fields keep embedded newlines', () => {
    assert.match(V.rowToProduct(tricky()[0]).product.specs, /line1\nline2/);
  });
  test('PC-08 semicolon-separated CSV (European Excel) is detected', () => {
    assert.deepEqual(V.parseCsv('id;name\nA;B\n'), [{ id: 'A', name: 'B' }]);
  });
  const rt = {};
  test('PC-09a export neutralises spreadsheet formulas', () => {
    rt.p = { ...V.validateProduct(base(), ctx()).product, name: '=cmd|calc', images: [] };
    rt.csv = V.toCsv([V.productToRow(rt.p, 'published')]);
    assert.match(rt.csv, /"?'=cmd/);
  });
  test('PC-09b import restores the neutralised text and the status', () => {
    rt.back = V.rowToProduct(V.parseCsv(rt.csv)[0]);
    assert.equal(rt.back.status, 'published');
    assert.equal(rt.back.product.name, '=cmd|calc');
  });
  test('PC-09c export → import round-trip keeps price bands, specs and lead time', () => {
    const again = V.validateProduct(rt.back.product, ctx()).product;
    assert.deepEqual(again.priceBands, rt.p.priceBands);
    assert.deepEqual(again.specs, rt.p.specs);
    assert.deepEqual(again.leadTimeDays, [10, 20]);
  });
  test('PC-10a real .xlsx files (shared strings + numbers) are read', () => {
    const buf = makeXlsx([['型号/编码*', '名称*', '起订量*'], ['X-1', 'Excel Lamp & Co', 25], ['X-2', '中文灯', 5]]);
    const rows = V.parseXlsx(buf);
    assert.deepEqual(rows.map((r) => V.rowToProduct(r).product), [{ id: 'X-1', name: 'Excel Lamp & Co', moq: '25' }, { id: 'X-2', name: '中文灯', moq: '5' }]);
  });
  test('PC-10b a file that is not an .xlsx (zip) is refused', () => {
    assert.throws(() => V.parseXlsx(Buffer.from('not a zip')), /xlsx/);
  });
});

describe('store', () => {
  test('PC-11a first start seeds the five categories', () => {
    assert.equal(C.listCategories().length, 5);
  });
  test('PC-11b first start seeds the products into the admin list and the live catalog', () => {
    const { total } = C.listProducts();
    assert.equal(total, 11);
    assert.equal(config.catalog.products.length, 11);
  });
  test('PC-11c first start seeds one SKU per product with price and MOQ from the files', () => {
    const sku = C.skusFor('YR-HB-U2')[0];
    assert.equal(sku.price, 52);
    assert.equal(sku.min_qty, 50);
  });
  test('PC-12a creating a product with variants starts at version 1', () => {
    const { product } = C.saveProduct(base(), { isNew: true, status: 'draft', variants: [variant(), variant({ sku: 'T-100-40K', options: 'CCT=4000K', price: '24' })] });
    assert.equal(product._version, 1);
  });
  test('PC-12b each variant\'s SKU, option value and price are saved', () => {
    assert.deepEqual(C.skusFor('T-100').map((v) => [v.sku, v.variant, v.price]), [['T-100-50K', '5000K', 25], ['T-100-40K', '4000K', 24]]);
  });
  test('PC-12c variant tier prices are parsed and saved', () => {
    assert.deepEqual(C.skusFor('T-100')[0].tier_prices, [{ minQty: 100, price: 22 }, { minQty: 500, price: 20 }]);
  });
  test('PC-12d creating a product logs a revision', () => {
    assert.equal(C.revisionsFor('T-100')[0].summary, '新建（含规格）');
  });
  const err = (vs, mode = 'both') => { try { C.saveProduct({ ...base(), id: 'T-300', slug: 't-300' }, { isNew: true, salesMode: mode, variants: vs }); return ''; } catch (e) { return e.message; } };
  test('PC-13a a variant for online sale must have a price', () => {
    assert.match(err([variant({ sku: 'T-300-A', price: '' })]), /必须填写售价/);
  });
  test('PC-13b inquiry-only products need no variant price', () => {
    assert.equal(err([variant({ sku: 'T-300-A', price: '' })], 'inquiry'), '', 'inquiry-only products need no price');
  });
  test('PC-13c tier price quantities must be ascending', () => {
    assert.match(err([variant({ sku: 'T-301-A', tier_prices: '500:20 | 100:22' })]), /阶梯价/);
  });
  test('PC-13d a tier price may not be higher than the base price', () => {
    assert.match(err([variant({ sku: 'T-302-A', tier_prices: '100:30' })]), /不应高于基础售价/);
  });
  test('PC-13e duplicate SKUs within a product are rejected', () => {
    assert.match(err([variant({ sku: 'T-303-A' }), variant({ sku: 'T-303-A' })]), /重复/);
  });
  test('PC-13f a SKU owned by another product is rejected', () => {
    assert.match(err([variant({ sku: 'YR-HB-U2' })]), /已属于商品 YR-HB-U2/);
  });
  test('PC-13g a product needs at least one variant', () => {
    assert.match(err([]), /至少需要一个规格/);
  });
  test('PC-14 optimistic locking: a stale edit is refused', () => {
    const p = C.getProduct('T-100');
    C.saveProduct({ id: 'T-100', name: 'Renamed by Alice' }, { expectVersion: p._version });
    assert.throws(() => C.saveProduct({ id: 'T-100', name: 'Renamed by Bob' }, { expectVersion: p._version }), /已被其他人修改/);
    assert.equal(C.getProduct('T-100').name, 'Renamed by Alice');
  });
  test('PC-15a unpublished edits mark the catalog dirty but are invisible in the live catalog', () => {
    C.saveProduct({ id: 'YR-HB-U2', name: 'UFO High Bay U2 — DRAFT EDIT' }, {});
    assert.equal(C.isDirty(), true);
    assert.equal(config.catalog.products.find((p) => p.id === 'YR-HB-U2').name, 'UFO High Bay U2', 'live catalog unchanged');
    assert.ok(!config.catalog.products.some((p) => p.id === 'T-100'), 'draft product not live');
  });
  test('PC-15b "publish" makes the edits live and clears the dirty flag', () => {
    C.setProductStatus('T-100', 'published');
    C.publishCatalog();
    assert.equal(C.isDirty(), false);
    assert.equal(config.catalog.products.find((p) => p.id === 'YR-HB-U2').name, 'UFO High Bay U2 — DRAFT EDIT');
  });
  test('PC-15c a newly published product appears live with its sales mode and variants', () => {
    const t = config.catalog.products.find((p) => p.id === 'T-100');
    assert.equal(t.salesMode, 'both');
    assert.deepEqual(t.variants.map((v) => v.sku), ['T-100-50K', 'T-100-40K']);
  });
  test('PC-16 publish writes catalog.json and site.json for the static site build', () => {
    const cat = JSON.parse(readFileSync(join(env.SITE_DIR, 'src/data/catalog.json'), 'utf8'));
    assert.ok(cat.products.some((p) => p.id === 'T-100'));
    assert.ok(existsSync(join(env.SITE_DIR, 'src/data/site.json')));
  });
  test('PC-17a archiving removes a product from the live catalog after publish', () => {
    C.setProductStatus('T-100', 'archived');
    C.publishCatalog();
    assert.ok(!config.catalog.products.some((p) => p.id === 'T-100'));
  });
  test('PC-17b an archived product keeps its SKUs for old orders', () => {
    assert.equal(C.skusFor('T-100').length, 2);
  });
  test('PC-18a a product without any sellable SKU cannot be put on sale', async () => {
    const { db } = await import('../../server/src/db.js');
    C.saveProduct({ ...base(), id: 'T-400', slug: 't-400' }, { isNew: true, variants: [variant({ sku: 'T-400-A' })] });
    db.prepare("UPDATE skus SET active = 0 WHERE product_id = 'T-400'").run();
    assert.throws(() => C.setProductStatus('T-400', 'published'), /没有可售规格/);
  });
  test('PC-18b an unknown product status is rejected', () => {
    assert.throws(() => C.setProductStatus('T-400', 'deleted'), /状态无效/);
  });
  test('PC-19a a product that has been published cannot be deleted', () => {
    assert.throws(() => C.deleteProduct('YR-HB-U2'), /上架过的商品不能删除/);
  });
  test('PC-19b a product used in a quote or order cannot be deleted', () => {
    C.saveProduct({ ...base(), id: 'T-500', slug: 't-500' }, { isNew: true, variants: [variant({ sku: 'T-500-A' })] });
    S.createQuote({ customer: { email: 'q@x.test' }, lines: [{ sku: 'T-500-A', qty: 10, unit_price: 25 }] });
    assert.throws(() => C.deleteProduct('T-500'), /报价或订单/);
  });
  test('PC-19c a never-published, unused product is deleted together with its SKUs', () => {
    C.saveProduct({ ...base(), id: 'T-600', slug: 't-600' }, { isNew: true, variants: [variant({ sku: 'T-600-A' })] });
    C.deleteProduct('T-600');
    assert.equal(C.getProduct('T-600'), null);
    assert.equal(C.skusFor('T-600', { all: true }).length, 0);
  });
  test('PC-20 removing a variant: deleted if unused, deactivated if it appears in a quote/order', () => {
    C.saveProduct({ id: 'T-500' }, { variants: [variant({ sku: 'T-500-B' })] });
    const all = C.skusFor('T-500', { all: true });
    assert.deepEqual(all.map((s) => [s.sku, s.active]).sort(), [['T-500-A', 0], ['T-500-B', 1]]);
  });
  test('PC-21a a real image is saved under a random name in the media folder', () => {
    const url = C.saveMedia(PNG, 'photo.png');
    assert.match(url, /^\/media\/[a-f0-9]{24}\.png$/);
    assert.ok(existsSync(join(C.mediaDir(), url.slice(7))));
  });
  test('PC-21b a non-image media upload is rejected', () => {
    assert.throws(() => C.saveMedia(Buffer.from('<svg/>'), 'x.png'), /只支持/);
  });
  test('PC-21c an oversized media upload is rejected', () => {
    assert.throws(() => C.saveMedia(Buffer.alloc(6 * 1024 * 1024, 1), 'big.jpg'), /不能超过/);
  });
  test('PC-21d an empty media upload is rejected', () => {
    assert.throws(() => C.saveMedia(Buffer.alloc(0)), /为空/);
  });
  test('PC-22a a new category is created with a slug from its name', () => {
    C.saveCategory({ id: 'solar-garden', name: 'Solar Garden Lights' }, { isNew: true });
    assert.equal(C.listCategories().find((c) => c.id === 'solar-garden').slug, 'solar-garden-lights');
  });
  test('PC-22b a duplicate category id is rejected', () => {
    assert.throws(() => C.saveCategory({ id: 'solar-garden', name: 'x' }, { isNew: true }), /已存在/);
  });
  test('PC-22c an invalid category id is rejected', () => {
    assert.throws(() => C.saveCategory({ id: 'Bad Id', name: 'x' }, { isNew: true }), /品类编码/);
  });
  test('PC-22d a category still used by products cannot be deleted', () => {
    assert.throws(() => C.deleteCategory('high-bay'), /还有 \d+ 个商品/);
  });
  test('PC-22e an unused category can be deleted', () => {
    C.deleteCategory('solar-garden');
    assert.ok(!C.listCategories().some((c) => c.id === 'solar-garden'));
  });

  const sortIds = {};
  test('PC-23a a smaller sort number lists the product first in the admin list', () => {
    const ids = sortIds.ids = C.listProducts({ status: 'published' }).rows.map((p) => p.id).slice(0, 3);
    C.setSortNumbers({ [ids[2]]: '0' });
    assert.equal(C.listProducts().rows[0].id, ids[2]);
  });
  test('PC-23b the published catalog follows the sort numbers', () => {
    C.publishCatalog();
    assert.equal(config.catalog.products[0].id, sortIds.ids[2]);
  });
  test('PC-23c negative or fractional sort numbers are rejected', () => {
    const { ids } = sortIds;
    assert.throws(() => C.setSortNumbers({ [ids[0]]: '-1' }), /排序号/);
    assert.throws(() => C.setSortNumbers({ [ids[0]]: '1.5' }), /排序号/);
  });
  test('PC-23d a sort number for an unknown product is rejected', () => {
    assert.throws(() => C.setSortNumbers({ NOPE: '1' }), /商品不存在/);
  });
  test('PC-23e drag-and-drop reordering renumbers in steps of 10 and marks the catalog dirty', () => {
    const { ids } = sortIds;
    C.reorderProducts([ids[1], ids[0]]);
    assert.deepEqual([C.getProduct(ids[1])._sort, C.getProduct(ids[0])._sort], [10, 20]);
    assert.equal(C.isDirty(), true);
  });
  const bulk = {};
  test('PC-24a bulk delist archives every selected product', () => {
    const ok = bulk.ok = C.listProducts({ status: 'published' }).rows.slice(0, 2).map((p) => p.id);
    const r = C.bulkStatus(ok, 'archived');
    assert.deepEqual(r, { done: ok, failed: [] });
    assert.equal(C.getProduct(ok[0])._status, 'archived');
  });
  test('PC-24b bulk list checks each product on its own and reports failures per product', () => {
    const r = C.bulkStatus([...bulk.ok, 'NOPE'], 'published');
    assert.deepEqual(r.done, bulk.ok);
    assert.match(r.failed[0].error, /商品不存在/);
  });
  test('PC-24c a product cannot be saved without SKUs, so it can never be listed', () => {
    assert.throws(() => C.saveProduct({ id: bulk.ok[0] }, { variants: [] }), /至少需要一个规格/); // a product without SKUs cannot exist, so it can never be listed
  });
  const feat = {};
  test('PC-25a flagging more recommended products than the limit is refused', () => {
    C.setFeaturedMax('2');
    const ids = feat.ids = C.listProducts({ status: 'published' }).rows.map((p) => p.id).slice(0, 3);
    C.setFeatured([ids[0], ids[1]], true);
    assert.throws(() => C.setFeatured([ids[2]], true), /最多 2 个/);
  });
  test('PC-25b the "recommended" filter lists the flagged products', () => {
    assert.deepEqual(C.listProducts({ featured: '1' }).rows.map((p) => p.id).sort(), [feat.ids[0], feat.ids[1]].sort());
  });
  test('PC-25c the published catalog marks recommended products in sort order', () => {
    C.publishCatalog();
    assert.deepEqual(config.catalog.products.filter((p) => p.featured).map((p) => p.id), C.featuredIds());
  });
  test('PC-25d unflagging a product frees a slot for another', () => {
    C.setFeatured([feat.ids[0]], false);
    C.setFeatured([feat.ids[2]], true);
    assert.equal(C.featuredIds().length, 2);
  });
  test('PC-25e an archived product cannot be recommended', () => {
    const arch = C.listProducts({ status: 'archived' }).rows[0]?.id;
    if (arch) assert.throws(() => C.setFeatured([arch], true), /已下架/);
  });
  test('PC-25f the recommended limit must be 0–100', () => {
    assert.throws(() => C.setFeaturedMax('101'), /0–100/);
  });
  test('PC-25g a limit of 0 means no limit', () => {
    C.setFeaturedMax('0');
    assert.doesNotThrow(() => C.setFeatured(C.listProducts({ status: 'published' }).rows.map((p) => p.id), true)); // 0 = no limit
  });
});
