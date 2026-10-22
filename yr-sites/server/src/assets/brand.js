// Brand assets (品牌资产) and layout templates (排版模板) for designers. The brand kit holds the logos (from the asset
// library), colours, fonts, slogans and usage rules of this site, with a colour-contrast check. Layout templates turn a
// product into a ready image — a main image with a badge, a promotion banner, a selling-point card, a social square —
// in the brand's colours, fonts and logo; results are saved to the product's folder in the asset library, one by one or
// as a batch in the task center. Built-in templates can be copied and edited (layers as JSON) into custom ones.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { db } from '../db.js';
import { config } from '../config.js';
import * as C from '../catalog/store.js';
import * as A from './store.js';
import { registerHandler, createTask } from '../tasks.js';
import { publicationsFor } from './publish.js'; // also creates the asset_publications table

// ---------------------------------------------------------------- brand kit
export const COLOR_KEYS = { primary: '主色', secondary: '辅助色', accent: '强调色', text: '文字色', background: '背景色' };
export const LOGO_KEYS = { primary: '标准 Logo', reversed: '反白 Logo（深色背景用）', icon: '图标 / 角标' };
export const FONTS = ['Inter', 'DejaVu Sans', 'WenQuanYi Micro Hei', 'Noto Sans CJK SC', 'Source Han Sans SC', 'Arial', 'Helvetica', 'Georgia'];
const HEX = /^#[0-9a-f]{6}$/i;
const DEFAULT_KIT = () => ({ name: config.profile.brand, slogan: { en: '', zh: '' }, colors: { primary: '#0b3d91', secondary: '#f5a623', accent: '#c62828', text: '#1b2430', background: '#ffffff' }, fonts: { heading: 'Inter', body: 'Inter' }, logos: { primary: '', reversed: '', icon: '' }, rules: '' });

export function brandKit() {
  const d = DEFAULT_KIT(), s = C.getSetting('brand_kit', {}) || {};
  return { ...d, ...s, slogan: { ...d.slogan, ...(s.slogan || {}) }, colors: { ...d.colors, ...(s.colors || {}) }, fonts: { ...d.fonts, ...(s.fonts || {}) }, logos: { ...d.logos, ...(s.logos || {}) } };
}
export function saveBrandKit(input) {
  const cur = brandKit();
  const kit = {
    name: String(input.name ?? cur.name).trim().slice(0, 80),
    slogan: { en: String(input.slogan?.en ?? cur.slogan.en).trim().slice(0, 120), zh: String(input.slogan?.zh ?? cur.slogan.zh).trim().slice(0, 60) },
    colors: { ...cur.colors }, fonts: { ...cur.fonts }, logos: { ...cur.logos },
    rules: String(input.rules ?? cur.rules).slice(0, 4000),
  };
  if (!kit.name) throw new Error('品牌名称必填');
  for (const k of Object.keys(COLOR_KEYS)) {
    const v = input.colors?.[k];
    if (v == null) continue;
    if (!HEX.test(String(v).trim())) throw new Error(`${COLOR_KEYS[k]}：须为 #RRGGBB 格式的颜色`);
    kit.colors[k] = String(v).trim().toLowerCase();
  }
  for (const k of ['heading', 'body']) {
    const v = input.fonts?.[k];
    if (v == null) continue;
    if (!/^[\w \-]{1,40}$/.test(String(v).trim())) throw new Error('字体名称只能包含字母、数字、空格和连字符');
    kit.fonts[k] = String(v).trim();
  }
  for (const k of Object.keys(LOGO_KEYS)) {
    const v = input.logos?.[k];
    if (v == null) continue;
    const id = String(v).trim();
    if (id) { const a = A.getAsset(id); if (!a || a.kind !== 'image' || a.status !== 'active') throw new Error(`${LOGO_KEYS[k]}：请填写素材库中一张图片的编号（建议透明 PNG）`); }
    kit.logos[k] = id;
  }
  C.setSetting('brand_kit', kit);
  return kit;
}

