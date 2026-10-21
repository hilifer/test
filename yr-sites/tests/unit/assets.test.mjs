// Module: server/src/assets/store.js — asset library: type detection, automatic tags, folders, versions & rollback,
// recycle bin, quota, search (incl. by image), zip download, video / PSD previews. IDs MD-xx. Real files throughout.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import { useTempEnv, tempDir } from '../helpers/env.mjs';

useTempEnv({ site: 'led', MEDIA_DIR: tempDir('yr-media-') });
const A = await import('../../server/src/assets/store.js');
const C = await import('../../server/src/catalog/store.js');
const { default: sharp } = await import('sharp');
const FFMPEG = await A.hasFfmpeg();

// test images: white-background product shot, transparent PNG, long detail image, small photo on a coloured background
const product = (bg = '#ffffff', w = 1000, h = 1000) => sharp({ create: { width: w, height: h, channels: 3, background: bg } })
  .composite([{ input: Buffer.from(`<svg width="${w}" height="${h}"><rect x="${w * 0.3}" y="${h * 0.3}" width="${w * 0.4}" height="${h * 0.4}" fill="#1565c0"/></svg>`) }]).jpeg().toBuffer();
const transparent = () => sharp({ create: { width: 900, height: 900, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: Buffer.from('<svg width="900" height="900"><circle cx="450" cy="450" r="200" fill="#c62828"/></svg>') }]).png().toBuffer();
function psdWithThumb(jpeg) {
  const head = Buffer.alloc(26); head.write('8BPS', 0); head.writeUInt16BE(1, 4); head.writeUInt16BE(3, 12); head.writeUInt32BE(100, 14); head.writeUInt32BE(100, 18); head.writeUInt16BE(8, 22); head.writeUInt16BE(3, 24);
  const thumbHeader = Buffer.alloc(28);
  const data = Buffer.concat([thumbHeader, jpeg]);
  const res = Buffer.concat([Buffer.from('8BIM'), Buffer.from([0x04, 0x0c]), Buffer.from([0, 0]), Buffer.alloc(4), data, Buffer.alloc(data.length % 2)]);
  res.writeUInt32BE(data.length, 8);
  const resLen = Buffer.alloc(4); resLen.writeUInt32BE(res.length);
  return Buffer.concat([head, Buffer.alloc(4), resLen, res, Buffer.alloc(8)]);
}

