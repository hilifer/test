// Modules: server/src/catalog/autolist.js — AI auto-listing (Kingdee materials / spec sheets / pasted text → product),
// fact check, defaults, auto-publish, GEO promotion of new products. IDs AL-xx. Mock LLM + IndexNow.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempEnv } from '../helpers/env.mjs';
import { mockServer } from '../helpers/mock-http.mjs';

const listing = []; // queued listing replies (objects or 'FAIL')
const llm = await mockServer((call) => {
  if (call.url === '/indexnow') return { status: 200, text: '' };
  if (call.url !== '/v1/messages') return { status: 404, text: '' };
  const sys = call.body.system;
  if (/You write product listings/.test(sys)) {
    const next = listing.shift();
    if (next === 'FAIL') return { status: 500, text: 'overloaded' };
    return { json: { content: [{ type: 'text', text: '```json\n' + JSON.stringify(next) + '\n```' }] } };
  }
  if (/You write articles/.test(sys)) {
    const body = `**Short answer:** This explosion-proof light suits hazardous areas.\n\n## Where is it used?\n\n${'Typical practice is to match the protection marking to the zone classification of the site. '.repeat(60)}`;
    return { json: { content: [{ type: 'text', text: JSON.stringify({ title: 'Explosion-proof LED light guide', description: 'What to check when choosing an explosion-proof LED light.', slug: 'explosion-proof-led-light-guide', faq: [{ q: 'Q1?', a: 'A1.' }, { q: 'Q2?', a: 'A2.' }], sources: [], product_ids: [], body }) }] } };
  }
  return { status: 400, text: 'unexpected' };
});
after(() => llm.close());

useTempEnv({ site: 'led', ERP_MODE: 'mock', LLM_PROVIDER: 'anthropic', LLM_API_KEY: 'k', LLM_MODEL: 'claude-opus-5-5', LLM_BASE_URL: llm.url, INDEXNOW_KEY: 'idx', INDEXNOW_ENDPOINT: `${llm.url}/indexnow`, CONTENT_AUTO_PUBLISH: 'false' });
const AL = await import('../../server/src/catalog/autolist.js');
const C = await import('../../server/src/catalog/store.js');
const { config } = await import('../../server/src/config.js');
const { db } = await import('../../server/src/db.js');
const { makeXlsx } = await import('../helpers/xlsx.mjs');
const { parseXlsx } = await import('../../server/src/catalog/validate.js');

const exDraft = (o = {}) => ({
  name: 'Explosion-proof LED Light 100W', nameZh: 'LED 防爆灯 100W', category: 'flood', summary: 'ATEX-style explosion-proof LED light for hazardous areas.', summaryZh: '用于危险区域的防爆 LED 灯。',
  highlights: ['Ex d IIC T6 marking', '130 lm/W', 'IP66 housing'], highlightsZh: ['防爆标志 Ex d IIC T6', '130 lm/W', 'IP66'],
  specs: { Power: '100 W', 'Luminous efficacy': '130 lm/W', 'IP rating': 'IP66', CCT: '5000K' }, applications: ['Oil & gas', 'Chemical plants'], keywords: ['explosion proof led light'], certifications: [], wattMin: 100, wattMax: 100, ...o,
});
const jobsBy = (status) => AL.listJobs(status);

describe('queue', () => {
  test('AL-01 Kingdee: only materials that are not yet a SKU are queued; pulling again adds nothing', async () => {
    const n = await AL.queueFromErp();
    assert.equal(n, 2); // the two MAT-LED-900x materials from the simulated ERP
    assert.deepEqual(jobsBy('queued').map((j) => j.source_ref).sort(), ['MAT-LED-9001', 'MAT-LED-9002']);
    assert.equal(await AL.queueFromErp(), 0);
  });
  test('AL-02 spec sheet (CSV/XLSX rows, any column names): one job per row, blank rows and repeats skipped', () => {
    const rows = parseXlsx(makeXlsx([['型号', '名称', '功率', '售价', '重量'], ['YR-TL-01', 'Tri-proof light 40W', '40W', '18.5', '1.2'], ['', '', '', '', ''], ['YR-TL-02', 'Tri-proof light 60W', '60W', '', '']]));
    assert.equal(AL.queueFromRows(rows, 'tri.xlsx'), 2);
    assert.equal(AL.queueFromRows(rows, 'tri.xlsx'), 0);
  });
  test('AL-03 pasted text: too short refused', () => {
    assert.throws(() => AL.queueFromText('lamp'), /太短/);
    const id = AL.queueFromText('YR-SL-77 Solar street light 60W\r\nBattery: LiFePO4 12.8V 30Ah\r\nPanel: 80W mono\r\nIP65'); // CRLF from a browser textarea
    assert.equal(AL.getJob(id).source_ref, 'YR-SL-77');
    assert.doesNotMatch(AL.getJob(id).raw.text, /\r/);
  });
});

