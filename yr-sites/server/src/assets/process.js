// Image processing (美工修图). Local operations run with sharp, no external service: resize to size presets, white
// background, canvas extension, colour matching / normalising, repair (denoise, sharpen, upscale), mask retouching.
// AI operations (cutout, background replacement) call an image service (remove.bg or any service with the same
// contract); the new background itself is composited locally. Every operation saves a new version of the asset (so it
// can be rolled back) unless "save as a new asset" is chosen.
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import * as C from '../catalog/store.js';
import * as A from './store.js';
import { registerHandler, createTask } from '../tasks.js';

// ---------------------------------------------------------------- size presets (系统默认，可自定义)
export const DEFAULT_PRESETS = [
  { id: 'main', name: '主图 / SKU 图', width: 800, height: 800 },
  { id: 'detail', name: '详情页宽度', width: 790, height: 0 },
  { id: 'hd-main', name: '高清主图', width: 2000, height: 2000 },
  { id: 'banner', name: '首页横幅', width: 1920, height: 640 },
  { id: 'social', name: '社媒方图', width: 1080, height: 1080 },
];
export const presets = () => C.getSetting('size_presets') || DEFAULT_PRESETS;
export function savePreset({ id, name, width, height }) {
  const w = Number(width), h = Number(height || 0);
  const n = String(name || '').trim();
  if (!n) throw new Error('尺寸名称必填');
  if (!(Number.isInteger(w) && w >= 50 && w <= 8000)) throw new Error('宽度须为 50–8000 的整数');
  if (!(Number.isInteger(h) && h >= 0 && h <= 8000)) throw new Error('高度须为 0–8000 的整数（0 = 按比例）');
  const key = String(id || '').trim() || `p${Date.now().toString(36)}`;
  C.setSetting('size_presets', [...presets().filter((p) => p.id !== key), { id: key, name: n.slice(0, 40), width: w, height: h }]);
  return key;
}
export function deletePreset(id) { C.setSetting('size_presets', presets().filter((p) => p.id !== id)); }

// ---------------------------------------------------------------- local operations (buffer → buffer)
const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };
const hex = (c, d = '#ffffff') => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : d);
const rgb = (h) => ({ r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16), alpha: 1 });

