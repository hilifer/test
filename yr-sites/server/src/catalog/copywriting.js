// Titles, prompts and compliance (标题、提示词与违禁词) for listing on our own website.
// - Banned words: built-in list (absolute claims, unverifiable guarantees, medical claims, Chinese advertising-law terms)
//   plus custom words; level "block" stops a product from being saved, "warn" saves with a warning.
// - Prompt templates (bilingual, built-ins + own) for titles, image work and descriptions, with {{variables}}.
// - AI title optimisation in a chosen language and direction, optionally learning from a reference page (text only);
//   without a model, rule-based titles from the product data. Every applied title is kept in a history.
// - AI prompt optimisation: turns a rough request into a precise prompt for an image or copy model.
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { aiEnabled } from '../config.js';
import { migrate } from '../migrate.js';
import { actorName } from '../auth.js';
import { complete, parseJson } from '../llm.js';
import * as C from './store.js';
import * as D from './copy-data.js';

migrate([{
  id: '2026-11-03-copywriting',
  up: () => db.exec(`CREATE TABLE prompt_templates (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, lang TEXT NOT NULL, body TEXT NOT NULL, created_by TEXT, updated_at TEXT);
    CREATE TABLE title_history (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id TEXT NOT NULL, lang TEXT NOT NULL, title TEXT NOT NULL, previous TEXT, source TEXT, note TEXT, created_by TEXT, ts TEXT);
    CREATE INDEX title_history_product ON title_history(product_id, id);`),
}]);
const now = () => new Date().toISOString();

// ---------------------------------------------------------------- banned words
export const LEVELS = { block: '禁止（不能保存）', warn: '提醒（可以保存）' };
export const BUILTIN_BANNED = D.BANNED.map(([word, lang, level, reason]) => ({ word, lang, level, reason, builtin: true }));
const bannedSettings = () => ({ custom: [], disabled: [], ...(C.getSetting('banned_words') || {}) });
export function bannedWords() {
  const s = bannedSettings();
  return [...BUILTIN_BANNED.filter((w) => !s.disabled.includes(w.word)), ...s.custom];
}
export function saveBannedWord({ word, lang = 'en', level = 'warn', reason = '' }) {
  const w = String(word || '').trim();
  if (!w || w.length > 60) throw new Error('违禁词须为 1–60 个字符');
  if (!LEVELS[level]) throw new Error('级别无效');
  if (!['en', 'zh'].includes(lang)) throw new Error('语言无效');
  const s = bannedSettings();
  s.custom = [...s.custom.filter((x) => x.word.toLowerCase() !== w.toLowerCase()), { word: w, lang, level, reason: String(reason || '自定义').slice(0, 60) }];
  s.disabled = s.disabled.filter((x) => x.toLowerCase() !== w.toLowerCase());
  C.setSetting('banned_words', s);
}
/** Custom words are removed; built-in words are switched off (and can be switched on again by adding them back). */
export function deleteBannedWord(word) {
  const s = bannedSettings();
  s.custom = s.custom.filter((x) => x.word !== word);
  if (BUILTIN_BANNED.some((b) => b.word === word) && !s.disabled.includes(word)) s.disabled.push(word);
  C.setSetting('banned_words', s);
}
export function restoreBuiltin(word) { const s = bannedSettings(); s.disabled = s.disabled.filter((x) => x !== word); C.setSetting('banned_words', s); }
export const disabledBuiltins = () => bannedSettings().disabled;

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CJK = /[\u3400-\u9fff]/;
/** Find banned words in a text. English words match whole words, case-insensitive; Chinese words match anywhere. */
export function checkText(text, words = bannedWords()) {
  const t = String(text || '');
  const hits = [];
  for (const w of words) {
    const re = CJK.test(w.word) ? new RegExp(reEsc(w.word), 'g') : new RegExp(`(?<![\\w])${reEsc(w.word)}(?![\\w])`, 'gi');
    for (const m of t.matchAll(re)) hits.push({ word: w.word, found: m[0], index: m.index, level: w.level, reason: w.reason });
  }
  return hits.sort((a, b) => a.index - b.index);
}
const FIELDS = { name: '名称', nameZh: '中文名称', summary: '简介', summaryZh: '中文简介', highlights: '卖点', highlightsZh: '中文卖点', keywords: '关键词', applications: '应用场景' };
/** Check the customer-facing text of a product. Returns { block: [...], warn: [...] } with field labels. */
export function checkProduct(p) {
  const words = bannedWords();
  const out = { block: [], warn: [] };
  for (const [k, label] of Object.entries(FIELDS)) {
    const v = p[k];
    if (v == null) continue;
    for (const h of checkText([].concat(v).join(' \n '), words)) out[h.level].push({ ...h, field: k, label });
  }
  return out;
}
// every product save (admin form, CSV import, AI listing) goes through this check
C.addSaveCheck((p) => { const r = checkProduct(p); return { errors: r.block.length ? [`违禁词：${describeHits(r.block)}`] : [], warnings: r.warn.length ? [`建议修改：${describeHits(r.warn)}`] : [] }; });
export const describeHits = (hits) => [...new Map(hits.map((h) => [`${h.label}:${h.found}`, `${h.label} "${h.found}"（${h.reason}）`])).values()].join('；');

