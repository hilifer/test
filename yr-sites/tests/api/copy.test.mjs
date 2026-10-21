// Black-box: titles & prompts over HTTP — AI title suggestions with a reference page, applying and changing back,
// banned words on product save, banned-word list and text check, prompt templates and prompt optimisation, AI image
// compliance check before listing, phone / desktop preview, roles, English UI. Mock model and mock reference site. IDs CP-xx.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { startServer, flash } from '../helpers/server.mjs';
import { mockServer } from '../helpers/mock-http.mjs';

let api, llm, site;
let titles = ['UFO High Bay 100-240W DLC Premium for Warehouses', 'Best UFO High Bay Light', 'FDA approved UFO lamp'];
before(async () => {
  llm = await mockServer((call) => {
    const c = call.body.messages?.[0]?.content;
    if (Array.isArray(c) && c[0]?.type === 'image') return { json: { content: [{ type: 'text', text: '{"issues":[{"type":"watermark","detail":"右下角有其他店铺的水印"},{"type":"brand","detail":"灯罩上有第三方品牌标志"}]}' }], stop_reason: 'end_turn' } };
    if (/Rewrite the user's rough request/.test(call.body.system || '')) return { json: { content: [{ type: 'text', text: '纯白背景，商品居中，突出灯珠，800×800' }], stop_reason: 'end_turn' } };
    if (/product titles/.test(call.body.system || '')) return { json: { content: [{ type: 'text', text: JSON.stringify({ titles }) }], stop_reason: 'end_turn' } };
    return { json: { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' } };
  });
  site = await mockServer(() => ({ text: '<html><head><title>Rival 200W UFO LED High Bay | Rival</title><script type="application/ld+json">{"@type":"Product","name":"Rival 200W UFO LED High Bay Light"}</script></head><body></body></html>', headers: { 'content-type': 'text/html' } }));
  api = await startServer({ site: 'led', env: { LLM_PROVIDER: 'anthropic', LLM_API_KEY: 'k', LLM_MODEL: 'claude-opus-5-5', LLM_BASE_URL: llm.url, PULL_ALLOW_PRIVATE: 'true' } });
  for (const [u, role] of [['dee', 'designer'], ['sam', 'sales'], ['fin', 'finance']]) await api.form('/admin/users/new', { username: u, role, password: PW });
});
after(async () => { await api.stop(); await llm.close(); await site.close(); });

const PW = 'Str0ngPassw0rd';
const auth = (u) => ({ authorization: 'Basic ' + Buffer.from(`${u}:${PW}`).toString('base64') });
const ADMIN = { authorization: 'Basic ' + Buffer.from('admin:test-pass').toString('base64') };
const form = (h, path, data) => fetch(api.url + path, { method: 'POST', redirect: 'manual', headers: { ...h, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data) });
const page = async (path, h = ADMIN) => (await fetch(api.url + path, { headers: h })).text();
const multipart = (path, fields, h = ADMIN) => { const fd = new FormData(); for (const [k, v] of Object.entries(fields)) fd.append(k, String(v)); return fetch(api.url + path, { method: 'POST', body: fd, redirect: 'manual', headers: h }); };
const productForm = (o = {}) => ({
  id: 'CP-UFO-1', name: 'Copy UFO 150W', category: 'high-bay', summary: 'UFO high bay.', status: 'draft', salesMode: 'both', illus: 'ufo', highlights: '160 lm/W', applications: 'warehouse', certifications: 'CE', keywords: 'ufo',
  specs: 'Power: 150 W', warranty: '5 years', unit: 'pcs', moq: '10', lead_min: '15', lead_max: '25', sample_min: '5', sample_max: '7', wattMin: '150', wattMax: '150', priceBands: '',
  v_0_sku: 'CP-UFO-1-50K', v_0_options: 'CCT=5000K', v_0_price: '30', v_0_weight_kg: '3', v_0_stock_local: '100', action: 'save', ...o,
});

test('CP-01 roles: designers use titles & prompts; sales can look but not change; finance has no access', async () => {
  for (const p of ['/admin/copy', '/admin/copy/prompts', '/admin/copy/banned']) assert.equal((await fetch(api.url + p, { headers: auth('dee') })).status, 200, p);
  assert.equal((await fetch(`${api.url}/admin/copy`, { headers: auth('sam') })).status, 200);
  assert.equal((await form(auth('sam'), '/admin/copy/apply', { product: 'YR-HB-U2', lang: 'en', title: 'x' })).status, 403);
  assert.equal((await fetch(`${api.url}/admin/copy`, { headers: auth('fin') })).status, 403);
  assert.match(await page('/admin/products/YR-HB-U2', auth('dee')), /href="\/admin\/copy\?product=YR-HB-U2">优化标题/);
});

test('CP-02 AI title suggestions use the reference page title; banned words are marked and block titles cannot be applied', async () => {
  const r = await form(auth('dee'), '/admin/copy/titles', { product: 'YR-HB-U2', lang: 'en', direction: 'seo', template: '', keywords: 'warehouse light', reference: `${site.url}/rival` });
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /AI 生成/);
  assert.match(html, /UFO High Bay 100-240W DLC Premium for Warehouses[\s\S]*?✓ 无违禁词/);
  assert.match(html, /<span class="hit warn"[^>]*>Best<\/span>/);
  assert.match(html, /<span class="hit "[^>]*>FDA approved<\/span>[\s\S]*?<button disabled>应用到商品/);
  assert.match(llm.calls.at(-1).body.messages[0].content, /Rival 200W UFO LED High Bay Light/);
  const bad = await form(auth('dee'), '/admin/copy/titles', { product: 'YR-HB-U2', lang: 'en', direction: 'seo', reference: 'http://' });
  assert.match(flash(bad).err, /参考页面打不开/);
});

test('CP-03 apply a title, see it in the history and change it back; banned titles refused', async () => {
  const a = await form(auth('dee'), '/admin/copy/apply', { product: 'YR-HB-U2', lang: 'en', title: 'UFO High Bay 100-240W DLC Premium for Warehouses', source: 'ai' });
  assert.match(flash(a).ok, /标题已应用/);
  let html = await page('/admin/copy?product=YR-HB-U2', auth('dee'));
  assert.match(html, /英文：<b translate="no">UFO High Bay 100-240W DLC Premium for Warehouses<\/b>/);
  assert.match(html, /<td translate="no">UFO High Bay 100-240W DLC Premium for Warehouses<\/td><td class="mute" translate="no">UFO High Bay U2<\/td><td>AI<\/td><td>dee<\/td>/);
  const back = await form(auth('dee'), '/admin/copy/apply', { product: 'YR-HB-U2', lang: 'en', title: 'UFO High Bay U2', source: 'revert' });
  assert.match(flash(back).ok, /已应用/);
  html = await page('/admin/copy?product=YR-HB-U2', auth('dee'));
  assert.match(html, /英文：<b translate="no">UFO High Bay U2<\/b>/);
  assert.match(html, /<td>改回<\/td>/);
  assert.match(flash(await form(auth('dee'), '/admin/copy/apply', { product: 'YR-HB-U2', lang: 'zh', title: '国内第一 UFO 工矿灯' })).err, /违禁词：第一/);
});

test('CP-04 product save: "block" words stop it with the field named, "warn" words save with a warning', async () => {
  const bad = await multipart('/admin/products/new', productForm({ summary: 'Kills bacteria in your warehouse.' }), auth('dee'));
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /违禁词：简介 &quot;Kills bacteria&quot;（医疗功效宣称）/);
  const ok = await multipart('/admin/products/new', productForm({ summary: 'The cheapest way to light a warehouse.' }), auth('dee'));
  assert.equal(ok.status, 302);
  assert.match(new URL(ok.headers.get('location'), api.url).searchParams.get('w'), /建议修改：简介 "cheapest"（绝对化用语）/);
});

test('CP-05 banned-word list: add, check a text, switch a built-in off and on again', async () => {
  assert.match(flash(await form(auth('dee'), '/admin/copy/banned', { word: 'miracle', lang: 'en', level: 'block', reason: '夸大' })).ok, /已添加/);
  let html = await page('/admin/copy/banned', auth('dee'));
  assert.match(html, /<td translate="no"><b>miracle<\/b><\/td><td>English<\/td><td><span class="pill" style="background:#fdecea">禁止<\/span><\/td><td translate="no">夸大<\/td><td>自定义<\/td>/);
  const chk = await (await form(auth('dee'), '/admin/copy/check', { text: 'A miracle lamp, the best in town' })).text();
  assert.match(chk, /<span class="hit "[^>]*>miracle<\/span>[\s\S]*<span class="hit warn"[^>]*>best<\/span>/);
  await form(auth('dee'), '/admin/copy/banned/delete', { word: 'best' });
  html = await page('/admin/copy/banned', auth('dee'));
  assert.match(html, /恢复「<span translate="no">best<\/span>」/);
  assert.doesNotMatch(await (await form(auth('dee'), '/admin/copy/check', { text: 'the best' })).text(), /class="hit/);
  await form(auth('dee'), '/admin/copy/banned/restore', { word: 'best' });
  assert.match(await (await form(auth('dee'), '/admin/copy/check', { text: 'the best' })).text(), /class="hit warn/);
  assert.match(flash(await form(auth('dee'), '/admin/copy/banned', { word: '' })).err, /1–60/);
});

test('CP-06 prompt optimisation and templates: optimise, save as template, copy a built-in, delete', async () => {
  const html = await (await form(auth('dee'), '/admin/copy/prompt', { text: '白底，突出灯珠', purpose: 'image', lang: 'zh' })).text();
  assert.match(html, /<pre id="optimised" translate="no"[^>]*>纯白背景，商品居中，突出灯珠，800×800<\/pre>/);
  assert.match(flash(await form(auth('dee'), '/admin/copy/templates', { name: '灯珠特写', kind: 'image', lang: 'zh', body: '纯白背景，商品居中，突出灯珠，800×800' })).ok, /模板已保存/);
  let list = await page('/admin/copy/prompts', auth('dee'));
  assert.match(list, /<b>灯珠特写<\/b>/);
  const copy = await page('/admin/copy/prompts?edit=b-title-seo-en', auth('dee'));
  assert.match(copy, /复制「SEO title \(English\)」[\s\S]*value="SEO title \(English\)（副本）"/);
  const id = list.match(/edit=([\w-]+)#tpl">编辑/)[1];
  assert.match(flash(await form(auth('dee'), `/admin/copy/templates/${id}/delete`, {})).ok, /已删除/);
  assert.match(flash(await form(auth('dee'), '/admin/copy/templates/b-title-zh/delete', {})).err, /内置/);
  list = await page('/admin/copy/prompts', auth('dee'));
  assert.doesNotMatch(list, /灯珠特写/);
});

test('CP-07 AI image compliance check: issues listed on the asset and repeated as a warning when listing it', async () => {
  const img = await sharp({ create: { width: 1000, height: 1000, channels: 3, background: '#ffffff' } }).composite([{ input: Buffer.from('<svg width="1000" height="1000"><rect x="300" y="300" width="400" height="400" fill="#1565c0"/></svg>') }]).jpeg().toBuffer();
  const fd = new FormData(); fd.append('files', new Blob([img], { type: 'image/jpeg' }), 'check.jpg'); fd.append('product', 'YR-HB-U2');
  await fetch(`${api.url}/admin/assets/upload`, { method: 'POST', body: fd, headers: { ...auth('dee'), 'x-requested-with': 'fetch' } });
  const id = (await page('/admin/assets?view=list&q=check', auth('dee'))).match(/name="ids" value="([\w-]+)"/)[1];
  assert.match(await page(`/admin/assets/${id}`, auth('dee')), /AI 合规检查[\s\S]*还没有检查过[\s\S]*检查正式版/);
  const r = await form(auth('dee'), `/admin/assets/${id}/compliance`, {});
  assert.match(flash(r).err, /发现 2 个问题/);
  const html = await page(`/admin/assets/${id}`, auth('dee'));
  assert.match(html, /<li>水印 \/ 其他店铺标记：右下角有其他店铺的水印<\/li><li>第三方品牌标志：灯罩上有第三方品牌标志<\/li>/);
  assert.match(html, /v1 · dee/);
  const pub = await form(auth('dee'), '/admin/assets/publish', { ids: id, product: 'YR-HB-U2', position: 'gallery' });
  assert.match(decodeURIComponent(pub.headers.get('location')), /AI 合规检查发现 2 个问题（右下角有其他店铺的水印/);
});

test('CP-08 phone / desktop preview shows the live product page in two frames', async () => {
  const html = await page('/admin/products/YR-HB-U2/preview', auth('dee'));
  assert.equal((html.match(/<iframe src="[^"]*\/products\/ufo-high-bay-u2\/"/g) || []).length, 2);
  assert.match(html, /手机（390 px）[\s\S]*电脑（1280 px/);
  assert.match(await page('/admin/products/CP-UFO-1/preview', auth('dee')), /这个商品还没有上架/);
});

test('CP-09 in English the titles, prompts and banned-word pages have no Chinese outside content marked translate="no"', async () => {
  const EN = { ...auth('dee'), cookie: 'yr_admin_lang=en' };
  const strip = (h) => h.replace(/<textarea[\s\S]*?<\/textarea>/g, '').replace(/<(span|b|pre|td|div)\b[^>]*\stranslate="no"[^>]*>[\s\S]*?<\/\1>/g, '').replace(/\svalue="[^"]*"/g, '').replace(/<option value="[\w-]+"[^>]*>[^<]*<\/option>/g, '');
  for (const p of ['/admin/copy?product=YR-HB-U2', '/admin/copy/prompts', '/admin/copy/banned', '/admin/products/YR-HB-U2/preview']) {
    const left = strip(await page(p, EN)).replace(/<script[\s\S]*?<\/script>|<[^>]+>/g, ' ').match(/[^\s]{0,20}[一-鿿]+[^\s]{0,20}/);
    assert.equal(left, null, `${p}: ${left?.[0]}`);
  }
  const t = await (await fetch(`${api.url}/admin/copy/titles`, { method: 'POST', headers: { ...EN, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ product: 'YR-HB-U2', lang: 'en', direction: 'b2b' }) })).text();
  assert.match(t, /Suggested titles/);
  assert.match(t, /Use on product/);
  assert.match(t, /Advertising law|Absolute claim|Medical claim|Lighting products are not FDA approved/);
});
