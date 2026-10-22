// Black-box: image processing and the task center over HTTP — processing panel, single processing (new version /
// save as new), mask retouching, multi-size export, size presets, batch processing as a background task, task
// visibility and controls, permissions. IDs MP-xx.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { startServer, flash, waitFor } from '../helpers/server.mjs';
import { mockServer } from '../helpers/mock-http.mjs';

let api, svc;
before(async () => {
  const cut = await sharp({ create: { width: 600, height: 600, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: Buffer.from('<svg width="600" height="600"><rect x="200" y="150" width="200" height="300" fill="#c62828"/></svg>') }]).png().toBuffer();
  svc = await mockServer(() => ({ body: cut, headers: { 'content-type': 'image/png' } }));
  api = await startServer({ site: 'led', env: { IMAGE_AI_KEY: 'k', IMAGE_AI_BASE_URL: svc.url } });
});
after(async () => { await api.stop(); await svc.close(); });

const PW = 'Str0ngPassw0rd';
const auth = (u) => ({ authorization: 'Basic ' + Buffer.from(`${u}:${PW}`).toString('base64') });
const ADMIN = { authorization: 'Basic ' + Buffer.from('admin:test-pass').toString('base64') };
const img = (w = 1000, h = 800) => sharp({ create: { width: w, height: h, channels: 3, background: '#f2f2f2' } })
  .composite([{ input: Buffer.from(`<svg width="${w}" height="${h}"><rect x="${w * 0.35}" y="${h * 0.3}" width="${w * 0.3}" height="${h * 0.4}" fill="#1565c0"/><circle cx="60" cy="60" r="10" fill="#000"/></svg>`) }]).jpeg({ quality: 95 }).toBuffer();
async function upload(headers, name, buf) {
  const fd = new FormData();
  fd.append('files', new Blob([buf], { type: 'image/jpeg' }), name);
  const r = await fetch(`${api.url}/admin/assets/upload`, { method: 'POST', body: fd, headers: { ...headers, 'x-requested-with': 'fetch' } });
  assert.equal(r.status, 200, await r.clone().text());
}
const form = (headers, path, data) => fetch(api.url + path, { method: 'POST', redirect: 'manual', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data) });
const page = async (path, h = ADMIN) => (await fetch(api.url + path, { headers: h })).text();
const idsOf = async (q, h = ADMIN) => [...(await page(`/admin/assets?view=list&q=${encodeURIComponent(q)}`, h)).matchAll(/name="ids" value="([\w-]+)"/g)].map((m) => m[1]);
const ctx = {};

test('MP-01a the image detail page has the processing panel, size presets and the multi-size export', async () => {
  for (const [u, role] of [['dee', 'designer'], ['dan', 'designer'], ['sam', 'sales']]) await api.form('/admin/users/new', { username: u, role, password: PW });
  await upload(auth('dee'), 'lamp.jpg', await img());
  await upload(auth('dee'), 'spot.jpg', await img(800, 600));
  [ctx.lamp] = await idsOf('lamp');
  [ctx.spot] = await idsOf('spot');
  ctx.detail = await page(`/admin/assets/${ctx.lamp}`, auth('dee'));
  for (const s of ['图片处理', '改尺寸', '白底', '扩图', '调色', '局部修图', 'AI 抠图', 'AI 换背景', '另存为新素材', '一键导出多尺寸', '主图 / SKU 图 800×800', 'id="procform"']) assert.ok(ctx.detail.includes(s), s);
});

test('MP-01b with IMAGE_AI_KEY set the AI tools are enabled (no "not configured" notice)', async () => {
  assert.ok(!ctx.detail.includes('未配置 AI 图片服务'), 'AI enabled when IMAGE_AI_KEY is set');
});

test('MP-01c the asset list offers batch processing as a task', async () => {
  assert.match(await page('/admin/assets', auth('dee')), /批量处理[\s\S]*加入任务/);
});

test('MP-02a processing with "new version" creates v2', async () => {
  const r = await form(auth('dee'), `/admin/assets/${ctx.lamp}/process`, { op: 'resize', preset: 'main', mode: 'contain', saveAs: 'version', prompt: '主图 800 白底' });
  assert.equal(r.status, 302);
  assert.match(flash(r).ok, /已生成 v2/);
});

test('MP-02b the detail page shows the new version, its size and the recorded prompt', async () => {
  const html = await page(`/admin/assets/${ctx.lamp}`, auth('dee'));
  assert.match(html, /v2（共 2 个版本）/);
  assert.match(html, /800×800/);
  assert.match(html, /提示词：主图 800 白底/);
});

test('MP-02c resizing without choosing a size is refused', async () => {
  const e = await form(auth('dee'), `/admin/assets/${ctx.lamp}/process`, { op: 'resize', preset: '', width: '' });
  assert.match(flash(e).err, /请选择尺寸/);
});

