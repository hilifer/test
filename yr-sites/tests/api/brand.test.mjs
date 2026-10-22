// Black-box: brand assets and layout templates over HTTP — roles, brand kit form (validation, logo from the asset
// library, contrast warning), template previews, saving to the asset library, custom templates (copy, JSON edit with
// errors, delete), batch generation in the task center, designer workbench, English. IDs BA-xx.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, flash, waitFor } from '../helpers/server.mjs';

let api, sharp;
before(async () => {
  ({ default: sharp } = await import('sharp'));
  api = await startServer({ site: 'led' });
  for (const [u, role] of [['dee', 'designer'], ['sam', 'sales'], ['wes', 'warehouse']]) await api.form('/admin/users/new', { username: u, name: u.toUpperCase(), role, password: PW });
});
after(() => api.stop());

const PW = 'Str0ngPassw0rd';
const auth = (u) => ({ authorization: 'Basic ' + Buffer.from(`${u}:${PW}`).toString('base64') });
const D = auth('dee');
const form = (path, data, h = D) => fetch(api.url + path, { method: 'POST', redirect: 'manual', headers: { ...h, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data) });
const page = async (path, h = D) => (await fetch(api.url + path, { headers: h })).text();
const solid = (hex, w, h) => sharp({ create: { width: w, height: h, channels: 4, background: hex } }).png().toBuffer();
async function upload(name, buf, fields = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append('files', new Blob([buf], { type: 'image/png' }), name);
  return (await (await fetch(`${api.url}/admin/assets/upload`, { method: 'POST', body: fd, headers: { ...D, 'x-requested-with': 'fetch' } })).json()).created[0];
}
const ctx = {};

const BRAND_PAGES = ['/admin/brand', '/admin/brand/templates', '/admin/brand/templates/main-badge'];
test('BA-01a roles: the designer can open the brand kit and template pages', async () => {
  for (const p of BRAND_PAGES) assert.equal((await fetch(api.url + p, { headers: D })).status, 200, p);
});
test('BA-01b roles: sales can view the brand kit and template pages', async () => {
  for (const p of BRAND_PAGES) assert.equal((await fetch(api.url + p, { headers: auth('sam') })).status, 200, p);
});
test('BA-01c roles: warehouse has no access to the brand kit and template pages (403)', async () => {
  for (const p of BRAND_PAGES) assert.equal((await fetch(api.url + p, { headers: auth('wes') })).status, 403, p);
});
test('BA-01d roles: sales cannot save the brand kit (403)', async () => {
  assert.equal((await form('/admin/brand', { name: 'X' }, auth('sam'))).status, 403);
});
test('BA-01e roles: sales cannot copy a template (403)', async () => {
  assert.equal((await form('/admin/brand/templates/main-badge/copy', {}, auth('sam'))).status, 403);
});
test('BA-01f the admin navigation links to "品牌与模板"', async () => {
  assert.match(await page('/admin/brand'), /<a href="\/admin\/brand">品牌与模板<\/a>/);
});

