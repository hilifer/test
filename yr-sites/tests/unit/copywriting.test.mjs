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
  test('CW-01 English matches whole words ignoring case; Chinese matches characters; results in text order', () => {
    const hits = W.checkText('The BEST light. Bestseller, secure fixing, 100% guaranteed! 国内第一品牌');
    assert.deepEqual(hits.map((h) => h.found), ['BEST', '100% guaranteed', '第一']);
    assert.equal(hits[0].level, 'warn');
    assert.equal(hits[1].level, 'block');
    assert.match(hits[2].reason, /广告法/);
    assert.deepEqual(W.checkText('Secure, curated, cured-in-place'), [], '"cure" only as a whole word');
    assert.equal(W.checkText('No.1 seller')[0].word, 'No.1');
  });
  test('CW-02 custom words; built-ins switched off and back on; validation', () => {
    W.saveBannedWord({ word: 'miracle', lang: 'en', level: 'block', reason: '夸大' });
    assert.equal(W.checkText('A miracle lamp')[0].level, 'block');
    W.saveBannedWord({ word: 'Miracle', lang: 'en', level: 'warn' }); // replaces, case-insensitive
    assert.equal(W.bannedWords().filter((w) => w.word.toLowerCase() === 'miracle').length, 1);
    assert.equal(W.checkText('miracle')[0].level, 'warn');
    W.deleteBannedWord('Miracle');
    assert.deepEqual(W.checkText('miracle'), []);
    W.deleteBannedWord('best');
    assert.deepEqual(W.checkText('best'), []);
    assert.deepEqual(W.disabledBuiltins(), ['best']);
    W.restoreBuiltin('best');
    assert.equal(W.checkText('best').length, 1);
    assert.throws(() => W.saveBannedWord({ word: '' }), /1–60/);
    assert.throws(() => W.saveBannedWord({ word: 'x', level: 'maybe' }), /级别/);
  });
  test('CW-03 every product save is checked: "block" words stop it, "warn" words save with a warning', () => {
    assert.throws(() => C.saveProduct({ id: 'YR-HB-U2', summary: 'Kills bacteria while lighting your warehouse' }), (e) => /违禁词：简介 "Kills bacteria"（医疗功效宣称）/.test(e.message));
    const { warnings } = C.saveProduct({ id: 'YR-HB-U2', highlightsZh: ['仓库照明的绝对首选'] });
    assert.ok(warnings.some((w) => /建议修改：中文卖点 "绝对"/.test(w)), warnings.join());
    assert.equal(C.getProduct('YR-HB-U2').highlightsZh[0], '仓库照明的绝对首选');
    assert.deepEqual(W.checkProduct({ name: 'Plain name', keywords: ['cheapest high bay'] }).warn.map((h) => h.label), ['关键词']);
  });
});

describe('prompt templates', () => {
  test('CW-04 built-ins + own templates; editing a built-in saves a copy; built-ins cannot be deleted; variables render', () => {
    assert.ok(W.listTemplates('title').length >= 3);
    const id = W.saveTemplate({ id: 'b-title-zh', kind: 'title', name: '我的中文标题', lang: 'zh', body: '为 {{name}}（{{model}}）写标题，突出 {{watt}}' });
    assert.notEqual(id, 'b-title-zh');
    assert.equal(W.getTemplate('b-title-zh').builtin, true);
    W.saveTemplate({ id, kind: 'title', name: '我的中文标题 v2', lang: 'zh', body: '为 {{name}} 写标题，突出 {{watt}}，{{unknown}}完' });
    assert.equal(W.getTemplate(id).name, '我的中文标题 v2');
    assert.equal(W.render(W.getTemplate(id).body, { name: 'U2', watt: '240W' }), '为 U2 写标题，突出 240W，完');
    assert.throws(() => W.deleteTemplate('b-title-zh'), /内置/);
    assert.throws(() => W.saveTemplate({ kind: 'nope', name: 'x', lang: 'en', body: 'long enough body' }), /类型/);
    assert.throws(() => W.saveTemplate({ kind: 'title', name: 'x', lang: 'en', body: 'short' }), /10–4000/);
    W.deleteTemplate(id);
    assert.equal(W.getTemplate(id), null);
  });
});

