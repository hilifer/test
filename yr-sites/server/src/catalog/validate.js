// Product / category validation and spreadsheet (CSV + XLSX) import/export for the admin product centre.
// Pure functions — no DB, no config — so they are easy to test and reuse.
import { inflateRawSync } from 'node:zlib';

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,39}$/;
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const STATUSES = { draft: '草稿', published: '已上架', archived: '已下架' };

export const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/\s*[|\n]\s*/)).map((s) => String(s).trim()).filter(Boolean);
const int = (v) => (v === '' || v == null ? null : Number.isFinite(Number(v)) && Number.isInteger(Number(v)) ? Number(v) : NaN);
const num = (v) => (v === '' || v == null ? null : Number.isFinite(Number(v)) ? Number(v) : NaN);

/** "Key: Value" lines (or a {k:v} object) → ordered object. */
export function parseSpecs(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  const out = {};
  for (const line of String(v ?? '').split(/\s*[|\n]\s*/)) {
    const i = line.indexOf(':');
    if (i > 0) { const k = line.slice(0, i).trim(); const val = line.slice(i + 1).trim(); if (k && val) out[k] = val; }
  }
  return out;
}
export const specsText = (specs = {}) => (typeof specs === 'string' ? specs : Object.entries(specs).map(([k, v]) => `${k}: ${v}`).join('\n'));

/** "50-499:39-52 | 500-1999:35-46 | 2000+:32-42"  ⇄  [{minQty,maxQty,low,high}] */
export function parseBands(v) {
  if (Array.isArray(v)) return v;
  const out = [];
  for (const part of String(v ?? '').split(/\s*[|\n]\s*/).filter(Boolean)) {
    const m = part.match(/^(\d+)\s*(?:-\s*(\d+)|(\+))?\s*[:：]\s*([\d.]+)\s*-\s*([\d.]+)$/);
    if (!m) { out.push({ invalid: part }); continue; }
    out.push({ minQty: Number(m[1]), maxQty: m[2] ? Number(m[2]) : null, low: Number(m[4]), high: Number(m[5]) });
  }
  return out;
}
export const bandsText = (bands = []) => (typeof bands === 'string' ? bands : bands.map((b) => `${b.minQty}${b.maxQty ? '-' + b.maxQty : '+'}:${b.low}-${b.high}`).join(' | '));

/**
 * Validate and normalise a product. ctx = { categories:[{id}], existing: Map(id → product) of other products, isNew }
 * Returns { product, errors[], warnings[] }. Unknown fields on `input` are kept (catalog fields we do not edit).
 */
