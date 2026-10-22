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

test('DA-01a AI negotiates: a lowball target price gets a counter_offer from the server', async () => {
  const sessionId = 'neg-session-1';
  turns.push(toolUse('prepare_offer', { email: 'buyer@acme-lighting.test', company: 'Acme Lighting', name: 'Pat Lee', country: 'US', lines: [{ product_id: 'YR-HB-U2', qty: 200, target_price: 1 }], incoterm: 'FOB', payment_terms: 'tt30' }),
    () => { const r = lastToolResult(); ctx.offer = r; return say(`Our best price is US$${r.lines[0].unit_price} per unit FOB, valid until ${r.valid_until}. Reference: subject to the formal PI.`); });
  ctx.negReply = (await (await api.json('/api/chat', { sessionId, message: 'I need 200 UFO high bays at $1 each, email buyer@acme-lighting.test' })).json()).reply;
  assert.equal(ctx.offer.status, 'counter_offer');
});
test('DA-01b the first counter-offer is below list price but within half of the grade-B discount', async () => {
  const l = ctx.offer.lines[0];
  assert.ok(l.unit_price < l.list_price && l.unit_price >= Math.round(l.list_price * 0.97 * 100) / 100 - 0.01, `${l.unit_price} vs list ${l.list_price}`); // B grade, round 1 = half of 6 %
});
test('DA-01c the offer the model sees reveals no floor price, discount cap or customer grade', async () => {
  assert.doesNotMatch(JSON.stringify(ctx.offer), /floor|maxDiscount|grade/i);
});
test('DA-01d the reply to the buyer quotes the server-computed unit price', async () => {
  const l = ctx.offer.lines[0];
  assert.match(ctx.negReply, new RegExp(`US\\$${l.unit_price}`));
});
test('DA-01e the system prompt tells the model to negotiate price only through prepare_offer', async () => {
  const sys = llm.calls.find((c) => c.body.tools?.some((t) => t.name === 'prepare_offer')).body.system;
  assert.match(sys, /negotiate price only through prepare_offer/);
});

test('DA-02a when the buyer accepts, the AI issues the contract', async () => {
  turns.push(toolUse('issue_contract', { offer_id: ctx.offer.offer_id, email: 'buyer@acme-lighting.test' }), () => { ctx.issue = lastToolResult(); return say(`Done — contract ${ctx.issue.contract_number} has been e-mailed to buyer@acme-lighting.test for e-signature.`); });
  ctx.issueReply = (await (await api.json('/api/chat', { sessionId: 'neg-session-1', message: 'OK, deal.' })).json()).reply;
  assert.equal(ctx.issue.issued, true);
});
test('DA-02b the signing link is not put into the chat reply', async () => {
  assert.doesNotMatch(ctx.issueReply, /portal\/contract/);
});
test('DA-02c the issued contract is listed in the admin as awaiting signature, from AI negotiation', async () => {
  const list = await (await api.admin('/admin/contracts')).text();
  ctx.kid = list.match(new RegExp(`/admin/contracts/([\\w-]+)"><b>${ctx.issue.contract_number}`))[1];
  const page = await (await api.admin(`/admin/contracts/${ctx.kid}`)).text();
  ctx.sign = page.match(/<code>([^<]*\/portal\/contract\/[\w-]+)<\/code>/)[1].replace(/^https?:\/\/[^/]+/, '');
  assert.match(page, /待客户签署/);
  assert.match(page, /来自 AI 议价/);
});

const sign = (data, headers = {}) => fetch(api.url + ctx.sign, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '198.51.100.7', 'user-agent': 'DA-Test', ...headers }, body: new URLSearchParams(data) });
test('DA-03a the portal signing page shows the contract, the buyer and an intact document fingerprint', async () => {
  const view = await (await api.get(ctx.sign)).text();
  assert.match(view, /Sales Contract/);
  assert.match(view, /Acme Lighting/);
  assert.match(view, /Document fingerprint \(SHA-256\): [0-9a-f]{64} — intact/);
});
test('DA-03b signing without ticking "read and agree" is refused (400)', async () => {
  const noConsent = await sign({ name: 'Pat Lee' });
  assert.equal(noConsent.status, 400);
  assert.match(await noConsent.text(), /read and agree/);
});
test('DA-03c a cross-site signing post is refused (403)', async () => {
  assert.equal((await sign({ name: 'Pat Lee', agree: '1' }, { origin: 'https://evil.test' })).status, 403);
});
test('DA-03d signing with consent succeeds, creates an order and shows the signer', async () => {
  const ok = await sign({ name: 'Pat Lee', title: 'Buyer', agree: '1' });
  const html = ctx.signed = await ok.text();
  assert.equal(ok.status, 200);
  ctx.order = html.match(/SO-\d{6}-\d{3}/)[0];
  assert.match(html, /Signed electronically by <b>Pat Lee<\/b>, Buyer/);
});
test('DA-03e the signature records the client IP taken from the trusted proxy header', async () => {
  assert.match(ctx.signed, /IP 198\.51\.100\.7/);
});
test('DA-03f the signed contract shows a valid signature record hash', async () => {
  assert.match(ctx.signed, /Signature record: [0-9a-f]{64} — valid/);
});
test('DA-03g a second signing of the same contract is refused (400)', async () => {
  const again = await sign({ name: 'Pat Lee', agree: '1' });
  assert.equal(again.status, 400);
  assert.match(await again.text(), /already been signed/);
});
test('DA-03h the order created by signing appears in the admin order list', async () => {
  assert.match(await (await api.admin('/admin/orders')).text(), new RegExp(ctx.order));
});
test('DA-03i the admin contract page shows it as signed with the signer\'s user agent', async () => {
  assert.match(await (await api.admin(`/admin/contracts/${ctx.kid}`)).text(), /已签署[\s\S]*DA-Test/);
});
test('DA-03j an unknown contract token is 404', async () => {
  assert.equal((await api.get('/portal/contract/not-a-token')).status, 404);
});