/** WCAG contrast ratio of two #rrggbb colours (1–21). */
export function contrast(a, b) {
  const lum = (hex) => { const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * bl; };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
}
/** Readability of the brand colour pairs used by the templates (4.5 for body text, 3 for large headlines). */
export function contrastChecks(kit = brandKit()) {
  const c = kit.colors;
  return [
    ['文字色 / 背景色', c.text, c.background, 4.5], ['白字 / 主色', '#ffffff', c.primary, 3], ['文字色 / 辅助色（按钮）', c.text, c.secondary, 4.5], ['白字 / 强调色（角标）', '#ffffff', c.accent, 3],
  ].map(([pair, fg, bg, min]) => { const ratio = contrast(fg, bg); return { pair, fg, bg, ratio, min, ok: ratio >= min }; });
}

// ---------------------------------------------------------------- templates
export const KINDS = { main: '主图', banner: '横幅', detail: '详情图', social: '社媒图' };
export const FIELDS = { title: '标题', subtitle: '副标题', badge: '角标文字', price: '价格', cta: '按钮文字', highlights: '卖点（每行一条）', slogan: '品牌口号' };
export const BUILTIN = [
  { id: 'main-badge', name: '主图 + 品牌角标', kind: 'main', width: 1000, height: 1000, background: 'background', builtin: true, layers: [
    { type: 'image', slot: 'product', x: 60, y: 60, w: 880, h: 880 },
    { type: 'logo', variant: 'icon', x: 40, y: 40, w: 140, h: 80 },
    { type: 'circle', cx: 860, cy: 860, r: 105, color: 'accent' },
    { type: 'text', field: 'badge', x: 770, y: 840, w: 180, size: 30, weight: 700, color: '#ffffff', align: 'center', lines: 2 },
  ] },
  { id: 'promo-banner', name: '促销横幅', kind: 'banner', width: 1920, height: 600, background: 'primary', builtin: true, layers: [
    { type: 'image', slot: 'product', x: 1180, y: 40, w: 640, h: 520 },
    { type: 'logo', variant: 'reversed', x: 100, y: 60, w: 220, h: 70 },
    { type: 'text', field: 'title', x: 100, y: 230, w: 960, size: 72, weight: 800, color: '#ffffff', lines: 2, font: 'heading' },
    { type: 'text', field: 'subtitle', x: 100, y: 330, w: 960, size: 34, color: '#ffffff', lines: 1 },
    { type: 'text', field: 'price', x: 100, y: 420, w: 600, size: 40, weight: 700, color: 'secondary', lines: 1 },
    { type: 'rect', x: 100, y: 460, w: 300, h: 76, radius: 38, color: 'secondary' },
    { type: 'text', field: 'cta', x: 100, y: 510, w: 300, size: 30, weight: 700, color: 'text', align: 'center', lines: 1 },
  ] },
  { id: 'feature-card', name: '卖点图', kind: 'detail', width: 1000, height: 1000, background: 'background', builtin: true, layers: [
    { type: 'image', slot: 'product', x: 150, y: 40, w: 700, h: 520 },
    { type: 'text', field: 'title', x: 80, y: 630, w: 840, size: 48, weight: 800, color: 'text', align: 'center', lines: 1, font: 'heading' },
    { type: 'bullets', field: 'highlights', x: 120, y: 720, w: 780, size: 34, color: 'text', dot: 'accent', gap: 82, lines: 3 },
  ] },
  { id: 'social-square', name: '社媒方图', kind: 'social', width: 1080, height: 1080, background: 'primary', builtin: true, layers: [
    { type: 'rect', x: 60, y: 60, w: 960, h: 760, radius: 32, color: '#ffffff' },
    { type: 'image', slot: 'product', x: 120, y: 110, w: 840, h: 660 },
    { type: 'logo', variant: 'reversed', x: 60, y: 860, w: 240, h: 80 },
    { type: 'text', field: 'title', x: 60, y: 1000, w: 960, size: 52, weight: 800, color: '#ffffff', lines: 1, font: 'heading' },
    { type: 'text', field: 'slogan', x: 340, y: 915, w: 680, size: 30, color: 'secondary', align: 'right', lines: 1 },
  ] },
];
const LAYER_TYPES = ['image', 'logo', 'rect', 'circle', 'text', 'bullets'];
export const templates = () => [...BUILTIN, ...(C.getSetting('layout_templates', []) || [])];
export const getTemplate = (id) => templates().find((t) => t.id === id) || null;