export function validateProduct(input, ctx) {
  const errors = [];
  const warnings = [];
  const p = { ...input };
  p.id = String(p.id || '').trim();
  p.name = String(p.name || '').trim();
  p.slug = String(p.slug || '').trim() || slugify(p.name);
  p.summary = String(p.summary || '').trim();
  p.category = String(p.category || '').trim();
  p.unit = String(p.unit || 'pcs').trim();
  p.warranty = String(p.warranty || '').trim();
  for (const k of ['highlights', 'highlightsZh', 'applications', 'certifications', 'keywords', 'images', 'detailImages', 'features']) if (p[k] != null) p[k] = list(p[k]);
  p.highlights ||= []; p.applications ||= []; p.certifications ||= []; p.images ||= [];
  p.specs = parseSpecs(p.specs);
  p.priceBands = parseBands(p.priceBands);
  p.moq = int(p.moq);
  p.leadTimeDays = [int(p.leadTimeDays?.[0]), int(p.leadTimeDays?.[1])];
  p.sampleDays = [int(p.sampleDays?.[0]), int(p.sampleDays?.[1])];
  for (const k of ['wattMin', 'wattMax']) { p[k] = num(p[k]); if (p[k] === null) delete p[k]; }
  if (p.cct != null && !Array.isArray(p.cct)) p.cct = list(String(p.cct).replace(/,/g, '|')).map(Number).filter(Number.isFinite);
  for (const k of ['nameZh', 'summaryZh']) if (p[k] != null) { p[k] = String(p[k]).trim(); if (!p[k]) delete p[k]; }
  if (p.highlightsZh && !p.highlightsZh.length) delete p.highlightsZh;

  if (!ID_RE.test(p.id)) errors.push('型号/编码：2–40 位字母、数字、点、横线或下划线');
  else if (ctx.isNew && ctx.existing.has(p.id)) errors.push(`型号 ${p.id} 已存在`);
  if (!p.name) errors.push('名称必填');
  else if (p.name.length > 120) errors.push('名称不超过 120 字');
  if (!SLUG_RE.test(p.slug)) errors.push('网址别名：小写字母、数字和横线，如 ufo-high-bay-u2');
  else for (const [id, o] of ctx.existing) if (id !== p.id && o.slug === p.slug) errors.push(`网址别名 ${p.slug} 已被 ${id} 使用`);
  if (!p.summary) errors.push('一句话简介必填');
  else if (p.summary.length > 300) errors.push('简介不超过 300 字');
  if (!ctx.categories.some((c) => c.id === p.category)) errors.push(`品类不存在：${p.category || '（空）'}`);
  if (!(p.moq >= 1)) errors.push('起订量必须是 ≥1 的整数');
  if (!p.unit) errors.push('单位必填');
  if (!p.warranty) errors.push('质保必填，如 5 years');
  if (!Object.keys(p.specs).length) errors.push('至少填写一项参数（每行"参数名: 参数值"）');
  for (const [label, [a, b]] of [['生产交期', p.leadTimeDays], ['样品时间', p.sampleDays]]) {
    if (a == null || b == null || !(a >= 0) || !(b >= 0)) errors.push(`${label}：请填写最短和最长天数（整数）`);
    else if (a > b) errors.push(`${label}：最短天数不能大于最长天数`);
  }
  if (p.wattMin != null && p.wattMax != null && p.wattMin > p.wattMax) errors.push('最小功率不能大于最大功率');
  if (Number.isNaN(p.wattMin) || Number.isNaN(p.wattMax)) errors.push('功率必须是数字');

  // price bands: ascending, contiguous, only the last one open-ended, low ≤ high
  const bands = p.priceBands;
  bands.forEach((b, i) => {
    const n = `价格档位 ${i + 1}`;
    if (b.invalid) return errors.push(`${n} 格式错误："${b.invalid}"，应为 50-499:39-52 或 2000+:32-42`);
    if (!(Number.isInteger(b.minQty) && b.minQty >= 1)) errors.push(`${n}：起始数量必须是 ≥1 的整数`);
    if (b.maxQty != null && !(b.maxQty >= b.minQty)) errors.push(`${n}：截止数量不能小于起始数量`);
    if (!(b.low > 0) || !(b.high > 0)) errors.push(`${n}：价格必须大于 0`);
    else if (b.low > b.high) errors.push(`${n}：最低价不能高于最高价`);
    if (b.maxQty == null && i < bands.length - 1) errors.push(`${n}：只有最后一档可以不设上限（写成 2000+）`);
    if (i > 0 && !bands[i - 1].invalid && bands[i - 1].maxQty != null && b.minQty !== bands[i - 1].maxQty + 1) errors.push(`${n}：应从 ${bands[i - 1].maxQty + 1} 开始，与上一档衔接`);
  });
  if (bands.length && !bands.some((b) => b.invalid)) {
    if (bands.at(-1).maxQty != null) warnings.push('最后一档建议不设上限（如 2000+），否则超出数量的询价会转人工');
    if (p.moq >= 1 && bands[0].minQty !== p.moq) warnings.push(`第一档起始数量（${bands[0].minQty}）与起订量（${p.moq}）不一致`);
  }
  if (!bands.length) warnings.push('未设置价格档位：网站和 AI 将显示"按项目报价"并转人工');
  for (const u of [...p.images, ...(p.detailImages || [])]) if (!/^\/media\/[a-f0-9]{24}\.(jpg|png|webp)$/.test(u) && !/^https:\/\/\S+$/.test(u)) errors.push(`图片地址无效：${u}`);
  if (p.detailImages && !p.detailImages.length) delete p.detailImages;
  p.image = p.images[0] || undefined;
  if (!p.image) delete p.image;
  if (!p.highlights.length) warnings.push('建议填写 2–3 条卖点');
  if (!p.certifications.length) warnings.push('未填写认证');
  return { product: p, errors, warnings };
}