const sales = as('sales1'), fin = as('fin1'), cnt = as('cnt1');
test('DA-04a roles: sales can open the deals list', async () => {
  for (const [u, role] of [['sales1', 'sales'], ['fin1', 'finance'], ['cnt1', 'content']]) await api.form('/admin/users/new', { username: u, role, password: PW });
  assert.equal((await sales.get('/admin/deals')).status, 200);
});
test('DA-04b roles: sales can neither view nor change the negotiation policy (403)', async () => {
  assert.equal((await sales.get('/admin/deals/policy')).status, 403);
  assert.equal((await sales.form('/admin/deals/policy', { pct_A: '30' })).status, 403);
});
test('DA-04c roles: sales cannot approve deals (403)', async () => {
  assert.equal((await sales.form('/admin/deals/x/decide', { decision: 'approve' })).status, 403);
});
test('DA-04d roles: finance can open the policy and the contracts list', async () => {
  assert.equal((await fin.get('/admin/deals/policy')).status, 200);
  assert.equal((await fin.get('/admin/contracts')).status, 200);
});
test('DA-04e roles: finance cannot void a contract (403)', async () => {
  assert.equal((await fin.form(`/admin/contracts/${ctx.kid}/void`, { reason: 'x' })).status, 403);
});
test('DA-04f roles: the contract template is admin-only (sales and finance 403)', async () => {
  assert.equal((await sales.get('/admin/contracts/template')).status, 403);
  assert.equal((await fin.get('/admin/contracts/template')).status, 403);
});
test('DA-04g roles: content has no access to deals (403)', async () => {
  assert.equal((await cnt.get('/admin/deals')).status, 403);
});
test('DA-04h the deals page needs a login (401)', async () => {
  assert.equal((await api.get('/admin/deals')).status, 401);
});

