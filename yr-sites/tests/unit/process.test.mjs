// Modules: server/src/assets/process.js (image processing) and server/src/tasks.js (task center). Real images made with
// sharp; the AI cutout service is a mock remove.bg. IDs IP-xx (processing) and TK-xx (tasks).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { useTempEnv, tempDir } from '../helpers/env.mjs';
import { mockServer } from '../helpers/mock-http.mjs';
import { waitFor } from '../helpers/server.mjs';

useTempEnv({ site: 'led', MEDIA_DIR: tempDir('yr-media-') });
const A = await import('../../server/src/assets/store.js');
const X = await import('../../server/src/assets/process.js');
const T = await import('../../server/src/tasks.js');
const { runAs } = await import('../../server/src/auth.js');
const { default: sharp } = await import('sharp');

const W = { r: 255, g: 255, b: 255 };
const product = (bg = '#ffffff', w = 1000, h = 800) => sharp({ create: { width: w, height: h, channels: 3, background: bg } })
  .composite([{ input: Buffer.from(`<svg width="${w}" height="${h}"><rect x="${w * 0.35}" y="${h * 0.3}" width="${w * 0.3}" height="${h * 0.4}" fill="#1565c0"/></svg>`) }]).jpeg({ quality: 95 }).toBuffer();
const transparent = (w = 600, h = 400) => sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: Buffer.from(`<svg width="${w}" height="${h}"><rect x="${w * 0.4}" y="${h * 0.2}" width="${w * 0.2}" height="${h * 0.6}" fill="#c62828"/></svg>`) }]).png().toBuffer();
const pixel = async (buf, x, y) => { const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true }); const i = (y * info.width + x) * 3; return { r: data[i], g: data[i + 1], b: data[i + 2] }; };
const near = (p, q, tol = 12) => Math.abs(p.r - q.r) <= tol && Math.abs(p.g - q.g) <= tol && Math.abs(p.b - q.b) <= tol;
const size = async (buf) => { const m = await sharp(buf).metadata(); return [m.width, m.height]; };