test('MP-02d rolling back to v1 creates a new version v3', async () => {
  const rb = await form(auth('dee'), `/admin/assets/${ctx.lamp}/rollback?version=1`, {});
  assert.match(flash(rb).ok, /v3/);
});

test('MP-03a retouching with a painted mask and "save as new" creates a new asset', async () => {
  const mask = await sharp({ create: { width: 1000, height: 800, channels: 3, background: '#000' } }).composite([{ input: Buffer.from('<svg width="1000" height="800"><circle cx="60" cy="60" r="16" fill="#fff"/></svg>') }]).png().toBuffer();
  const r = await form(auth('dee'), `/admin/assets/${ctx.lamp}/process`, { op: 'retouch', mask: `data:image/png;base64,${mask.toString('base64')}`, saveAs: 'new' });
  assert.match(flash(r).ok, /另存为新素材/);
  ctx.retouched = flash(r).path.split('/').pop();
  assert.notEqual(ctx.retouched, ctx.lamp);
});

test('MP-03b the retouched image has the masked black dot removed', async () => {
  const file = await fetch(`${api.url}/admin/assets/file/${ctx.retouched}/1`, { headers: ADMIN });
  const { data, info } = await sharp(Buffer.from(await file.arrayBuffer())).raw().toBuffer({ resolveWithObject: true });
  assert.ok(data[(60 * info.width + 60) * info.channels] > 150, 'black dot removed');
});

test('MP-03c retouching without a painted mask is refused', async () => {
  const none = await form(auth('dee'), `/admin/assets/${ctx.lamp}/process`, { op: 'retouch', mask: '' });
  assert.match(flash(none).err, /涂抹/);
});

test('MP-04a AI cutout of a JPEG is saved as a new transparent PNG asset', async () => {
  const c = await form(auth('dee'), `/admin/assets/${ctx.spot}/process`, { op: 'cutout' });
  assert.match(flash(c).ok, /另存为新素材/); // JPEG → transparent PNG is a new asset
  assert.match(await page(flash(c).path, auth('dee')), /spot-cutout\.png/);
});

test('MP-04b AI background replacement creates v2 with the chosen background colour', async () => {
  const b = await form(auth('dee'), `/admin/assets/${ctx.spot}/process`, { op: 'background', bgColour: '#00ff00', scale: '0.7' });
  assert.match(flash(b).ok, /v2/);
  const file = await fetch(`${api.url}/admin/assets/file/${ctx.spot}/2`, { headers: ADMIN });
  const { data } = await sharp(Buffer.from(await file.arrayBuffer())).raw().toBuffer({ resolveWithObject: true });
  assert.ok(data[1] > 200 && data[0] < 60, 'green background');
});

test('MP-04c every call to the image service carries the API key', async () => {
  assert.ok(svc.calls.length >= 2 && svc.calls.every((x) => x.headers['x-api-key'] === 'k'));
});

test('MP-05a a size preset can be added in settings', async () => {
  const add = await form(auth('dee'), '/admin/assets/presets', { name: '独立站列表图', width: '600', height: '600' });
  assert.match(flash(add).ok, /已保存/);
});

test('MP-05b a size preset with an invalid width is refused', async () => {
  const bad = await form(auth('dee'), '/admin/assets/presets', { name: 'x', width: '20' });
  assert.match(flash(bad).err, /宽度/);
});

test('MP-05c the settings page lists the new preset with its size', async () => {
  const s = await page('/admin/assets/settings', auth('dee'));
  assert.match(s, /独立站列表图<\/td><td>600 × 600/);
  ctx.pid = [...s.matchAll(/\/admin\/assets\/presets\/([\w-]+)\/delete/g)].map((m) => m[1]).find((x) => x.startsWith('p'));
  assert.ok(ctx.pid);
});