test('DA-05a finance policy: an out-of-range grade A discount is rejected', async () => {
  assert.match(flash(await fin.form('/admin/deals/policy', { enabled: '1', pct_A: '99', pct_B: '6', pct_C: '3', maxOrderValue: '30000', maxRounds: '3', validityDays: '7', paymentTerms: 'tt30', incoterms: 'FOB' })).err, /A 级/);
});
test('DA-05b finance policy: a valid policy with several payment terms and incoterms is saved', async () => {
  const body = new URLSearchParams([['enabled', '1'], ['pct_A', '10'], ['pct_B', '6'], ['pct_C', '3'], ['maxOrderValue', '5000'], ['maxRounds', '3'], ['validityDays', '7'], ['paymentTerms', 'tt30'], ['paymentTerms', 'tt100'], ['incoterms', 'FOB'], ['incoterms', 'EXW']]);
  const saved = await fetch(`${api.url}/admin/deals/policy`, { method: 'POST', redirect: 'manual', headers: { authorization: 'Basic ' + Buffer.from(`fin1:${PW}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' }, body });
  assert.match(flash(saved).ok, /政策已保存/);
  assert.match(await (await fin.get('/admin/deals/policy')).text(), /name="paymentTerms" value="tt100" checked/);
});
test('DA-05c finance sets a floor price for a product', async () => {
  assert.match(flash(await fin.form('/admin/deals/floors', { 'floor_YR-HB-U2': '40' })).ok, /已更新 1 个底价/);
});
test('DA-05d a floor price that is not above 0 is rejected', async () => {
  assert.match(flash(await fin.form('/admin/deals/floors', { 'floor_YR-HB-U2': '-5' })).err, /大于 0/);
});
test('DA-05e the floor price never reaches the public product API', async () => {
  // the floor never reaches the public product API or MCP
  assert.doesNotMatch(await (await api.get('/api/shop/product/YR-HB-U2')).text(), /floor/i);
});
test('DA-05f an offer request above the AI order-value cap goes to the approval queue with the reason', async () => {
  const r = (await rpc('tools/call', { name: 'prepare_offer', arguments: { email: 'big@distri.test', company: 'Distri', lines: [{ product_id: 'YR-HB-U2', qty: 1000 }] } })).result.structuredContent;
  assert.equal(r.status, 'needs_approval');
  const queue = await (await fin.get('/admin/deals?status=needs_approval')).text();
  ctx.deal = queue.match(new RegExp(`/admin/deals/([\\w-]+)"><b>${r.offer_id}`))[1];
  assert.match(queue, /超过 AI 可成交金额/);
});
test('DA-05g approving with a price below the floor is refused', async () => {
  assert.match(flash(await fin.form(`/admin/deals/${ctx.deal}/decide`, { decision: 'approve', 'price_YR-HB-U2': '30' })).err, /低于底价 40/);
});
test('DA-05h approving at a price above the floor sends a contract and records the approver', async () => {
  const id = ctx.deal;
  const ok = flash(await fin.form(`/admin/deals/${id}/decide`, { decision: 'approve', 'price_YR-HB-U2': '41', note: 'volume' }));
  assert.match(ok.ok, /已批准，合同 SC-\d{6}-\d{3} 已发到 big@distri\.test/);
  assert.match(await (await fin.get(`/admin/deals/${id}`)).text(), /已发合同[\s\S]*fin1/);
});

test('DA-06a MCP: a buyer agent can get an offer', async () => {
  const r = ctx.mcpOffer = (await rpc('tools/call', { name: 'prepare_offer', arguments: { email: 'agent@buyer-ai.test', lines: [{ product_id: 'YR-HB-U2', qty: 60 }] } })).result.structuredContent;
  assert.equal(r.status, 'offer');
});
test('DA-06b MCP: issuing the contract to a different e-mail than the offer\'s is refused (email_mismatch)', async () => {
  const bad = (await rpc('tools/call', { name: 'issue_contract', arguments: { offer_id: ctx.mcpOffer.offer_id, email: 'attacker@evil.test' } })).result.structuredContent;
  assert.equal(bad.error, 'email_mismatch');
});
test('DA-06c MCP: the contract is issued and sent to the offer\'s own e-mail', async () => {
  const good = (await rpc('tools/call', { name: 'issue_contract', arguments: { offer_id: ctx.mcpOffer.offer_id, email: 'agent@buyer-ai.test' } })).result.structuredContent;
  assert.equal(good.issued, true);
  assert.equal(good.sent_to, 'agent@buyer-ai.test');
});

test('DA-07a a saved PI offers "generate contract and send for signing"', async () => {
  const created = await api.form('/admin/quotes/new', { email: 'manual@buyer-co.test', company: 'Manual Co' });
  const qid = ctx.qid = created.headers.get('location').split('/').pop();
  await api.form(`/admin/quotes/${qid}/save`, { sku_0: 'YR-HB-U2', qty_0: '100', price_0: '45', currency: 'USD', incoterm: 'FOB', payment_terms: 'tt30', validity_days: '15', action: 'save' });
  assert.match(await (await api.admin(`/admin/quotes/${qid}`)).text(), /生成合同并发给客户签署/);
});
test('DA-07b sales generates a contract from the PI and it is sent to the customer', async () => {
  const k = flash(await as('sales1').form(`/admin/quotes/${ctx.qid}/contract`, {}));
  assert.match(k.ok, /合同 SC-\d{6}-\d{3} 已生成并发到客户邮箱/);
  ctx.staffKid = k.path.split('/').pop();
});
test('DA-07c the PI then shows "sent, awaiting customer signature"', async () => {
  const quotePage = await (await api.admin(`/admin/quotes/${ctx.qid}`)).text();
  assert.match(quotePage, /已发送，待客户签署/);
  ctx.piLink = quotePage.match(/\/portal\/pi\/[\w-]+/)[0];
});
test('DA-07d the PI accept button now redirects the customer to the contract signing page', async () => {
  const accept = await fetch(api.url + ctx.piLink, { method: 'POST', redirect: 'manual' });
  assert.equal(accept.status, 302);
  assert.match(accept.headers.get('location'), /^\/portal\/contract\//);
});
test('DA-07e voiding a contract without a reason is rejected', async () => {
  assert.match(flash(await as('sales1').form(`/admin/contracts/${ctx.staffKid}/void`, { reason: '' })).err, /作废原因/);
});
test('DA-07f sales voids a contract with a reason', async () => {
  assert.match(flash(await as('sales1').form(`/admin/contracts/${ctx.staffKid}/void`, { reason: 'price changed' })).ok, /已作废/);
});
test('DA-07g a contract template that is too short is rejected', async () => {
  assert.match(flash(await api.form('/admin/contracts/template', { template: 'short' })).err, /太短/);
});
test('DA-07h the admin saves an extended contract template', async () => {
  const tpl = (await (await api.admin('/admin/contracts/template')).text()).match(/<textarea name="template"[^>]*>([\s\S]*?)<\/textarea>/)[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  assert.match(flash(await api.form('/admin/contracts/template', { template: tpl + '\n\n## 10. Language\nThis contract is made in English.' })).ok, /模板已保存/);
});