const isColor = (v) => Object.hasOwn(COLOR_KEYS, v) || HEX.test(String(v));
/** Checks a template (custom ones come from a JSON editor). Returns the cleaned template or throws with every problem. */
export function validateTemplate(t) {
  const errs = [];
  const num = (v, min, max, what) => { const n = Number(v); if (!Number.isFinite(n) || n < min || n > max) errs.push(`${what}：须在 ${min}–${max} 之间`); return n; };
  const out = { id: String(t.id || ''), name: String(t.name || '').trim().slice(0, 40), kind: KINDS[t.kind] ? t.kind : 'detail', width: num(t.width, 100, 4000, '宽度'), height: num(t.height, 100, 4000, '高度'), background: t.background ?? 'background', layers: [] };
  if (!out.name) errs.push('模板名称必填');
  if (!isColor(out.background)) errs.push('背景色须为品牌色名称（primary / secondary / accent / text / background）或 #RRGGBB');
  if (!Array.isArray(t.layers) || !t.layers.length) errs.push('至少需要一个图层');
  else if (t.layers.length > 30) errs.push('图层不能超过 30 个');
  for (const [i, l] of (Array.isArray(t.layers) ? t.layers.slice(0, 30) : []).entries()) {
    const at = `第 ${i + 1} 个图层`;
    if (!LAYER_TYPES.includes(l?.type)) { errs.push(`${at}：类型须为 ${LAYER_TYPES.join(' / ')}`); continue; }
    const L = { type: l.type };
    const W = out.width || 4000, H = out.height || 4000;
    if (l.type === 'circle') { L.cx = num(l.cx, 0, W, `${at} cx`); L.cy = num(l.cy, 0, H, `${at} cy`); L.r = num(l.r, 1, Math.max(W, H), `${at} r`); } else {
      L.x = num(l.x, 0, W, `${at} x`); L.y = num(l.y, 0, H, `${at} y`); L.w = num(l.w, 1, W, `${at} w`);
      if (l.type !== 'text' && l.type !== 'bullets') L.h = num(l.h, 1, H, `${at} h`);
    }
    if (['rect', 'circle', 'text', 'bullets'].includes(l.type)) { L.color = l.color ?? 'text'; if (!isColor(L.color)) errs.push(`${at}：颜色无效`); }
    if (l.type === 'rect') L.radius = num(l.radius ?? 0, 0, 2000, `${at} 圆角`);
    if (l.type === 'image') L.slot = 'product';
    if (l.type === 'logo') { L.variant = LOGO_KEYS[l.variant] ? l.variant : 'primary'; }
    if (l.type === 'text' || l.type === 'bullets') {
      if (!FIELDS[l.field]) errs.push(`${at}：文字字段须为 ${Object.keys(FIELDS).join(' / ')}`);
      L.field = l.field; L.size = num(l.size ?? 32, 8, 400, `${at} 字号`); L.weight = [400, 500, 600, 700, 800].includes(Number(l.weight)) ? Number(l.weight) : 400;
      L.align = ['left', 'center', 'right'].includes(l.align) ? l.align : 'left'; L.lines = num(l.lines ?? 1, 1, 10, `${at} 行数`); L.font = l.font === 'heading' ? 'heading' : 'body';
      if (l.type === 'bullets') { L.dot = l.dot ?? 'accent'; if (!isColor(L.dot)) errs.push(`${at}：圆点颜色无效`); L.gap = num(l.gap ?? L.size * 2, 10, 1000, `${at} 行距`); }
    }
    out.layers.push(L);
  }
  if (errs.length) throw Object.assign(new Error(errs.slice(0, 8).join('；')), { errors: errs });
  return out;
}
export function saveTemplate(t) {
  if (BUILTIN.some((b) => b.id === t.id)) throw new Error('内置模板不能修改，请先复制为自定义模板');
  const clean = validateTemplate({ ...t, id: t.id || `tpl-${randomUUID().slice(0, 8)}` });
  const list = C.getSetting('layout_templates', []) || [];
  C.setSetting('layout_templates', [...list.filter((x) => x.id !== clean.id), clean]);
  return clean;
}
export function copyTemplate(id) {
  const t = getTemplate(id);
  if (!t) throw new Error('模板不存在');
  const { builtin, ...rest } = t; // eslint-disable-line no-unused-vars
  return saveTemplate({ ...rest, id: '', name: `${t.name} · 副本`.slice(0, 40) });
}
export function deleteTemplate(id) {
  if (BUILTIN.some((b) => b.id === id)) throw new Error('内置模板不能删除');
  C.setSetting('layout_templates', (C.getSetting('layout_templates', []) || []).filter((x) => x.id !== id));
}