test('MP-05d one image is exported to several sizes as new assets', async () => {
  const ex = await fetch(`${api.url}/admin/assets/${ctx.lamp}/sizes`, { method: 'POST', redirect: 'manual', headers: { ...auth('dee'), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams([['presets', 'main'], ['presets', ctx.pid]]) });
  assert.match(flash(ex).ok, /已导出 2 个尺寸/);
  assert.equal((await idsOf('lamp-600x600')).length, 1);
});

test('MP-05e exporting without choosing a size is refused', async () => {
  assert.match(flash(await form(auth('dee'), `/admin/assets/${ctx.lamp}/sizes`, {})).err, /至少一个/);
});

test('MP-05f a size preset can be deleted', async () => {
  assert.match(flash(await form(auth('dee'), `/admin/assets/presets/${ctx.pid}/delete`, {})).ok, /已删除/);
  assert.doesNotMatch(await page('/admin/assets/settings', auth('dee')), /独立站列表图/);
});

test('MP-06a batch processing redirects to a new background task', async () => {
  const r = await fetch(`${api.url}/admin/assets/batch`, { method: 'POST', redirect: 'manual', headers: { ...auth('dee'), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams([['ids', ctx.lamp], ['ids', ctx.spot], ['op', 'white'], ['preset', 'main']]) });
  assert.equal(r.status, 302);
  assert.match(flash(r).path, /^\/admin\/tasks\/[\w-]+$/);
  ctx.task = flash(r).path.split('/').pop();
});

test('MP-06b the batch task finishes with both images done', async () => {
  const t = await waitFor(async () => { const j = await (await fetch(`${api.url}/admin/tasks/${ctx.task}/json`, { headers: auth('dee') })).json(); return ['done', 'failed'].includes(j.status) && j; });
  assert.equal(t.status, 'done', JSON.stringify(t.items));
  assert.equal(t.progress.done, 2);
});

test('MP-06c the task page shows the task and each result with a link to the asset', async () => {
  const html = await page(`/admin/tasks/${ctx.task}`, auth('dee'));
  assert.match(html, /白底 · 2 张/);
  assert.match(html, /已生成 v\d+ <a href="\/admin\/assets\/[\w-]+">查看<\/a>/);
});

test('MP-06d the creator sees the task in the task center', async () => {
  assert.match(await page('/admin/tasks', auth('dee')), /白底 · 2 张/);
});

test('MP-06e another designer neither sees nor opens the task (404)', async () => {
  assert.doesNotMatch(await page('/admin/tasks', auth('dan')), /白底 · 2 张/, 'another designer does not see it');
  assert.equal((await fetch(`${api.url}/admin/tasks/${ctx.task}`, { headers: auth('dan') })).status, 404);
});

test('MP-06f an admin sees all tasks', async () => {
  assert.match(await page('/admin/tasks'), /白底 · 2 张/, 'admin sees all tasks');
});

test('MP-06g batch multi-size export also runs as a task', async () => {
  const sizes = await fetch(`${api.url}/admin/assets/batch`, { method: 'POST', redirect: 'manual', headers: { ...auth('dee'), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams([['ids', ctx.lamp], ['op', 'sizes'], ['preset', 'social']]) });
  assert.match(flash(sizes).path, /^\/admin\/tasks\//);
});

test('MP-06h batch processing without selected images is refused', async () => {
  assert.match(flash(await form(auth('dee'), '/admin/assets/batch', { op: 'white' })).err, /请先勾选/);
});

test('MP-07a a finished task cannot be paused', async () => {
  assert.match(flash(await form(auth('dee'), `/admin/tasks/${ctx.task}/pause`, {})).err, /不能/);
});

test('MP-07b retry is refused when the task has no failed items', async () => {
  assert.match(flash(await form(auth('dee'), `/admin/tasks/${ctx.task}/retry`, {})).err, /任务还在进行中|没有失败/);
});

test('MP-07c another user cannot control my task (404)', async () => {
  assert.equal((await form(auth('dan'), `/admin/tasks/${ctx.task}/cancel`, {})).status, 404);
});

test('MP-08a sales cannot process images, singly or in batch (403)', async () => {
  assert.equal((await form(auth('sam'), `/admin/assets/${ctx.lamp}/process`, { op: 'white' })).status, 403);
  assert.equal((await form(auth('sam'), '/admin/assets/batch', { ids: ctx.lamp, op: 'white' })).status, 403);
});

test('MP-08b the task center is open to every logged-in user (sales gets 200)', async () => {
  assert.equal((await fetch(`${api.url}/admin/tasks`, { headers: auth('sam') })).status, 200);
});

test('MP-08c anonymous visitors cannot open the task center (401)', async () => {
  assert.equal((await fetch(`${api.url}/admin/tasks`)).status, 401);
});

const EN = () => ({ ...auth('dan'), cookie: 'yr_admin_lang=en' });
const CJK = /[一-鿿]/;

test('MP-09a in English the processing panel, presets, task center and asset list have no Chinese left', async () => {
  for (const path of [`/admin/assets/${ctx.lamp}`, '/admin/assets/settings', '/admin/tasks', '/admin/assets']) {
    const html = (await page(path, EN())).replace(/<option value="[\w-]+">[^<]*<\/option>/g, '').replace(/title="[^"]*"|alt="[^"]*"/g, '');
    const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, ' ');
    const left = text.split(/\s+/).filter((w) => CJK.test(w) && !/lamp|spot|dee|dan|独立站列表图/.test(w));
    assert.deepEqual(left, [], path);
  }
});

test('MP-09b in English a batch repair task page names the operation in English and has no Chinese left', async () => {
  const r = await fetch(`${api.url}/admin/assets/batch`, { method: 'POST', redirect: 'manual', headers: { ...auth('dan'), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams([['ids', ctx.lamp], ['op', 'repair']]) });
  const text = (await page(flash(r).path, EN())).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, ' ');
  assert.match(text, /Denoise|Repair/);
  assert.doesNotMatch(text.replace(/lamp[^\s]*/g, ''), CJK);
});