/** Resize to a preset. mode: contain (pad, default), cover (crop to fill), inside (keep ratio). height 0 = proportional. */
export async function resize(buf, { width, height = 0, mode = 'contain', background = '#ffffff' }) {
  const img = sharp(buf).rotate();
  if (!height) return img.resize({ width, withoutEnlargement: false }).toBuffer();
  return img.resize(width, height, { fit: { contain: 'contain', cover: 'cover', inside: 'inside' }[mode] || 'contain', background: rgb(hex(background)), position: 'centre' }).toBuffer();
}
/** Transparent / light background → solid colour, with an even margin so the product sits centred. */
export async function whiteBackground(buf, { margin = 0.06, background = '#ffffff' } = {}) {
  const m = await sharp(buf).metadata();
  const trimmed = await sharp(buf).rotate().trim({ background: m.hasAlpha ? { r: 0, g: 0, b: 0, alpha: 0 } : '#ffffff', threshold: 12 }).toBuffer().catch(() => buf);
  const t = await sharp(trimmed).metadata();
  const side = Math.round(Math.max(t.width, t.height) * (1 + margin * 2));
  return sharp(trimmed).flatten({ background: rgb(hex(background)) })
    .extend({ top: Math.floor((side - t.height) / 2), bottom: Math.ceil((side - t.height) / 2), left: Math.floor((side - t.width) / 2), right: Math.ceil((side - t.width) / 2), background: rgb(hex(background)) })
    .toBuffer();
}
/** Extend the canvas to a ratio (e.g. 1:1 or 3:4). fill: a colour, or 'blur' (blurred, stretched copy behind). */
export async function extendCanvas(buf, { ratio = '1:1', fill = 'blur' } = {}) {
  const [rw, rh] = String(ratio).split(':').map(Number);
  if (!(rw > 0 && rh > 0)) throw new Error('比例格式应为 宽:高，如 1:1');
  const img = sharp(buf).rotate();
  const m = await sharp(await img.toBuffer()).metadata();
  let W = m.width, H = Math.round(m.width * rh / rw);
  if (H < m.height) { H = m.height; W = Math.round(m.height * rw / rh); }
  const left = Math.floor((W - m.width) / 2), top = Math.floor((H - m.height) / 2);
  if (fill === 'blur') {
    const bg = await sharp(buf).rotate().resize(W, H, { fit: 'cover' }).blur(Math.max(8, Math.round(Math.max(W, H) / 40))).modulate({ brightness: 1.05 }).toBuffer();
    return sharp(bg).composite([{ input: await img.toBuffer(), left, top }]).toBuffer();
  }
  return img.extend({ top, bottom: H - m.height - top, left, right: W - m.width - left, background: rgb(hex(fill)) }).toBuffer();
}
/** Colour: adjust brightness / saturation / contrast, or match the average colour and contrast of a reference image. */
export async function adjustColour(buf, { brightness = 1, saturation = 1, contrast = 1, reference = null, normalise = false } = {}) {
  let img = sharp(buf).rotate();
  if (normalise) img = img.normalise();
  if (reference) {
    const [s, r] = await Promise.all([sharp(buf).stats(), sharp(reference).stats()]);
    const a = [], b = [];
    for (let i = 0; i < 3; i++) { const k = (r.channels[i].stdev || 1) / (s.channels[i].stdev || 1); const kk = Math.max(0.5, Math.min(2, k)); a.push(kk); b.push(r.channels[i].mean - s.channels[i].mean * kk); }
    img = sharp(await img.removeAlpha().toBuffer()).linear(a, b);
  }
  if (brightness !== 1 || saturation !== 1) img = img.modulate({ brightness, saturation });
  if (contrast !== 1) img = img.linear(contrast, 128 * (1 - contrast));
  return img.toBuffer();
}
/** Repair: remove noise (median), sharpen, optional ×2 upscale for low-resolution images. */
export async function repair(buf, { denoise = 3, sharpen = true, upscale = false } = {}) {
  let img = sharp(buf).rotate();
  if (upscale) { const m = await sharp(buf).metadata(); img = img.resize(m.width * 2, m.height * 2, { kernel: 'lanczos3' }); }
  if (denoise) img = img.median(Math.max(1, Math.min(9, Math.round(denoise))));
  if (sharpen) img = img.sharpen({ sigma: 1.1 });
  return img.toBuffer();
}
/**
 * Local mask retouching: mask = white where the blemish is (PNG, any size). The area is replaced by a heavily blurred
 * version of its surroundings — good for dust, small scratches and stray marks on plain backgrounds.
 */
export async function retouch(buf, mask, { strength = 1 } = {}) {
  const m = await sharp(buf).rotate().metadata();
  const base = await sharp(buf).rotate().removeAlpha().toBuffer();
  const blurred = await sharp(base).blur(Math.max(4, Math.round(Math.min(m.width, m.height) / 40 * strength))).toBuffer();
  const alpha = await sharp(mask).resize(m.width, m.height, { fit: 'fill' }).greyscale().blur(2).toColourspace('b-w').raw().toBuffer();
  const patch = await sharp(blurred).joinChannel(alpha, { raw: { width: m.width, height: m.height, channels: 1 } }).png().toBuffer();
  return sharp(base).composite([{ input: patch, blend: 'over' }]).toBuffer();
}

