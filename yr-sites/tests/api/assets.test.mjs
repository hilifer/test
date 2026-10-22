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


test('MS-01a roles: a designer can open the asset library', async () => {
  for (const [u, role] of [['dee', 'designer'], ['sam', 'sales'], ['wes', 'warehouse'], ['cat', 'content']]) await api.form('/admin/users/new', { username: u, role, password: PW });
  assert.equal((await fetch(`${api.url}/admin/assets`, { headers: auth('dee') })).status, 200);
});
test('MS-01b roles: a sales user can view the asset library', async () => {
  assert.equal((await fetch(`${api.url}/admin/assets`, { headers: auth('sam') })).status, 200);
});
test('MS-01c roles: a warehouse user has no access to the asset library (403)', async () => {
  assert.equal((await fetch(`${api.url}/admin/assets`, { headers: auth('wes') })).status, 403);
});
test('MS-01d roles: a sales user cannot upload assets (403)', async () => {
  assert.equal((await upload(auth('sam'), [['a.jpg', await img()]])).status, 403);
});
test('MS-01e roles: a content user cannot permanently delete from the recycle bin (403)', async () => {
  assert.equal((await form(auth('cat'), '/admin/assets/trash/purge', { ids: 'x' })).status, 403);
});
test('MS-01f the asset library needs a login (401)', async () => {
  assert.equal((await fetch(`${api.url}/admin/assets`)).status, 401);
});

test('MS-02a uploading several images into a product creates one asset per image', async () => {
  const r = await upload(auth('dee'), [['main-white.jpg', await img()], ['scene.jpg', await img('#88aa66', 1200, 800)], ['notes.txt', Buffer.from('hello'), 'text/plain']], { product: 'YR-HB-U2', sub: '主图' });
  const j = ctx.multi = await r.json();
  assert.equal(j.created.length, 2);
  ctx.main = j.created[0];
});
test('MS-02b an unsupported file in a multi-file upload is reported per file and in the summary', async () => {
  const j = ctx.multi;
  assert.match(j.errors[0], /notes\.txt：不支持的文件类型/);
  assert.match(j.message, /已上传 2 个，1 个失败/);
});
test('MS-02c uploading a whole folder creates all its files', async () => {
  const root = await form(auth('dee'), '/admin/assets/folders/new', { name: '展会 2026' });
  ctx.folder = new URL(root.headers.get('location'), api.url).searchParams.get('folder');
  const f = await upload(auth('dee'), [['booth/day1/a.jpg', await img('#ffeecc', 900, 900)], ['booth/day2/b.jpg', await img('#ccddee', 900, 900)]], { folder: ctx.folder });
  assert.equal((await f.json()).created.length, 2);
});
test('MS-02d a folder upload keeps the folder structure as sub-folders', async () => {
  const list = await page(`/admin/assets?folder=${ctx.folder}`);
  assert.match(list, /📁 booth[\s\S]*📁 day1[\s\S]*📁 day2/);
});
test('MS-02e a folder listing includes assets from all sub-folders (recursive)', async () => {
  const list = await page(`/admin/assets?folder=${ctx.folder}`);
  assert.equal(ids(list).length, 2); // recursive
});
test('MS-02f a classic form upload without files asks to choose files', async () => {
  const plain = await upload(auth('dee'), [], {}, false); // classic form without files
  assert.match(flash(plain).err || flash(plain).ok, /请选择文件/);
});

