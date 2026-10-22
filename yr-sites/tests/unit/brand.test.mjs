// Module: server/src/assets/brand.js — brand kit (colours, fonts, logos, contrast check) and layout templates (validation,
// text wrapping, rendering with brand colours / logo / product picture, saving to the asset library, batch via the task
// center). Real images made with sharp. IDs LT-xx.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempEnv, tempDir } from '../helpers/env.mjs';
import { waitFor } from '../helpers/server.mjs';

useTempEnv({ site: 'led', MEDIA_DIR: tempDir('yr-media-') });
const B = await import('../../server/src/assets/brand.js');
const A = await import('../../server/src/assets/store.js');
const T = await import('../../server/src/tasks.js');
const { runAs } = await import('../../server/src/auth.js');
const { default: sharp } = await import('sharp');

const solid = (hex, w, h, alpha = false) => sharp({ create: { width: w, height: h, channels: alpha ? 4 : 3, background: hex } }).png().toBuffer();
const pixel = async (buf, x, y) => { const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true }); const i = (y * info.width + x) * 3; return `#${[data[i], data[i + 1], data[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`; };
const near = (a, b, tol = 10) => [1, 3, 5].every((i) => Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)) <= tol);

describe('brand kit', () => {
  const kit = {};
  test('LT-01a the brand kit defaults come from the site', () => {
    const k = kit.k = B.brandKit();
    assert.equal(k.name, 'YAORONG Lighting');
    assert.match(k.colors.primary, /^#[0-9a-f]{6}$/);
  });
  test('LT-01b saving a colour that is not #RRGGBB is refused', () => {
    assert.throws(() => B.saveBrandKit({ colors: { primary: 'blue' } }), /主色：须为 #RRGGBB/);
  });
  test('LT-01c saving an invalid font name is refused', () => {
    assert.throws(() => B.saveBrandKit({ fonts: { heading: 'Inter; drop' } }), /字体名称/);
  });
  test('LT-01d saving a logo that is not an asset-library id is refused', () => {
    assert.throws(() => B.saveBrandKit({ logos: { primary: 'nope' } }), /标准 Logo：请填写素材库/);
  });
  test('LT-01e saving a blank brand name is refused', () => {
    assert.throws(() => B.saveBrandKit({ name: ' ' }), /品牌名称必填/);
  });
  test('LT-01f saving colours lower-cases them and keeps the colours not sent', async () => {
    kit.logo = await A.ingest(await solid('#ff0000', 300, 100, true), { name: 'logo.png' });
    const saved = B.saveBrandKit({ colors: { primary: '#123456', accent: '#C62828' }, fonts: { heading: 'DejaVu Sans' }, logos: { reversed: kit.logo.id }, slogan: { en: 'Built to last' } });
    assert.equal(saved.colors.primary, '#123456');
    assert.equal(saved.colors.accent, '#c62828', 'lower-cased');
    assert.equal(saved.colors.secondary, kit.k.colors.secondary, 'untouched colours kept');
  });
  test('LT-01g the saved logo and slogan are stored in the brand kit', () => {
    assert.equal(B.brandKit().logos.reversed, kit.logo.id);
    assert.equal(B.brandKit().slogan.en, 'Built to last');
  });
  test('LT-02a contrast is computed as the WCAG ratio', () => {
    assert.equal(B.contrast('#000000', '#ffffff'), 21);
    assert.equal(B.contrast('#ffffff', '#ffffff'), 1);
    assert.ok(Math.abs(B.contrast('#767676', '#ffffff') - 4.54) < 0.02);
  });
  test('LT-02b a low-contrast text / background pair is flagged', () => {
    B.saveBrandKit({ colors: { text: '#bbbbbb' } });
    assert.equal(B.contrastChecks().find((x) => x.pair === '文字色 / 背景色').ok, false);
  });
  test('LT-02c with a dark text colour every contrast check passes', () => {
    B.saveBrandKit({ colors: { text: '#1b2430' } });
    assert.ok(B.contrastChecks().every((x) => x.ok));
  });
});

describe('templates', () => {
  const tpl = {};
  test('LT-03a there are four built-in templates and all of them are valid', () => {
    assert.deepEqual(B.templates().map((t) => t.id), ['main-badge', 'promo-banner', 'feature-card', 'social-square']);
    for (const t of B.BUILTIN) assert.doesNotThrow(() => B.validateTemplate(t), t.id);
  });
  test('LT-03b template validation reports every problem at once', () => {
    try { B.validateTemplate({ name: '', width: 50, height: 500, background: 'pink', layers: [{ type: 'video' }, { type: 'text', field: 'nope', x: 0, y: 0, w: 10 }, { type: 'rect', x: 0, y: 0, w: 10, h: 10, color: 'red' }] }); assert.fail('should throw'); } catch (e) {
      const all = e.errors.join('\n');
      for (const re of [/名称必填/, /宽度：须在 100–4000/, /背景色/, /第 1 个图层：类型须为/, /第 2 个图层：文字字段/, /第 3 个图层：颜色无效/]) assert.match(all, re);
    }
  });
  test('LT-03c built-in templates cannot be modified or deleted', () => {
    assert.throws(() => B.saveTemplate({ ...B.BUILTIN[0] }), /内置模板不能修改/);
    assert.throws(() => B.deleteTemplate('main-badge'), /内置模板不能删除/);
  });
  test('LT-03d copying a built-in template creates a custom template named "· 副本"', () => {
    const copy = tpl.copy = B.copyTemplate('promo-banner');
    assert.match(copy.id, /^tpl-/);
    assert.equal(copy.name, '促销横幅 · 副本');
    assert.equal(B.getTemplate(copy.id).builtin, undefined);
  });
  test('LT-03e saving a custom template whose layers do not fit the canvas is refused', () => {
    assert.throws(() => B.saveTemplate({ ...tpl.copy, height: 400 }), /第 1 个图层 h：须在 1–400 之间/, 'layers must fit the canvas');
  });
  test('LT-03f a custom template can be saved', () => {
    B.saveTemplate({ ...tpl.copy, width: 2000 });
    assert.equal(B.getTemplate(tpl.copy.id).width, 2000);
  });
  test('LT-03g a custom template can be deleted', () => {
    B.deleteTemplate(tpl.copy.id);
    assert.equal(B.getTemplate(tpl.copy.id), null);
  });
  test('LT-04a text that fits stays on one line', () => {
    assert.deepEqual(B.wrap('Short title', 600, 40, 700, 2), ['Short title']);
  });
  test('LT-04b Latin text wraps by words into at most N lines within the width, ending with an ellipsis', () => {
    const two = B.wrap('UFO High Bay U2 with a very long name that will never fit on two lines', 400, 40, 700, 2);
    assert.equal(two.length, 2);
    assert.match(two[1], /…$/);
    assert.ok(two.every((l) => B.textWidth(l, 40, 700) <= 400));
  });
  test('LT-04c Chinese text wraps by characters, ending with an ellipsis', () => {
    const zh = B.wrap('工矿灯一百五十瓦防水防尘高光效工厂直供五年质保', 200, 40, 400, 2);
    assert.equal(zh[0], '工矿灯一百');
    assert.match(zh[1], /…$/);
  });
  test('LT-05a English product texts: name, price from the cheapest SKU, warranty badge, highlights', () => {
    const f = B.productFields({ id: 'YR-HB-U2', name: 'UFO High Bay U2', warranty: '5 years', highlights: ['a', 'b'], priceBands: [{ low: 39 }] }, 'en');
    assert.equal(f.title, 'UFO High Bay U2');
    assert.equal(f.price, 'From USD 52');
    assert.equal(f.badge, '5-YEAR WARRANTY');
    assert.deepEqual(f.highlights, ['a', 'b']);
  });
  test('LT-05b Chinese product texts use the Chinese name, badge, price and call to action', () => {
    const zh = B.productFields({ id: 'YR-HB-U2', name: 'UFO High Bay U2', nameZh: 'UFO 工矿灯', warranty: '5 years' }, 'zh');
    assert.deepEqual([zh.title, zh.badge, zh.price, zh.cta], ['UFO 工矿灯', '5 年质保', 'USD 52 起', '立即询价']);
  });
});

describe('rendering', () => {
  const rd = {};
  test('LT-06a the render is a PNG at the template size', async () => {
    rd.r = await B.render({ templateId: 'promo-banner', productId: 'YR-HB-U2' });
    const m = await sharp(rd.r.buffer).metadata();
    assert.deepEqual([m.width, m.height, m.format], [1920, 600, 'png']);
  });
  test('LT-06b the background uses the brand primary colour', async () => {
    assert.ok(near(await pixel(rd.r.buffer, 10, 10), '#123456'), 'primary background');
  });
  test('LT-06c without a product picture a placeholder is drawn and a warning given', async () => {
    assert.ok(near(await pixel(rd.r.buffer, 1500, 300), '#eef1f4'), 'placeholder where the picture goes');
    assert.match(rd.r.warnings.join('|'), /还没有图片/);
  });
  test('LT-06d the reversed logo from the brand kit is drawn in its box without a warning', async () => {
    assert.ok(!rd.r.warnings.some((w) => /反白 Logo/.test(w)), 'reversed logo is set');
    assert.ok(near(await pixel(rd.r.buffer, 105, 65), '#ff0000'), 'logo drawn at its box');
  });
  test('LT-06e a template whose icon is not set warns and still draws the accent badge', async () => {
    const main = await B.render({ templateId: 'main-badge', productId: 'YR-HB-U2' });
    assert.match(main.warnings.join('|'), /没有设置：图标 \/ 角标/);
    assert.ok(near(await pixel(main.buffer, 860, 790), '#c62828'), 'accent badge');
  });
  test('LT-07a without a chosen asset the picture comes from the product folder', async () => {
    const pic = await A.ingest(await solid('#2e7d32', 800, 800), { name: 'green.png', productId: 'YR-HB-U2' });
    assert.ok(pic.id);
    const r = await B.render({ templateId: 'feature-card', productId: 'YR-HB-U2' });
    assert.ok(near(await pixel(r.buffer, 500, 300), '#2e7d32'), 'from the product folder');
  });
  test('LT-07b a chosen asset is used as the product picture', async () => {
    const other = await A.ingest(await solid('#6a1b9a', 800, 800), { name: 'purple.png' });
    const r = await B.render({ templateId: 'feature-card', productId: 'YR-HB-U2', assetId: other.id });
    assert.ok(near(await pixel(r.buffer, 500, 300), '#6a1b9a'), 'chosen asset');
  });
  test('LT-07c a chosen asset that does not exist is refused', async () => {
    await assert.rejects(B.render({ templateId: 'feature-card', productId: 'YR-HB-U2', assetId: 'missing' }), /不是可用的图片/);
  });
  test('LT-07d field overrides replace the product texts', async () => {
    const r = await B.render({ templateId: 'promo-banner', productId: 'YR-HB-U2', fields: { title: 'Black Friday', highlights: 'x\ny' } });
    assert.equal(r.fields.title, 'Black Friday');
    assert.deepEqual(r.fields.highlights, ['x', 'y']);
  });
  test('LT-07e rendering an unknown template is refused', async () => {
    await assert.rejects(B.render({ templateId: 'nope', productId: 'YR-HB-U2' }), /模板不存在/);
  });
  test('LT-07f rendering for an unknown product is refused', async () => {
    await assert.rejects(B.render({ templateId: 'main-badge', productId: 'NOPE' }), /商品不存在/);
  });
  test('LT-08a a main-image render is saved to the product\'s 主图 folder with template tags', async () => {
    const { asset } = await runAs({ username: 'dee' }, () => B.renderToAsset({ templateId: 'main-badge', productId: 'YR-HB-U2', lang: 'en' }));
    assert.equal(asset.product_id, 'YR-HB-U2');
    assert.ok(asset.tags.includes('排版模板') && asset.tags.includes('主图 + 品牌角标'));
    assert.equal(A.folderPath(asset.folder_id).at(-1).name, '主图');
    assert.equal(asset.width, 1000);
  });
  test('LT-08b saved template results are not used as the product picture', async () => {
    const again = await B.render({ templateId: 'feature-card', productId: 'YR-HB-U2' });
    assert.ok(near(await pixel(again.buffer, 500, 300), '#2e7d32'), 'template results are not used as the product picture');
  });
  test('LT-08c a batch without any valid product is refused', () => {
    assert.throws(() => B.queueTemplate('main-badge', ['NOPE']), /请选择商品/);
  });
  test('LT-08d a batch over several products removes duplicates, keeps only shared overrides and finishes every item', async () => {
    const id = runAs({ username: 'dee' }, () => B.queueTemplate('feature-card', ['YR-HB-U2', 'YR-HB-U2', 'YR-HB-L4'], { lang: 'en', fields: { badge: 'NEW', title: 'ignored' } }));
    const done = await waitFor(() => { const t = T.getTask(id); return t && ['done', 'failed'].includes(t.status) && t; }, { timeout: 20000 });
    assert.equal(done.items.length, 2, 'duplicates removed');
    assert.deepEqual(done.params.fields, { badge: 'NEW' }, 'only shared overrides');
    assert.ok(done.items.every((i) => i.status === 'done'), JSON.stringify(done.items));
  });
});