// ---------------------------------------------------------------- rendering
const CJK = /[\u3400-\u9fff\uff00-\uffef\u3000-\u303f]/;
const XML = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
/** Rough text width (no font metrics on the server): CJK ≈ 1 em, Latin ≈ 0.56 em (bold a bit wider). */
export const textWidth = (s, size, weight = 400) => [...String(s)].reduce((a, ch) => a + (CJK.test(ch) ? 1 : ch === ' ' ? 0.3 : /[A-Z0-9]/.test(ch) ? 0.64 : 0.54), 0) * size * (weight >= 700 ? 1.06 : 1);
/** Breaks text into at most `lines` lines that fit `width` (words for Latin, characters for Chinese); the last one gets "…". */
export function wrap(text, width, size, weight, lines) {
  const tokens = String(text || '').replace(/\s+/g, ' ').trim().match(/[\u3400-\u9fff\uff00-\uffef\u3000-\u303f]|[^\s\u3400-\u9fff\uff00-\uffef\u3000-\u303f]+|\s/g) || [];
  const out = [];
  let cur = '';
  for (const tk of tokens) {
    const next = cur + tk;
    if (!cur.trim() || textWidth(next.trimEnd(), size, weight) <= width) { cur = next; continue; }
    out.push(cur.trim()); cur = tk.trim();
    if (out.length === lines) break;
  }
  if (out.length < lines && cur.trim()) out.push(cur.trim());
  const used = out.join(' ').replace(/\s/g, '').length, all = tokens.join('').replace(/\s/g, '').length;
  if (used < all && out.length) { let last = out[out.length - 1]; while (last && textWidth(`${last}…`, size, weight) > width) last = last.slice(0, -1); out[out.length - 1] = `${last.trimEnd()}…`; }
  return out;
}

/** Default texts for a product in a language; any of them can be overridden. */
export function productFields(p, lang = 'en', kit = brandKit()) {
  const zh = lang === 'zh';
  const skus = C.skusFor(p.id).filter((s) => s.price != null);
  const low = skus.length ? Math.min(...skus.map((s) => s.price)) : p.priceBands?.[0]?.low;
  const cur = config.catalog.currency || 'USD';
  const years = String(p.warranty || '').match(/\d+/)?.[0];
  return {
    title: (zh && p.nameZh) || p.name, subtitle: (zh && p.summaryZh) || p.summary || '', slogan: kit.slogan[lang] || kit.slogan.en || '',
    badge: years ? (zh ? `${years} 年质保` : `${years}-YEAR WARRANTY`) : (zh ? '工厂直供' : 'FACTORY DIRECT'),
    price: low != null && config.catalog.priceDisplay !== 'hidden' ? (zh ? `${cur} ${low} 起` : `From ${cur} ${low}`) : '',
    cta: zh ? '立即询价' : 'Get a quote', highlights: ((zh && p.highlightsZh) || p.highlights || []).slice(0, 5),
  };
}