// ---------------------------------------------------------------- prompt templates
export const KINDS = { title: '商品标题', image: '图片处理 / 生成', description: '商品描述' };
export const BUILTIN_TEMPLATES = D.TEMPLATES;
export function listTemplates(kind = '') {
  const own = db.prepare(`SELECT * FROM prompt_templates ${kind ? 'WHERE kind = ?' : ''} ORDER BY kind, name`).all(...(kind ? [kind] : []));
  return [...BUILTIN_TEMPLATES.filter((t) => !kind || t.kind === kind).map((t) => ({ ...t, builtin: true })), ...own];
}
export const getTemplate = (id) => listTemplates().find((t) => t.id === id) || null;
export function saveTemplate({ id, kind, name, lang, body }) {
  if (!KINDS[kind]) throw new Error('模板类型无效');
  if (!['en', 'zh'].includes(lang)) throw new Error('语言无效');
  const n = String(name || '').trim(), b = String(body || '').trim();
  if (!n) throw new Error('模板名称必填');
  if (b.length < 10 || b.length > 4000) throw new Error('模板内容须为 10–4000 个字符');
  if (id && BUILTIN_TEMPLATES.some((t) => t.id === id)) id = null; // editing a built-in saves a copy
  const key = id || randomUUID();
  db.prepare('INSERT INTO prompt_templates (id, kind, name, lang, body, created_by, updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, name = excluded.name, lang = excluded.lang, body = excluded.body, updated_at = excluded.updated_at')
    .run(key, kind, n.slice(0, 80), lang, b, actorName('system'), now());
  return key;
}
export function deleteTemplate(id) {
  if (BUILTIN_TEMPLATES.some((t) => t.id === id)) throw new Error('内置模板不能删除');
  db.prepare('DELETE FROM prompt_templates WHERE id = ?').run(id);
}
export const render = (body, vars) => String(body).replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] != null && vars[k] !== '' ? String(vars[k]) : ''));

// ---------------------------------------------------------------- titles
export const DIRECTIONS = { seo: '搜索优化（核心词在前）', concise: '简洁', b2b: '批发 / 工程采购', features: '突出卖点' };
const MAX_LEN = { en: 120, zh: 60 };
const watt = (p) => (p.wattMin && p.wattMax && p.wattMin !== p.wattMax ? `${p.wattMin}-${p.wattMax}W` : p.wattMax || p.wattMin ? `${p.wattMax || p.wattMin}W` : '');
const specText = (p) => Object.entries(p.specs || {}).slice(0, 6).map(([k, v]) => `${k}: ${v}`).join('; ');
function varsFor(p, { lang, direction, count, keywords }) {
  return {
    name: lang === 'zh' ? p.nameZh || p.name : p.name, model: p.id, specs: specText(p), certifications: (p.certifications || []).join(', '), keywords: keywords || (p.keywords || []).join(', '),
    applications: (p.applications || []).join(', '), warranty: p.warranty || '', direction: DIRECTIONS[direction] || direction, count, maxLength: MAX_LEN[lang], watt: watt(p),
  };
}
const clip = (s, n) => (s.length <= n ? s : s.slice(0, n).replace(/[\s,，/|-]+\S*$/, '').trim());
/** Titles from the product data alone (no model). */
export function ruleTitles(p, { lang = 'en', direction = 'seo', keywords = '' } = {}) {
  const name = lang === 'zh' ? p.nameZh || p.name : p.name;
  const w = watt(p);
  const certs = (p.certifications || []).slice(0, 2).join('/');
  const app = (p.applications || [])[0] || '';
  const kw = String(keywords || (p.keywords || []).slice(0, 2).join(' ')).split(/[,，]/)[0].trim();
  const hl = ((lang === 'zh' ? p.highlightsZh : null) || p.highlights || [])[0] || '';
  const has = (part) => part && !name.toLowerCase().includes(String(part).toLowerCase());
  const join = (parts) => clip(parts.filter(Boolean).join(lang === 'zh' ? ' ' : ' ').replace(/\s+/g, ' ').trim(), MAX_LEN[lang]);
  const opts = {
    seo: [[has(kw) && kw, name, has(w) && w, certs, app && (lang === 'zh' ? app : `for ${app}`)], [name, has(w) && w, has(kw) && kw, certs]],
    concise: [[name, has(w) && w], [name]],
    b2b: [[name, has(w) && w, certs, D.WORDS[lang].wholesale], [name, has(w) && w, app && D.WORDS[lang].projects(app)]],
    features: [[name, has(w) && w, hl && (lang === 'zh' ? `｜${hl}` : `- ${hl}`)], [name, hl && (lang === 'zh' ? `｜${hl}` : `- ${hl}`)]],
  }[direction] || [[name, w]];
  return [...new Set([...opts.map(join), join([name, has(w) && w, certs])])].filter(Boolean).slice(0, 3);
}
/**
 * Suggest titles. reference: { title, description } read from a reference page (text only). Returns
 * { titles: [{ title, length, hits }], source: 'ai' | 'rules', prompt }.
 */
