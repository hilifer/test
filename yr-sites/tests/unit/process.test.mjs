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
  test('IP-01 resize: contain pads to the exact preset with white, cover crops, height 0 keeps ratio', async () => {
    const src = await product('#ffffff', 1000, 500);
    const c = await X.resize(src, { width: 800, height: 800 });
    assert.deepEqual(await size(c), [800, 800]);
    assert.ok(near(await pixel(c, 400, 20), W), 'padding is white');
    const cv = await X.resize(src, { width: 800, height: 800, mode: 'cover' });
    assert.deepEqual(await size(cv), [800, 800]);
    assert.deepEqual(await size(await X.resize(src, { width: 790 })), [790, 395]);
  });
  test('IP-02 white background: transparent product → square, white, product centred with a margin', async () => {
    const out = await X.whiteBackground(await transparent(), { margin: 0.1 });
    const [w, h] = await size(out);
    assert.equal(w, h);
    assert.equal((await sharp(out).metadata()).hasAlpha, false);
    assert.ok(near(await pixel(out, 2, 2), W));
    assert.ok(near(await pixel(out, Math.round(w / 2), Math.round(h / 2)), { r: 198, g: 40, b: 40 }, 20), 'product in the centre');
    // product (120×240) + 10 % margin on each side of the long edge
    assert.ok(Math.abs(w - 288) <= 4, `side ${w}`);
  });
  test('IP-03 extend canvas to 1:1 and 3:4; colour fill or blurred fill; bad ratio refused', async () => {
    const src = await product('#eeeeee', 1000, 500);
    const sq = await X.extendCanvas(src, { ratio: '1:1', fill: '#ff0000' });
    assert.deepEqual(await size(sq), [1000, 1000]);
    assert.ok(near(await pixel(sq, 500, 10), { r: 255, g: 0, b: 0 }, 20));
    const tall = await X.extendCanvas(src, { ratio: '3:4', fill: 'blur' });
    assert.deepEqual(await size(tall), [1000, 1333]);
    assert.ok(!near(await pixel(tall, 500, 10), { r: 255, g: 0, b: 0 }, 20));
    await assert.rejects(X.extendCanvas(src, { ratio: 'abc' }), /比例/);
  });
  test('IP-04 colour: brightness up makes it lighter; matching a reference moves the average colour towards it', async () => {
    const src = await product('#808080', 400, 400);
    const mean = async (b) => (await sharp(b).stats()).channels.slice(0, 3).map((c) => c.mean);
    assert.ok((await mean(await X.adjustColour(src, { brightness: 1.3 })))[0] > (await mean(src))[0] + 10);
    const warm = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#d08040' } }).composite([{ input: Buffer.from('<svg width="200" height="200"><rect x="50" y="50" width="100" height="100" fill="#603010"/></svg>') }]).png().toBuffer();
    const matched = await mean(await X.adjustColour(src, { reference: warm }));
    const ref = await mean(warm);
    assert.ok(Math.abs(matched[0] - ref[0]) < 20 && Math.abs(matched[2] - ref[2]) < 20, `matched ${matched} vs ${ref}`);
  });
  test('IP-05 repair: denoise removes salt-and-pepper noise; upscale doubles the size', async () => {
    const { data, info } = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#808080' } }).raw().toBuffer({ resolveWithObject: true });
    for (let i = 0; i < 2000; i++) { const p = ((i * 7919) % (200 * 200)) * 3; data[p] = data[p + 1] = data[p + 2] = i % 2 ? 255 : 0; }
    const noisy = await sharp(data, { raw: info }).png().toBuffer();
    const sd = async (b) => (await sharp(b).stats()).channels[0].stdev;
    assert.ok(await sd(await X.repair(noisy, { denoise: 3, sharpen: false })) < (await sd(noisy)) / 3);
    assert.deepEqual(await size(await X.repair(noisy, { upscale: true })), [400, 400]);
  });
  test('IP-06 retouch: the masked blemish is gone, the rest of the image is untouched', async () => {
    const src = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#f0f0f0' } }).composite([{ input: Buffer.from('<svg width="400" height="400"><circle cx="100" cy="100" r="8" fill="#000"/><rect x="250" y="250" width="100" height="100" fill="#1565c0"/></svg>') }]).png().toBuffer();
    const mask = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#000' } }).composite([{ input: Buffer.from('<svg width="200" height="200"><circle cx="50" cy="50" r="10" fill="#fff"/></svg>') }]).png().toBuffer(); // half size: scaled up
    const out = await X.retouch(src, mask);
    assert.ok((await pixel(out, 100, 100)).r > 150, 'dot removed');
    assert.ok(near(await pixel(out, 300, 300), { r: 21, g: 101, b: 192 }, 6), 'product untouched');
  });
});