describe('drafting & fact check', () => {
  test('AL-04 factCheck removes certifications and spec numbers that are not in the source; flags superlatives and unknown category', () => {
    const raw = { name: 'Flood 200W', spec: 'Power: 200W; IP66; CE' };
    const d = { name: 'Best in the industry flood', category: 'nope', certifications: ['CE', 'UL', 'DLC Premium'], specs: { Power: '200 W', Efficacy: '150 lm/W', 'IP rating': 'IP66' }, wattMin: 200, wattMax: 250 };
    const issues = AL.factCheck(d, raw);
    assert.deepEqual(d.certifications, ['CE']);
    assert.deepEqual(Object.keys(d.specs), ['Power', 'IP rating']);
    assert.equal(d.wattMax, undefined);
    assert.ok(issues.some((i) => /UL/.test(i)) && issues.some((i) => /DLC/.test(i)) && issues.some((i) => /150/.test(i)) && issues.some((i) => /250/.test(i)));
    assert.ok(issues.some((i) => /夸大/.test(i)));
    assert.ok(issues.some((i) => /品类/.test(i)));
    assert.ok(C.listCategories().some((c) => c.id === d.category)); // fallback guess
  });
  test('AL-05 AI draft from a Kingdee material: EN+ZH copy, verified specs, SKU linked to the material, inquiry-only without a price; draft by default', async () => {
    const job = jobsBy('queued').find((j) => j.source_ref === 'MAT-LED-9001');
    listing.push(exDraft({ certifications: ['ATEX'] })); // ATEX is not in the material data
    const j = await AL.draftJob(job.id);
    assert.equal(j.status, 'drafted');
    assert.equal(j.mode, 'ai');
    assert.equal(j.product_id, 'MAT-LED-9001');
    const p = C.getProduct('MAT-LED-9001');
    assert.equal(p._status, 'draft');
    assert.equal(p._salesMode, 'inquiry');
    assert.equal(p.nameZh, 'LED 防爆灯 100W');
    assert.deepEqual(p.certifications, []);
    assert.equal(p.specs['Luminous efficacy'], '130 lm/W');
    assert.equal(p.autoListed.source, 'erp');
    assert.equal(C.skusFor('MAT-LED-9001')[0].erp_number, 'MAT-LED-9001');
    assert.ok(j.issues.some((i) => /ATEX/.test(i)));
    assert.ok(j.notes.some((i) => /售价/.test(i))); // informational, does not block
    assert.ok(!config.catalog.products.some((x) => x.id === 'MAT-LED-9001')); // not live
    // the model never sees our prices/terms: warranty and lead times are the defaults
    const s = AL.autolistSettings();
    assert.equal(p.warranty, s.warranty);
    assert.deepEqual(p.leadTimeDays, s.leadTimeDays);
  });
  test('AL-06 price, weight and MOQ come from the sheet row, never from the model', async () => {
    const job = jobsBy('queued').find((j) => j.source_ref === 'YR-TL-01');
    listing.push({ name: 'Tri-proof LED Light 40W', category: 'indoor', summary: 'Tri-proof batten.', specs: { Power: '40W' }, highlights: [], price: 1 });
    const j = await AL.draftJob(job.id);
    const v = C.skusFor('YR-TL-01')[0];
    assert.equal(v.price, 18.5);
    assert.equal(v.weight_kg, 1.2);
    assert.equal(C.getProduct('YR-TL-01')._salesMode, 'both');
    assert.ok(!j.notes.some((i) => /售价/.test(i)));
  });
  test('AL-07 LLM failure → rule-based draft (never auto-published); duplicate ids get a suffix', async () => {
    const job = jobsBy('queued').find((j) => j.source_ref === 'YR-TL-02');
    C.saveProduct({ id: 'YR-TL-02', name: 'Existing', category: 'indoor', summary: 'x', warranty: '1 year', unit: 'pcs', moq: 1, leadTimeDays: [1, 2], sampleDays: [1, 2], specs: 'Power: 1W' }, { isNew: true, salesMode: 'inquiry', variants: [{ sku: 'YR-TL-02-X', price: '' }] });
    listing.push('FAIL');
    const j = await AL.draftJob(job.id);
    assert.equal(j.status, 'drafted');
    assert.equal(j.mode, 'rules');
    assert.equal(j.product_id, 'YR-TL-02-2');
    assert.ok(j.issues.some((i) => /AI 生成失败/.test(i)));
    assert.ok(j.issues.some((i) => /规则生成/.test(i)));
    assert.equal(C.getProduct('YR-TL-02-2').specs['功率'], '60W');
  });
  test('AL-08 a job that cannot be saved is marked failed with the reason; retry works; skip', async () => {
    const id = AL.queueFromText('X\nnothing useful here at all, really nothing');
    listing.push({ name: '', category: 'indoor', summary: '', specs: {} });
    const j = await AL.draftJob(id);
    assert.equal(j.status, 'failed');
    assert.match(j.error, /名称必填|参数/);
    listing.push(exDraft({ name: 'Retry Light', specs: {} }));
    // still no verifiable specs → fails again; then skipped by a person
    assert.equal((await AL.draftJob(id)).status, 'failed');
    AL.skipJob(id);
    assert.equal(AL.getJob(id).status, 'skipped');
    await assert.rejects(AL.draftJob('nope'), /任务不存在/);
  });
});

