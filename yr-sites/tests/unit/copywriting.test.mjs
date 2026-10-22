// Module: server/src/catalog/copywriting.js — banned words (check, custom list, product save hook), prompt templates,
// title optimisation (rules and mock model), applying titles with history, prompt optimisation. IDs CW-xx.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempEnv } from '../helpers/env.mjs';
import { mockServer } from '../helpers/mock-http.mjs';

let reply = () => '{"titles":["UFO High Bay 240W DLC Premium Warehouse Light","Best UFO High Bay Light 100-240W"]}';
const llm = await mockServer((call) => ({ json: { content: [{ type: 'text', text: reply(call) }], stop_reason: 'end_turn' } }));
useTempEnv({ site: 'led', LLM_PROVIDER: 'anthropic', LLM_API_KEY: 'k', LLM_MODEL: 'claude-opus-5-5', LLM_BASE_URL: llm.url });
const C = await import('../../server/src/catalog/store.js');
const W = await import('../../server/src/catalog/copywriting.js');
const { config } = await import('../../server/src/config.js');
const { runAs } = await import('../../server/src/auth.js');
after(() => llm.close());

describe('banned words', () => {
  const sample = () => W.checkText('The BEST light. Bestseller, secure fixing, 100% guaranteed! 国内第一品牌');
  test('CW-01a English and Chinese banned words are found (English ignoring case) and returned in text order', () => {
    assert.deepEqual(sample().map((h) => h.found), ['BEST', '100% guaranteed', '第一']);
  });
  test('CW-01b each hit carries its level and reason', () => {
    const hits = sample();
    assert.equal(hits[0].level, 'warn');
    assert.equal(hits[1].level, 'block');
    assert.match(hits[2].reason, /广告法/);
  });
  test('CW-01c English words match only as whole words', () => {
    assert.deepEqual(W.checkText('Secure, curated, cured-in-place'), [], '"cure" only as a whole word');
  });
  test('CW-01d words containing punctuation (No.1) are matched', () => {
    assert.equal(W.checkText('No.1 seller')[0].word, 'No.1');
  });
  test('CW-02a a custom banned word is applied with its level', () => {
    W.saveBannedWord({ word: 'miracle', lang: 'en', level: 'block', reason: '夸大' });
    assert.equal(W.checkText('A miracle lamp')[0].level, 'block');
  });
  test('CW-02b saving the same word in another case replaces it', () => {
    W.saveBannedWord({ word: 'Miracle', lang: 'en', level: 'warn' }); // replaces, case-insensitive
    assert.equal(W.bannedWords().filter((w) => w.word.toLowerCase() === 'miracle').length, 1);
    assert.equal(W.checkText('miracle')[0].level, 'warn');
  });
  test('CW-02c a deleted custom word is no longer matched', () => {
    W.deleteBannedWord('Miracle');
    assert.deepEqual(W.checkText('miracle'), []);
  });
  test('CW-02d deleting a built-in word switches it off', () => {
    W.deleteBannedWord('best');
    assert.deepEqual(W.checkText('best'), []);
    assert.deepEqual(W.disabledBuiltins(), ['best']);
  });
  test('CW-02e a switched-off built-in word can be restored', () => {
    W.restoreBuiltin('best');
    assert.equal(W.checkText('best').length, 1);
  });
  test('CW-02f an empty banned word is refused', () => {
    assert.throws(() => W.saveBannedWord({ word: '' }), /1–60/);
  });
  test('CW-02g an unknown level is refused', () => {
    assert.throws(() => W.saveBannedWord({ word: 'x', level: 'maybe' }), /级别/);
  });
  test('CW-03a a product save containing a "block" word is refused, naming field and reason', () => {
    assert.throws(() => C.saveProduct({ id: 'YR-HB-U2', summary: 'Kills bacteria while lighting your warehouse' }), (e) => /违禁词：简介 "Kills bacteria"（医疗功效宣称）/.test(e.message));
  });
  test('CW-03b a product save containing a "warn" word is saved with a warning', () => {
    const { warnings } = C.saveProduct({ id: 'YR-HB-U2', highlightsZh: ['仓库照明的绝对首选'] });
    assert.ok(warnings.some((w) => /建议修改：中文卖点 "绝对"/.test(w)), warnings.join());
    assert.equal(C.getProduct('YR-HB-U2').highlightsZh[0], '仓库照明的绝对首选');
  });
  test('CW-03c the product check also covers keywords', () => {
    assert.deepEqual(W.checkProduct({ name: 'Plain name', keywords: ['cheapest high bay'] }).warn.map((h) => h.label), ['关键词']);
  });
});