// ---------------------------------------------------------------- AI image service (cutout); background composited here
export const aiImageConfigured = () => Boolean(process.env.IMAGE_AI_KEY);
/** Cutout via remove.bg (or a compatible service: POST multipart image_file → PNG with transparency). */
export async function cutout(buf) {
  if (!aiImageConfigured()) throw new Error('未配置 AI 图片服务（IMAGE_AI_KEY），无法抠图');
  const base = (process.env.IMAGE_AI_BASE_URL || 'https://api.remove.bg').replace(/\/$/, '');
  const fd = new FormData();
  fd.append('image_file', new Blob([buf]), 'image');
  fd.append('size', 'auto');
  fd.append('format', 'png');
  const r = await fetch(`${base}/v1.0/removebg`, { method: 'POST', body: fd, headers: { 'X-Api-Key': process.env.IMAGE_AI_KEY }, signal: AbortSignal.timeout(90000) });
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`AI 抠图失败：HTTP ${r.status} ${t.slice(0, 160)}`); }
  const out = Buffer.from(await r.arrayBuffer());
  if (A.detect(out)?.kind !== 'image') throw new Error('AI 抠图服务返回的不是图片');
  return out;
}
/** Background replacement: cutout, then place the product on a colour or on a background image (scene) from the library. */
export async function replaceBackground(buf, { background = '#ffffff', backgroundImage = null, scale = 0.8, shadow = true } = {}) {
  const cut = await cutout(buf);
  const subject = await sharp(cut).trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } }).toBuffer().catch(() => cut);
  const meta = await sharp(buf).metadata();
  const W = meta.width, H = meta.height;
  const canvas = backgroundImage ? await sharp(backgroundImage).resize(W, H, { fit: 'cover' }).removeAlpha().toBuffer() : await sharp({ create: { width: W, height: H, channels: 3, background: rgb(hex(background)) } }).png().toBuffer();
  const fitted = await sharp(subject).resize(Math.round(W * scale), Math.round(H * scale), { fit: 'inside' }).toBuffer();
  const fm = await sharp(fitted).metadata();
  const left = Math.round((W - fm.width) / 2), top = Math.round((H - fm.height) / 2);
  const layers = [];
  if (shadow) {
    const sh = await sharp({ create: { width: fm.width, height: Math.max(8, Math.round(fm.height * 0.06)), channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.25 } } }).png().toBuffer();
    layers.push({ input: await sharp(sh).blur(6).toBuffer(), left, top: Math.min(H - 8, top + fm.height - Math.round(fm.height * 0.03)) });
  }
  layers.push({ input: fitted, left, top });
  return sharp(canvas).composite(layers).toBuffer();
}

// ---------------------------------------------------------------- apply to an asset
export const OPS = {
  resize: '改尺寸', white: '白底', extend: '扩图', colour: '调色', repair: '修复（去噪 / 锐化 / 放大）', retouch: '局部修图', cutout: 'AI 抠图', background: 'AI 换背景',
};
/** Run one operation on an asset's official version. Returns the updated (or new) asset. */
export async function processAsset(id, op, params = {}, { saveAs = 'version', prompt = null, note = '' } = {}) {
  const a = A.getAsset(id);
  if (!a || a.status !== 'active') throw new Error('素材不存在');
  if (a.kind !== 'image') throw new Error('只有图片可以处理');
  if (!OPS[op]) throw new Error('未知的处理方式');
  const src = readFileSync(A.officialFile(a));
  let out;
  if (op === 'resize') {
    const p = params.preset ? presets().find((x) => x.id === params.preset) : { width: Number(params.width), height: Number(params.height || 0) };
    if (!p || !(p.width > 0)) throw new Error('请选择尺寸');
    out = await resize(src, { width: p.width, height: p.height, mode: params.mode, background: params.background });
    note ||= `改尺寸 ${p.width}×${p.height || '自适应'}`;
  } else if (op === 'white') out = await whiteBackground(src, { margin: Number(params.margin ?? 0.06), background: params.background });
  else if (op === 'extend') out = await extendCanvas(src, { ratio: params.ratio || '1:1', fill: params.fill || 'blur' });
  else if (op === 'colour') {
    const ref = params.referenceId ? A.getAsset(params.referenceId) : null;
    if (params.referenceId && !ref) throw new Error('参考图不存在');
    out = await adjustColour(src, { brightness: Number(params.brightness || 1), saturation: Number(params.saturation || 1), contrast: Number(params.contrast || 1), normalise: Boolean(params.normalise), reference: ref ? readFileSync(A.officialFile(ref)) : null });
  } else if (op === 'repair') out = await repair(src, { denoise: Number(params.denoise ?? 3), sharpen: params.sharpen !== false, upscale: Boolean(params.upscale) });
  else if (op === 'retouch') { if (!params.mask) throw new Error('请先涂抹要修的区域'); out = await retouch(src, params.mask); }
  else if (op === 'cutout') out = await cutout(src);
  else if (op === 'background') {
    const bg = params.backgroundId ? A.getAsset(params.backgroundId) : null;
    if (params.backgroundId && !bg) throw new Error('背景图不存在');
    out = await replaceBackground(src, { background: params.background || '#ffffff', backgroundImage: bg ? readFileSync(A.officialFile(bg)) : null, scale: Number(params.scale || 0.8) });
  }
  // keep the original format family: JPEG stays JPEG (unless transparency was produced), PNG/WebP stay as they are
  const om = await sharp(out).metadata();
  out = om.hasAlpha && op === 'cutout' ? await sharp(out).png().toBuffer() : a.ext === 'jpg' ? await sharp(out).flatten({ background: WHITE }).jpeg({ quality: 92 }).toBuffer() : a.ext === 'webp' ? await sharp(out).webp({ quality: 92 }).toBuffer() : await sharp(out).png().toBuffer();
  const desc = note || OPS[op];
  if (saveAs === 'new' || (op === 'cutout' && a.ext === 'jpg')) {
    return A.ingest(out, { name: a.original_name.replace(/(\.\w+)?$/, `-${op}${om.hasAlpha && op === 'cutout' ? '.png' : '$1'}`), folderId: a.folder_id, tags: [...a.tags, OPS[op]], note: `${desc}（来自 ${a.original_name} v${a.official}）`, source: 'process', prompt });
  }
  return A.addVersion(id, out, { source: 'process', note: desc, prompt });
}