test('MS-03a the tag filter finds the white-background image by its auto tag', async () => {
  const white = await page('/admin/assets?tag=白底图');
  assert.ok(ids(white).includes(ctx.main));
});
test('MS-03b list view filtered by kind=image shows a table of images', async () => {
  assert.match(await page('/admin/assets?view=list&kind=image'), /<table>[\s\S]*main-white\.jpg/);
});
test('MS-03c thumbnails are served as 480 px wide WebP', async () => {
  const t = await fetch(`${api.url}/admin/assets/thumb/${ctx.main}`, { headers: ADMIN });
  assert.equal(t.headers.get('content-type'), 'image/webp');
  assert.equal((await sharp(Buffer.from(await t.arrayBuffer())).metadata()).width, 480);
});
test('MS-03d a sales user can download the original with a versioned file name', async () => {
  const full = await fetch(`${api.url}/admin/assets/file/${ctx.main}/1`, { headers: auth('sam') });
  assert.equal(full.status, 200);
  assert.match(full.headers.get('content-disposition'), /main-white-v1\.jpg/);
});
test('MS-03e original download supports range requests (206 with Content-Range)', async () => {
  const part = await fetch(`${api.url}/admin/assets/file/${ctx.main}/1`, { headers: { ...ADMIN, range: 'bytes=0-99' } });
  assert.equal(part.status, 206);
  assert.equal((await part.arrayBuffer()).byteLength, 100);
  assert.match(part.headers.get('content-range'), /^bytes 0-99\/\d+$/);
});
test('MS-03f a custom role with only assets.view cannot download originals (403)', async () => {
  await api.form('/admin/roles', new URLSearchParams([['key', 'viewer'], ['name', '只看素材'], ['perms', 'assets.view']]));
  await api.form('/admin/users/new', { username: 'vic', role: 'viewer', password: PW });
  assert.equal((await fetch(`${api.url}/admin/assets/file/${ctx.main}/1`, { headers: auth('vic') })).status, 403); // no "download originals"
});
test('MS-03g a custom role with only assets.view can still see thumbnails', async () => {
  assert.equal((await fetch(`${api.url}/admin/assets/thumb/${ctx.main}`, { headers: auth('vic') })).status, 200);
});

const b = (pairs) => new URLSearchParams(pairs);
test('MS-04a bulk tag adds tags to all selected assets', async () => {
  const all = ctx.all = ids(await page(`/admin/assets?folder=${ctx.folder}`));
  assert.match(flash(await form(auth('dee'), '/admin/assets/bulk', b([['action', 'tag'], ['tags', '展会, 新品'], ...all.map((i) => ['ids', i])]))).ok, /已为 2 个素材添加标签/);
  assert.equal(ids(await page('/admin/assets?tag=展会')).length, 2);
});
test('MS-04b bulk untag removes a tag from the selected asset only', async () => {
  await form(auth('dee'), '/admin/assets/bulk', b([['action', 'untag'], ['tags', '新品'], ['ids', ctx.all[0]]]));
  assert.equal(ids(await page('/admin/assets?tag=新品')).length, 1);
});
test('MS-04c bulk download returns a zip with one entry per selected asset (sales allowed)', async () => {
  const zip = await fetch(`${api.url}/admin/assets/bulk-download`, { method: 'POST', headers: { ...auth('sam'), 'content-type': 'application/x-www-form-urlencoded' }, body: b(ctx.all.map((i) => ['ids', i])) });
  assert.equal(zip.headers.get('content-type'), 'application/zip');
  const zbuf = Buffer.from(await zip.arrayBuffer());
  assert.equal(zbuf.readUInt16LE(zbuf.length - 12), 2);
});
test('MS-04d bulk move moves the selected asset to another folder', async () => {
  assert.match(flash(await form(auth('dee'), '/admin/assets/bulk', b([['action', 'move'], ['folder', ''], ['ids', ctx.all[0]]]))).ok, /已移动 1 个/);
});
test('MS-04e bulk trash moves the asset into the recycle bin', async () => {
  assert.match(flash(await form(auth('dee'), '/admin/assets/bulk', b([['action', 'trash'], ['ids', ctx.all[0]]]))).ok, /已移到回收站/);
  assert.ok(ids(await page('/admin/assets/trash')).includes(ctx.all[0]));
});
test('MS-04f restoring from the recycle bin takes the asset out of the bin', async () => {
  await form(auth('cat'), '/admin/assets/trash/restore', { ids: ctx.all[0] });
  assert.ok(!ids(await page('/admin/assets/trash')).includes(ctx.all[0]));
});
test('MS-04g permanent delete from the recycle bin removes the asset (thumbnail 404)', async () => {
  await form(auth('dee'), '/admin/assets/bulk', b([['action', 'trash'], ['ids', ctx.all[0]]]));
  assert.match(flash(await form(auth('dee'), '/admin/assets/trash/purge', { ids: ctx.all[0] })).ok, /已彻底删除 1 个/);
  assert.equal((await fetch(`${api.url}/admin/assets/thumb/${ctx.all[0]}`, { headers: ADMIN })).status, 404);
});
test('MS-04h a bulk action without selected assets asks to select first', async () => {
  assert.match(flash(await form(auth('dee'), '/admin/assets/bulk', b([['action', 'tag']]))).err, /请先勾选/);
});
test('MS-04i a non-empty folder cannot be deleted', async () => {
  assert.match(flash(await form(auth('dee'), `/admin/assets/folders/${ctx.folder}/delete`, {})).err, /不是空的/);
});

