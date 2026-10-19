// SEO/GEO content agent: plan a topic → write an answer-first article → validate → save.
// Guardrails: product facts only from the catalog, numbers only from catalog or supplied
// sources, external links only to supplied sources, no copied text, anything risky → draft.
import { config, aiEnabled } from '../config.js';
import { complete, parseJson } from '../llm.js';
import { listArticles, saveArticle, markSeen, logRun, articleUrl } from './store.js';
import { freshItems } from './feeds.js';

const llmOpts = () => config.content.llm;
const contentReady = () => aiEnabled() || Boolean(config.content.llm.apiKey && config.content.llm.model && config.content.llm.provider);

function catalogBrief(lang) {
  const c = config.catalog;
  return c.products.map((p) => ({
    id: p.id,
    name: lang === 'zh' && p.nameZh ? p.nameZh : p.name,
    url: (lang === 'zh' ? '/zh' : '') + `/products/${p.slug}/`,
    category: p.category,
    summary: lang === 'zh' && p.summaryZh ? p.summaryZh : p.summary,
    keySpecs: Object.fromEntries(Object.entries(p.specs).slice(0, 6)),
    certifications: p.certifications,
  }));
}

function allowedPaths(lang) {
  const pre = lang === 'zh' ? '/zh' : '';
  const base = config.profile.content.internalPages || ['/products/', '/solutions/', '/news/'];
  return new Set([...base.map((p) => (p.startsWith('/zh/') || p.startsWith('/for-') ? p : pre + p)), ...config.catalog.products.map((p) => `${pre}/products/${p.slug}/`), ...listArticles().filter((a) => a.data.status === 'published').map((a) => articleUrl(a.id))]);
}

const PLAN_SYS = (lang) => `You are the content strategist for ${config.profile.brand}, writing for ${config.profile.content.audience}.
Goal: win search (SEO) and get cited by AI answer engines (GEO) for buyer questions in our product categories.
Pick ONE article to write now, in ${lang === 'zh' ? 'Simplified Chinese' : 'English'}.
Prefer a fresh, relevant industry news item if one clearly matters to our buyers (policy, tariffs, standards, market prices, technology). Otherwise pick the most valuable evergreen topic from the queue.
Avoid topics that duplicate recent titles. Reply with JSON only:
{"kind":"news"|"evergreen","item_ids":[numbers of news items used, max 3],"topic":"…","target_question":"the exact question a buyer would type or ask an AI","angle":"why it matters to our buyers, one sentence","product_ids":["ids from catalog that genuinely fit, max 3"]}`;

const WRITE_SYS = (lang) => {
  const p = config.profile;
  const zh = lang === 'zh';
  return `You write articles for the website of ${p.brand} (${p.company}). Audience: ${p.content.audience}. Voice: ${p.content.voice}
Language: ${zh ? 'Simplified Chinese (简体中文)' : 'English'}.

STRUCTURE (answer-first, built to be quoted by AI answer engines)
- Body starts with one paragraph beginning "${zh ? '**简短回答：**' : '**Short answer:**'}" that answers the target question in 2–3 sentences.
- Then 3–6 sections with "## " headings phrased as the sub-questions buyers ask. Short paragraphs, lists and one table where it helps.
- Mention our products only where they genuinely fit, linking with relative URLs from the catalog. End with a one-line next step linking to one of the allowed internal pages.
- ${zh ? '正文 1200–2500 字' : 'Body 700–1400 words'}. Title ≤ ${zh ? '32 characters' : '70 characters'}. Description ${zh ? '50–90 characters' : '120–160 characters'}, a plain summary, not clickbait.
- 3–5 FAQ entries: real buyer questions with direct 1–3 sentence answers.

FACT RULES (strict)
- Product facts ONLY from the catalog provided. Company facts ONLY from the facts provided.
- Any statistic, price, date or claim about the market must come from the supplied news items, and that item must be listed in "sources". If you don't have a source for a number, don't use the number.
- General engineering knowledge (how a technology works, typical design practice) is fine without a source; phrase it as typical practice, not as a precise statistic.
- Write original analysis. Do not copy sentences from the news items; at most one short quote in quotation marks.
- No superlatives about us (best, #1, cheapest, leading), no guarantees, no price promises, no attacks on competitors.
- External links: only the URLs of supplied news items. Internal links: only URLs from the allowed list.

Reply with JSON only:
{"title":"…","description":"…","slug":"lowercase-ascii-kebab-case","tags":["…"],"product_ids":["…"],"faq":[{"q":"…","a":"…"}],"sources":[{"title":"…","url":"…"}],"body":"markdown body without the H1"}

COMPANY FACTS
${p.facts.map((f) => '- ' + f).join('\n')}`;
};