export function validateCategory(input, { existing, isNew }) {
  const c = { ...input };
  const errors = [];
  c.id = String(c.id || '').trim();
  c.name = String(c.name || '').trim();
  c.slug = String(c.slug || '').trim() || slugify(c.title || c.name);
  c.title = String(c.title || '').trim() || c.name;
  c.blurb = String(c.blurb || '').trim();
  c.keywords = list(c.keywords);
  for (const k of ['nameZh', 'blurbZh']) if (c[k] != null) { c[k] = String(c[k]).trim(); if (!c[k]) delete c[k]; }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(c.id)) errors.push('品类编码：小写字母、数字和横线');
  else if (isNew && existing.some((x) => x.id === c.id)) errors.push(`品类 ${c.id} 已存在`);
  if (!c.name) errors.push('品类名称必填');
  if (!SLUG_RE.test(c.slug)) errors.push('品类页网址别名无效');
  else if (existing.some((x) => x.id !== c.id && x.slug === c.slug)) errors.push(`网址别名 ${c.slug} 已被使用`);
  return { category: c, errors };
}

// ---------------------------------------------------------------- spreadsheets
export const COLUMNS = [
  ['id', '型号/编码*'], ['status', '状态(draft/published/archived)'], ['category', '品类编码*'], ['name', '名称*'], ['name_zh', '中文名称'],
  ['slug', '网址别名'], ['summary', '一句话简介*'], ['summary_zh', '中文简介'], ['highlights', '卖点(用|分隔)'], ['highlights_zh', '中文卖点(用|分隔)'],
  ['applications', '应用场景(用|分隔)'], ['certifications', '认证(用|分隔)'], ['keywords', '搜索关键词(用|分隔)'], ['warranty', '质保*'], ['unit', '单位*'],
  ['moq', '起订量*'], ['lead_time_min', '交期最短天数*'], ['lead_time_max', '交期最长天数*'], ['sample_days_min', '样品最短天数*'], ['sample_days_max', '样品最长天数*'],
  ['watt_min', '最小功率W'], ['watt_max', '最大功率W'], ['specs', '参数(参数名: 值，用|分隔)*'], ['price_bands', '价格档位(如 50-499:39-52 | 500+:35-46)'], ['images', '图片地址(用|分隔)'],
];

export function productToRow(p, status) {
  return {
    id: p.id, status, category: p.category, name: p.name, name_zh: p.nameZh || '', slug: p.slug, summary: p.summary, summary_zh: p.summaryZh || '',
    highlights: (p.highlights || []).join(' | '), highlights_zh: (p.highlightsZh || []).join(' | '), applications: (p.applications || []).join(' | '),
    certifications: (p.certifications || []).join(' | '), keywords: (p.keywords || []).join(' | '), warranty: p.warranty, unit: p.unit, moq: p.moq,
    lead_time_min: p.leadTimeDays?.[0], lead_time_max: p.leadTimeDays?.[1], sample_days_min: p.sampleDays?.[0], sample_days_max: p.sampleDays?.[1],
    watt_min: p.wattMin ?? '', watt_max: p.wattMax ?? '', specs: Object.entries(p.specs || {}).map(([k, v]) => `${k}: ${v}`).join(' | '),
    price_bands: bandsText(p.priceBands), images: (p.images || []).join(' | '),
  };
}