describe('settings, auto-publish and GEO promotion', () => {
  test('AL-09 settings validation; saved defaults are used and no longer flagged', () => {
    assert.throws(() => AL.saveAutolistSettings({ warranty: '', unit: 'pcs', moq: '0', lead_min: '9', lead_max: '3', sample_min: '1', sample_max: '2' }), /质保[\s\S]*起订量[\s\S]*生产交期/);
    const s = AL.saveAutolistSettings({ autoPublish: '1', promote: '1', warranty: '3 years', unit: 'pcs', moq: '10', lead_min: '10', lead_max: '20', sample_min: '3', sample_max: '5' });
    assert.equal(s.autoPublish, true);
    assert.equal(AL.autolistSettings().fromCatalog, false);
  });
  test('AL-10 auto-publish: a clean AI draft goes live, the catalog is published and the product promoted (IndexNow, GEO questions, article)', async () => {
    llm.calls.length = 0;
    listing.push({ name: 'LED Tunnel Light 150W', nameZh: 'LED 隧道灯 150W', category: 'flood', summary: 'Tunnel light for road tunnels.', specs: { Power: '150W', 'Luminous efficacy': '140lm/W', 'IP rating': 'IP66', 'Impact rating': 'IK08' }, highlights: ['140 lm/W', 'IK08', 'IP66'], certifications: [] });
    const out = await AL.runQueue({ limit: 1 });
    assert.equal(out[0].source_ref, 'MAT-LED-9002');
    assert.equal(out[0].status, 'published');
    assert.deepEqual(out[0].issues, []);
    const p = C.getProduct('MAT-LED-9002');
    assert.equal(p._status, 'published');
    assert.equal(p.warranty, '3 years');
    assert.equal(p.moq, 10);
    assert.ok(config.catalog.products.some((x) => x.id === 'MAT-LED-9002')); // live for AI sales / MCP
    // promotion runs in the background
    for (let i = 0; i < 50 && !AL.listPromotions().length; i++) await new Promise((r) => setTimeout(r, 20));
    const promo = AL.listPromotions()[0];
    assert.equal(promo.product_id, 'MAT-LED-9002');
    const idx = llm.calls.find((c) => c.url === '/indexnow');
    assert.ok(idx.body.urlList.some((u) => u.endsWith(`/products/${p.slug}/`)));
    assert.ok(AL.extraGeoQuestions().some((q) => q.product === 'MAT-LED-9002' && /tunnel light/i.test(q.q)));
    const art = promo.actions.find((a) => a.kind === 'article');
    assert.equal(art.status, 'draft'); // CONTENT_AUTO_PUBLISH=false → waits for review
    assert.ok(llm.calls.some((c) => c.url === '/v1/messages' && /You write articles/.test(c.body.system) && /LED Tunnel Light 150W: specifications/.test(c.body.messages[0].content)));
  });
  test('AL-11 a flagged draft is not auto-published even with auto-publish on', async () => {
    const id = AL.queueFromText('YR-SL-88 Solar street light 30W\nBattery: LiFePO4 12.8V 18Ah\nIP65');
    listing.push({ name: 'Solar Street Light 30W', category: 'area', summary: 'Solar street light.', specs: { Power: '30W', Battery: 'LiFePO4 12.8V 18Ah', Autonomy: '3 nights' }, certifications: ['UL'] });
    const j = await AL.draftJob(id);
    assert.equal(j.status, 'drafted');
    assert.equal(C.getProduct(j.product_id)._status, 'draft');
    assert.ok(j.issues.some((i) => /UL/.test(i)));
  });
  test('AL-12 publishing again does not re-promote products that were already live; GEO monitor asks the new questions', async () => {
    const before = AL.listPromotions().length;
    const r = await AL.publishAndPromote({ rebuildSite: false });
    assert.deepEqual(r.fresh, []);
    assert.equal(AL.listPromotions().length, before);
    const { runGeoCheck } = await import('../../server/src/content/geo.js');
    const geoQs = AL.extraGeoQuestions().map((q) => q.q);
    const res = await runGeoCheck().catch(() => []);
    assert.ok(geoQs.every((q) => res.some((x) => x.q === q)));
    assert.ok(db.prepare('SELECT COUNT(*) n FROM listing_jobs').get().n >= 6);
  });
  test('AL-13 rule draft from pasted text: model code becomes the id, name without the code, every spec line parsed', async () => {
    const job = jobsBy('queued').find((j) => j.source_ref === 'YR-SL-77');
    listing.push('FAIL');
    const j = await AL.draftJob(job.id);
    assert.equal(j.product_id, 'YR-SL-77');
    const p = C.getProduct('YR-SL-77');
    assert.equal(p.name, 'Solar street light 60W');
    assert.deepEqual(p.specs, { Battery: 'LiFePO4 12.8V 30Ah', Panel: '80W mono' });
    assert.equal(p.slug, 'solar-street-light-60w');
  });
});
