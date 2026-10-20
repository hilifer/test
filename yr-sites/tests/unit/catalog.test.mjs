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
  test('PC-01 a complete product passes; slug generated; specs / bands / lists parsed', () => {
    const { product, errors } = V.validateProduct(base(), ctx());
    assert.deepEqual(errors, []);
    assert.equal(product.slug, 'test-high-bay-100w');
    assert.deepEqual(product.specs, { Power: '100 W', IP: 'IP65' });
    assert.deepEqual(product.priceBands, [{ minQty: 10, maxQty: 99, low: 20, high: 25 }, { minQty: 100, maxQty: null, low: 18, high: 22 }]);
    assert.deepEqual(product.certifications, ['CE', 'RoHS']);
  });
  test('PC-02 required fields and formats', () => {
    const { errors } = V.validateProduct({ id: 'x y', category: 'nope', moq: 0, leadTimeDays: [9, 3], sampleDays: [], specs: '' }, ctx());
    for (const k of ['型号/编码', '名称必填', '简介必填', '品类不存在', '起订量', '质保必填', '至少填写一项参数', '生产交期', '样品时间']) assert.ok(errors.some((e) => e.includes(k)), k);
  });
  test('PC-03 price bands must be ascending, contiguous, only the last open-ended, low ≤ high', () => {
    const bad = (b) => V.validateProduct({ ...base(), priceBands: b }, ctx()).errors.join('|');
    assert.match(bad('10-99:20-25 | 150+:18-22'), /应从 100 开始/);
    assert.match(bad('10+:20-25 | 100+:18-22'), /只有最后一档/);
    assert.match(bad('10-99:30-25'), /最低价不能高于最高价/);
    assert.match(bad('ten:1-2'), /格式错误/);
    assert.ok(V.validateProduct({ ...base(), priceBands: '' }, ctx()).warnings.some((w) => w.includes('按项目报价')));
  });
  test('PC-04 duplicate id / slug are rejected', () => {
    const existing = new Map([['T-100', { slug: 'other' }], ['T-200', { slug: 'test-high-bay-100w' }]]);
    const { errors } = V.validateProduct(base(), ctx({ existing }));
    assert.ok(errors.some((e) => e.includes('已存在')));
    assert.ok(errors.some((e) => e.includes('已被 T-200 使用')));
  });
  test('PC-05 only uploaded media or https image URLs are accepted', () => {
    assert.ok(V.validateProduct({ ...base(), images: ['javascript:alert(1)'] }, ctx()).errors.some((e) => e.includes('图片地址无效')));
    assert.deepEqual(V.validateProduct({ ...base(), images: ['/media/0123456789abcdef01234567.png'] }, ctx()).errors, []);
  });
  test('PC-06 image type detection by magic bytes (not by file name)', () => {
    assert.equal(V.imageType(PNG), 'png');
    assert.equal(V.imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'jpg');
    assert.equal(V.imageType(Buffer.from('<svg onload=alert(1)>')), null);
    assert.equal(V.imageType(Buffer.from('GIF89a......')), null);
  });
});