describe('local operations', () => {
  let src1;
  test('IP-01a resize contain pads to the exact preset size with white', async () => {
    src1 = await product('#ffffff', 1000, 500);
    const c = await X.resize(src1, { width: 800, height: 800 });
    assert.deepEqual(await size(c), [800, 800]);
    assert.ok(near(await pixel(c, 400, 20), W), 'padding is white');
  });
  test('IP-01b resize cover crops to the exact preset size', async () => {
    const cv = await X.resize(src1, { width: 800, height: 800, mode: 'cover' });
    assert.deepEqual(await size(cv), [800, 800]);
  });
  test('IP-01c resize with no height keeps the aspect ratio', async () => {
    assert.deepEqual(await size(await X.resize(src1, { width: 790 })), [790, 395]);
  });
  let out2, side2;
  test('IP-02a white background turns a transparent product into a square, opaque, white image', async () => {
    out2 = await X.whiteBackground(await transparent(), { margin: 0.1 });
    const [w, h] = await size(out2);
    side2 = w;
    assert.equal(w, h);
    assert.equal((await sharp(out2).metadata()).hasAlpha, false);
    assert.ok(near(await pixel(out2, 2, 2), W));
  });
  test('IP-02b white background puts the product in the centre', async () => {
    assert.ok(near(await pixel(out2, Math.round(side2 / 2), Math.round(side2 / 2)), { r: 198, g: 40, b: 40 }, 20), 'product in the centre');
  });
  test('IP-02c white background keeps the requested margin around the long edge', () => {
    // product (120×240) + 10 % margin on each side of the long edge
    assert.ok(Math.abs(side2 - 288) <= 4, `side ${side2}`);
  });
  let src3;
  test('IP-03a extend canvas to 1:1 with a colour fill', async () => {
    src3 = await product('#eeeeee', 1000, 500);
    const sq = await X.extendCanvas(src3, { ratio: '1:1', fill: '#ff0000' });
    assert.deepEqual(await size(sq), [1000, 1000]);
    assert.ok(near(await pixel(sq, 500, 10), { r: 255, g: 0, b: 0 }, 20));
  });
  test('IP-03b extend canvas to 3:4 with a blurred fill', async () => {
    const tall = await X.extendCanvas(src3, { ratio: '3:4', fill: 'blur' });
    assert.deepEqual(await size(tall), [1000, 1333]);
    assert.ok(!near(await pixel(tall, 500, 10), { r: 255, g: 0, b: 0 }, 20));
  });
  test('IP-03c extend canvas refuses a bad ratio', async () => {
    await assert.rejects(X.extendCanvas(src3, { ratio: 'abc' }), /比例/);
  });
  const mean = async (b) => (await sharp(b).stats()).channels.slice(0, 3).map((c) => c.mean);
  test('IP-04a raising brightness makes the image lighter', async () => {
    const src = await product('#808080', 400, 400);
    assert.ok((await mean(await X.adjustColour(src, { brightness: 1.3 })))[0] > (await mean(src))[0] + 10);
  });
  test('IP-04b matching a reference moves the average colour towards it', async () => {
    const src = await product('#808080', 400, 400);
    const warm = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#d08040' } }).composite([{ input: Buffer.from('<svg width="200" height="200"><rect x="50" y="50" width="100" height="100" fill="#603010"/></svg>') }]).png().toBuffer();
    const matched = await mean(await X.adjustColour(src, { reference: warm }));
    const ref = await mean(warm);
    assert.ok(Math.abs(matched[0] - ref[0]) < 20 && Math.abs(matched[2] - ref[2]) < 20, `matched ${matched} vs ${ref}`);
  });
  let noisy;
  test('IP-05a denoise removes salt-and-pepper noise', async () => {
    const { data, info } = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#808080' } }).raw().toBuffer({ resolveWithObject: true });
    for (let i = 0; i < 2000; i++) { const p = ((i * 7919) % (200 * 200)) * 3; data[p] = data[p + 1] = data[p + 2] = i % 2 ? 255 : 0; }
    noisy = await sharp(data, { raw: info }).png().toBuffer();
    const sd = async (b) => (await sharp(b).stats()).channels[0].stdev;
    assert.ok(await sd(await X.repair(noisy, { denoise: 3, sharpen: false })) < (await sd(noisy)) / 3);
  });
  test('IP-05b upscale doubles the size', async () => {
    assert.deepEqual(await size(await X.repair(noisy, { upscale: true })), [400, 400]);
  });
  let out6;
  test('IP-06a retouch removes the masked blemish (mask scaled to the image)', async () => {
    const src = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#f0f0f0' } }).composite([{ input: Buffer.from('<svg width="400" height="400"><circle cx="100" cy="100" r="8" fill="#000"/><rect x="250" y="250" width="100" height="100" fill="#1565c0"/></svg>') }]).png().toBuffer();
    const mask = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#000' } }).composite([{ input: Buffer.from('<svg width="200" height="200"><circle cx="50" cy="50" r="10" fill="#fff"/></svg>') }]).png().toBuffer(); // half size: scaled up
    out6 = await X.retouch(src, mask);
    assert.ok((await pixel(out6, 100, 100)).r > 150, 'dot removed');
  });
  test('IP-06b retouch leaves the rest of the image untouched', async () => {
    assert.ok(near(await pixel(out6, 300, 300), { r: 21, g: 101, b: 192 }, 6), 'product untouched');
  });
});

describe('AI cutout & background (mock remove.bg)', () => {
  let svc;
  before(async () => {
    svc = await mockServer(async (call) => (call.url === '/v1.0/removebg' && call.headers['x-api-key'] === 'img-key' ? { body: await transparent(1000, 800), headers: { 'content-type': 'image/png' } } : { status: 402, text: 'insufficient credits' }));
    process.env.IMAGE_AI_BASE_URL = svc.url;
  });
  after(async () => { await svc.close(); delete process.env.IMAGE_AI_KEY; delete process.env.IMAGE_AI_BASE_URL; });
  test('IP-07a without a key, AI is not configured and cutout is refused with a clear message', async () => {
    delete process.env.IMAGE_AI_KEY;
    assert.equal(X.aiImageConfigured(), false);
    await assert.rejects(X.cutout(await product()), /IMAGE_AI_KEY/);
  });
  test('IP-07b with a key, cutout uploads the image file and returns a transparent PNG', async () => {
    process.env.IMAGE_AI_KEY = 'img-key';
    const out = await X.cutout(await product());
    assert.equal((await sharp(out).metadata()).hasAlpha, true);
    assert.match(String(svc.calls.at(-1).body), /image_file/);
  });
  test('IP-08 service errors are reported (HTTP status and message)', async () => {
    process.env.IMAGE_AI_KEY = 'wrong';
    await assert.rejects(X.cutout(await product()), /HTTP 402 insufficient credits/);
    process.env.IMAGE_AI_KEY = 'img-key';
  });
  let out9;
  test('IP-09a replace background keeps the original size', async () => {
    out9 = await X.replaceBackground(await product('#999999', 1000, 800), { background: '#00ff00', shadow: false });
    assert.deepEqual(await size(out9), [1000, 800]);
  });
  test('IP-09b replace background fills with the chosen colour', async () => {
    assert.ok(near(await pixel(out9, 10, 10), { r: 0, g: 255, b: 0 }, 20));
  });
  test('IP-09c replace background keeps the product in the middle', async () => {
    assert.ok(near(await pixel(out9, 500, 400), { r: 198, g: 40, b: 40 }, 25));
  });
});