describe('titles', () => {
  test('CW-05 rule-based titles (no model) use the product data, follow the direction and the length limit', () => {
    const p = C.getProduct('YR-HB-U2');
    const seo = W.ruleTitles(p, { lang: 'en', direction: 'seo', keywords: 'warehouse high bay light' });
    assert.match(seo[0], /^warehouse high bay light UFO High Bay U2 100-240W DLC Premium\/ETL for warehouse$/);
    assert.match(W.ruleTitles(p, { direction: 'b2b' })[0], /Wholesale & OEM/);
    assert.equal(W.ruleTitles(p, { direction: 'concise' })[0], 'UFO High Bay U2 100-240W');
    assert.match(W.ruleTitles(p, { direction: 'features' })[0], /- Wattage selectable/);
    assert.match(W.ruleTitles({ ...p, nameZh: 'UFO 工矿灯 U2' }, { lang: 'zh', direction: 'b2b' })[0], /^UFO 工矿灯 U2 100-240W .*工厂直供/);
    const long = W.ruleTitles({ ...p, name: 'X'.repeat(50) + ' ' + 'Y'.repeat(60) }, { direction: 'seo' });
    assert.ok(long.every((t) => t.length <= 120));
  });
  test('CW-06 AI titles: prompt carries the product facts, banned words to avoid and the reference title; hits are marked', async () => {
    const r = await W.optimiseTitles({ productId: 'YR-HB-U2', lang: 'en', direction: 'seo', keywords: 'warehouse light', reference: { title: 'Competitor 200W UFO LED High Bay' } });
    assert.equal(r.source, 'ai');
    assert.equal(r.titles.length, 2);
    assert.deepEqual(r.titles[0].hits, []);
    assert.equal(r.titles[1].hits[0].found, 'Best');
    const call = llm.calls.at(-1).body;
    assert.match(call.system, /Never use these words:.*best/);
    assert.match(call.messages[0].content, /UFO High Bay U2 \(YR-HB-U2\)/);
    assert.match(call.messages[0].content, /DLC Premium/);
    assert.match(call.messages[0].content, /warehouse light/);
    assert.match(call.messages[0].content, /Competitor 200W UFO LED High Bay/);
    assert.match(r.prompt, /never copy brands/);
  });
  test('CW-07 model failure or unusable answer falls back to rule-based titles', async () => {
    reply = () => 'sorry, no JSON';
    const r = await W.optimiseTitles({ productId: 'YR-HB-U2', lang: 'zh', direction: 'concise' });
    assert.equal(r.source, 'rules');
    assert.ok(r.titles.length >= 1);
    await assert.rejects(W.optimiseTitles({ productId: 'NOPE' }), /不存在/);
    await assert.rejects(W.optimiseTitles({ productId: 'YR-HB-U2', lang: 'fr' }), /语言/);
  });
  test('CW-08 applying a title writes the product name, keeps a history with the previous title; banned / too long refused', () => {
    runAs({ username: 'dee' }, () => W.applyTitle('YR-HB-U2', 'en', 'UFO High Bay 100-240W DLC Premium', { source: 'ai' }));
    runAs({ username: 'dee' }, () => W.applyTitle('YR-HB-U2', 'zh', 'UFO 工矿灯 100-240W'));
    const p = C.getProduct('YR-HB-U2');
    assert.equal(p.name, 'UFO High Bay 100-240W DLC Premium');
    assert.equal(p.nameZh, 'UFO 工矿灯 100-240W');
    const h = W.titleHistory('YR-HB-U2');
    assert.equal(h.length, 2);
    assert.deepEqual([h[1].lang, h[1].previous, h[1].source, h[1].created_by], ['en', 'UFO High Bay U2', 'ai', 'dee']);
    assert.equal(h[0].previous, '');
    assert.throws(() => W.applyTitle('YR-HB-U2', 'en', 'FDA approved UFO'), /违禁词：FDA approved/);
    assert.throws(() => W.applyTitle('YR-HB-U2', 'zh', '灯'.repeat(61)), /60/);
    assert.equal(config.catalog.products.find((x) => x.id === 'YR-HB-U2').name, 'UFO High Bay U2', 'website unchanged until published');
  });
});

describe('prompt optimisation', () => {
  test('CW-09 AI rewrites a rough request; without a usable answer a structured checklist is produced', async () => {
    reply = () => '纯白背景，商品居中，突出灯珠细节，800×800 方图，不加文字和水印';
    const r = await W.optimisePrompt({ text: '白底，突出灯珠', purpose: 'image', lang: 'zh' });
    assert.deepEqual(r, { prompt: '纯白背景，商品居中，突出灯珠细节，800×800 方图，不加文字和水印', source: 'ai' });
    assert.match(llm.calls.at(-1).body.system, /image editing \/ generation model.*Simplified Chinese/s);
    reply = () => '';
    const f = await W.optimisePrompt({ text: 'white background', purpose: 'image', lang: 'en' });
    assert.equal(f.source, 'rules');
    assert.match(f.prompt, /^Request: white background\nComposition/);
    assert.match((await W.optimisePrompt({ text: '写描述', purpose: 'description', lang: 'zh' })).prompt, /要求：写描述\n语言：简体中文/);
    await assert.rejects(W.optimisePrompt({ text: 'x' }), /大致要求/);
  });
});
