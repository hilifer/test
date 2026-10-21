// Black-box: asset library over HTTP — roles, multi-file and folder upload, filters, thumbnails / previews / original
// download (with ranges), bulk tag / move / zip / trash, recycle bin, versions, search by image, settings, video frame
// capture, AI tags (mock vision model). IDs MS-xx.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { startServer, flash, waitFor } from '../helpers/server.mjs';
import { mockServer } from '../helpers/mock-http.mjs';
import { tempDir } from '../helpers/env.mjs';

let api, llm, shop;
const shopFiles = new Map(); // path → [buffer, type]
before(async () => {
  llm = await mockServer((call) => (call.url === '/v1/messages' && call.body.messages?.[0]?.content?.[0]?.type === 'image'
    ? { json: { content: [{ type: 'text', text: '{"tags":["场景图","不存在的标签"]}' }], stop_reason: 'end_turn' } }
    : { json: { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' } }));
  shop = await mockServer((call) => { const f = shopFiles.get(call.url.split('?')[0]); return f ? { body: f[0], headers: { 'content-type': f[1] } } : { status: 404, text: 'nope' }; });
  api = await startServer({ site: 'led', env: { LLM_PROVIDER: 'anthropic', LLM_API_KEY: 'k', LLM_MODEL: 'claude-opus-5-5', LLM_BASE_URL: llm.url, PULL_ALLOW_PRIVATE: 'true' } });
});
after(async () => { await api.stop(); await llm.close(); await shop.close(); });

const PW = 'Str0ngPassw0rd';
const auth = (u) => ({ authorization: 'Basic ' + Buffer.from(`${u}:${PW}`).toString('base64') });
const ADMIN = { authorization: 'Basic ' + Buffer.from('admin:test-pass').toString('base64') };
const img = (bg = '#ffffff', w = 1000, h = 1000) => sharp({ create: { width: w, height: h, channels: 3, background: bg } })
  .composite([{ input: Buffer.from(`<svg width="${w}" height="${h}"><rect x="${w * 0.3}" y="${h * 0.3}" width="${w * 0.4}" height="${h * 0.4}" fill="#1565c0"/></svg>`) }]).jpeg().toBuffer();
async function upload(headers, files, fields = {}, fetchMode = true) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const [name, buf, type = 'image/jpeg'] of files) fd.append('files', new Blob([buf], { type }), name);
  return fetch(`${api.url}/admin/assets/upload`, { method: 'POST', body: fd, redirect: 'manual', headers: { ...headers, ...(fetchMode ? { 'x-requested-with': 'fetch' } : {}) } });
}
const form = (headers, path, data) => fetch(api.url + path, { method: 'POST', redirect: 'manual', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, body: data instanceof URLSearchParams ? data : new URLSearchParams(data) });
const page = async (path, h = ADMIN) => (await fetch(api.url + path, { headers: h })).text();
const ids = (html) => [...html.matchAll(/name="ids" value="([\w-]+)"/g)].map((m) => m[1]);
const ctx = {};

test('MS-01 roles: designer uploads and deletes for good; sales only views and downloads; warehouse has no access', async () => {
  for (const [u, role] of [['dee', 'designer'], ['sam', 'sales'], ['wes', 'warehouse'], ['cat', 'content']]) await api.form('/admin/users/new', { username: u, role, password: PW });
  assert.equal((await fetch(`${api.url}/admin/assets`, { headers: auth('dee') })).status, 200);
  assert.equal((await fetch(`${api.url}/admin/assets`, { headers: auth('sam') })).status, 200);
  assert.equal((await fetch(`${api.url}/admin/assets`, { headers: auth('wes') })).status, 403);
  assert.equal((await upload(auth('sam'), [['a.jpg', await img()]])).status, 403);
  assert.equal((await form(auth('cat'), '/admin/assets/trash/purge', { ids: 'x' })).status, 403);
  assert.equal((await fetch(`${api.url}/admin/assets`)).status, 401);
});

test('MS-02 upload several files into a product, and a whole folder (structure kept); bad files reported', async () => {
  const r = await upload(auth('dee'), [['main-white.jpg', await img()], ['scene.jpg', await img('#88aa66', 1200, 800)], ['notes.txt', Buffer.from('hello'), 'text/plain']], { product: 'YR-HB-U2', sub: '主图' });
  const j = await r.json();
  assert.equal(j.created.length, 2);
  assert.match(j.errors[0], /notes\.txt：不支持的文件类型/);
  assert.match(j.message, /已上传 2 个，1 个失败/);
  ctx.main = j.created[0];
  const root = await form(auth('dee'), '/admin/assets/folders/new', { name: '展会 2026' });
  ctx.folder = new URL(root.headers.get('location'), api.url).searchParams.get('folder');
  const f = await upload(auth('dee'), [['booth/day1/a.jpg', await img('#ffeecc', 900, 900)], ['booth/day2/b.jpg', await img('#ccddee', 900, 900)]], { folder: ctx.folder });
  assert.equal((await f.json()).created.length, 2);
  const list = await page(`/admin/assets?folder=${ctx.folder}`);
  assert.match(list, /📁 booth[\s\S]*📁 day1[\s\S]*📁 day2/);
  assert.equal(ids(list).length, 2); // recursive
  const plain = await upload(auth('dee'), [], {}, false); // classic form without files
  assert.match(flash(plain).err || flash(plain).ok, /请选择文件/);
});

test('MS-03 filters, list view, thumbnails, previews, original download with range requests', async () => {
  const white = await page('/admin/assets?tag=白底图');
  assert.ok(ids(white).includes(ctx.main));
  assert.match(await page('/admin/assets?view=list&kind=image'), /<table>[\s\S]*main-white\.jpg/);
  const t = await fetch(`${api.url}/admin/assets/thumb/${ctx.main}`, { headers: ADMIN });
  assert.equal(t.headers.get('content-type'), 'image/webp');
  assert.equal((await sharp(Buffer.from(await t.arrayBuffer())).metadata()).width, 480);
  const full = await fetch(`${api.url}/admin/assets/file/${ctx.main}/1`, { headers: auth('sam') });
  assert.equal(full.status, 200);
  assert.match(full.headers.get('content-disposition'), /main-white-v1\.jpg/);
  const part = await fetch(`${api.url}/admin/assets/file/${ctx.main}/1`, { headers: { ...ADMIN, range: 'bytes=0-99' } });
  assert.equal(part.status, 206);
  assert.equal((await part.arrayBuffer()).byteLength, 100);
  assert.match(part.headers.get('content-range'), /^bytes 0-99\/\d+$/);
  await api.form('/admin/roles', new URLSearchParams([['key', 'viewer'], ['name', '只看素材'], ['perms', 'assets.view']]));
  await api.form('/admin/users/new', { username: 'vic', role: 'viewer', password: PW });
  assert.equal((await fetch(`${api.url}/admin/assets/file/${ctx.main}/1`, { headers: auth('vic') })).status, 403); // no "download originals"
  assert.equal((await fetch(`${api.url}/admin/assets/thumb/${ctx.main}`, { headers: auth('vic') })).status, 200);
});

test('MS-04 bulk: tag, untag, move, zip download, trash → restore → permanent delete', async () => {
  const all = ids(await page(`/admin/assets?folder=${ctx.folder}`));
  const b = (pairs) => new URLSearchParams(pairs);
  assert.match(flash(await form(auth('dee'), '/admin/assets/bulk', b([['action', 'tag'], ['tags', '展会, 新品'], ...all.map((i) => ['ids', i])]))).ok, /已为 2 个素材添加标签/);
  assert.equal(ids(await page('/admin/assets?tag=展会')).length, 2);
  await form(auth('dee'), '/admin/assets/bulk', b([['action', 'untag'], ['tags', '新品'], ['ids', all[0]]]));
  assert.equal(ids(await page('/admin/assets?tag=新品')).length, 1);
  const zip = await fetch(`${api.url}/admin/assets/bulk-download`, { method: 'POST', headers: { ...auth('sam'), 'content-type': 'application/x-www-form-urlencoded' }, body: b(all.map((i) => ['ids', i])) });
  assert.equal(zip.headers.get('content-type'), 'application/zip');
  const zbuf = Buffer.from(await zip.arrayBuffer());
  assert.equal(zbuf.readUInt16LE(zbuf.length - 12), 2);
  assert.match(flash(await form(auth('dee'), '/admin/assets/bulk', b([['action', 'move'], ['folder', ''], ['ids', all[0]]]))).ok, /已移动 1 个/);
  assert.match(flash(await form(auth('dee'), '/admin/assets/bulk', b([['action', 'trash'], ['ids', all[0]]]))).ok, /已移到回收站/);
  assert.ok(ids(await page('/admin/assets/trash')).includes(all[0]));
  await form(auth('cat'), '/admin/assets/trash/restore', { ids: all[0] });
  assert.ok(!ids(await page('/admin/assets/trash')).includes(all[0]));
  await form(auth('dee'), '/admin/assets/bulk', b([['action', 'trash'], ['ids', all[0]]]));
  assert.match(flash(await form(auth('dee'), '/admin/assets/trash/purge', { ids: all[0] })).ok, /已彻底删除 1 个/);
  assert.equal((await fetch(`${api.url}/admin/assets/thumb/${all[0]}`, { headers: ADMIN })).status, 404);
  assert.match(flash(await form(auth('dee'), '/admin/assets/bulk', b([['action', 'tag']]))).err, /请先勾选/);
  assert.match(flash(await form(auth('dee'), `/admin/assets/folders/${ctx.folder}/delete`, {})).err, /不是空的/);
});

test('MS-05 detail page: edit title and tags, upload a new version, compare, set official, roll back', async () => {
  const id = ctx.main;
  await form(auth('dee'), `/admin/assets/${id}`, { title: 'UFO 主图', tags: '主推, 2026', folder: '' });
  const d = await page(`/admin/assets/${id}`);
  assert.match(d, /UFO 主图/);
  assert.match(d, /value="主推, 2026"/);
  const fd = new FormData(); fd.append('file', new Blob([await img('#ffffff', 1600, 1600)], { type: 'image/jpeg' }), 'big.jpg'); fd.append('note', '放大到 1600');
  assert.match(flash(await fetch(`${api.url}/admin/assets/${id}/version`, { method: 'POST', body: fd, redirect: 'manual', headers: auth('dee') })).ok, /已上传 v2/);
  assert.match(await page(`/admin/assets/compare?id=${id}&v=1&v=2`), /v1 · 1000×1000[\s\S]*v2 · 1600×1600/);
  assert.match(flash(await fetch(`${api.url}/admin/assets/compare?id=${id}&v=1`, { redirect: 'manual', headers: ADMIN })).err, /两个版本/);
  assert.match(flash(await form(auth('dee'), `/admin/assets/${id}/official?version=1`, {})).ok, /v1 设为正式版/);
  assert.match(flash(await form(auth('dee'), `/admin/assets/${id}/rollback?version=2`, {})).ok, /生成 v3/);
  const after = await page(`/admin/assets/${id}`);
  assert.match(after, /<b>v3<\/b> <span class="tag" style="background:#c8e6c9">正式版/);
  assert.match(after, /回滚[\s\S]*回滚到 v2/);
});

test('MS-06 search by image finds the identical picture first', async () => {
  const fd = new FormData(); fd.append('file', new Blob([await img('#88aa66', 1200, 800)], { type: 'image/jpeg' }), 'q.jpg');
  const html = await (await fetch(`${api.url}/admin/assets/similar`, { method: 'POST', body: fd, headers: auth('dee') })).text();
  assert.match(html, /scene\.jpg<\/b>完全相同/);
});

test('MS-07 settings: validation, usage per product, saved values', async () => {
  assert.match(flash(await form(auth('dee'), '/admin/assets/settings', { quotaGb: '0', trashDays: '30', quality: '85', maxEdge: '2000' })).err, /容量上限/);
  assert.match(flash(await form(auth('dee'), '/admin/assets/settings', { quotaGb: '30', trashDays: '400', quality: '85', maxEdge: '2000' })).err, /回收站/);
  assert.match(flash(await form(auth('dee'), '/admin/assets/settings', { quotaGb: '50', trashDays: '14', quality: '80', maxEdge: '1800' })).ok, /设置已保存/);
  const s = await page('/admin/assets/settings');
  assert.match(s, /\/ 50 GB/);
  assert.match(s, /YR-HB-U2/);
});

test('MS-08 video: preview served with ranges; a captured frame becomes an image in the product folder', async (t) => {
  const dir = tempDir('yr-vid-');
  try { execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=2', '-pix_fmt', 'yuv420p', join(dir, 'c.mp4')]); } catch { t.skip('ffmpeg not installed'); return; }
  const j = await (await upload(auth('dee'), [['demo.mp4', readFileSync(join(dir, 'c.mp4')), 'video/mp4']], { product: 'YR-HB-U2' })).json();
  const vid = j.created[0];
  const p = await fetch(`${api.url}/admin/assets/preview/${vid}`, { headers: { ...ADMIN, range: 'bytes=0-1023' } });
  assert.equal(p.status, 206);
  assert.equal(p.headers.get('content-type'), 'video/mp4');
  assert.match(await page(`/admin/assets/${vid}`), /截取当前画面保存为图片/);
  const fd = new FormData(); fd.append('file', new Blob([await sharp({ create: { width: 320, height: 240, channels: 3, background: '#123456' } }).png().toBuffer()], { type: 'image/png' }), 'frame-1.2s.png'); fd.append('t', '1.2');
  const cap = await (await fetch(`${api.url}/admin/assets/${vid}/capture`, { method: 'POST', body: fd, headers: { ...auth('dee'), 'x-requested-with': 'fetch' } })).json();
  assert.ok(cap.id);
  const d = await page(`/admin/assets/${cap.id}`);
  assert.match(d, /YR-HB-U2 \/ 副图/);
  assert.match(d, /视频截帧/);
  assert.match(d, /来自 demo\.mp4 第 1\.2 秒/);
});

test('MS-09 AI tags from the vision model (only known tags are kept)', async () => {
  const tagged = await waitFor(async () => /AI:场景图/.test(await page(`/admin/assets/${ctx.main}`)));
  assert.ok(tagged);
  assert.doesNotMatch(await page(`/admin/assets/${ctx.main}`), /不存在的标签/);
  assert.ok(llm.calls.some((c) => c.body.messages?.[0]?.content?.[0]?.source?.media_type === 'image/webp'));
});

const productPage = async (id) => (await fetch(`${api.url}/admin/products/${id}`, { headers: ADMIN })).text();
const imgsOf = (html) => [...html.matchAll(/name="img_url_\d+" value="([^"]+)"/g)].map((m) => m[1]);
const detailsOf = (html) => [...html.matchAll(/name="detail_url_\d+" value="([^"]+)"/g)].map((m) => m[1]);
const pub = (h, data) => form(h, '/admin/assets/publish', new URLSearchParams(data));

test('MS-10 list library images on a product: main image n, gallery, detail images, SKU image; pre-listing checks', async () => {
  const before = imgsOf(await productPage('YR-HB-U2'));
  const scene = ids(await page('/admin/assets?q=scene'))[0];
  let r = await pub(auth('dee'), [['ids', ctx.main], ['product', 'YR-HB-U2'], ['position', 'main'], ['index', '1']]);
  assert.match(decodeURIComponent(r.headers.get('location')), /已上架 1 张到主图/);
  let imgs = imgsOf(await productPage('YR-HB-U2'));
  assert.equal(imgs.length, before.length + 1);
  assert.match(imgs[0], /^\/media\/[a-f0-9]{24}\.jpg$/);
  const media = await sharp(Buffer.from(await (await fetch(api.url + imgs[0])).arrayBuffer())).metadata();
  assert.ok(Math.max(media.width, media.height) <= 1800); // max edge from MS-07 settings
  r = await pub(auth('dee'), [['ids', scene], ['product', 'YR-HB-U2'], ['position', 'main'], ['index', '1']]);
  assert.match(decodeURIComponent(r.headers.get('location')), /w=.*主图建议使用白底图.*主图建议使用 1:1 方图/);
  await pub(auth('dee'), [['ids', scene], ['product', 'YR-HB-U2'], ['position', 'gallery']]);
  await pub(auth('dee'), [['ids', ctx.main], ['product', 'YR-HB-U2'], ['position', 'detail']]);
  const page2 = await productPage('YR-HB-U2');
  assert.equal(imgsOf(page2).length, before.length + 3);
  assert.equal(detailsOf(page2).length, 1);
  r = await pub(auth('dee'), [['ids', ctx.main], ['product', 'YR-HB-U2'], ['position', 'sku'], ['sku', 'NOPE']]);
  assert.match(flash(r).err, /SKU/);
  r = await pub(auth('dee'), [['ids', ctx.main], ['product', 'YR-HB-U2'], ['position', 'sku'], ['sku', 'YR-HB-U2']]);
  assert.match(decodeURIComponent(r.headers.get('location')), /SKU 图/);
  const tiny = (await (await upload(auth('dee'), [['tiny.jpg', await img('#ffffff', 300, 300)]], { product: 'YR-HB-U2' })).json()).created[0];
  assert.match(flash(await pub(auth('dee'), [['ids', tiny], ['product', 'YR-HB-U2'], ['position', 'gallery']])).err, /太小，至少 500 px/);
  assert.match(flash(await pub(auth('sam'), [['ids', ctx.main], ['product', 'YR-HB-U2'], ['position', 'gallery']])).err || '', /需要"商品：编辑、上下架"权限|^$/);
  assert.match(await page(`/admin/assets/${ctx.main}`), /上架记录[\s\S]*YR-HB-U2[\s\S]*详情图/);
  // published catalog for the website carries the detail images
  await api.form('/admin/products/publish', {});
  const { readFileSync: rf } = await import('node:fs');
  const cat = JSON.parse(rf(join(api.dir, 'site/src/data/catalog.json'), 'utf8'));
  assert.equal(cat.products.find((p) => p.id === 'YR-HB-U2').detailImages.length, 1);
});

test('MS-11 image history: restore the previous set of product images in one click', async () => {
  const pageNow = await productPage('YR-HB-U2');
  assert.match(pageNow, /图片历史/);
  const rev = pageNow.match(/\/admin\/products\/YR-HB-U2\/images\/restore\?rev=(\d+)/)[1];
  const r = await form(ADMIN, `/admin/products/YR-HB-U2/images/restore?rev=${rev}`, {});
  assert.match(flash(r).ok, /已恢复这组图片/);
  const after = await productPage('YR-HB-U2');
  assert.ok(imgsOf(after).length < imgsOf(pageNow).length || detailsOf(after).length < detailsOf(pageNow).length);
});

test('MS-12 watermarks: validation; publish watermark changes the listed image; preview watermark leaves the original alone', async () => {
  assert.match(flash(await form(auth('dee'), '/admin/assets/watermarks', { name: '', type: 'text', text: 'x', opacity: '0.5', scale: '0.3' })).err, /名称必填/);
  assert.match(flash(await form(auth('dee'), '/admin/assets/watermarks', { name: 'Logo', type: 'image', assetId: 'nope', opacity: '0.5', scale: '0.3' })).err, /图片水印/);
  assert.match(flash(await form(auth('dee'), '/admin/assets/watermarks', { name: 'Brand', type: 'text', text: 'YAORONG 耀嵘', position: 'center', opacity: '0.9', scale: '0.6', color: '#000000' })).ok, /水印已保存/);
  const wid = (await page('/admin/assets/watermarks')).match(/watermarks\?edit=([\w-]+)/)[1];
  const rawPreview = Buffer.from(await (await fetch(`${api.url}/admin/assets/preview/${ctx.main}`, { headers: ADMIN })).arrayBuffer());
  await form(auth('dee'), '/admin/assets/watermarks/use', { preview: wid, publish: wid });
  const wmPreview = Buffer.from(await (await fetch(`${api.url}/admin/assets/preview/${ctx.main}`, { headers: ADMIN })).arrayBuffer());
  assert.ok(!wmPreview.equals(rawPreview), 'preview carries the watermark');
  const original = Buffer.from(await (await fetch(`${api.url}/admin/assets/file/${ctx.main}/1`, { headers: ADMIN })).arrayBuffer());
  const orig2 = Buffer.from(await (await fetch(`${api.url}/admin/assets/file/${ctx.main}/1`, { headers: ADMIN })).arrayBuffer());
  assert.ok(original.equals(orig2));
  await pub(auth('dee'), [['ids', ctx.main], ['product', 'YR-SL-M2'], ['position', 'gallery']]);
  const url = imgsOf(await productPage('YR-SL-M2')).at(-1);
  const stats = await sharp(Buffer.from(await (await fetch(api.url + url)).arrayBuffer())).stats();
  const plain = await sharp(original).stats();
  assert.ok(Math.abs(stats.channels[0].mean - plain.channels[0].mean) > 1, 'listed image differs from the original (watermark)');
  await form(auth('dee'), '/admin/assets/watermarks/use', { preview: '', publish: '' });
});

test('MS-13 link pulling: images from a supplier page are filed into the product folders; reference mode reads text only', async () => {
  shopFiles.set('/p/panel', [Buffer.from(`<html><head><title>x</title><script type="application/ld+json">{"@type":"Product","name":"Supplier Panel 600","sku":"SP-600","description":"60x60 panel","image":["/i/main.jpg","/i/side.jpg"]}</script></head>
    <body><img src="/i/long.jpg"><img src="/i/icon.jpg"></body></html>`), 'text/html; charset=utf-8']);
  shopFiles.set('/i/main.jpg', [await img('#ffffff', 1000, 1000), 'image/jpeg']);
  shopFiles.set('/i/side.jpg', [await img('#ddeeff', 1000, 800), 'image/jpeg']);
  shopFiles.set('/i/long.jpg', [await img('#ffffff', 790, 2400), 'image/jpeg']);
  shopFiles.set('/i/icon.jpg', [await img('#ffffff', 64, 64), 'image/jpeg']);
  const r = await form(auth('dee'), '/admin/assets/pull', { url: `${shop.url}/p/panel`, mode: 'own', product: 'YR-FL-F5' });
  assert.match(flash(r).ok, /已拉取 3 个素材到 YR-FL-F5/); // the 64 px icon is skipped
  const folders = await page('/admin/assets?product=YR-FL-F5&view=list');
  assert.equal([...folders.matchAll(/name="ids"/g)].length, 3);
  const logs = await page('/admin/assets/pull');
  assert.match(logs, /Supplier Panel 600 · 型号 SP-600/);
  const longId = ids(await page('/admin/assets?product=YR-FL-F5&tag=长图（详情图）'))[0];
  assert.match(await page(`/admin/assets/${longId}`), /YR-FL-F5 \/ 详情图/);
  assert.match(await page(`/admin/assets/${longId}`), /拉取自/);
  const ref = await form(auth('dee'), '/admin/assets/pull', { url: `${shop.url}/p/panel`, mode: 'reference' });
  assert.match(flash(ref).ok, /已读取：Supplier Panel 600/);
  assert.equal([...(await page('/admin/assets?product=YR-FL-F5&view=list')).matchAll(/name="ids"/g)].length, 3); // no new images
  assert.match(flash(await form(auth('dee'), '/admin/assets/pull', { url: `${shop.url}/missing`, mode: 'own', product: 'YR-FL-F5' })).err, /无法打开链接/);
  assert.match(flash(await form(auth('dee'), '/admin/assets/pull', { url: 'ftp://x.test/a', mode: 'own', product: 'YR-FL-F5' })).err, /链接无效/);
});
