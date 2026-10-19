// Black-box: AI negotiation & e-contracts over HTTP — the AI agent (LLM mocked) negotiates through prepare_offer and issues
// a contract; the buyer signs in the portal; approval queue, policy and contracts admin with roles; staff-made contracts;
// buyer AI agents over MCP. IDs DA-xx.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, flash } from '../helpers/server.mjs';
import { mockServer } from '../helpers/mock-http.mjs';

const turns = [];
let llm, api;
before(async () => {
  llm = await mockServer(() => { const next = turns.shift(); if (!next) return { status: 500, text: 'no scripted reply' }; return typeof next === 'function' ? next() : next; });
  api = await startServer({ site: 'led', env: { LLM_PROVIDER: 'anthropic', LLM_API_KEY: 'k', LLM_MODEL: 'claude-opus-5-5', LLM_BASE_URL: llm.url, TRUSTED_PROXY_HOPS: '1' } });
});
after(async () => { await api.stop(); await llm.close(); });

const toolUse = (name, input, id = 't1') => ({ json: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] } });
const say = (text) => ({ json: { stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
const lastToolResult = () => JSON.parse(llm.calls.at(-1).body.messages.at(-1).content[0].content);
const PW = 'Str0ngPassw0rd';
const as = (u) => ({
  get: (p) => fetch(api.url + p, { redirect: 'manual', headers: { authorization: 'Basic ' + Buffer.from(`${u}:${PW}`).toString('base64') } }),
  form: (p, d) => fetch(api.url + p, { method: 'POST', redirect: 'manual', headers: { authorization: 'Basic ' + Buffer.from(`${u}:${PW}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(d) }),
});
const rpc = async (method, params) => (await api.json('/mcp', { jsonrpc: '2.0', id: 1, method, params })).json();
const ctx = {};

test('DA-01 AI negotiates: lowball target → counter-offer from the server; the model only sees the result', async () => {
  const sessionId = 'neg-session-1';
  turns.push(toolUse('prepare_offer', { email: 'buyer@acme-lighting.test', company: 'Acme Lighting', name: 'Pat Lee', country: 'US', lines: [{ product_id: 'YR-HB-U2', qty: 200, target_price: 1 }], incoterm: 'FOB', payment_terms: 'tt30' }),
    () => { const r = lastToolResult(); ctx.offer = r; return say(`Our best price is US$${r.lines[0].unit_price} per unit FOB, valid until ${r.valid_until}. Reference: subject to the formal PI.`); });
  const r = await (await api.json('/api/chat', { sessionId, message: 'I need 200 UFO high bays at $1 each, email buyer@acme-lighting.test' })).json();
  assert.equal(ctx.offer.status, 'counter_offer');
  const l = ctx.offer.lines[0];
  assert.ok(l.unit_price < l.list_price && l.unit_price >= Math.round(l.list_price * 0.97 * 100) / 100 - 0.01, `${l.unit_price} vs list ${l.list_price}`); // B grade, round 1 = half of 6 %
  assert.doesNotMatch(JSON.stringify(ctx.offer), /floor|maxDiscount|grade/i);
  assert.match(r.reply, new RegExp(`US\\$${l.unit_price}`));
  const sys = llm.calls.find((c) => c.body.tools?.some((t) => t.name === 'prepare_offer')).body.system;
  assert.match(sys, /negotiate price only through prepare_offer/);
});

test('DA-02 buyer accepts → AI issues the contract; link goes to the buyer\'s e-mail, not into the chat', async () => {
  turns.push(toolUse('issue_contract', { offer_id: ctx.offer.offer_id, email: 'buyer@acme-lighting.test' }), () => { ctx.issue = lastToolResult(); return say(`Done — contract ${ctx.issue.contract_number} has been e-mailed to buyer@acme-lighting.test for e-signature.`); });
  const r = await (await api.json('/api/chat', { sessionId: 'neg-session-1', message: 'OK, deal.' })).json();
  assert.equal(ctx.issue.issued, true);
  assert.doesNotMatch(r.reply, /portal\/contract/);
  const list = await (await api.admin('/admin/contracts')).text();
  ctx.kid = list.match(new RegExp(`/admin/contracts/([\\w-]+)"><b>${ctx.issue.contract_number}`))[1];
  const page = await (await api.admin(`/admin/contracts/${ctx.kid}`)).text();
  ctx.sign = page.match(/<code>([^<]*\/portal\/contract\/[\w-]+)<\/code>/)[1].replace(/^https?:\/\/[^/]+/, '');
  assert.match(page, /待客户签署/);
  assert.match(page, /来自 AI 议价/);
});

test('DA-03 portal signing: page shows the contract; consent required; cross-site post refused; signed → order; IP from the proxy', async () => {
  const view = await (await api.get(ctx.sign)).text();
  assert.match(view, /Sales Contract/);
  assert.match(view, /Acme Lighting/);
  assert.match(view, /Document fingerprint \(SHA-256\): [0-9a-f]{64} — intact/);
  const post = (data, headers = {}) => fetch(api.url + ctx.sign, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '198.51.100.7', 'user-agent': 'DA-Test', ...headers }, body: new URLSearchParams(data) });
  const noConsent = await post({ name: 'Pat Lee' });
  assert.equal(noConsent.status, 400);
  assert.match(await noConsent.text(), /read and agree/);
  assert.equal((await post({ name: 'Pat Lee', agree: '1' }, { origin: 'https://evil.test' })).status, 403);
  const ok = await post({ name: 'Pat Lee', title: 'Buyer', agree: '1' });
  const html = await ok.text();
  assert.equal(ok.status, 200);
  ctx.order = html.match(/SO-\d{6}-\d{3}/)[0];
  assert.match(html, /Signed electronically by <b>Pat Lee<\/b>, Buyer/);
  assert.match(html, /IP 198\.51\.100\.7/);
  assert.match(html, /Signature record: [0-9a-f]{64} — valid/);
  const again = await post({ name: 'Pat Lee', agree: '1' });
  assert.equal(again.status, 400);
  assert.match(await again.text(), /already been signed/);
  assert.match(await (await api.admin('/admin/orders')).text(), new RegExp(ctx.order));
  assert.match(await (await api.admin(`/admin/contracts/${ctx.kid}`)).text(), /已签署[\s\S]*DA-Test/);
  assert.equal((await api.get('/portal/contract/not-a-token')).status, 404);
});

test('DA-04 roles: sales sees deals and manages contracts; finance sets policy/floors and approves; template is admin-only', async () => {
  for (const [u, role] of [['sales1', 'sales'], ['fin1', 'finance'], ['cnt1', 'content']]) await api.form('/admin/users/new', { username: u, role, password: PW });
  const sales = as('sales1'), fin = as('fin1'), cnt = as('cnt1');
  assert.equal((await sales.get('/admin/deals')).status, 200);
  assert.equal((await sales.get('/admin/deals/policy')).status, 403);
  assert.equal((await sales.form('/admin/deals/policy', { pct_A: '30' })).status, 403);
  assert.equal((await sales.form('/admin/deals/x/decide', { decision: 'approve' })).status, 403);
  assert.equal((await fin.get('/admin/deals/policy')).status, 200);
  assert.equal((await fin.get('/admin/contracts')).status, 200);
  assert.equal((await fin.form(`/admin/contracts/${ctx.kid}/void`, { reason: 'x' })).status, 403);
  assert.equal((await sales.get('/admin/contracts/template')).status, 403);
  assert.equal((await fin.get('/admin/contracts/template')).status, 403);
  assert.equal((await cnt.get('/admin/deals')).status, 403);
  assert.equal((await api.get('/admin/deals')).status, 401);
});

test('DA-05 finance policy: validation, floors; over-cap request → approval queue → finance approves with a price (not below floor) → contract', async () => {
  const fin = as('fin1');
  assert.match(flash(await fin.form('/admin/deals/policy', { enabled: '1', pct_A: '99', pct_B: '6', pct_C: '3', maxOrderValue: '30000', maxRounds: '3', validityDays: '7', paymentTerms: 'tt30', incoterms: 'FOB' })).err, /A 级/);
  const body = new URLSearchParams([['enabled', '1'], ['pct_A', '10'], ['pct_B', '6'], ['pct_C', '3'], ['maxOrderValue', '5000'], ['maxRounds', '3'], ['validityDays', '7'], ['paymentTerms', 'tt30'], ['paymentTerms', 'tt100'], ['incoterms', 'FOB'], ['incoterms', 'EXW']]);
  const saved = await fetch(`${api.url}/admin/deals/policy`, { method: 'POST', redirect: 'manual', headers: { authorization: 'Basic ' + Buffer.from(`fin1:${PW}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' }, body });
  assert.match(flash(saved).ok, /政策已保存/);
  assert.match(await (await fin.get('/admin/deals/policy')).text(), /name="paymentTerms" value="tt100" checked/);
  assert.match(flash(await fin.form('/admin/deals/floors', { 'floor_YR-HB-U2': '40' })).ok, /已更新 1 个底价/);
  assert.match(flash(await fin.form('/admin/deals/floors', { 'floor_YR-HB-U2': '-5' })).err, /大于 0/);
  // the floor never reaches the public product API or MCP
  assert.doesNotMatch(await (await api.get('/api/shop/product/YR-HB-U2')).text(), /floor/i);
  const r = (await rpc('tools/call', { name: 'prepare_offer', arguments: { email: 'big@distri.test', company: 'Distri', lines: [{ product_id: 'YR-HB-U2', qty: 1000 }] } })).result.structuredContent;
  assert.equal(r.status, 'needs_approval');
  const queue = await (await fin.get('/admin/deals?status=needs_approval')).text();
  const id = queue.match(new RegExp(`/admin/deals/([\\w-]+)"><b>${r.offer_id}`))[1];
  assert.match(queue, /超过 AI 可成交金额/);
  assert.match(flash(await fin.form(`/admin/deals/${id}/decide`, { decision: 'approve', 'price_YR-HB-U2': '30' })).err, /低于底价 40/);
  const ok = flash(await fin.form(`/admin/deals/${id}/decide`, { decision: 'approve', 'price_YR-HB-U2': '41', note: 'volume' }));
  assert.match(ok.ok, /已批准，合同 SC-\d{6}-\d{3} 已发到 big@distri\.test/);
  assert.match(await (await fin.get(`/admin/deals/${id}`)).text(), /已发合同[\s\S]*fin1/);
});

test('DA-06 MCP: buyer agents can get an offer; a contract only goes to the offer\'s own e-mail', async () => {
  const r = (await rpc('tools/call', { name: 'prepare_offer', arguments: { email: 'agent@buyer-ai.test', lines: [{ product_id: 'YR-HB-U2', qty: 60 }] } })).result.structuredContent;
  assert.equal(r.status, 'offer');
  const bad = (await rpc('tools/call', { name: 'issue_contract', arguments: { offer_id: r.offer_id, email: 'attacker@evil.test' } })).result.structuredContent;
  assert.equal(bad.error, 'email_mismatch');
  const good = (await rpc('tools/call', { name: 'issue_contract', arguments: { offer_id: r.offer_id, email: 'agent@buyer-ai.test' } })).result.structuredContent;
  assert.equal(good.issued, true);
  assert.equal(good.sent_to, 'agent@buyer-ai.test');
});

test('DA-07 staff contract from a PI; the PI accept button then requires signing; void by sales; template edit by admin', async () => {
  const created = await api.form('/admin/quotes/new', { email: 'manual@buyer-co.test', company: 'Manual Co' });
  const qid = created.headers.get('location').split('/').pop();
  await api.form(`/admin/quotes/${qid}/save`, { sku_0: 'YR-HB-U2', qty_0: '100', price_0: '45', currency: 'USD', incoterm: 'FOB', payment_terms: 'tt30', validity_days: '15', action: 'save' });
  assert.match(await (await api.admin(`/admin/quotes/${qid}`)).text(), /生成合同并发给客户签署/);
  const k = flash(await as('sales1').form(`/admin/quotes/${qid}/contract`, {}));
  assert.match(k.ok, /合同 SC-\d{6}-\d{3} 已生成并发到客户邮箱/);
  const quotePage = await (await api.admin(`/admin/quotes/${qid}`)).text();
  assert.match(quotePage, /已发送，待客户签署/);
  const piLink = quotePage.match(/\/portal\/pi\/[\w-]+/)[0];
  const accept = await fetch(api.url + piLink, { method: 'POST', redirect: 'manual' });
  assert.equal(accept.status, 302);
  assert.match(accept.headers.get('location'), /^\/portal\/contract\//);
  const kid = k.path.split('/').pop();
  assert.match(flash(await as('sales1').form(`/admin/contracts/${kid}/void`, { reason: '' })).err, /作废原因/);
  assert.match(flash(await as('sales1').form(`/admin/contracts/${kid}/void`, { reason: 'price changed' })).ok, /已作废/);
  assert.match(flash(await api.form('/admin/contracts/template', { template: 'short' })).err, /太短/);
  const tpl = (await (await api.admin('/admin/contracts/template')).text()).match(/<textarea name="template"[^>]*>([\s\S]*?)<\/textarea>/)[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  assert.match(flash(await api.form('/admin/contracts/template', { template: tpl + '\n\n## 10. Language\nThis contract is made in English.' })).ok, /模板已保存/);
});