export async function optimiseTitles({ productId, lang = 'en', direction = 'seo', templateId = '', keywords = '', reference = null, count = 3 }) {
  const p = C.getProduct(productId);
  if (!p) throw new Error('商品不存在');
  if (!['en', 'zh'].includes(lang)) throw new Error('语言无效');
  const tpl = (templateId && getTemplate(templateId)) || BUILTIN_TEMPLATES.find((t) => t.kind === 'title' && t.lang === lang && (direction === 'b2b' ? t.id.includes('b2b') : !t.id.includes('b2b'))) || BUILTIN_TEMPLATES[0];
  const vars = varsFor(p, { lang, direction, count, keywords });
  let prompt = render(tpl.body, vars);
  if (reference?.title) prompt += `\n${D.WORDS[lang].reference}: ${reference.title}`;
  const avoid = bannedWords().filter((w) => w.lang === lang).map((w) => w.word);
  let titles = [], source = 'rules';
  if (aiEnabled()) {
    try {
      const out = await complete({
        system: `You write product titles for a manufacturer's own website. Answer with JSON only: {"titles":["..."]}. Language: ${lang === 'zh' ? 'Simplified Chinese' : 'English'}. Never use these words: ${avoid.join(', ')}. Do not invent specs or certifications that are not given.`,
        user: prompt, maxTokens: 800, temperature: 0.7,
      });
      titles = [].concat(parseJson(out)?.titles || []).map((t) => String(t).trim()).filter(Boolean);
      if (titles.length) source = 'ai';
    } catch { /* model unavailable: fall back to rules */ }
  }
  if (!titles.length) titles = ruleTitles(p, { lang, direction, keywords });
  const words = bannedWords();
  return { titles: titles.slice(0, Math.max(1, Math.min(10, count))).map((t) => ({ title: clip(t, MAX_LEN[lang]), length: [...clip(t, MAX_LEN[lang])].length, hits: checkText(t, words) })), source, prompt, template: tpl.name };
}
/** Use a title on the product (English name or Chinese name); refuses titles with "block" words; keeps a history. */
export function applyTitle(productId, lang, title, { source = 'manual', note = '' } = {}) {
  const p = C.getProduct(productId);
  if (!p) throw new Error('商品不存在');
  const t = String(title || '').trim();
  if (!t) throw new Error('标题不能为空');
  if ([...t].length > MAX_LEN[lang]) throw new Error(`标题不超过 ${MAX_LEN[lang]} 个字符`);
  const block = checkText(t).filter((h) => h.level === 'block');
  if (block.length) throw new Error(`标题含违禁词：${[...new Set(block.map((h) => h.found))].join('、')}`);
  const key = lang === 'zh' ? 'nameZh' : 'name';
  const previous = p[key] || '';
  C.saveProduct({ id: productId, [key]: t }, { expectVersion: p._version });
  db.prepare('INSERT INTO title_history (product_id, lang, title, previous, source, note, created_by, ts) VALUES (?,?,?,?,?,?,?,?)').run(productId, lang, t, previous, source, String(note || '').slice(0, 300), actorName('system'), now());
  return C.getProduct(productId);
}
export const titleHistory = (productId, n = 30) => db.prepare('SELECT * FROM title_history WHERE product_id = ? ORDER BY id DESC LIMIT ?').all(productId, n);

// ---------------------------------------------------------------- prompt optimisation
export const PURPOSES = { image: '图片处理 / 生成', title: '商品标题', description: '商品描述' };
/** Turn a rough request into a precise prompt. Without a model: a structured checklist version of the request. */
export async function optimisePrompt({ text, purpose = 'image', lang = 'zh' }) {
  const raw = String(text || '').trim();
  if (raw.length < 2) throw new Error('请先写下大致要求');
  if (raw.length > 2000) throw new Error('要求不超过 2000 个字符');
  if (aiEnabled()) {
    try {
      const out = await complete({
        system: `Rewrite the user's rough request into one precise, ready-to-use prompt for ${purpose === 'image' ? 'an image editing / generation model' : 'a copywriting model'} working on product listings for a lighting / solar manufacturer's own website. Keep every concrete requirement, add the missing specifics (background, composition, size, lighting, what to avoid) as sensible defaults, avoid exaggerated claims. Answer in ${lang === 'zh' ? 'Simplified Chinese' : 'English'} with the prompt only.`,
        user: raw, maxTokens: 600,
      });
      if (out.trim()) return { prompt: out.trim(), source: 'ai' };
    } catch { /* fall back */ }
  }
  const parts = [D.WORDS[lang].request(raw), ...D.PROMPT_RULES[lang][purpose === 'image' ? 'image' : 'copy']];
  return { prompt: parts.join('\n'), source: 'rules' };
}