test('BA-02a the workbench reminds that the brand kit has no logo yet', async () => {
  assert.match(await page('/admin/home'), /品牌资产还没有设置 Logo/);
});
test('BA-02b brand kit: a primary colour that is not #RRGGBB is rejected', async () => {
  assert.match(flash(await form('/admin/brand', { name: 'YAORONG', color_primary: 'navy' })).err, /主色：须为 #RRGGBB/);
});
test('BA-02c brand kit: a logo that is not an asset-library id is rejected', async () => {
  assert.match(flash(await form('/admin/brand', { name: 'YAORONG', logo_primary: 'not-an-asset' })).err, /标准 Logo：请填写素材库/);
});
test('BA-02d brand kit: saving low-contrast text/background colours succeeds with a contrast warning', async () => {
  ctx.logo = await upload('logo.png', await solid('#ff0000', 400, 120));
  const r = flash(await form('/admin/brand', { name: 'YAORONG', slogan_en: 'Built to last', color_primary: '#123456', color_text: '#cccccc', logo_primary: ctx.logo, logo_reversed: ctx.logo, font_heading: 'DejaVu Sans' }));
  assert.match(r.ok, /已保存；注意：文字色 \/ 背景色[^；]* 对比度偏低/);
});
test('BA-02e brand kit page shows the logo from the asset library and the saved colour', async () => {
  const html = await page('/admin/brand');
  assert.match(html, new RegExp(`<img src="/admin/assets/thumb/${ctx.logo}"`));
  assert.match(html, /name="color_primary" value="#123456"/);
});
test('BA-02f brand kit page flags the low contrast ratio (recommended ≥ 4.5)', async () => {
  const html = await page('/admin/brand');
  assert.match(html, /偏低（建议 ≥ 4\.5）/);
});
test('BA-02g the workbench reminds about the low brand colour contrast', async () => {
  assert.match(await page('/admin/home'), /品牌色对比度偏低：文字色 \/ 背景色/);
});
test('BA-02h fixing the text colour saves without warning and the workbench reminders disappear', async () => {
  assert.match(flash(await form('/admin/brand', { name: 'YAORONG', color_text: '#1b2430' })).ok, /^已保存$/);
  assert.doesNotMatch(await page('/admin/home'), /品牌资产还没有设置 Logo|品牌色对比度偏低/);
});

test('BA-03a the template list shows a product preview for every built-in template', async () => {
  const list = await page('/admin/brand/templates');
  for (const id of ['main-badge', 'promo-banner', 'feature-card', 'social-square']) assert.ok(list.includes(`/admin/brand/templates/${id}/preview.png?product=`), id);
});
test('BA-03b a template preview is a WebP image at the requested width and template aspect ratio', async () => {
  const r = await fetch(`${api.url}/admin/brand/templates/promo-banner/preview.png?product=YR-HB-U2&w=960&title=Black%20Friday`, { headers: D });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/webp');
  ctx.previewWarnings = r.headers.get('x-warnings');
  const m = await sharp(Buffer.from(await r.arrayBuffer())).metadata();
  assert.deepEqual([m.width, m.height], [960, 300]);
});
test('BA-03c a preview for a product without images carries a "no image yet" warning header', async () => {
  assert.match(decodeURIComponent(ctx.previewWarnings), /还没有图片/);
});
test('BA-03d a preview of an unknown template is a 400', async () => {
  assert.equal((await fetch(`${api.url}/admin/brand/templates/nope/preview.png?product=YR-HB-U2`, { headers: D })).status, 400);
});
test('BA-03e a preview for an unknown product is a 400', async () => {
  assert.equal((await fetch(`${api.url}/admin/brand/templates/main-badge/preview.png?product=NOPE`, { headers: D })).status, 400);
});
test('BA-03f the template use page shows only the fields the template uses', async () => {
  const use = await page('/admin/brand/templates/feature-card?product=YR-HB-U2');
  assert.match(use, /placeholder="Wattage selectable/);
  assert.doesNotMatch(use, /<label style="display:grid;gap:4px">按钮文字/, 'only the fields the template uses');
});

test('BA-04a rendering a template with a chosen picture saves it to the asset library and opens the new asset', async () => {
  ctx.pic = await upload('lamp.png', await solid('#2e7d32', 900, 900));
  const r = await form('/admin/brand/templates/main-badge/render', { product: 'YR-HB-U2', lang: 'en', asset: ctx.pic, badge: 'NEW' });
  assert.equal(r.status, 302);
  const loc = ctx.renderLoc = r.headers.get('location');
  assert.match(decodeURIComponent(loc), /^\/admin\/assets\/[\w-]+\?m=已保存到素材库/);
});
test('BA-04b the rendered asset is named after template, product and language and tagged 排版模板', async () => {
  const asset = await page(ctx.renderLoc.split('?')[0]);
  assert.match(asset, /main-badge-YR-HB-U2-en\.png/);
  assert.match(asset, /排版模板/);
});
test('BA-04c rendering with a picture that is not a usable asset is rejected', async () => {
  assert.match(flash(await form('/admin/brand/templates/main-badge/render', { product: 'YR-HB-U2', asset: 'missing' })).err, /不是可用的图片/);
});

test('BA-05a copying a built-in template creates an editable custom copy named "· 副本"', async () => {
  const r = await form('/admin/brand/templates/social-square/copy', {});
  const id = ctx.tpl = r.headers.get('location').match(/templates\/(tpl-[\w-]+)\/edit/)[1];
  const edit = await page(`/admin/brand/templates/${id}/edit`);
  assert.match(edit, /&quot;name&quot;: &quot;社媒方图 · 副本&quot;/);
});
test('BA-05b saving malformed template JSON is a 400 with a JSON format error', async () => {
  const bad = await form(`/admin/brand/templates/${ctx.tpl}/edit`, { json: '{ not json' });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /JSON 格式错误/);
});
test('BA-05c saving a template with invalid layers is a 400 listing the error of each layer', async () => {
  const bad = await form(`/admin/brand/templates/${ctx.tpl}/edit`, { json: JSON.stringify({ name: 'Square', width: 1080, height: 1080, layers: [{ type: 'text', field: 'price', x: 0, y: 2000, w: 100 }, { type: 'blob' }] }) });
  assert.equal(bad.status, 400);
  const errs = await bad.text();
  assert.match(errs, /第 1 个图层 y：须在 0–1080 之间/);
  assert.match(errs, /第 2 个图层：类型须为/);
});
test('BA-05d a valid template edit is saved', async () => {
  assert.match(flash(await form(`/admin/brand/templates/${ctx.tpl}/edit`, { json: JSON.stringify({ name: 'Square sale', kind: 'social', width: 1080, height: 1080, background: 'accent', layers: [{ type: 'image', x: 90, y: 90, w: 900, h: 700 }, { type: 'text', field: 'price', x: 90, y: 950, w: 900, size: 60, weight: 800, color: '#ffffff' }] }) })).ok, /已保存/);
});
test('BA-05e the preview of the edited template uses the accent background', async () => {
  const img = await fetch(`${api.url}/admin/brand/templates/${ctx.tpl}/preview.png?product=YR-HB-U2&w=1080`, { headers: D });
  const { data } = await sharp(Buffer.from(await img.arrayBuffer())).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.ok(data[0] > 150 && data[1] < 80, 'accent background');
});
test('BA-05f built-in templates cannot be edited', async () => {
  assert.match(flash(await fetch(`${api.url}/admin/brand/templates/main-badge/edit`, { headers: D, redirect: 'manual' })).err, /内置模板不能修改/);
});
test('BA-05g a custom template can be deleted and is then 404', async () => {
  assert.match(flash(await form(`/admin/brand/templates/${ctx.tpl}/delete`, {})).ok, /已删除/);
  assert.equal((await fetch(`${api.url}/admin/brand/templates/${ctx.tpl}`, { headers: D })).status, 404);
});

test('BA-06a batch generation creates a task that renders one image per product and finishes in the task center', async () => {
  const body = new URLSearchParams([['products', 'YR-HB-U2'], ['products', 'YR-HB-L4'], ['lang', 'en'], ['badge', 'HOT']]);
  const r = await fetch(`${api.url}/admin/brand/templates/feature-card/batch`, { method: 'POST', redirect: 'manual', headers: { ...D, 'content-type': 'application/x-www-form-urlencoded' }, body });
  const task = r.headers.get('location').match(/\/admin\/tasks\/([\w-]+)/)[1];
  const t = await waitFor(async () => { const j = await (await fetch(`${api.url}/admin/tasks/${task}/json`, { headers: D })).json(); return ['done', 'failed'].includes(j.status) && j; }, { timeout: 20000 });
  assert.equal(t.status, 'done');
  assert.equal(t.items.length, 2);
  assert.match(t.title, /卖点图 · 2 个商品/);
});
test('BA-06b batch generation without products asks to choose products', async () => {
  assert.match(flash(await form('/admin/brand/templates/feature-card/batch', { lang: 'en' })).err, /请选择商品/);
});

test('BA-07 English brand and template pages', async () => {
  const EN = { ...D, cookie: 'yr_admin_lang=en' };
  for (const p of ['/admin/brand', '/admin/brand/templates', '/admin/brand/templates/promo-banner?product=YR-HB-U2']) {
    const text = (await page(p, EN)).replace(/<textarea[\s\S]*?<\/textarea>|<script[\s\S]*?<\/script>|<option[\s\S]*?<\/option>|<[^>]+translate="no"[^>]*>[\s\S]*?<\/[a-z]+>|<[^>]+>/g, ' ');
    const left = text.match(/[^\s]{0,20}[\u3400-\u9fff]+[^\s]{0,20}/);
    assert.equal(left, null, `${p}: ${left?.[0]}`);
  }
});