const BANNED = /(guarantee[ds]?|best in the (world|industry)|#1\b|number one|cheapest|world[- ]leading|industry[- ]leading|100% (safe|reliable)|最便宜|行业第一|全球领先|保证收益|稳赚)/i;
const MONEY = /(US\$|\$|USD|RMB|CNY|¥|元\/|美元)\s?\d/;

export function validate(d, { lang, allowed, sourceUrls, existingSlugs }) {
  const issues = []; // hard → keeps it as draft
  const notes = []; // soft → shown to the reviewer
  const zh = lang === 'zh';
  if (!d.title || !d.body || !d.slug) issues.push('missing title/body/slug');
  d.slug = String(d.slug || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  if (existingSlugs.has(d.slug)) d.slug = `${d.slug}-${new Date().toISOString().slice(0, 10)}`;
  const len = zh ? (d.body || '').replace(/\s/g, '').length : (d.body || '').split(/\s+/).length;
  if (zh ? len < 900 : len < 500) issues.push(`too short (${len} ${zh ? 'chars' : 'words'})`);
  if (!(d.body || '').trimStart().startsWith(zh ? '**简短回答：**' : '**Short answer:**')) issues.push('does not open with the short answer');
  if (!/^## /m.test(d.body || '')) issues.push('no section headings');
  if (!Array.isArray(d.faq) || d.faq.length < 2) issues.push('fewer than 2 FAQ entries');
  if (d.description && (zh ? d.description.length > 120 : d.description.length > 180)) notes.push('description is long');
  // links
  d.body = (d.body || '').replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) => {
    if (url.startsWith('/')) { if (allowed.has(url)) return m; notes.push(`removed unknown internal link ${url}`); return text; }
    if (sourceUrls.has(url)) return m;
    notes.push(`removed unsourced external link ${url}`); return text;
  });
  d.sources = (d.sources || []).filter((s) => sourceUrls.has(s.url));
  d.product_ids = (d.product_ids || []).filter((id) => config.catalog.products.some((p) => p.id === id));
  const all = [d.title, d.description, d.body, ...(d.faq || []).flatMap((f) => [f.q, f.a])].join('\n');
  if (BANNED.test(all)) issues.push(`banned claim: "${all.match(BANNED)[0]}"`);
  if (MONEY.test(all)) issues.push('mentions money figures — verify before publishing');
  const nums = (d.body.match(/\d+(\.\d+)?\s?%/g) || []).length;
  if (nums && !d.sources.length) issues.push(`${nums} percentage figure(s) without a source`);
  return { issues, notes };
}

/** Generate one article. Returns {id, status, issues, notes}. */
export async function generateArticle({ lang = 'en', topic = '' } = {}) {
  if (!contentReady()) throw new Error('No LLM configured for content (set LLM_* or CONTENT_LLM_*).');
  const cc = config.profile.content;
  const existing = listArticles();
  const recent = existing.slice(0, 40).map((a) => a.data.title);
  const usedTopics = new Set(existing.map((a) => a.data.topic).filter(Boolean));
  const queue = (cc.topics[lang] || []).filter((t) => !usedTopics.has(t)).slice(0, 15);
  const { items, errors } = await freshItems(cc.feeds || []);
  const numbered = items.map((it, i) => ({ n: i + 1, title: it.title, source: it.source, date: it.date.toISOString().slice(0, 10), summary: it.summary, url: it.link }));

  let plan;
  if (topic) plan = { kind: 'evergreen', item_ids: [], topic, target_question: topic, angle: '', product_ids: [] };
  else {
    plan = parseJson(await complete({ system: PLAN_SYS(lang), user: JSON.stringify({ news_items: numbered.map(({ url, ...x }) => x), evergreen_queue: queue, recent_titles: recent, catalog_categories: config.catalog.categories.map((c) => c.name) }), maxTokens: 600, temperature: 0.4, llm: llmOpts() }));
  }
  const used = numbered.filter((x) => (plan.item_ids || []).includes(x.n));
  const sourceUrls = new Set(used.map((x) => x.url));
  const allowed = allowedPaths(lang);

  const userMsg = (extra = '') => JSON.stringify({
    target_question: plan.target_question, topic: plan.topic, angle: plan.angle, suggested_products: plan.product_ids,
    news_items: used, catalog: catalogBrief(lang), allowed_internal_urls: [...allowed], today: new Date().toISOString().slice(0, 10),
  }) + extra;

  let d = parseJson(await complete({ system: WRITE_SYS(lang), user: userMsg(), maxTokens: 5000, temperature: 0.5, llm: llmOpts() }));
  const ctx = { lang, allowed, sourceUrls, existingSlugs: new Set(existing.map((a) => a.id.replace(/^zh\//, ''))) };
  let v = validate(d, ctx);
  if (v.issues.length) {
    // one self-correction pass with the validator's findings
    d = parseJson(await complete({ system: WRITE_SYS(lang), user: userMsg(`\n\nYour previous draft failed these checks — fix all of them and return the full JSON again:\n- ${v.issues.join('\n- ')}\n\nPrevious draft:\n${JSON.stringify(d)}`), maxTokens: 5000, temperature: 0.3, llm: llmOpts() }));
    v = validate(d, ctx);
  }
  const status = config.content.autoPublish && !v.issues.length ? 'published' : 'draft';
  const id = (lang === 'zh' ? 'zh/' : '') + d.slug;
  const now = new Date();
  saveArticle(id, {
    title: d.title, description: d.description, date: now.toISOString().slice(0, 10), status, lang,
    tags: d.tags || [], products: d.product_ids, faq: d.faq || [], sources: d.sources || [],
    author: lang === 'zh' ? `${config.profile.brand} 编辑部` : `${config.profile.brand} editorial team`,
    topic: plan.topic, targetQuestion: plan.target_question, kind: plan.kind,
    generatedBy: `${(llmOpts().model || config.llm.model)} · ${now.toISOString()}`,
    review: { issues: v.issues, notes: v.notes, feedErrors: errors },
  }, d.body);
  used.forEach((x) => markSeen(x.url));
  logRun('article', status, { id, lang, issues: v.issues, notes: v.notes, feedErrors: errors });
  return { id, status, issues: v.issues, notes: v.notes, feedErrors: errors };
}