describe('prompt templates', () => {
  const tp = {};
  test('CW-04a built-in title templates are listed', () => {
    assert.ok(W.listTemplates('title').length >= 3);
  });
  test('CW-04b editing a built-in template saves a copy and leaves the built-in unchanged', () => {
    tp.id = W.saveTemplate({ id: 'b-title-zh', kind: 'title', name: '我的中文标题', lang: 'zh', body: '为 {{name}}（{{model}}）写标题，突出 {{watt}}' });
    assert.notEqual(tp.id, 'b-title-zh');
    assert.equal(W.getTemplate('b-title-zh').builtin, true);
  });
  test('CW-04c an own template can be edited', () => {
    W.saveTemplate({ id: tp.id, kind: 'title', name: '我的中文标题 v2', lang: 'zh', body: '为 {{name}} 写标题，突出 {{watt}}，{{unknown}}完' });
    assert.equal(W.getTemplate(tp.id).name, '我的中文标题 v2');
  });
  test('CW-04d template variables render and unknown variables become empty', () => {
    assert.equal(W.render(W.getTemplate(tp.id).body, { name: 'U2', watt: '240W' }), '为 U2 写标题，突出 240W，完');
  });
  test('CW-04e built-in templates cannot be deleted', () => {
    assert.throws(() => W.deleteTemplate('b-title-zh'), /内置/);
  });
  test('CW-04f a template of an unknown kind is refused', () => {
    assert.throws(() => W.saveTemplate({ kind: 'nope', name: 'x', lang: 'en', body: 'long enough body' }), /类型/);
  });
  test('CW-04g a template body shorter than 10 characters is refused', () => {
    assert.throws(() => W.saveTemplate({ kind: 'title', name: 'x', lang: 'en', body: 'short' }), /10–4000/);
  });
  test('CW-04h an own template can be deleted', () => {
    W.deleteTemplate(tp.id);
    assert.equal(W.getTemplate(tp.id), null);
  });
});