describe('processing assets (versions) and presets', () => {
  const ctx = {};
  let a10, b10;
  test('IP-10a processAsset saves a new official version of the same asset', async () => {
    a10 = await A.ingest(await product('#f4f4f4', 1200, 900), { name: 'lamp.jpg', tags: ['灯具'] });
    b10 = await runAs({ username: 'dee' }, () => X.processAsset(a10.id, 'resize', { preset: 'main' }, { prompt: '主图 800' }));
    assert.equal(b10.id, a10.id);
    assert.equal(b10.version, 2);
    assert.equal(b10.official, 2);
  });
  test('IP-10b a processed JPEG stays JPEG at the preset size', () => {
    assert.equal(b10.ext, 'jpg');
    assert.deepEqual([b10.width, b10.height], [800, 800]);
  });
  test('IP-10c the new version records source, note, prompt and author', () => {
    const v = A.versionsOf(a10.id)[0];
    assert.equal(v.source, 'process');
    assert.match(v.note, /800×800/);
    assert.equal(v.prompt, '主图 800');
    assert.equal(v.created_by, 'dee');
  });
  test('IP-10d rolling back restores the original version', async () => {
    const back = await A.rollback(a10.id, 1);
    assert.deepEqual([back.width, back.height], [1200, 900]);
    ctx.a = back;
  });
  test('IP-11a "save as new" creates a separate asset in the same folder with a derived name and tag', async () => {
    const n = await X.processAsset(ctx.a.id, 'white', {}, { saveAs: 'new' });
    assert.notEqual(n.id, ctx.a.id);
    assert.equal(n.folder_id, ctx.a.folder_id);
    assert.match(n.original_name, /lamp-white\.jpg/);
    assert.ok(n.tags.includes('白底'));
  });
  test('IP-11b an unknown operation is refused', async () => {
    await assert.rejects(X.processAsset(ctx.a.id, 'explode'), /未知/);
  });
  test('IP-11c processing an unknown asset is refused', async () => {
    await assert.rejects(X.processAsset('nope', 'white'), /不存在/);
  });
  test('IP-11d retouch without a painted mask is refused', async () => {
    await assert.rejects(X.processAsset(ctx.a.id, 'retouch', {}), /涂抹/);
  });
  test('IP-12 cutout of a JPEG becomes a new transparent PNG asset (a JPEG cannot hold transparency)', async () => {
    const svc = await mockServer(async () => ({ body: await transparent(), headers: { 'content-type': 'image/png' } }));
    Object.assign(process.env, { IMAGE_AI_KEY: 'k', IMAGE_AI_BASE_URL: svc.url });
    try {
      const n = await X.processAsset(ctx.a.id, 'cutout');
      assert.notEqual(n.id, ctx.a.id);
      assert.equal(n.ext, 'png');
      assert.match(n.original_name, /-cutout\.png$/);
      assert.ok(n.auto_tags.includes('透明图'));
    } finally { await svc.close(); delete process.env.IMAGE_AI_KEY; delete process.env.IMAGE_AI_BASE_URL; }
  });
  let pid;
  test('IP-13a the default presets include the 800 px main image', () => {
    assert.ok(X.presets().some((p) => p.id === 'main' && p.width === 800));
  });
  test('IP-13b a new preset is added', () => {
    pid = X.savePreset({ name: '亚马逊主图', width: 2000, height: 2000 });
    assert.ok(X.presets().some((p) => p.id === pid && p.name === '亚马逊主图'));
  });
  test('IP-13c saving with an existing id replaces the preset', () => {
    X.savePreset({ id: pid, name: '亚马逊主图', width: 1600, height: 1600 });
    assert.equal(X.presets().filter((p) => p.id === pid).length, 1);
    assert.equal(X.presets().find((p) => p.id === pid).width, 1600);
  });
  test('IP-13d a preset with a too-small width is refused', () => {
    assert.throws(() => X.savePreset({ name: 'x', width: 10 }), /宽度/);
  });
  test('IP-13e a preset without a name is refused', () => {
    assert.throws(() => X.savePreset({ name: '', width: 800 }), /名称/);
  });
  test('IP-13f a preset with a negative height is refused', () => {
    assert.throws(() => X.savePreset({ name: 'x', width: 800, height: -1 }), /高度/);
  });
  test('IP-13g a deleted preset is gone', () => {
    X.deletePreset(pid);
    assert.ok(!X.presets().some((p) => p.id === pid));
  });
  let out14;
  test('IP-14a exporting several sizes creates one new asset per known preset, named by size', async () => {
    out14 = await X.exportSizes(ctx.a.id, ['main', 'social', 'unknown']);
    assert.equal(out14.length, 2);
    assert.deepEqual(out14.map((o) => [o.width, o.height]), [[800, 800], [1080, 1080]]);
    assert.match(out14[0].original_name, /lamp-800x800\.jpg/);
  });
  test('IP-14b exporting sizes leaves the original asset untouched', () => {
    assert.equal(A.getAsset(ctx.a.id).version, 3);
  });
  test('IP-14c each exported size has its file written', () => {
    assert.ok(readFileSync(A.officialFile(out14[1])).length > 0);
  });
});