describe('ingest & analysis', () => {
  const ctx = {};
  test('MD-01 type detection by content (not by name); unsupported files refused', () => {
    assert.equal(A.detect(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'x.png').ext, 'jpg');
    assert.equal(A.detect(Buffer.from('....ftypisom'), 'a.mp4').kind, 'video');
    assert.equal(A.detect(Buffer.from('....ftypqt  '), 'a.mov').ext, 'mov');
    assert.equal(A.detect(Buffer.from('8BPS'), 'x').ext, 'psd');
    assert.equal(A.detect(Buffer.from('%PDF-1.5'), 'logo.ai').ext, 'ai');
    assert.equal(A.detect(Buffer.from('%PDF-1.5'), 'doc.pdf'), null);
    assert.equal(A.detect(Buffer.from('<svg/>'), 'x.svg'), null);
  });
  test('MD-02 upload into a product: folders 网站 → 产品 → 主图/副图/… created; automatic tags from the pixels', async () => {
    ctx.white = await A.ingest(await product(), { name: 'main.jpg', productId: 'YR-HB-U2' });
    assert.deepEqual(A.folderPath(ctx.white.folder_id).map((f) => f.name).slice(-2), ['YR-HB-U2', '主图']);
    assert.equal(ctx.white.product_id, 'YR-HB-U2');
    assert.deepEqual([ctx.white.width, ctx.white.height], [1000, 1000]);
    assert.ok(ctx.white.auto_tags.includes('白底图'));
    assert.ok(ctx.white.auto_tags.includes('方图（主图候选）'));
    const png = await A.ingest(await transparent(), { name: 'cutout.png', productId: 'YR-HB-U2', sub: '副图' });
    assert.ok(png.auto_tags.includes('透明图'));
    const long = await A.ingest(await product('#f0e6d2', 790, 2400), { name: 'detail.jpg', productId: 'YR-HB-U2', sub: '详情图' });
    assert.ok(long.auto_tags.includes('长图（详情图）'));
    assert.ok(!long.auto_tags.includes('白底图'));
    const small = await A.ingest(await product('#336699', 500, 400), { name: 'small.jpg', folderId: A.sharedFolder() });
    assert.ok(small.auto_tags.includes('低分辨率'));
    assert.equal(small.product_id, null);
    assert.ok(A.thumbFile(ctx.white.id) && A.previewFile(ctx.white.id));
  });
  test('MD-03 video: duration and size read, poster frame and low-bitrate preview made (ffmpeg)', { skip: !FFMPEG && 'ffmpeg not installed' }, async () => {
    const dir = tempDir('yr-vid-');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=2', '-pix_fmt', 'yuv420p', join(dir, 'clip.mp4')]);
    const v = await A.ingest(readFileSync(join(dir, 'clip.mp4')), { name: 'clip.mp4', productId: 'YR-HB-U2' });
    assert.equal(v.kind, 'video');
    assert.deepEqual([v.width, v.height], [640, 360]);
    assert.ok(Math.abs(v.duration - 2) < 0.2);
    assert.deepEqual(A.folderPath(v.folder_id).map((f) => f.name).at(-1), '视频');
    assert.ok(A.thumbFile(v.id));
    assert.match(A.previewFile(v.id), /preview\.mp4$/);
  });
  test('MD-04 PSD: stored as a source file with its embedded thumbnail shown', async () => {
    const thumb = await sharp({ create: { width: 160, height: 120, channels: 3, background: '#2e7d32' } }).jpeg().toBuffer();
    const p = await A.ingest(psdWithThumb(thumb), { name: 'layout.psd', productId: 'YR-HB-U2' });
    assert.equal(p.kind, 'source');
    assert.ok(A.thumbFile(p.id), 'thumbnail from the PSD');
    assert.deepEqual(A.folderPath(p.folder_id).map((f) => f.name).at(-1), '源文件');
  });
  test('MD-05 size limits and unsupported types', async () => {
    await assert.rejects(A.ingest(Buffer.from('hello'), { name: 'x.txt' }), /不支持的文件类型/);
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(26 * 1048576)]);
    await assert.rejects(A.ingest(big, { name: 'huge.jpg' }), /不能超过 25 MB/);
  });

  test('MD-06 versions: new version becomes official; rollback adds a version (history kept); mark an older version official', async () => {
    const a = ctx.white;
    const v2 = await A.addVersion(a.id, await product('#ffffff', 1200, 1200), { source: 'process', note: '放大', prompt: 'keep subject, pure white background' });
    assert.equal(v2.version, 2); assert.equal(v2.official, 2); assert.equal(v2.width, 1200);
    const v3 = await A.rollback(a.id, 1);
    assert.equal(v3.version, 3); assert.equal(v3.width, 1000);
    assert.deepEqual(A.versionsOf(a.id).map((v) => [v.version, v.source]), [[3, 'rollback'], [2, 'process'], [1, 'upload']]);
    assert.equal(A.versionsOf(a.id).find((v) => v.version === 2).prompt, 'keep subject, pure white background');
    await A.setOfficial(a.id, 2);
    assert.equal(A.getAsset(a.id).official, 2);
    assert.match(A.officialFile(A.getAsset(a.id)), /v2\.jpg$/);
    const thumb = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#000' } }).jpeg().toBuffer();
    await assert.rejects(A.addVersion(a.id, psdWithThumb(thumb)), /类型相同/); // an image cannot become a PSD
  });
});

