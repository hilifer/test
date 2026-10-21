// Watermarks and "上架到独立站": put library images on a product (main image n / gallery / SKU image / detail images).
// Each listing makes a web-optimised copy (max edge, quality, optional publish watermark), runs pre-listing checks, and
// is saved as a product revision, so the previous images can be restored with one click.
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import sharp from 'sharp';
import { db } from '../db.js';
import { migrate } from '../migrate.js';
import { actorName } from '../auth.js';
import * as C from '../catalog/store.js';
import * as A from './store.js';

migrate([{
  id: '2026-10-30-asset-publications',
  up: () => db.exec(`CREATE TABLE asset_publications (id INTEGER PRIMARY KEY AUTOINCREMENT, asset_id TEXT, version INTEGER, product_id TEXT, position TEXT, sku TEXT, url TEXT, ts TEXT, actor TEXT);
    CREATE INDEX idx_pub_asset ON asset_publications(asset_id); CREATE INDEX idx_pub_product ON asset_publications(product_id);`),
}]);

// ---------------------------------------------------------------- watermark templates
export const POSITIONS = { br: '右下', bl: '左下', tr: '右上', tl: '左上', center: '居中', tile: '平铺' };
const GRAVITY = { br: 'southeast', bl: 'southwest', tr: 'northeast', tl: 'northwest', center: 'centre' };
export const watermarks = () => C.getSetting('watermarks', []);
export const watermarkUse = () => ({ preview: null, publish: null, ...(C.getSetting('watermark_use') || {}) });
export function saveWatermark(t) {
  const list = watermarks();
  const w = {
    id: t.id || randomUUID().slice(0, 8), name: String(t.name || '').trim(), type: t.type === 'image' ? 'image' : 'text', text: String(t.text || '').slice(0, 60), assetId: String(t.assetId || ''),
    position: POSITIONS[t.position] ? t.position : 'br', opacity: Number(t.opacity), scale: Number(t.scale), color: /^#[0-9a-f]{6}$/i.test(t.color || '') ? t.color : '#ffffff',
  };
  if (!w.name) throw new Error('水印名称必填');
  if (w.type === 'text' && !w.text.trim()) throw new Error('文字水印需要填写文字');
  if (w.type === 'image') { const a = A.getAsset(w.assetId); if (!a || a.kind !== 'image') throw new Error('图片水印需要选择素材库中的一张图片（建议透明 PNG）'); }
  if (!(w.opacity >= 0.05 && w.opacity <= 1)) throw new Error('透明度须在 0.05–1 之间');
  if (!(w.scale >= 0.05 && w.scale <= 0.8)) throw new Error('大小须在 0.05–0.8 之间（占图片宽度的比例）');
  C.setSetting('watermarks', [...list.filter((x) => x.id !== w.id), w]);
  return w;
}
export function deleteWatermark(id) {
  C.setSetting('watermarks', watermarks().filter((x) => x.id !== id));
  const use = watermarkUse();
  C.setSetting('watermark_use', { preview: use.preview === id ? null : use.preview, publish: use.publish === id ? null : use.publish });
}
export function setWatermarkUse({ preview = null, publish = null }) {
  for (const id of [preview, publish]) if (id && !watermarks().some((w) => w.id === id)) throw new Error('水印模板不存在');
  C.setSetting('watermark_use', { preview: preview || null, publish: publish || null });
}
const escXml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
/** Apply a watermark template to an image buffer. */
export async function applyWatermark(buf, w) {
  if (!w) return buf;
  const img = sharp(buf).rotate();
  const { width, height } = await sharp(await img.toBuffer()).metadata();
  const markW = Math.max(16, Math.round(width * w.scale));
  let mark;
  if (w.type === 'text') {
    const size = Math.max(10, Math.round(markW / Math.max(4, w.text.length * 0.62)));
    const h = Math.round(size * 1.4);
    mark = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${markW}" height="${h}"><text x="50%" y="${Math.round(size * 1.05)}" text-anchor="middle" font-family="DejaVu Sans, WenQuanYi Micro Hei, sans-serif" font-size="${size}" font-weight="700" fill="${w.color}" fill-opacity="${w.opacity}" stroke="#000" stroke-opacity="${w.opacity * 0.35}" stroke-width="${Math.max(1, size / 24)}">${escXml(w.text)}</text></svg>`);
  } else {
    const a = A.getAsset(w.assetId);
    const f = a && A.officialFile(a);
    if (!f || !existsSync(f)) return buf;
    const png = await sharp(readFileSync(f)).resize(markW).ensureAlpha().png().toBuffer();
    const m = await sharp(png).metadata();
    mark = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${m.width}" height="${m.height}"><image width="${m.width}" height="${m.height}" opacity="${w.opacity}" xlink:href="data:image/png;base64,${png.toString('base64')}"/></svg>`);
  }
  const margin = Math.round(Math.min(width, height) * 0.03);
  const markPng = await sharp(mark).png().toBuffer();
  const padded = w.position === 'tile' || w.position === 'center' ? markPng : await sharp(markPng).extend({ top: margin, bottom: margin, left: margin, right: margin, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  const meta = await sharp(padded).metadata();
  if (meta.width > width || meta.height > height) return buf; // image too small for this watermark
  return img.composite([w.position === 'tile' ? { input: padded, tile: true, blend: 'over' } : { input: padded, gravity: GRAVITY[w.position], blend: 'over' }]).toBuffer();
}
/** Preview with the preview watermark (cached per template); the original file is never changed. */
export async function watermarkedPreview(id) {
  const use = watermarkUse();
  const w = watermarks().find((x) => x.id === use.preview);
  const p = A.previewFile(id);
  if (!w || !p || !p.endsWith('.webp')) return p;
  const out = join(dirname(p), `preview-wm-${w.id}-${Buffer.from(JSON.stringify(w)).toString('base64url').slice(-12)}.webp`);
  if (!existsSync(out)) writeFileSync(out, await sharp(await applyWatermark(readFileSync(p), w)).webp({ quality: 82 }).toBuffer());
  return out;
}

// ---------------------------------------------------------------- pre-listing checks
/** Checks before an image goes to the website: format, size, main-image rules. errors block, warnings inform. */
export async function preflight(asset, position) {
  const errors = [], warnings = [];
  if (asset.kind !== 'image') errors.push(`${asset.original_name}：只有图片可以上架（视频和源文件请在素材库中使用）`);
  else {
    const min = Math.min(asset.width, asset.height);
    if (min < 500) errors.push(`${asset.original_name}：尺寸 ${asset.width}×${asset.height} 太小，至少 500 px`);
    else if (min < 800) warnings.push(`${asset.original_name}：尺寸 ${asset.width}×${asset.height}，建议至少 800×800`);
    if (position === 'main') {
      if (!asset.auto_tags.includes('白底图') && !asset.auto_tags.includes('透明图')) warnings.push(`${asset.original_name}：主图建议使用白底图`);
      if (Math.abs(asset.width - asset.height) / Math.max(asset.width, asset.height) > 0.05) warnings.push(`${asset.original_name}：主图建议使用 1:1 方图`);
    }
    if (position === 'detail' && asset.width < 750) warnings.push(`${asset.original_name}：详情图宽度建议不小于 790 px`);
    const cc = (() => { try { return asset.compliance ? JSON.parse(asset.compliance) : null; } catch { return null; } })();
    if (cc && !cc.ok && cc.version === asset.official) warnings.push(`${asset.original_name}：AI 合规检查发现 ${cc.issues.length} 个问题（${cc.issues.map((i) => i.detail).join('；').slice(0, 120)}）`);
  }
  return { errors, warnings };
}

/** Web copy: rotate, fit within maxEdge, JPEG (PNG kept when transparent), publish watermark. Returns /media URL. */
async function webCopy(asset) {
  const s = A.settings();
  const src = readFileSync(A.officialFile(asset));
  let buf = await sharp(src).rotate().resize(s.maxEdge, s.maxEdge, { fit: 'inside', withoutEnlargement: true }).toBuffer();
  const w = watermarks().find((x) => x.id === watermarkUse().publish);
  if (w) buf = await applyWatermark(buf, w);
  const transparent = asset.auto_tags.includes('透明图');
  buf = transparent ? await sharp(buf).png({ compressionLevel: 9 }).toBuffer() : await sharp(buf).flatten({ background: '#fff' }).jpeg({ quality: s.quality, mozjpeg: true }).toBuffer();
  return C.saveMedia(buf, asset.original_name);
}

/**
 * List images on a product. position: main | gallery | detail | sku. For main, index = place among the images (0 = first);
 * replace = replace the image at that place instead of inserting. Returns { urls, warnings }.
 */
export async function publishToProduct({ productId, assetIds, position = 'gallery', index = 0, replace = false, sku = '' }) {
  const p = C.getProduct(productId);
  if (!p) throw new Error('商品不存在');
  if (!['main', 'gallery', 'detail', 'sku'].includes(position)) throw new Error('上架位置无效');
  const assets = assetIds.map((id) => A.getAsset(id)).filter((a) => a && a.status === 'active');
  if (!assets.length) throw new Error('请选择要上架的素材');
  if (position === 'sku' && (!sku || !C.skusFor(productId).some((s) => s.sku === sku))) throw new Error('请选择该商品的一个 SKU');
  if (position === 'sku' && assets.length > 1) throw new Error('SKU 图一次只能选一张');
  const errors = [], warnings = [];
  for (const a of assets) { const r = await preflight(a, position); errors.push(...r.errors); warnings.push(...r.warnings); }
  if (errors.length) throw Object.assign(new Error(errors.join('；')), { errors, warnings });
  const urls = [];
  for (const a of assets) urls.push(await webCopy(a));
  if (position === 'sku') C.setSkuImage(sku, urls[0]);
  else {
    const images = [...(p.images || [])], details = [...(p.detailImages || [])];
    if (position === 'main') { const i = Math.max(0, Math.min(Number(index) || 0, images.length)); images.splice(i, replace ? urls.length : 0, ...urls); }
    if (position === 'gallery') images.push(...urls);
    if (position === 'detail') details.push(...urls);
    C.saveProduct({ id: productId, images, detailImages: details }, {});
  }
  const ts = new Date().toISOString(), actor = actorName('system');
  const st = db.prepare('INSERT INTO asset_publications (asset_id, version, product_id, position, sku, url, ts, actor) VALUES (?,?,?,?,?,?,?,?)');
  assets.forEach((a, i) => st.run(a.id, a.official, productId, position, sku || null, urls[i], ts, actor));
  return { urls, warnings };
}
export const publicationsOf = (assetId) => db.prepare('SELECT * FROM asset_publications WHERE asset_id = ? ORDER BY id DESC').all(assetId);
export const publicationsFor = (productId) => db.prepare('SELECT * FROM asset_publications WHERE product_id = ? ORDER BY id DESC LIMIT 100').all(productId);