describe('AI cutout & background (mock remove.bg)', () => {
  let svc;
  before(async () => {
    svc = await mockServer(async (call) => (call.url === '/v1.0/removebg' && call.headers['x-api-key'] === 'img-key' ? { body: await transparent(1000, 800), headers: { 'content-type': 'image/png' } } : { status: 402, text: 'insufficient credits' }));
    process.env.IMAGE_AI_BASE_URL = svc.url;
  });
  after(async () => { await svc.close(); delete process.env.IMAGE_AI_KEY; delete process.env.IMAGE_AI_BASE_URL; });
  test('IP-07 without a key cutout is refused with a clear message; with a key it returns a transparent PNG', async () => {
    delete process.env.IMAGE_AI_KEY;
    assert.equal(X.aiImageConfigured(), false);
    await assert.rejects(X.cutout(await product()), /IMAGE_AI_KEY/);
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
  test('IP-09 replace background: product on a colour, keeps the original size, product in the middle', async () => {
    const out = await X.replaceBackground(await product('#999999', 1000, 800), { background: '#00ff00', shadow: false });
    assert.deepEqual(await size(out), [1000, 800]);
    assert.ok(near(await pixel(out, 10, 10), { r: 0, g: 255, b: 0 }, 20));
    assert.ok(near(await pixel(out, 500, 400), { r: 198, g: 40, b: 40 }, 25));
  });
});

describe('processing assets (versions) and presets', () => {
  const ctx = {};
  test('IP-10 processAsset saves a new version (rollback possible) with note and prompt; JPEG stays JPEG', async () => {
    const a = await A.ingest(await product('#f4f4f4', 1200, 900), { name: 'lamp.jpg', tags: ['灯具'] });
    const b = await runAs({ username: 'dee' }, () => X.processAsset(a.id, 'resize', { preset: 'main' }, { prompt: '主图 800' }));
    assert.equal(b.id, a.id);
    assert.equal(b.version, 2);
    assert.equal(b.official, 2);
    assert.equal(b.ext, 'jpg');
    assert.deepEqual([b.width, b.height], [800, 800]);
    const v = A.versionsOf(a.id)[0];
    assert.equal(v.source, 'process');
    assert.match(v.note, /800×800/);
    assert.equal(v.prompt, '主图 800');
    assert.equal(v.created_by, 'dee');
    const back = await A.rollback(a.id, 1);
    assert.deepEqual([back.width, back.height], [1200, 900]);
    ctx.a = back;
  });
  test('IP-11 "save as new" creates a separate asset in the same folder; videos and unknown ops refused', async () => {
    const n = await X.processAsset(ctx.a.id, 'white', {}, { saveAs: 'new' });
    assert.notEqual(n.id, ctx.a.id);
    assert.equal(n.folder_id, ctx.a.folder_id);
    assert.match(n.original_name, /lamp-white\.jpg/);
    assert.ok(n.tags.includes('白底'));
    await assert.rejects(X.processAsset(ctx.a.id, 'explode'), /未知/);
    await assert.rejects(X.processAsset('nope', 'white'), /不存在/);
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
  test('IP-13 presets: defaults, add / replace / delete, validation', () => {
    assert.ok(X.presets().some((p) => p.id === 'main' && p.width === 800));
    const id = X.savePreset({ name: '亚马逊主图', width: 2000, height: 2000 });
    assert.ok(X.presets().some((p) => p.id === id && p.name === '亚马逊主图'));
    X.savePreset({ id, name: '亚马逊主图', width: 1600, height: 1600 });
    assert.equal(X.presets().filter((p) => p.id === id).length, 1);
    assert.equal(X.presets().find((p) => p.id === id).width, 1600);
    assert.throws(() => X.savePreset({ name: 'x', width: 10 }), /宽度/);
    assert.throws(() => X.savePreset({ name: '', width: 800 }), /名称/);
    assert.throws(() => X.savePreset({ name: 'x', width: 800, height: -1 }), /高度/);
    X.deletePreset(id);
    assert.ok(!X.presets().some((p) => p.id === id));
  });
  test('IP-14 export several sizes at once: one new asset per preset, original untouched', async () => {
    const out = await X.exportSizes(ctx.a.id, ['main', 'social', 'unknown']);
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((o) => [o.width, o.height]), [[800, 800], [1080, 1080]]);
    assert.match(out[0].original_name, /lamp-800x800\.jpg/);
    assert.equal(A.getAsset(ctx.a.id).version, 3);
    assert.ok(readFileSync(A.officialFile(out[1])).length > 0);
  });
});

describe('task center', () => {
  const ctx = {};
  T.registerHandler('test.echo', { label: '测试', run: async (key, p) => { if (key.startsWith('bad')) throw new Error(`坏的 ${key}`); if (p.slow) await new Promise((r) => setTimeout(r, p.slow)); return `ok ${key}`; } });
  test('TK-01 a task runs every item in the background, records results, failures and a log', async () => {
    const id = runAs({ username: 'dee' }, () => T.createTask({ kind: 'test.echo', title: '回显', items: [{ key: 'a' }, { key: 'bad1', label: '坏项' }, { key: 'c' }] }));
    await waitFor(() => T.tasksIdle());
    const t = T.getTask(id);
    assert.equal(t.status, 'failed');
    assert.equal(t.created_by, 'dee');
    assert.deepEqual(t.items.map((i) => i.status), ['done', 'failed', 'done']);
    assert.equal(t.items[0].result, 'ok a');
    assert.equal(t.items[1].error, '坏的 bad1');
    assert.deepEqual(T.progress(t), { total: 3, done: 2, failed: 1, finished: 3, pct: 100 });
    assert.ok(t.log.some((l) => /失败：坏项/.test(l.msg)) && t.log.some((l) => /成功 2，失败 1/.test(l.msg)));
    ctx.id = id;
  });
  test('TK-02 retry re-runs only the failed items', async () => {
    T.registerHandler('test.echo', { label: '测试', run: async (key) => `ok ${key}` }); // the cause was fixed
    T.retryTask(ctx.id);
    await waitFor(() => T.tasksIdle());
    const t = T.getTask(ctx.id);
    assert.equal(t.status, 'done');
    assert.deepEqual(t.items.map((i) => i.result), ['ok a', 'ok bad1', 'ok c']);
    assert.throws(() => T.retryTask(ctx.id), /没有失败/);
  });
  test('TK-03 pause stops between items, resume continues, cancel marks the rest cancelled', async () => {
    T.registerHandler('test.slow', { label: '慢', run: async (key) => { await new Promise((r) => setTimeout(r, 60)); return key; } });
    const id = T.createTask({ kind: 'test.slow', items: Array.from({ length: 6 }, (_, i) => ({ key: `k${i}` })) });
    await waitFor(() => T.getTask(id).items.some((i) => i.status === 'done'));
    T.pauseTask(id);
    await waitFor(() => T.tasksIdle());
    const paused = T.getTask(id);
    assert.equal(paused.status, 'paused');
    const doneAtPause = paused.items.filter((i) => i.status === 'done').length;
    assert.ok(doneAtPause < 6);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(T.getTask(id).items.filter((i) => i.status === 'done').length, doneAtPause, 'nothing runs while paused');
    assert.throws(() => T.pauseTask(id), /不能/);
    T.resumeTask(id);
    await waitFor(() => T.getTask(id).items.filter((i) => i.status === 'done').length > doneAtPause);
    T.cancelTask(id);
    await waitFor(() => T.tasksIdle());
    const t = T.getTask(id);
    assert.equal(t.status, 'cancelled');
    assert.ok(t.items.some((i) => i.status === 'cancelled'));
    assert.ok(t.finished_at);
    T.retryTask(id); // cancelled items can be picked up again
    await waitFor(() => T.tasksIdle());
    assert.equal(T.getTask(id).status, 'done');
  });
  test('TK-04 validation: unknown kind, no items, too many items', () => {
    assert.throws(() => T.createTask({ kind: 'nope', items: [{ key: 'a' }] }), /未知/);
    assert.throws(() => T.createTask({ kind: 'test.echo', items: [] }), /没有/);
    assert.throws(() => T.createTask({ kind: 'test.echo', items: Array.from({ length: 2001 }, (_, i) => ({ key: String(i) })) }), /2000/);
  });
  test('TK-05 batch image processing through the task center: every image gets a new version; videos are skipped', async () => {
    const imgs = await Promise.all([1, 2].map(async (n) => A.ingest(await transparent(500 + n * 10, 400), { name: `p${n}.png` })));
    const id = X.queueBatch([...imgs.map((a) => a.id), 'missing'], { op: 'white' });
    await waitFor(() => T.tasksIdle());
    const t = T.getTask(id);
    assert.equal(t.items.length, 2);
    assert.equal(t.status, 'done');
    for (const a of imgs) { const b = A.getAsset(a.id); assert.equal(b.version, 2); assert.equal(b.width, b.height); assert.ok(b.auto_tags.includes('白底图')); }
    assert.match(t.items[0].result.text, /v2/);
    assert.equal(t.items[0].result.link, `/admin/assets/${imgs[0].id}`);
    const s = X.queueBatch([imgs[0].id], { op: 'sizes', presetIds: ['main', 'banner'] });
    await waitFor(() => T.tasksIdle());
    assert.match(T.getTask(s).items[0].result.text, /2 个尺寸/);
    assert.throws(() => X.queueBatch(['missing'], { op: 'white' }), /请勾选图片/);
    assert.throws(() => X.queueBatch([imgs[0].id], { op: 'retouch' }), /不支持批量/);
    assert.throws(() => X.queueBatch([imgs[0].id], { op: 'cutout' }), /IMAGE_AI_KEY/);
    assert.throws(() => X.queueBatch([imgs[0].id], { op: 'sizes', presetIds: [] }), /尺寸/);
  });
});