/** The product picture: the chosen asset, else the last one listed as main image, else the product's first image, else its main-image folder. */
export function productImage(productId, assetId = '') {
  if (assetId) { const a = A.getAsset(assetId); if (a && a.kind === 'image' && a.status === 'active') return readFileSync(A.officialFile(a)); throw new Error('所选素材不是可用的图片'); }
  const pub = publicationsFor(productId).find((x) => x.position === 'main');
  const a = pub && A.getAsset(pub.asset_id);
  if (a && a.status === 'active') return readFileSync(A.officialFile(a));
  const url = C.getProduct(productId)?.images?.[0];
  if (url && /^\/media\//.test(url)) { const f = join(C.mediaDir(), url.replace(/^\/media\//, '')); if (existsSync(f)) return readFileSync(f); }
  // oldest image of the product that is not itself a template result
  const row = db.prepare("SELECT id FROM assets WHERE product_id = ? AND kind = 'image' AND status = 'active' AND tags NOT LIKE '%排版模板%' ORDER BY created_at LIMIT 1").get(productId);
  const lib = row && A.getAsset(row.id);
  return lib ? readFileSync(A.officialFile(lib)) : null;
}

async function placeholder(w, h, label, kit) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${Math.min(w, h) * 0.04}" fill="#eef1f4"/><text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" font-family="${XML(kit.fonts.body)}, DejaVu Sans, sans-serif" font-size="${Math.round(Math.min(w, h) * 0.07)}" fill="#8a96a3">${XML(label)}</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * Renders a template for a product: { template id, productId, lang, fields (overrides), assetId (picture) } → PNG buffer.
 * Missing logo or picture does not fail: the logo is left out and the picture becomes a grey placeholder (reported in warnings).
 */
export async function render({ templateId, template = null, productId, lang = 'en', fields = {}, assetId = '' }) {
  const t = template ? validateTemplate(template) : getTemplate(templateId);
  if (!t) throw new Error('模板不存在');
  const p = C.getProduct(productId);
  if (!p) throw new Error('商品不存在');
  const kit = brandKit();
  const col = (v) => (Object.hasOwn(COLOR_KEYS, v) ? kit.colors[v] : v);
  const f = { ...productFields(p, lang, kit) };
  for (const [k, v] of Object.entries(fields || {})) if (FIELDS[k] && v != null && String(v).trim() !== '') f[k] = k === 'highlights' ? (Array.isArray(v) ? v : String(v).split(/\r?\n/)).map((x) => String(x).trim()).filter(Boolean) : String(v);
  const warnings = [];
  const pic = productImage(productId, assetId);
  if (!pic) warnings.push('这个商品还没有图片，已用占位图（可以选择素材库中的图片）');
  const comps = [];
  let svg = [];
  const flush = () => { if (svg.length) { comps.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${t.width}" height="${t.height}">${svg.join('')}</svg>`), left: 0, top: 0 }); svg = []; } };
  const fam = (l) => `${XML(l.font === 'heading' ? kit.fonts.heading : kit.fonts.body)}, Inter, DejaVu Sans, WenQuanYi Micro Hei, Noto Sans CJK SC, sans-serif`;
  const textSvg = (str, x, y, w, l, colour) => {
    const anchor = { left: 'start', center: 'middle', right: 'end' }[l.align];
    const ax = l.align === 'center' ? x + w / 2 : l.align === 'right' ? x + w : x;
    return wrap(str, w, l.size, l.weight, l.lines).map((line, i) => `<text x="${ax}" y="${y + i * l.size * 1.2}" text-anchor="${anchor}" font-family="${fam(l)}" font-size="${l.size}" font-weight="${l.weight}" fill="${col(colour)}">${XML(line)}</text>`).join('');
  };
  for (const l of t.layers) {
    if (l.type === 'image' || l.type === 'logo') {
      let buf = null;
      if (l.type === 'image') buf = pic ? await sharp(pic).rotate().resize(Math.round(l.w), Math.round(l.h), { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer() : await placeholder(Math.round(l.w), Math.round(l.h), f.title, kit);
      else {
        const id = kit.logos[l.variant] || kit.logos.primary;
        const a = id && A.getAsset(id);
        if (!a || a.status !== 'active') { warnings.push(`品牌资产里没有设置：${LOGO_KEYS[l.variant]}，已跳过`); continue; }
        buf = await sharp(readFileSync(A.officialFile(a))).resize(Math.round(l.w), Math.round(l.h), { fit: 'inside' }).png().toBuffer();
      }
      flush();
      comps.push({ input: buf, left: Math.round(l.x), top: Math.round(l.y) });
    } else if (l.type === 'rect') svg.push(`<rect x="${l.x}" y="${l.y}" width="${l.w}" height="${l.h}" rx="${l.radius}" fill="${col(l.color)}"/>`);
    else if (l.type === 'circle') svg.push(`<circle cx="${l.cx}" cy="${l.cy}" r="${l.r}" fill="${col(l.color)}"/>`);
    else if (l.type === 'text') { if (f[l.field]) svg.push(textSvg(Array.isArray(f[l.field]) ? f[l.field].join(' · ') : f[l.field], l.x, l.y, l.w, l, l.color)); }
    else if (l.type === 'bullets') {
      const items = (Array.isArray(f[l.field]) ? f[l.field] : String(f[l.field] || '').split(/\r?\n/)).filter(Boolean).slice(0, l.lines);
      items.forEach((it, i) => { const y = l.y + i * l.gap; svg.push(`<circle cx="${l.x + l.size * 0.35}" cy="${y - l.size * 0.35}" r="${l.size * 0.22}" fill="${col(l.dot)}"/>`, textSvg(it, l.x + l.size * 1.1, y, l.w - l.size * 1.1, { ...l, lines: 1, align: 'left' }, l.color)); });
    }
  }
  flush();
  const buf = await sharp({ create: { width: t.width, height: t.height, channels: 4, background: col(t.background) } }).composite(comps).png().toBuffer();
  return { buffer: buf, warnings, template: t, fields: f };
}

/** Render and save into the product's folder in the asset library (main / detail sub-folder by template kind). */
export async function renderToAsset(opts) {
  const r = await render(opts);
  const sub = r.template.kind === 'main' ? '主图' : '详情图';
  const a = await A.ingest(r.buffer, { name: `${r.template.id}-${opts.productId}-${opts.lang || 'en'}.png`, title: `${r.template.name} · ${r.fields.title}`.slice(0, 200), productId: opts.productId, sub, source: 'template', note: `排版模板 ${r.template.name}`, tags: ['排版模板', r.template.name] });
  return { asset: a, warnings: r.warnings };
}
registerHandler('asset.template', {
  label: '排版模板批量生成',
  run: async (productId, { templateId, lang = 'en', fields = {} }) => {
    const { asset, warnings } = await renderToAsset({ templateId, productId, lang, fields });
    return { text: `已生成 ${asset.original_name}${warnings.length ? `（${warnings.join('；')}）` : ''}`, link: `/admin/assets/${asset.id}` };
  },
});
/** Queue one template for several products (texts from each product; only shared overrides such as the badge apply). */
export function queueTemplate(templateId, productIds, { lang = 'en', fields = {} } = {}) {
  const t = getTemplate(templateId);
  if (!t) throw new Error('模板不存在');
  const items = [...new Set(productIds)].map((id) => C.getProduct(id)).filter(Boolean).map((p) => ({ key: p.id, label: p.name }));
  if (!items.length) throw new Error('请选择商品');
  const shared = Object.fromEntries(Object.entries(fields).filter(([k, v]) => ['badge', 'cta', 'slogan', 'price', 'subtitle'].includes(k) && String(v || '').trim()));
  return createTask({ kind: 'asset.template', title: `${t.name} · ${items.length} 个商品`, items, params: { templateId, lang, fields: shared } });
}