describe('task center', () => {
  const ctx = {};
  T.registerHandler('test.echo', { label: '测试', run: async (key, p) => { if (key.startsWith('bad')) throw new Error(`坏的 ${key}`); if (p.slow) await new Promise((r) => setTimeout(r, p.slow)); return `ok ${key}`; } });
  let t1;
  test('TK-01a a task runs every item in the background and records item status and creator', async () => {
    const id = runAs({ username: 'dee' }, () => T.createTask({ kind: 'test.echo', title: '回显', items: [{ key: 'a' }, { key: 'bad1', label: '坏项' }, { key: 'c' }] }));
    await waitFor(() => T.tasksIdle());
    t1 = T.getTask(id);
    assert.equal(t1.status, 'failed');
    assert.equal(t1.created_by, 'dee');
    assert.deepEqual(t1.items.map((i) => i.status), ['done', 'failed', 'done']);
    ctx.id = id;
  });
  test('TK-01b item results and failure messages are recorded', () => {
    assert.equal(t1.items[0].result, 'ok a');
    assert.equal(t1.items[1].error, '坏的 bad1');
  });
  test('TK-01c progress counts done, failed and finished items', () => {
    assert.deepEqual(T.progress(t1), { total: 3, done: 2, failed: 1, finished: 3, pct: 100 });
  });
  test('TK-01d the task log names failed items and sums up the result', () => {
    assert.ok(t1.log.some((l) => /失败：坏项/.test(l.msg)) && t1.log.some((l) => /成功 2，失败 1/.test(l.msg)));
  });
  test('TK-02a retry re-runs only the failed items and the task is done', async () => {
    T.registerHandler('test.echo', { label: '测试', run: async (key) => `ok ${key}` }); // the cause was fixed
    T.retryTask(ctx.id);
    await waitFor(() => T.tasksIdle());
    const t = T.getTask(ctx.id);
    assert.equal(t.status, 'done');
    assert.deepEqual(t.items.map((i) => i.result), ['ok a', 'ok bad1', 'ok c']);
  });
  test('TK-02b retrying a task without failed items is refused', () => {
    assert.throws(() => T.retryTask(ctx.id), /没有失败/);
  });
  let id3, doneAtPause;
  test('TK-03a pause stops the task between items', async () => {
    T.registerHandler('test.slow', { label: '慢', run: async (key) => { await new Promise((r) => setTimeout(r, 60)); return key; } });
    id3 = T.createTask({ kind: 'test.slow', items: Array.from({ length: 6 }, (_, i) => ({ key: `k${i}` })) });
    await waitFor(() => T.getTask(id3).items.some((i) => i.status === 'done'));
    T.pauseTask(id3);
    await waitFor(() => T.tasksIdle());
    const paused = T.getTask(id3);
    assert.equal(paused.status, 'paused');
    doneAtPause = paused.items.filter((i) => i.status === 'done').length;
    assert.ok(doneAtPause < 6);
  });
  test('TK-03b nothing runs while paused and a paused task cannot be paused again', async () => {
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(T.getTask(id3).items.filter((i) => i.status === 'done').length, doneAtPause, 'nothing runs while paused');
    assert.throws(() => T.pauseTask(id3), /不能/);
  });
  test('TK-03c resume continues with the remaining items', async () => {
    T.resumeTask(id3);
    await waitFor(() => T.getTask(id3).items.filter((i) => i.status === 'done').length > doneAtPause);
    assert.ok(T.getTask(id3).items.filter((i) => i.status === 'done').length > doneAtPause);
  });
  test('TK-03d cancel marks the rest cancelled and finishes the task', async () => {
    T.cancelTask(id3);
    await waitFor(() => T.tasksIdle());
    const t = T.getTask(id3);
    assert.equal(t.status, 'cancelled');
    assert.ok(t.items.some((i) => i.status === 'cancelled'));
    assert.ok(t.finished_at);
  });
  test('TK-03e retrying a cancelled task picks up the cancelled items', async () => {
    T.retryTask(id3); // cancelled items can be picked up again
    await waitFor(() => T.tasksIdle());
    assert.equal(T.getTask(id3).status, 'done');
  });
  test('TK-04a a task of an unknown kind is refused', () => {
    assert.throws(() => T.createTask({ kind: 'nope', items: [{ key: 'a' }] }), /未知/);
  });
  test('TK-04b a task without items is refused', () => {
    assert.throws(() => T.createTask({ kind: 'test.echo', items: [] }), /没有/);
  });
  test('TK-04c a task with more than 2000 items is refused', () => {
    assert.throws(() => T.createTask({ kind: 'test.echo', items: Array.from({ length: 2001 }, (_, i) => ({ key: String(i) })) }), /2000/);
  });
  let imgs, t5;
  test('TK-05a a batch queues one item per existing image (missing ones skipped) and finishes', async () => {
    imgs = await Promise.all([1, 2].map(async (n) => A.ingest(await transparent(500 + n * 10, 400), { name: `p${n}.png` })));
    const id = X.queueBatch([...imgs.map((a) => a.id), 'missing'], { op: 'white' });
    await waitFor(() => T.tasksIdle());
    t5 = T.getTask(id);
    assert.equal(t5.items.length, 2);
    assert.equal(t5.status, 'done');
  });
  test('TK-05b every image in the batch gets a new square white-background version', () => {
    for (const a of imgs) { const b = A.getAsset(a.id); assert.equal(b.version, 2); assert.equal(b.width, b.height); assert.ok(b.auto_tags.includes('白底图')); }
  });
  test('TK-05c each batch item result names the new version and links to the asset', () => {
    assert.match(t5.items[0].result.text, /v2/);
    assert.equal(t5.items[0].result.link, `/admin/assets/${imgs[0].id}`);
  });
  test('TK-05d a batch size export reports the number of sizes made', async () => {
    const s = X.queueBatch([imgs[0].id], { op: 'sizes', presetIds: ['main', 'banner'] });
    await waitFor(() => T.tasksIdle());
    assert.match(T.getTask(s).items[0].result.text, /2 个尺寸/);
  });
  test('TK-05e a batch without any existing image is refused', () => {
    assert.throws(() => X.queueBatch(['missing'], { op: 'white' }), /请勾选图片/);
  });
  test('TK-05f retouch cannot be run as a batch', () => {
    assert.throws(() => X.queueBatch([imgs[0].id], { op: 'retouch' }), /不支持批量/);
  });
  test('TK-05g a batch cutout without an AI key is refused', () => {
    assert.throws(() => X.queueBatch([imgs[0].id], { op: 'cutout' }), /IMAGE_AI_KEY/);
  });
  test('TK-05h a batch size export without sizes is refused', () => {
    assert.throws(() => X.queueBatch([imgs[0].id], { op: 'sizes', presetIds: [] }), /尺寸/);
  });
});