/** One image → several presets, each saved as a new asset in the same folder (批量尺寸转换). */
export async function exportSizes(id, presetIds, { mode = 'contain' } = {}) {
  const a = A.getAsset(id);
  if (!a || a.kind !== 'image') throw new Error('只有图片可以导出尺寸');
  const src = readFileSync(A.officialFile(a));
  const out = [];
  for (const pid of presetIds) {
    const p = presets().find((x) => x.id === pid);
    if (!p) continue;
    const buf = await resize(src, { width: p.width, height: p.height, mode });
    const enc = a.ext === 'png' ? await sharp(buf).png().toBuffer() : await sharp(buf).flatten({ background: WHITE }).jpeg({ quality: 90 }).toBuffer();
    out.push(await A.ingest(enc, { name: a.original_name.replace(/(\.\w+)?$/, `-${p.width}x${p.height || 'auto'}${a.ext === 'png' ? '.png' : '.jpg'}`), folderId: a.folder_id, tags: [...a.tags, p.name], note: `${p.name} ${p.width}×${p.height || '自适应'}（来自 ${a.original_name}）`, source: 'process' }));
  }
  return out;
}

// ---------------------------------------------------------------- batch jobs (任务中心)
export const BATCH_OPS = ['resize', 'white', 'extend', 'colour', 'repair', 'cutout', 'background'];
registerHandler('asset.process', {
  label: '批量图片处理',
  run: async (id, { op, params = {}, saveAs = 'version', prompt = null }) => {
    const a = await processAsset(id, op, params, { saveAs, prompt });
    return a.id === id ? { text: `已生成 v${a.version}`, link: `/admin/assets/${a.id}` } : { text: `已另存为 ${a.original_name}`, link: `/admin/assets/${a.id}` };
  },
});
registerHandler('asset.sizes', {
  label: '批量尺寸导出',
  run: async (id, { presets: ids = [], mode = 'contain' }) => {
    const out = await exportSizes(id, ids, { mode });
    if (!out.length) throw new Error('没有可用的尺寸预设');
    return { text: `已导出 ${out.length} 个尺寸`, link: `/admin/assets/${out[0].id}` };
  },
});
/** Queue a batch over several assets; returns the task id. */
export function queueBatch(ids, { op, params = {}, saveAs = 'version', prompt = null, presetIds = null }) {
  const rows = ids.map((id) => A.getAsset(id)).filter((a) => a && a.status === 'active' && a.kind === 'image');
  if (!rows.length) throw new Error('请勾选图片素材（视频和源文件不能批量处理）');
  const items = rows.map((a) => ({ key: a.id, label: a.title || a.original_name }));
  if (op === 'sizes') {
    const ps = presets().filter((p) => (presetIds || []).includes(p.id));
    if (!ps.length) throw new Error('请选择至少一个尺寸');
    return createTask({ kind: 'asset.sizes', title: `尺寸导出 ${ps.map((p) => p.name).join('、')} · ${rows.length} 张`, items, params: { presets: ps.map((p) => p.id) } });
  }
  if (!BATCH_OPS.includes(op)) throw new Error('这个处理方式不支持批量');
  if ((op === 'cutout' || op === 'background') && !aiImageConfigured()) throw new Error('未配置 AI 图片服务（IMAGE_AI_KEY），无法抠图');
  return createTask({ kind: 'asset.process', title: `${OPS[op]} · ${rows.length} 张`, items, params: { op, params, saveAs, prompt } });
}