describe('titles', () => {
  const u2 = () => C.getProduct('YR-HB-U2');
  test('CW-05a rule-based SEO title starts with the keywords and uses the product data', () => {
    const seo = W.ruleTitles(u2(), { lang: 'en', direction: 'seo', keywords: 'warehouse high bay light' });
    assert.match(seo[0], /^warehouse high bay light UFO High Bay U2 100-240W DLC Premium\/ETL for warehouse$/);
  });
  test('CW-05b rule-based B2B title mentions wholesale & OEM', () => {
    assert.match(W.ruleTitles(u2(), { direction: 'b2b' })[0], /Wholesale & OEM/);
  });
  test('CW-05c rule-based concise title is name plus wattage', () => {
    assert.equal(W.ruleTitles(u2(), { direction: 'concise' })[0], 'UFO High Bay U2 100-240W');
  });
  test('CW-05d rule-based features title lists a feature', () => {
    assert.match(W.ruleTitles(u2(), { direction: 'features' })[0], /- Wattage selectable/);
  });
  test('CW-05e rule-based Chinese B2B title uses the Chinese name and 工厂直供', () => {
    assert.match(W.ruleTitles({ ...u2(), nameZh: 'UFO 工矿灯 U2' }, { lang: 'zh', direction: 'b2b' })[0], /^UFO 工矿灯 U2 100-240W .*工厂直供/);
  });
  test('CW-05f rule-based titles respect the 120-character limit', () => {
    const long = W.ruleTitles({ ...u2(), name: 'X'.repeat(50) + ' ' + 'Y'.repeat(60) }, { direction: 'seo' });
    assert.ok(long.every((t) => t.length <= 120));
  });
  const aiT = {};
  test('CW-06a AI titles are returned from the model', async () => {
    const r = aiT.r = await W.optimiseTitles({ productId: 'YR-HB-U2', lang: 'en', direction: 'seo', keywords: 'warehouse light', reference: { title: 'Competitor 200W UFO LED High Bay' } });
    aiT.call = llm.calls.at(-1).body;
    assert.equal(r.source, 'ai');
    assert.equal(r.titles.length, 2);
  });
  test('CW-06b banned words in AI titles are marked', () => {
    assert.deepEqual(aiT.r.titles[0].hits, []);
    assert.equal(aiT.r.titles[1].hits[0].found, 'Best');
  });
  test('CW-06c the system prompt lists the banned words to avoid', () => {
    assert.match(aiT.call.system, /Never use these words:.*best/);
  });
  test('CW-06d the prompt carries the product facts, keywords and the reference title', () => {
    const { call } = aiT;
    assert.match(call.messages[0].content, /UFO High Bay U2 \(YR-HB-U2\)/);
    assert.match(call.messages[0].content, /DLC Premium/);
    assert.match(call.messages[0].content, /warehouse light/);
    assert.match(call.messages[0].content, /Competitor 200W UFO LED High Bay/);
  });
  test('CW-06e the returned prompt tells the model never to copy brands from the reference', () => {
    assert.match(aiT.r.prompt, /never copy brands/);
  });
  test('CW-07a an unusable model answer falls back to rule-based titles', async () => {
    reply = () => 'sorry, no JSON';
    const r = await W.optimiseTitles({ productId: 'YR-HB-U2', lang: 'zh', direction: 'concise' });
    assert.equal(r.source, 'rules');
    assert.ok(r.titles.length >= 1);
  });
  test('CW-07b title optimisation for an unknown product is refused', async () => {
    await assert.rejects(W.optimiseTitles({ productId: 'NOPE' }), /不存在/);
  });
  test('CW-07c title optimisation in an unsupported language is refused', async () => {
    await assert.rejects(W.optimiseTitles({ productId: 'YR-HB-U2', lang: 'fr' }), /语言/);
  });
  test('CW-08a applying titles writes the English and Chinese product names', () => {
    runAs({ username: 'dee' }, () => W.applyTitle('YR-HB-U2', 'en', 'UFO High Bay 100-240W DLC Premium', { source: 'ai' }));
    runAs({ username: 'dee' }, () => W.applyTitle('YR-HB-U2', 'zh', 'UFO 工矿灯 100-240W'));
    const p = C.getProduct('YR-HB-U2');
    assert.equal(p.name, 'UFO High Bay 100-240W DLC Premium');
    assert.equal(p.nameZh, 'UFO 工矿灯 100-240W');
  });
  test('CW-08b each applied title is kept in the history with the previous title, source and user', () => {
    const h = W.titleHistory('YR-HB-U2');
    assert.equal(h.length, 2);
    assert.deepEqual([h[1].lang, h[1].previous, h[1].source, h[1].created_by], ['en', 'UFO High Bay U2', 'ai', 'dee']);
    assert.equal(h[0].previous, '');
  });
  test('CW-08c a title containing a banned word is refused', () => {
    assert.throws(() => W.applyTitle('YR-HB-U2', 'en', 'FDA approved UFO'), /违禁词：FDA approved/);
  });
  test('CW-08d a title over 60 characters is refused', () => {
    assert.throws(() => W.applyTitle('YR-HB-U2', 'zh', '灯'.repeat(61)), /60/);
  });
  test('CW-08e the website keeps the old title until the catalog is published', () => {
    assert.equal(config.catalog.products.find((x) => x.id === 'YR-HB-U2').name, 'UFO High Bay U2', 'website unchanged until published');
  });
});

describe('prompt optimisation', () => {
  test('CW-09a the AI rewrites a rough request into a prompt', async () => {
    reply = () => '纯白背景，商品居中，突出灯珠细节，800×800 方图，不加文字和水印';
    const r = await W.optimisePrompt({ text: '白底，突出灯珠', purpose: 'image', lang: 'zh' });
    assert.deepEqual(r, { prompt: '纯白背景，商品居中，突出灯珠细节，800×800 方图，不加文字和水印', source: 'ai' });
  });
  test('CW-09b the system prompt targets the purpose (image model) and the language (Chinese)', () => {
    assert.match(llm.calls.at(-1).body.system, /image editing \/ generation model.*Simplified Chinese/s);
  });
  test('CW-09c without a usable answer an English image request becomes a structured checklist', async () => {
    reply = () => '';
    const f = await W.optimisePrompt({ text: 'white background', purpose: 'image', lang: 'en' });
    assert.equal(f.source, 'rules');
    assert.match(f.prompt, /^Request: white background\nComposition/);
  });
  test('CW-09d without a usable answer a Chinese description request becomes a Chinese checklist', async () => {
    assert.match((await W.optimisePrompt({ text: '写描述', purpose: 'description', lang: 'zh' })).prompt, /要求：写描述\n语言：简体中文/);
  });
  test('CW-09e a request that is too short is refused', async () => {
    await assert.rejects(W.optimisePrompt({ text: 'x' }), /大致要求/);
  });
});