/** Spreadsheet row (keys = column ids, or the Chinese header labels) → partial product. Empty cells are omitted. */
export function rowToProduct(row) {
  const byLabel = Object.fromEntries(COLUMNS.map(([k, l]) => [l, k]));
  const r = {};
  for (const [k, v] of Object.entries(row)) { const key = byLabel[k.trim()] || k.trim().toLowerCase(); if (String(v ?? '').trim() !== '') r[key] = String(v).trim(); }
  const p = {};
  const map = { id: 'id', category: 'category', name: 'name', name_zh: 'nameZh', slug: 'slug', summary: 'summary', summary_zh: 'summaryZh', highlights: 'highlights', highlights_zh: 'highlightsZh', applications: 'applications', certifications: 'certifications', keywords: 'keywords', warranty: 'warranty', unit: 'unit', moq: 'moq', watt_min: 'wattMin', watt_max: 'wattMax', specs: 'specs', price_bands: 'priceBands', images: 'images' };
  for (const [col, field] of Object.entries(map)) if (r[col] != null) p[field] = r[col];
  if (r.lead_time_min != null || r.lead_time_max != null) p.leadTimeDays = [r.lead_time_min, r.lead_time_max];
  if (r.sample_days_min != null || r.sample_days_max != null) p.sampleDays = [r.sample_days_min, r.sample_days_max];
  return { product: p, status: r.status ? String(r.status).toLowerCase() : null };
}

const csvCell = (v) => {
  const s = String(v ?? '').replace(/^[=+\-@\t\r]/, "'$&");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function toCsv(rows, { labels = true } = {}) {
  const head = COLUMNS.map(([k, l]) => (labels ? l : k));
  return '﻿' + [head.map(csvCell).join(','), ...rows.map((r) => COLUMNS.map(([k]) => csvCell(r[k])).join(','))].join('\r\n') + '\r\n';
}

/** RFC 4180 CSV → array of objects keyed by the header row. Handles BOM, quotes, CRLF and ";" separators. */
export function parseCsv(text) {
  text = String(text).replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0] || '';
  const sep = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return tableToObjects(rows);
}

function tableToObjects(rows) {
  const data = rows.filter((r) => r.some((c) => String(c).trim() !== ''));
  if (!data.length) return [];
  const head = data[0].map((h) => String(h).trim());
  return data.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])).valueOf()).map((o) => {
    for (const k of Object.keys(o)) if (typeof o[k] === 'string' && o[k].startsWith("'") && /^'[=+\-@]/.test(o[k])) o[k] = o[k].slice(1);
    return o;
  });
}

/** Minimal .xlsx reader (first worksheet) — enough for product sheets exported from Excel / WPS. */
export function parseXlsx(buf) {
  const files = unzip(buf);
  const xml = (name) => (files[name] ? files[name].toString('utf8') : '');
  const dec = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(n)).replace(/&amp;/g, '&');
  const shared = [...xml('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => dec([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
  const sheetName = Object.keys(files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0];
  if (!sheetName) throw new Error('Excel 文件里没有工作表');
  const col = (ref) => ref.replace(/\d+/g, '').split('').reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const rows = [];
  for (const [, inner] of xml(sheetName).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const r = [];
    for (const [, attrs, body = ''] of inner.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = (attrs.match(/r="([A-Z]+\d+)"/) || [])[1];
      const t = (attrs.match(/t="(\w+)"/) || [])[1];
      const v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      let val = '';
      if (t === 's') val = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') val = dec([...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(''));
      else if (v != null) val = dec(v);
      r[ref ? col(ref) : r.length] = val;
    }
    rows.push(Array.from(r, (x) => x ?? ''));
  }
  return tableToObjects(rows);
}

function unzip(buf) {
  const out = {};
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('不是有效的 .xlsx 文件');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('不是有效的 .xlsx 文件');
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), nameLen = buf.readUInt16LE(p + 28), extra = buf.readUInt16LE(p + 30), comment = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extra + comment;
    if (!/^xl\/(sharedStrings|worksheets\/sheet\d+)\.xml$/.test(name)) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    if (size > 50 * 1024 * 1024) throw new Error('Excel 文件过大');
    out[name] = method === 8 ? inflateRawSync(data) : Buffer.from(data);
  }
  return out;
}

/** Detect image type from magic bytes. Only raster formats the browser shows safely. */
export function imageType(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}