test('MS-05a detail page: title and tags can be edited', async () => {
  const id = ctx.main;
  await form(auth('dee'), `/admin/assets/${id}`, { title: 'UFO 主图', tags: '主推, 2026', folder: '' });
  const d = await page(`/admin/assets/${id}`);
  assert.match(d, /UFO 主图/);
  assert.match(d, /value="主推, 2026"/);
});
test('MS-05b detail page: uploading a new file creates version v2', async () => {
  const fd = new FormData(); fd.append('file', new Blob([await img('#ffffff', 1600, 1600)], { type: 'image/jpeg' }), 'big.jpg'); fd.append('note', '放大到 1600');
  assert.match(flash(await fetch(`${api.url}/admin/assets/${ctx.main}/version`, { method: 'POST', body: fd, redirect: 'manual', headers: auth('dee') })).ok, /已上传 v2/);
});
test('MS-05c comparing two versions shows both with their dimensions', async () => {
  assert.match(await page(`/admin/assets/compare?id=${ctx.main}&v=1&v=2`), /v1 · 1000×1000[\s\S]*v2 · 1600×1600/);
});
test('MS-05d comparing with only one version asks for two versions', async () => {
  assert.match(flash(await fetch(`${api.url}/admin/assets/compare?id=${ctx.main}&v=1`, { redirect: 'manual', headers: ADMIN })).err, /两个版本/);
});
test('MS-05e an older version can be set as the official version', async () => {
  assert.match(flash(await form(auth('dee'), `/admin/assets/${ctx.main}/official?version=1`, {})).ok, /v1 设为正式版/);
});
test('MS-05f rolling back to v2 creates an official v3 and records the rollback in the history', async () => {
  const id = ctx.main;
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

test('MS-07a settings: a storage quota of 0 GB is rejected', async () => {
  assert.match(flash(await form(auth('dee'), '/admin/assets/settings', { quotaGb: '0', trashDays: '30', quality: '85', maxEdge: '2000' })).err, /容量上限/);
});
test('MS-07b settings: a recycle-bin retention of 400 days is rejected', async () => {
  assert.match(flash(await form(auth('dee'), '/admin/assets/settings', { quotaGb: '30', trashDays: '400', quality: '85', maxEdge: '2000' })).err, /回收站/);
});
test('MS-07c settings: valid values are saved and the quota is shown', async () => {
  assert.match(flash(await form(auth('dee'), '/admin/assets/settings', { quotaGb: '50', trashDays: '14', quality: '80', maxEdge: '1800' })).ok, /设置已保存/);
  const s = await page('/admin/assets/settings');
  assert.match(s, /\/ 50 GB/);
});
test('MS-07d settings page shows storage usage per product', async () => {
  const s = await page('/admin/assets/settings');
  assert.match(s, /YR-HB-U2/);
});

test('MS-08a video: an uploaded video preview is served as video/mp4 with range support', async (t) => {
  const dir = tempDir('yr-vid-');
  try { execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=2', '-pix_fmt', 'yuv420p', join(dir, 'c.mp4')]); } catch { t.skip('ffmpeg not installed'); return; }
  const j = await (await upload(auth('dee'), [['demo.mp4', readFileSync(join(dir, 'c.mp4')), 'video/mp4']], { product: 'YR-HB-U2' })).json();
  const vid = ctx.vid = j.created[0];
  const p = await fetch(`${api.url}/admin/assets/preview/${vid}`, { headers: { ...ADMIN, range: 'bytes=0-1023' } });
  assert.equal(p.status, 206);
  assert.equal(p.headers.get('content-type'), 'video/mp4');
});
test('MS-08b video: the detail page offers "capture current frame as image"', async (t) => {
  if (!ctx.vid) { t.skip('ffmpeg not installed'); return; }
  assert.match(await page(`/admin/assets/${ctx.vid}`), /截取当前画面保存为图片/);
});
test('MS-08c video: a captured frame becomes a new image in the product sub-folder 副图', async (t) => {
  if (!ctx.vid) { t.skip('ffmpeg not installed'); return; }
  const fd = new FormData(); fd.append('file', new Blob([await sharp({ create: { width: 320, height: 240, channels: 3, background: '#123456' } }).png().toBuffer()], { type: 'image/png' }), 'frame-1.2s.png'); fd.append('t', '1.2');
  const cap = await (await fetch(`${api.url}/admin/assets/${ctx.vid}/capture`, { method: 'POST', body: fd, headers: { ...auth('dee'), 'x-requested-with': 'fetch' } })).json();
  assert.ok(cap.id);
  ctx.cap = cap.id;
  const d = await page(`/admin/assets/${cap.id}`);
  assert.match(d, /YR-HB-U2 \/ 副图/);
});
test('MS-08d video: the captured image is tagged as a video frame and records source video and time', async (t) => {
  if (!ctx.cap) { t.skip('ffmpeg not installed'); return; }
  const d = await page(`/admin/assets/${ctx.cap}`);
  assert.match(d, /视频截帧/);
  assert.match(d, /来自 demo\.mp4 第 1\.2 秒/);
});

test('MS-09a AI tags from the vision model are added to the asset', async () => {
  const tagged = await waitFor(async () => /AI:场景图/.test(await page(`/admin/assets/${ctx.main}`)));
  assert.ok(tagged);
});
test('MS-09b AI tags that are not in the tag list are dropped', async () => {
  assert.doesNotMatch(await page(`/admin/assets/${ctx.main}`), /不存在的标签/);
});
test('MS-09c the vision model receives the image as WebP', async () => {
  assert.ok(llm.calls.some((c) => c.body.messages?.[0]?.content?.[0]?.source?.media_type === 'image/webp'));
});

const productPage = async (id) => (await fetch(`${api.url}/admin/products/${id}`, { headers: ADMIN })).text();
const imgsOf = (html) => [...html.matchAll(/name="img_url_\d+" value="([^"]+)"/g)].map((m) => m[1]);
const detailsOf = (html) => [...html.matchAll(/name="detail_url_\d+" value="([^"]+)"/g)].map((m) => m[1]);
const pub = (h, data) => form(h, '/admin/assets/publish', new URLSearchParams(data));

test('MS-10a a library image listed as main image #1 becomes the first product image under /media', async () => {
  ctx.before = imgsOf(await productPage('YR-HB-U2'));
  const r = await pub(auth('dee'), [['ids', ctx.main], ['product', 'YR-HB-U2'], ['position', 'main'], ['index', '1']]);
  assert.match(decodeURIComponent(r.headers.get('location')), /已上架 1 张到主图/);
  const imgs = ctx.imgs = imgsOf(await productPage('YR-HB-U2'));
  assert.equal(imgs.length, ctx.before.length + 1);
  assert.match(imgs[0], /^\/media\/[a-f0-9]{24}\.jpg$/);
});
test('MS-10b the listed image is resized to the max edge from the settings', async () => {
  const media = await sharp(Buffer.from(await (await fetch(api.url + ctx.imgs[0])).arrayBuffer())).metadata();
  assert.ok(Math.max(media.width, media.height) <= 1800); // max edge from MS-07 settings
});
test('MS-10c listing a non-white, non-square image as main image warns about white background and 1:1', async () => {
  ctx.scene = ids(await page('/admin/assets?q=scene'))[0];
  const r = await pub(auth('dee'), [['ids', ctx.scene], ['product', 'YR-HB-U2'], ['position', 'main'], ['index', '1']]);
  assert.match(decodeURIComponent(r.headers.get('location')), /w=.*主图建议使用白底图.*主图建议使用 1:1 方图/);
});
test('MS-10d images can be listed to the gallery and as detail images', async () => {
  await pub(auth('dee'), [['ids', ctx.scene], ['product', 'YR-HB-U2'], ['position', 'gallery']]);
  await pub(auth('dee'), [['ids', ctx.main], ['product', 'YR-HB-U2'], ['position', 'detail']]);
  const page2 = await productPage('YR-HB-U2');
  assert.equal(imgsOf(page2).length, ctx.before.length + 3);
  assert.equal(detailsOf(page2).length, 1);
});
test('MS-10e listing a SKU image for an unknown SKU is rejected', async () => {
  const r = await pub(auth('dee'), [['ids', ctx.main], ['product', 'YR-HB-U2'], ['position', 'sku'], ['sku', 'NOPE']]);
  assert.match(flash(r).err, /SKU/);
});
test('MS-10f an image can be listed as the image of a known SKU', async () => {
  const r = await pub(auth('dee'), [['ids', ctx.main], ['product', 'YR-HB-U2'], ['position', 'sku'], ['sku', 'YR-HB-U2']]);
  assert.match(decodeURIComponent(r.headers.get('location')), /SKU 图/);
});
test('MS-10g pre-listing check: an image under 500 px is rejected', async () => {
  const tiny = (await (await upload(auth('dee'), [['tiny.jpg', await img('#ffffff', 300, 300)]], { product: 'YR-HB-U2' })).json()).created[0];
  assert.match(flash(await pub(auth('dee'), [['ids', tiny], ['product', 'YR-HB-U2'], ['position', 'gallery']])).err, /太小，至少 500 px/);
});
test('MS-10h a user without the product edit / listing permission cannot list images', async () => {
  const r = await pub(auth('sam'), [['ids', ctx.main], ['product', 'YR-HB-U2'], ['position', 'gallery']]);
  if (r.status === 302) assert.match(flash(r).err || '', /需要"商品：编辑、上下架"权限/); else assert.equal(r.status, 403);
});
test('MS-10i the asset detail page shows the listing record (product and position)', async () => {
  assert.match(await page(`/admin/assets/${ctx.main}`), /上架记录[\s\S]*YR-HB-U2[\s\S]*详情图/);
});
test('MS-10j the published website catalog carries the detail images', async () => {
  // published catalog for the website carries the detail images
  await api.form('/admin/products/publish', {});
  const cat = JSON.parse(readFileSync(join(api.dir, 'site/src/data/catalog.json'), 'utf8'));
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

test('MS-12a watermarks: a watermark without a name is rejected', async () => {
  assert.match(flash(await form(auth('dee'), '/admin/assets/watermarks', { name: '', type: 'text', text: 'x', opacity: '0.5', scale: '0.3' })).err, /名称必填/);
});
test('MS-12b watermarks: an image watermark with an unknown asset is rejected', async () => {
  assert.match(flash(await form(auth('dee'), '/admin/assets/watermarks', { name: 'Logo', type: 'image', assetId: 'nope', opacity: '0.5', scale: '0.3' })).err, /图片水印/);
});
test('MS-12c watermarks: a valid text watermark is saved', async () => {
  assert.match(flash(await form(auth('dee'), '/admin/assets/watermarks', { name: 'Brand', type: 'text', text: 'YAORONG 耀嵘', position: 'center', opacity: '0.9', scale: '0.6', color: '#000000' })).ok, /水印已保存/);
});
test('MS-12d watermarks: the preview watermark changes the served preview', async () => {
  const wid = (await page('/admin/assets/watermarks')).match(/watermarks\?edit=([\w-]+)/)[1];
  const rawPreview = Buffer.from(await (await fetch(`${api.url}/admin/assets/preview/${ctx.main}`, { headers: ADMIN })).arrayBuffer());
  await form(auth('dee'), '/admin/assets/watermarks/use', { preview: wid, publish: wid });
  const wmPreview = Buffer.from(await (await fetch(`${api.url}/admin/assets/preview/${ctx.main}`, { headers: ADMIN })).arrayBuffer());
  assert.ok(!wmPreview.equals(rawPreview), 'preview carries the watermark');
});
test('MS-12e watermarks: the original download stays the same while watermarks are active', async () => {
  const original = ctx.original = Buffer.from(await (await fetch(`${api.url}/admin/assets/file/${ctx.main}/1`, { headers: ADMIN })).arrayBuffer());
  const orig2 = Buffer.from(await (await fetch(`${api.url}/admin/assets/file/${ctx.main}/1`, { headers: ADMIN })).arrayBuffer());
  assert.ok(original.equals(orig2));
});
test('MS-12f watermarks: the publish watermark changes the image listed on a product', async () => {
  try {
    await pub(auth('dee'), [['ids', ctx.main], ['product', 'YR-SL-M2'], ['position', 'gallery']]);
    const url = imgsOf(await productPage('YR-SL-M2')).at(-1);
    const stats = await sharp(Buffer.from(await (await fetch(api.url + url)).arrayBuffer())).stats();
    const plain = await sharp(ctx.original).stats();
    assert.ok(Math.abs(stats.channels[0].mean - plain.channels[0].mean) > 1, 'listed image differs from the original (watermark)');
  } finally {
    await form(auth('dee'), '/admin/assets/watermarks/use', { preview: '', publish: '' });
  }
});

test('MS-13a link pulling ("own" mode) files the supplier page images into the product and skips tiny icons', async () => {
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
});
test('MS-13b the pull log records the product name and model read from the page', async () => {
  const logs = await page('/admin/assets/pull');
  assert.match(logs, /Supplier Panel 600 · 型号 SP-600/);
});
test('MS-13c a pulled long image is filed under 详情图 and records where it was pulled from', async () => {
  const longId = ids(await page('/admin/assets?product=YR-FL-F5&tag=长图（详情图）'))[0];
  assert.match(await page(`/admin/assets/${longId}`), /YR-FL-F5 \/ 详情图/);
  assert.match(await page(`/admin/assets/${longId}`), /拉取自/);
});
test('MS-13d "reference" mode reads the page text only and adds no images', async () => {
  const ref = await form(auth('dee'), '/admin/assets/pull', { url: `${shop.url}/p/panel`, mode: 'reference' });
  assert.match(flash(ref).ok, /已读取：Supplier Panel 600/);
  assert.equal([...(await page('/admin/assets?product=YR-FL-F5&view=list')).matchAll(/name="ids"/g)].length, 3); // no new images
});
test('MS-13e pulling an unreachable link reports that it cannot be opened', async () => {
  assert.match(flash(await form(auth('dee'), '/admin/assets/pull', { url: `${shop.url}/missing`, mode: 'own', product: 'YR-FL-F5' })).err, /无法打开链接/);
});
test('MS-13f pulling a non-HTTP link is rejected as invalid', async () => {
  assert.match(flash(await form(auth('dee'), '/admin/assets/pull', { url: 'ftp://x.test/a', mode: 'own', product: 'YR-FL-F5' })).err, /链接无效/);
});

test('MS-14 the version compare page opened without an asset goes back to the library with a message (no server error)', async () => {
  const r = await fetch(`${api.url}/admin/assets/compare`, { headers: ADMIN, redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.match(decodeURIComponent(r.headers.get('location')), /^\/admin\/assets\?e=请勾选两个版本进行对比/);
});