describe('organise, search, download', () => {
  test('MD-07 folders: create, rename, unique names, cannot delete a non-empty folder; move and tag in bulk', async () => {
    const root = A.createFolder(null, '展会素材');
    const sub = A.createFolder(root, '2026 广交会');
    assert.throws(() => A.createFolder(root, '2026 广交会'), /同名/);
    assert.throws(() => A.createFolder(root, 'a/b'), /不能含/);
    A.renameFolder(sub, '2026 秋季广交会');
    const ids = A.search({ productId: 'YR-HB-U2', kind: 'image' }).rows.slice(0, 2).map((a) => a.id);
    A.bulkMove(ids, sub);
    A.bulkTag(ids, ['展会', '新品'], []);
    assert.equal(A.search({ folderId: root }).total, 2); // recursive
    assert.ok(A.getAsset(ids[0]).tags.includes('展会'));
    assert.equal(A.getAsset(ids[0]).product_id, null); // moved out of the product folder
    assert.throws(() => A.deleteFolder(root), /不是空的/);
    A.bulkTag(ids, [], ['新品']);
    assert.deepEqual(A.getAsset(ids[0]).tags, ['展会']);
  });
  test('MD-08 search: by product, type, tag, format, size, keyword; search by image finds the same picture first', async () => {
    assert.ok(A.search({ tag: '白底图' }).rows.length >= 1);
    assert.ok(A.search({ kind: 'source' }).rows.every((a) => a.kind === 'source'));
    assert.ok(A.search({ ext: 'png' }).rows.every((a) => a.ext === 'png'));
    assert.ok(A.search({ minWidth: 1000 }).rows.every((a) => a.width >= 1000));
    assert.ok(A.search({ q: 'detail' }).rows.some((a) => a.original_name === 'detail.jpg'));
    const hits = await A.similar(await product());
    assert.equal(hits[0].distance, 0);
    assert.ok(A.allTags().includes('白底图'));
  });
  test('MD-09 recycle bin: trash hides, restore brings back, permanent delete only from the bin; expiry purge', async () => {
    const a = A.search({ q: 'small' }).rows[0];
    A.trash([a.id]);
    assert.ok(!A.search({ q: 'small' }).rows.length);
    assert.equal(A.search({ status: 'trashed' }).rows[0].id, a.id);
    A.restore([a.id]);
    assert.equal(A.getAsset(a.id).status, 'active');
    assert.equal(A.purge([a.id]), 0); // not in the bin
    A.trash([a.id]);
    assert.equal(A.purge([a.id]), 1);
    assert.equal(A.getAsset(a.id), undefined);
    const b = A.search({ q: 'cutout' }).rows[0];
    A.trash([b.id]);
    const { db } = await import('../../server/src/db.js');
    db.prepare('UPDATE assets SET trashed_at = ? WHERE id = ?').run('2020-01-01T00:00:00Z', b.id);
    assert.equal(A.purgeExpired(), 1);
    assert.ok(!existsSync(join(A.assetsDir(), b.id)));
  });
  test('MD-10 zip download contains the official versions with their names', async () => {
    const ids = A.search({ kind: 'image' }).rows.map((a) => a.id);
    const z = A.zip(ids);
    assert.equal(z.readUInt32LE(z.length - 22), 0x06054b50);
    const count = z.readUInt16LE(z.length - 12);
    assert.equal(count, ids.length);
    const nameLen = z.readUInt16LE(26), size = z.readUInt32LE(18);
    const name = z.toString('utf8', 30, 30 + nameLen);
    assert.match(name, /\.(jpg|png|webp)$/);
    assert.equal(A.detect(z.subarray(30 + nameLen, 30 + nameLen + size)).kind, 'image');
    void inflateRawSync;
  });
  test('MD-11 quota: usage per product and type; uploads refused beyond the limit', async () => {
    const u = A.usage();
    assert.ok(u.total > 0 && u.byProduct.some((p) => p.product_id === 'YR-HB-U2'));
    C.setSetting('asset_settings', { quotaGb: u.total / 1073741824 }); // full
    await assert.rejects(A.ingest(await product(), { name: 'more.jpg' }), /空间不足/);
    C.setSetting('asset_settings', { quotaGb: 30 });
  });
});
