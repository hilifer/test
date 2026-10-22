// Black-box: AI mode (LLM mocked over HTTP) — tool-calling, guardrails that do not depend on the model,
// fallback to rules when the LLM fails; real-Kingdee mode against a mock Kingdee WebAPI; YR GRID smoke.
// IDs AI-xx, KF-xx, GR-xx.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, flash, waitFor } from '../helpers/server.mjs';
import { mockServer } from '../helpers/mock-http.mjs';

const turns = [];
let llm, api;
before(async () => {
  llm = await mockServer((call) => {
    const next = turns.shift();
    if (!next) return { status: 500, text: 'no scripted reply' };
    return typeof next === 'function' ? next(call) : next;
  });
  api = await startServer({ site: 'led', env: { LLM_PROVIDER: 'anthropic', LLM_API_KEY: 'k', LLM_MODEL: 'claude-opus-5-5', LLM_BASE_URL: llm.url } });
});
after(async () => { await api.stop(); await llm.close(); });

const toolUse = (name, input, id = 't1') => ({ json: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] } });
const say = (text) => ({ json: { stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
const lastToolResult = () => JSON.parse(llm.calls.at(-1).body.messages.at(-1).content[0].content);

describe('AI sales agent (LLM mocked)', () => {
  test('AI-01 health reports AI mode', async () => {
    assert.equal((await (await api.get('/api/health')).json()).mode, 'ai');
  });
  let firstReq;
  test('AI-02a the system prompt sent to the model carries the red lines', async () => {
    turns.push(say('Hello! I am an AI assistant.'));
    await api.json('/api/chat', { message: 'hi' });
    const req = firstReq = llm.calls.at(-1).body;
    assert.match(req.system, /You are an AI assistant/);
    assert.match(req.system, /Never reveal internal costs, margins, floor prices/);
    assert.match(req.system, /Before save_lead, ask for consent/);
  });
  test('AI-02b exactly the nine sales tools are offered to the model', async () => {
    const req = firstReq;
    assert.deepEqual(req.tools.map((t) => t.name).sort(), ['estimate_quote', 'get_product', 'handoff_to_human', 'issue_contract', 'prepare_offer', 'request_after_sales', 'save_lead', 'search_products', 'track_order']);
  });
  let chain;
  test('AI-03a search → estimate tool chain returns an AI-mode reply with the found product card', async () => {
    turns.push(toolUse('search_products', { query: 'ufo high bay' }), toolUse('estimate_quote', { product_id: 'YR-HB-U2', quantity: 600 }, 't2'),
      (call) => { const res = JSON.parse(call.body.messages.at(-1).content[0].content); return say(`Reference price ${res.unitPrice.low}-${res.unitPrice.high} USD per unit (FOB Shenzhen). Reference only — subject to the formal PI.`); });
    const r = chain = await (await api.json('/api/chat', { message: 'price for 600 ufo high bays?' })).json();
    assert.equal(r.mode, 'ai');
    assert.equal(r.products[0].id, 'YR-HB-U2');
  });
  test('AI-03b the estimate is returned to the widget as a quote and the lead form is requested', async () => {
    assert.equal(chain.quote.quantity, 600);
    assert.equal(chain.askLead, true);
  });
  test('AI-03c the model reply carries the price range from the estimate tool', async () => {
    assert.match(chain.reply, /35-46 USD/);
  });
  test('AI-04a safety net: an English money figure without the disclaimer gets it appended', async () => {
    turns.push(say('It is about US$40 each.'));
    const r = await (await api.json('/api/chat', { message: 'quick price?' })).json();
    assert.match(r.reply, /US\$40 each\.\n\(Reference only — subject to the formal PI\.\)/);
  });
  test('AI-04b safety net: a Chinese money figure without the disclaimer gets the Chinese disclaimer appended', async () => {
    turns.push(say('大约 US$40 一个。'));
    const zh = await (await api.json('/api/chat', { message: '多少钱' })).json();
    assert.match(zh.reply, /以上价格仅供参考，以正式 PI 为准/);
  });
  test('AI-05a the model cannot save a lead without consent (consent_required)', async () => {
    turns.push(toolUse('save_lead', { email: 'b@corp.test', consent: false }), say('May we contact you?'));
    await api.json('/api/chat', { message: 'my email is b@corp.test' });
    assert.equal(lastToolResult().error, 'consent_required');
  });
  test('AI-05b the model cannot save a lead without contact details (contact_required)', async () => {
    turns.push(toolUse('save_lead', { consent: true }), say('Please share an email.'));
    await api.json('/api/chat', { message: 'ok' });
    assert.equal(lastToolResult().error, 'contact_required');
  });
  test('AI-05c with consent and an email the model saves the lead and it appears in the admin', async () => {
    turns.push(toolUse('save_lead', { email: 'b@corp.test', company: 'Corp', quantity: 2000, timeline: 'ASAP', consent: true }), say('Thanks!'));
    const r = await (await api.json('/api/chat', { message: 'yes you may' })).json();
    assert.equal(r.leadSaved, true);
    assert.equal(r.askLead, false);
    assert.match(await (await api.admin('/admin')).text(), /b@corp\.test/);
  });
  test('AI-06 the model cannot read an order without a matching email', async () => {
    turns.push(toolUse('track_order', { order_number: 'SO-000000-001', email: 'x@y.test' }), say('Not found.'));
    await api.json('/api/chat', { message: 'where is SO-000000-001' });
    assert.equal(lastToolResult().found, false);
  });
  test('AI-07 handoff tool flags the conversation for sales', async () => {
    turns.push(toolUse('handoff_to_human', { reason: 'discount request', summary: 'wants 20% off' }), say('A sales engineer will contact you.'));
    const r = await (await api.json('/api/chat', { message: 'give me 20% discount' })).json();
    assert.equal(r.handoff, true);
    assert.match(await (await api.admin('/admin/conversations')).text(), /discount request/);
  });
  test('AI-08a an unknown tool name returns unknown_tool to the model', async () => {
    turns.push(toolUse('delete_database', {}), say('Sorry.'));
    await api.json('/api/chat', { message: 'x' });
    assert.equal(lastToolResult().error, 'unknown_tool');
  });
  test('AI-08b a quote for an unknown product returns not_found to the model', async () => {
    turns.push(toolUse('estimate_quote', { product_id: 'FAKE', quantity: 10 }), say('Unknown model.'));
    await api.json('/api/chat', { message: 'price of FAKE' });
    assert.equal(lastToolResult().error, 'not_found');
  });
  test('AI-09 LLM outage → the customer still gets a rules-based answer', async () => {
    turns.push({ status: 529, text: 'overloaded' });
    const r = await (await api.json('/api/chat', { message: 'price for 600 pcs ufo high bay' })).json();
    assert.equal(r.reply.length > 0, true);
    assert.match(r.reply, /US\$35–US\$46/);
  });
  test('AI-10 empty model reply → polite clarification instead of a blank bubble', async () => {
    turns.push(say(''));
    const r = await (await api.json('/api/chat', { message: 'hmm' })).json();
    assert.match(r.reply, /tell me a bit more/);
  });
});

describe('real Kingdee mode (mock Kingdee WebAPI)', () => {
  let failNext = false;
  let kd, s;
  const kf = {};
  before(async () => {
    kd = await mockServer((call) => {
      if (call.url.includes('LoginByAppSecret')) return { json: { LoginResultType: 1 }, headers: { 'set-cookie': 'kdservice-sessionid=ABC; path=/' } };
      if (call.headers.cookie !== 'kdservice-sessionid=ABC') return { status: 401, text: 'login first' };
      if (call.url.includes('ExecuteBillQuery')) return { json: [] };
      if (call.url.includes('Save')) {
        if (failNext && call.body.formid === 'SAL_SaleOrder') return { json: { Result: { ResponseStatus: { IsSuccess: false, Errors: [{ FieldName: 'FMaterialId', Message: '物料不存在' }] } } } };
        return { json: { Result: { ResponseStatus: { IsSuccess: true }, Number: call.body.formid === 'BD_Customer' ? 'CUST-KD-1' : 'XSDD-KD-1' } } };
      }
      return { status: 404, text: '' };
    });
    s = await startServer({ site: 'led', env: { ERP_MODE: 'kingdee', KD_BASE_URL: kd.url, KD_ACCT_ID: 'A', KD_USERNAME: 'u', KD_APP_ID: 'app', KD_APP_SECRET: 'sec' } });
  });
  after(async () => { await s?.stop(); await kd?.close(); });
  const accept = async (email) => {
    await s.json('/api/leads', { email, company: 'KD Test', product_id: 'YR-HB-U2', quantity: 100, consent: true });
    const page = await (await s.admin('/admin')).text();
    const lead = page.split('<tr>').find((r) => r.includes(email)).match(/lead=([\w-]+)/)[1];
    const q = flash(await s.admin(`/admin/quotes/new?lead=${lead}`)).path.split('/').pop();
    flash(await s.form(`/admin/quotes/${q}/status`, { to: 'sent' }));
    const token = (await (await s.admin(`/admin/quotes/${q}`)).text()).match(/\/portal\/pi\/([\w-]+)/)[1];
    await s.form(`/portal/pi/${token}`, {}, { auth: false });
    const orders = await (await s.admin('/admin/orders')).text();
    const id = orders.match(/\/admin\/orders\/([\w-]+)/)[1];
    // the Kingdee push runs in the background: wait until the order shows a bill number or an error
    await waitFor(async () => /<b>金蝶<\/b>.*?(销售订单号 <b>|<span style="color:#c62828">)/s.test(await (await s.admin(`/admin/orders/${id}`)).text())); // the card itself: the page CSS also contains the error colour
    return id;
  };
  const saves = () => kd.calls.filter((c) => c.url.includes('.Save.'));
  test('KF-01a a PI accepted on the portal is pushed to Kingdee and the order shows the Kingdee sales order number', async () => {
    const id = await accept('kd1@test.test');
    assert.match(await (await s.admin(`/admin/orders/${id}`)).text(), /XSDD-KD-1/);
  });
  test('KF-01b the push saves the customer first, then the sales order (with the session cookie)', async () => {
    assert.deepEqual(saves().map((c) => c.body.formid), ['BD_Customer', 'SAL_SaleOrder']);
  });
  test('KF-01c the Kingdee sales order references the customer number returned by Kingdee', async () => {
    assert.equal(saves()[1].body.data.Model.FCustId.FNumber, 'CUST-KD-1');
  });
  test('KF-01d the Kingdee sales order is not auto-submitted or audited', async () => {
    assert.equal(saves()[1].body.data.IsAutoSubmitAndAudit, false);
  });
  test('KF-01e a Kingdee save failure is shown on the order', async () => {
    failNext = true;
    try {
      kf.id2 = await accept('kd2@test.test');
      assert.match(await (await s.admin(`/admin/orders/${kf.id2}`)).text(), /物料不存在/);
    } finally { failNext = false; }
  });
  test('KF-01f a manual retry pushes the failed order to Kingdee', async () => {
    assert.match(flash(await s.form(`/admin/orders/${kf.id2}/erp`, {})).ok, /已推送到金蝶，销售订单号 XSDD-KD-1/, 'manual retry works');
  });
});

describe('YR GRID site backend', () => {
  let g;
  before(async () => { g = await startServer({ site: 'grid' }); });
  after(async () => { await g?.stop(); });
  test('GR-01a grid server health reports site "grid"', async () => {
    assert.equal((await (await g.get('/api/health')).json()).site, 'grid');
  });
  test('GR-01b a Chinese quote request in chat gets a reply with the Chinese reference-only disclaimer', async () => {
    const zh = await (await g.json('/api/chat', { message: '工商业储能柜 215kWh 2 台 报价' })).json();
    assert.match(zh.reply, /仅供参考/);
  });
  test('GR-01c the MCP search_products tool returns only YR GRID (YRG-) products', async () => {
    const mcp = await (await g.json('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_products', arguments: { query: 'charger' } } })).json();
    assert.ok(mcp.result.structuredContent.products.every((p) => p.id.startsWith('YRG-')));
  });
  test('GR-01d the customer portal renders in Chinese', async () => {
    assert.match(await (await g.get('/portal?lang=zh')).text(), /查询订单/);
  });
  test('GR-01e a calculator lead is accepted and its sizing summary is shown in the admin', async () => {
    const calc = await g.json('/api/leads', { email: 'factory@vn.test', consent: true, source: 'calculator', extra: { calculator: { kwp: 480, payback: 4.3 } } });
    assert.equal(calc.status, 200);
    assert.match(await (await g.admin('/admin')).text(), /测算：480 kWp，回本 4\.3 年/);
  });
});

const takeover = {};
test('AI-11a while a staff member has taken over the chat, the AI stays silent (mode human)', async () => {
  turns.push(say('Hello! I am an AI assistant.'));
  const sid = takeover.sid = (await (await api.json('/api/chat', { message: 'hi there' })).json()).sessionId;
  await api.form(`/admin/conv/${sid}/reply`, { text: 'Anna here — we can do DDP Houston.' });
  const silent = await (await api.json('/api/chat', { sessionId: sid, message: 'great' })).json();
  assert.equal(silent.mode, 'human');
});
test('AI-11b after the takeover is released, the model sees the staff reply as an assistant turn', async () => {
  const sid = takeover.sid;
  await api.form(`/admin/conv/${sid}/release`, {});
  turns.push(say('Happy to help further.'));
  await api.json('/api/chat', { sessionId: sid, message: 'one more question' });
  const msgs = takeover.msgs = llm.calls.at(-1).body.messages;
  assert.ok(msgs.some((m) => m.role === 'assistant' && /^\[Sales engineer\] Anna here/.test(m.content)));
});
test('AI-11c system notes about joining / leaving the chat are left out of the model history', async () => {
  assert.ok(!takeover.msgs.some((m) => /joined the chat|assistant is back/.test(typeof m.content === 'string' ? m.content : '')));
});
test('AI-11d the model history contains only user and assistant roles', async () => {
  assert.ok(takeover.msgs.every((m) => ['user', 'assistant'].includes(m.role)));
});