describe('spreadsheets', () => {
  test('PC-07 CSV: BOM, quotes, embedded commas/newlines, CRLF, Chinese headers', () => {
    const csv = '﻿型号/编码*,名称*,参数(参数名: 值，用|分隔)*\r\n"A-1","Lamp, ""Pro""","Power: 100 W | Note: line1\nline2"\r\n';
    const rows = V.parseCsv(csv);
    assert.equal(rows.length, 1);
    const { product } = V.rowToProduct(rows[0]);
    assert.equal(product.id, 'A-1');
    assert.equal(product.name, 'Lamp, "Pro"');
    assert.match(product.specs, /line1\nline2/);
  });
  test('PC-08 semicolon-separated CSV (European Excel) is detected', () => {
    assert.deepEqual(V.parseCsv('id;name\nA;B\n'), [{ id: 'A', name: 'B' }]);
  });
  test('PC-09 export → import round-trip keeps every field; formulas are neutralised and restored', () => {
    const p = { ...V.validateProduct(base(), ctx()).product, name: '=cmd|calc', images: [] };
    const csv = V.toCsv([V.productToRow(p, 'published')]);
    assert.match(csv, /"?'=cmd/);
    const back = V.rowToProduct(V.parseCsv(csv)[0]);
    assert.equal(back.status, 'published');
    assert.equal(back.product.name, '=cmd|calc');
    const again = V.validateProduct(back.product, ctx()).product;
    assert.deepEqual(again.priceBands, p.priceBands);
    assert.deepEqual(again.specs, p.specs);
    assert.deepEqual(again.leadTimeDays, [10, 20]);
  });
  test('PC-10 real .xlsx files (shared strings + numbers) are read', () => {
    const buf = makeXlsx([['型号/编码*', '名称*', '起订量*'], ['X-1', 'Excel Lamp & Co', 25], ['X-2', '中文灯', 5]]);
    const rows = V.parseXlsx(buf);
    assert.deepEqual(rows.map((r) => V.rowToProduct(r).product), [{ id: 'X-1', name: 'Excel Lamp & Co', moq: '25' }, { id: 'X-2', name: '中文灯', moq: '5' }]);
    assert.throws(() => V.parseXlsx(Buffer.from('not a zip')), /xlsx/);
  });
});

describe('store', () => {
  test('PC-11 first start seeds categories, products and one SKU per product from the files', () => {
    assert.equal(C.listCategories().length, 5);
    const { total } = C.listProducts();
    assert.equal(total, 11);
    const sku = C.skusFor('YR-HB-U2')[0];
    assert.equal(sku.price, 52);
    assert.equal(sku.min_qty, 50);
    assert.equal(config.catalog.products.length, 11);
  });
  test('PC-12 create with variants; SKU fields saved; revision logged', () => {
    const { product } = C.saveProduct(base(), { isNew: true, status: 'draft', variants: [variant(), variant({ sku: 'T-100-40K', options: 'CCT=4000K', price: '24' })] });
    assert.equal(product._version, 1);
    const vs = C.skusFor('T-100');
    assert.deepEqual(vs.map((v) => [v.sku, v.variant, v.price]), [['T-100-50K', '5000K', 25], ['T-100-40K', '4000K', 24]]);
    assert.deepEqual(vs[0].tier_prices, [{ minQty: 100, price: 22 }, { minQty: 500, price: 20 }]);
    assert.equal(C.revisionsFor('T-100')[0].summary, '新建（含规格）');
  });
  test('PC-13 variant rules: price for online sale, tiers ascending & cheaper, duplicate SKU, SKU owned by another product', () => {
    const err = (vs, mode = 'both') => { try { C.saveProduct({ ...base(), id: 'T-300', slug: 't-300' }, { isNew: true, salesMode: mode, variants: vs }); return ''; } catch (e) { return e.message; } };
    assert.match(err([variant({ sku: 'T-300-A', price: '' })]), /必须填写售价/);
    assert.equal(err([variant({ sku: 'T-300-A', price: '' })], 'inquiry'), '', 'inquiry-only products need no price');
    assert.match(err([variant({ sku: 'T-301-A', tier_prices: '500:20 | 100:22' })]), /阶梯价/);
    assert.match(err([variant({ sku: 'T-302-A', tier_prices: '100:30' })]), /不应高于基础售价/);
    assert.match(err([variant({ sku: 'T-303-A' }), variant({ sku: 'T-303-A' })]), /重复/);
    assert.match(err([variant({ sku: 'YR-HB-U2' })]), /已属于商品 YR-HB-U2/);
    assert.match(err([]), /至少需要一个规格/);
  });
  test('PC-14 optimistic locking: a stale edit is refused', () => {
    const p = C.getProduct('T-100');
    C.saveProduct({ id: 'T-100', name: 'Renamed by Alice' }, { expectVersion: p._version });
    assert.throws(() => C.saveProduct({ id: 'T-100', name: 'Renamed by Bob' }, { expectVersion: p._version }), /已被其他人修改/);
    assert.equal(C.getProduct('T-100').name, 'Renamed by Alice');
  });
  test('PC-15 unpublished edits are invisible to customers / AI / MCP until "publish"', () => {
    C.saveProduct({ id: 'YR-HB-U2', name: 'UFO High Bay U2 — DRAFT EDIT' }, {});
    assert.equal(C.isDirty(), true);
    assert.equal(config.catalog.products.find((p) => p.id === 'YR-HB-U2').name, 'UFO High Bay U2', 'live catalog unchanged');
    assert.ok(!config.catalog.products.some((p) => p.id === 'T-100'), 'draft product not live');
    C.setProductStatus('T-100', 'published');
    C.publishCatalog();
    assert.equal(C.isDirty(), false);
    assert.equal(config.catalog.products.find((p) => p.id === 'YR-HB-U2').name, 'UFO High Bay U2 — DRAFT EDIT');
    const t = config.catalog.products.find((p) => p.id === 'T-100');
    assert.equal(t.salesMode, 'both');
    assert.deepEqual(t.variants.map((v) => v.sku), ['T-100-50K', 'T-100-40K']);
  });
  test('PC-16 publish writes catalog.json and site.json for the static site build', () => {
    const cat = JSON.parse(readFileSync(join(env.SITE_DIR, 'src/data/catalog.json'), 'utf8'));
    assert.ok(cat.products.some((p) => p.id === 'T-100'));
    assert.ok(existsSync(join(env.SITE_DIR, 'src/data/site.json')));
  });
  test('PC-17 archiving removes a product from the live catalog after publish; SKUs kept for old orders', () => {
    C.setProductStatus('T-100', 'archived');
    C.publishCatalog();
    assert.ok(!config.catalog.products.some((p) => p.id === 'T-100'));
    assert.equal(C.skusFor('T-100').length, 2);
  });
  test('PC-18 a product without any sellable SKU cannot be put on sale', async () => {
    const { db } = await import('../../server/src/db.js');
    C.saveProduct({ ...base(), id: 'T-400', slug: 't-400' }, { isNew: true, variants: [variant({ sku: 'T-400-A' })] });
    db.prepare("UPDATE skus SET active = 0 WHERE product_id = 'T-400'").run();
    assert.throws(() => C.setProductStatus('T-400', 'published'), /没有可售规格/);
    assert.throws(() => C.setProductStatus('T-400', 'deleted'), /状态无效/);
  });
  test('PC-19 delete: only never-published products not used in quotes/orders', () => {
    assert.throws(() => C.deleteProduct('YR-HB-U2'), /上架过的商品不能删除/);
    C.saveProduct({ ...base(), id: 'T-500', slug: 't-500' }, { isNew: true, variants: [variant({ sku: 'T-500-A' })] });
    S.createQuote({ customer: { email: 'q@x.test' }, lines: [{ sku: 'T-500-A', qty: 10, unit_price: 25 }] });
    assert.throws(() => C.deleteProduct('T-500'), /报价或订单/);
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
  test('PC-21 media: saves real images under random names, rejects everything else', () => {
    const url = C.saveMedia(PNG, 'photo.png');
    assert.match(url, /^\/media\/[a-f0-9]{24}\.png$/);
    assert.ok(existsSync(join(C.mediaDir(), url.slice(7))));
    assert.throws(() => C.saveMedia(Buffer.from('<svg/>'), 'x.png'), /只支持/);
    assert.throws(() => C.saveMedia(Buffer.alloc(6 * 1024 * 1024, 1), 'big.jpg'), /不能超过/);
    assert.throws(() => C.saveMedia(Buffer.alloc(0)), /为空/);
  });
  test('PC-22 categories: create, validate, cannot delete while products use it', () => {
    C.saveCategory({ id: 'solar-garden', name: 'Solar Garden Lights' }, { isNew: true });
    assert.equal(C.listCategories().find((c) => c.id === 'solar-garden').slug, 'solar-garden-lights');
    assert.throws(() => C.saveCategory({ id: 'solar-garden', name: 'x' }, { isNew: true }), /已存在/);
    assert.throws(() => C.saveCategory({ id: 'Bad Id', name: 'x' }, { isNew: true }), /品类编码/);
    assert.throws(() => C.deleteCategory('high-bay'), /还有 \d+ 个商品/);
    C.deleteCategory('solar-garden');
    assert.ok(!C.listCategories().some((c) => c.id === 'solar-garden'));
  });

  test('PC-23 sort numbers: smaller first in the admin list and the published catalog; drag order renumbers; validation', () => {
    const ids = C.listProducts({ status: 'published' }).rows.map((p) => p.id).slice(0, 3);
    C.setSortNumbers({ [ids[2]]: '0' });
    assert.equal(C.listProducts().rows[0].id, ids[2]);
    C.publishCatalog();
    assert.equal(config.catalog.products[0].id, ids[2]);
    assert.throws(() => C.setSortNumbers({ [ids[0]]: '-1' }), /排序号/);
    assert.throws(() => C.setSortNumbers({ [ids[0]]: '1.5' }), /排序号/);
    assert.throws(() => C.setSortNumbers({ NOPE: '1' }), /商品不存在/);
    C.reorderProducts([ids[1], ids[0]]);
    assert.deepEqual([C.getProduct(ids[1])._sort, C.getProduct(ids[0])._sort], [10, 20]);
    assert.equal(C.isDirty(), true);
  });
  test('PC-24 bulk list / delist: each product checked on its own; failures reported per product', () => {
    const ok = C.listProducts({ status: 'published' }).rows.slice(0, 2).map((p) => p.id);
    let r = C.bulkStatus(ok, 'archived');
    assert.deepEqual(r, { done: ok, failed: [] });
    assert.equal(C.getProduct(ok[0])._status, 'archived');
    r = C.bulkStatus([...ok, 'NOPE'], 'published');
    assert.deepEqual(r.done, ok);
    assert.match(r.failed[0].error, /商品不存在/);
    assert.throws(() => C.saveProduct({ id: ok[0] }, { variants: [] }), /至少需要一个规格/); // a product without SKUs cannot exist, so it can never be listed
  });
  test('PC-25 recommended: flag, limit, archived products refused, shown in the published catalog in sort order', () => {
    C.setFeaturedMax('2');
    const ids = C.listProducts({ status: 'published' }).rows.map((p) => p.id).slice(0, 3);
    C.setFeatured([ids[0], ids[1]], true);
    assert.throws(() => C.setFeatured([ids[2]], true), /最多 2 个/);
    assert.deepEqual(C.listProducts({ featured: '1' }).rows.map((p) => p.id).sort(), [ids[0], ids[1]].sort());
    C.publishCatalog();
    assert.deepEqual(config.catalog.products.filter((p) => p.featured).map((p) => p.id), C.featuredIds());
    C.setFeatured([ids[0]], false);
    C.setFeatured([ids[2]], true);
    assert.equal(C.featuredIds().length, 2);
    const arch = C.listProducts({ status: 'archived' }).rows[0]?.id;
    if (arch) assert.throws(() => C.setFeatured([arch], true), /已下架/);
    assert.throws(() => C.setFeaturedMax('101'), /0–100/);
    C.setFeaturedMax('0');
    C.setFeatured(C.listProducts({ status: 'published' }).rows.map((p) => p.id), true); // 0 = no limit
  });
});
