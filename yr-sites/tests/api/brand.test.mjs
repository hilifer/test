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

test('BA-01 roles: the designer edits brand assets and templates; sales may only look; warehouse has no access', async () => {
  for (const p of ['/admin/brand', '/admin/brand/templates', '/admin/brand/templates/main-badge']) {
    assert.equal((await fetch(api.url + p, { headers: D })).status, 200, p);
    assert.equal((await fetch(api.url + p, { headers: auth('sam') })).status, 200, p);
    assert.equal((await fetch(api.url + p, { headers: auth('wes') })).status, 403, p);
  }
  assert.equal((await form('/admin/brand', { name: 'X' }, auth('sam'))).status, 403);
  assert.equal((await form('/admin/brand/templates/main-badge/copy', {}, auth('sam'))).status, 403);
  assert.match(await page('/admin/brand'), /<a href="\/admin\/brand">品牌与模板<\/a>/);
});

test('BA-02 brand kit: colour and logo validated; logo from the library shown; low contrast warned; workbench reminds', async () => {
  assert.match(await page('/admin/home'), /品牌资产还没有设置 Logo/);
  assert.match(flash(await form('/admin/brand', { name: 'YAORONG', color_primary: 'navy' })).err, /主色：须为 #RRGGBB/);
  assert.match(flash(await form('/admin/brand', { name: 'YAORONG', logo_primary: 'not-an-asset' })).err, /标准 Logo：请填写素材库/);
  ctx.logo = await upload('logo.png', await solid('#ff0000', 400, 120));
  const r = flash(await form('/admin/brand', { name: 'YAORONG', slogan_en: 'Built to last', color_primary: '#123456', color_text: '#cccccc', logo_primary: ctx.logo, logo_reversed: ctx.logo, font_heading: 'DejaVu Sans' }));
  assert.match(r.ok, /已保存；注意：文字色 \/ 背景色[^；]* 对比度偏低/);
  const html = await page('/admin/brand');
  assert.match(html, new RegExp(`<img src="/admin/assets/thumb/${ctx.logo}"`));
  assert.match(html, /name="color_primary" value="#123456"/);
  assert.match(html, /偏低（建议 ≥ 4\.5）/);
  assert.match(await page('/admin/home'), /品牌色对比度偏低：文字色 \/ 背景色/);
  assert.match(flash(await form('/admin/brand', { name: 'YAORONG', color_text: '#1b2430' })).ok, /^已保存$/);
  assert.doesNotMatch(await page('/admin/home'), /品牌资产还没有设置 Logo|品牌色对比度偏低/);
});

test('BA-03 previews: every template renders for a product; unknown template or product is a 400', async () => {
  const list = await page('/admin/brand/templates');
  for (const id of ['main-badge', 'promo-banner', 'feature-card', 'social-square']) assert.ok(list.includes(`/admin/brand/templates/${id}/preview.png?product=`), id);
  const r = await fetch(`${api.url}/admin/brand/templates/promo-banner/preview.png?product=YR-HB-U2&w=960&title=Black%20Friday`, { headers: D });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/webp');
  const m = await sharp(Buffer.from(await r.arrayBuffer())).metadata();
  assert.deepEqual([m.width, m.height], [960, 300]);
  assert.match(decodeURIComponent(r.headers.get('x-warnings')), /还没有图片/);
  assert.equal((await fetch(`${api.url}/admin/brand/templates/nope/preview.png?product=YR-HB-U2`, { headers: D })).status, 400);
  assert.equal((await fetch(`${api.url}/admin/brand/templates/main-badge/preview.png?product=NOPE`, { headers: D })).status, 400);
  const use = await page('/admin/brand/templates/feature-card?product=YR-HB-U2');
  assert.match(use, /placeholder="Wattage selectable/);
  assert.doesNotMatch(use, /<label style="display:grid;gap:4px">按钮文字/, 'only the fields the template uses');
});

test('BA-04 save to the asset library: the picture is the chosen asset; lands in the product folder; tagged', async () => {
  ctx.pic = await upload('lamp.png', await solid('#2e7d32', 900, 900));
  const r = await form('/admin/brand/templates/main-badge/render', { product: 'YR-HB-U2', lang: 'en', asset: ctx.pic, badge: 'NEW' });
  assert.equal(r.status, 302);
  const loc = r.headers.get('location');
  assert.match(decodeURIComponent(loc), /^\/admin\/assets\/[\w-]+\?m=已保存到素材库/);
  const asset = await page(loc.split('?')[0]);
  assert.match(asset, /main-badge-YR-HB-U2-en\.png/);
  assert.match(asset, /排版模板/);
  assert.match(flash(await form('/admin/brand/templates/main-badge/render', { product: 'YR-HB-U2', asset: 'missing' })).err, /不是可用的图片/);
});

test('BA-05 custom templates: copy a built-in, JSON errors listed, valid edit saved, built-ins locked, delete', async () => {
  const r = await form('/admin/brand/templates/social-square/copy', {});
  const id = r.headers.get('location').match(/templates\/(tpl-[\w-]+)\/edit/)[1];
  const edit = await page(`/admin/brand/templates/${id}/edit`);
  assert.match(edit, /&quot;name&quot;: &quot;社媒方图 · 副本&quot;/);
  let bad = await form(`/admin/brand/templates/${id}/edit`, { json: '{ not json' });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /JSON 格式错误/);
  bad = await form(`/admin/brand/templates/${id}/edit`, { json: JSON.stringify({ name: 'Square', width: 1080, height: 1080, layers: [{ type: 'text', field: 'price', x: 0, y: 2000, w: 100 }, { type: 'blob' }] }) });
  assert.equal(bad.status, 400);
  const errs = await bad.text();
  assert.match(errs, /第 1 个图层 y：须在 0–1080 之间/);
  assert.match(errs, /第 2 个图层：类型须为/);
  assert.match(flash(await form(`/admin/brand/templates/${id}/edit`, { json: JSON.stringify({ name: 'Square sale', kind: 'social', width: 1080, height: 1080, background: 'accent', layers: [{ type: 'image', x: 90, y: 90, w: 900, h: 700 }, { type: 'text', field: 'price', x: 90, y: 950, w: 900, size: 60, weight: 800, color: '#ffffff' }] }) })).ok, /已保存/);
  const img = await fetch(`${api.url}/admin/brand/templates/${id}/preview.png?product=YR-HB-U2&w=1080`, { headers: D });
  const { data } = await sharp(Buffer.from(await img.arrayBuffer())).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.ok(data[0] > 150 && data[1] < 80, 'accent background');
  assert.match(flash(await fetch(`${api.url}/admin/brand/templates/main-badge/edit`, { headers: D, redirect: 'manual' })).err, /内置模板不能修改/);
  assert.match(flash(await form(`/admin/brand/templates/${id}/delete`, {})).ok, /已删除/);
  assert.equal((await fetch(`${api.url}/admin/brand/templates/${id}`, { headers: D })).status, 404);
});

test('BA-06 batch: one image per product as a task; follow it in the task center', async () => {
  const body = new URLSearchParams([['products', 'YR-HB-U2'], ['products', 'YR-HB-L4'], ['lang', 'en'], ['badge', 'HOT']]);
  const r = await fetch(`${api.url}/admin/brand/templates/feature-card/batch`, { method: 'POST', redirect: 'manual', headers: { ...D, 'content-type': 'application/x-www-form-urlencoded' }, body });
  const task = r.headers.get('location').match(/\/admin\/tasks\/([\w-]+)/)[1];
  const t = await waitFor(async () => { const j = await (await fetch(`${api.url}/admin/tasks/${task}/json`, { headers: D })).json(); return ['done', 'failed'].includes(j.status) && j; }, { timeout: 20000 });
  assert.equal(t.status, 'done');
  assert.equal(t.items.length, 2);
  assert.match(t.title, /卖点图 · 2 个商品/);
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
