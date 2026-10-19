// Black-box: AI mode (LLM mocked over HTTP) — tool-calling, guardrails that do not depend on the model,
// fallback to rules when the LLM fails; real-Kingdee mode against a mock Kingdee WebAPI; YR GRID smoke.
// IDs AI-xx, KF-xx, GR-xx.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, flash } from '../helpers/server.mjs';
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
  test('AI-02 system prompt carries the red lines; tools offered to the model', async () => {
    turns.push(say('Hello! I am an AI assistant.'));
    await api.json('/api/chat', { message: 'hi' });
    const req = llm.calls.at(-1).body;
    assert.match(req.system, /You are an AI assistant/);
    assert.match(req.system, /Never reveal internal costs, margins, floor prices/);
    assert.match(req.system, /Before save_lead, ask for consent/);
    assert.deepEqual(req.tools.map((t) => t.name).sort(), ['estimate_quote', 'get_product', 'handoff_to_human', 'issue_contract', 'prepare_offer', 'request_after_sales', 'save_lead', 'search_products', 'track_order']);
  });
  test('AI-03 search → estimate → answer: product cards + quote returned to the widget', async () => {
    turns.push(toolUse('search_products', { query: 'ufo high bay' }), toolUse('estimate_quote', { product_id: 'YR-HB-U2', quantity: 600 }, 't2'),
      (call) => { const res = JSON.parse(call.body.messages.at(-1).content[0].content); return say(`Reference price ${res.unitPrice.low}-${res.unitPrice.high} USD per unit (FOB Shenzhen). Reference only — subject to the formal PI.`); });
    const r = await (await api.json('/api/chat', { message: 'price for 600 ufo high bays?' })).json();
    assert.equal(r.mode, 'ai');
    assert.equal(r.products[0].id, 'YR-HB-U2');
    assert.equal(r.quote.quantity, 600);
    assert.equal(r.askLead, true);
    assert.match(r.reply, /35-46 USD/);
  });
  test('AI-04 safety net: a money figure without the disclaimer gets it appended', async () => {
    turns.push(say('It is about US$40 each.'));
    const r = await (await api.json('/api/chat', { message: 'quick price?' })).json();
    assert.match(r.reply, /US\$40 each\.\n\(Reference only — subject to the formal PI\.\)/);
    turns.push(say('大约 US$40 一个。'));
    const zh = await (await api.json('/api/chat', { message: '多少钱' })).json();
    assert.match(zh.reply, /以上价格仅供参考，以正式 PI 为准/);
  });
  test('AI-05 the model cannot save a lead without consent or without contact details', async () => {
    turns.push(toolUse('save_lead', { email: 'b@corp.test', consent: false }), say('May we contact you?'));
    await api.json('/api/chat', { message: 'my email is b@corp.test' });
    assert.equal(lastToolResult().error, 'consent_required');
    turns.push(toolUse('save_lead', { consent: true }), say('Please share an email.'));
    await api.json('/api/chat', { message: 'ok' });
    assert.equal(lastToolResult().error, 'contact_required');
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
  test('AI-08 unknown tool names and unknown products are handled', async () => {
    turns.push(toolUse('delete_database', {}), say('Sorry.'));
    await api.json('/api/chat', { message: 'x' });
    assert.equal(lastToolResult().error, 'unknown_tool');
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
  test('KF-01 PI accepted on the portal is pushed to Kingdee with the session cookie; failures are shown on the order', async () => {
    let failNext = false;
    const kd = await mockServer((call) => {
      if (call.url.includes('LoginByAppSecret')) return { json: { LoginResultType: 1 }, headers: { 'set-cookie': 'kdservice-sessionid=ABC; path=/' } };
      if (call.headers.cookie !== 'kdservice-sessionid=ABC') return { status: 401, text: 'login first' };
      if (call.url.includes('ExecuteBillQuery')) return { json: [] };
      if (call.url.includes('Save')) {
        if (failNext && call.body.formid === 'SAL_SaleOrder') return { json: { Result: { ResponseStatus: { IsSuccess: false, Errors: [{ FieldName: 'FMaterialId', Message: '物料不存在' }] } } } };
        return { json: { Result: { ResponseStatus: { IsSuccess: true }, Number: call.body.formid === 'BD_Customer' ? 'CUST-KD-1' : 'XSDD-KD-1' } } };
      }
      return { status: 404, text: '' };
    });
    const s = await startServer({ site: 'led', env: { ERP_MODE: 'kingdee', KD_BASE_URL: kd.url, KD_ACCT_ID: 'A', KD_USERNAME: 'u', KD_APP_ID: 'app', KD_APP_SECRET: 'sec' } });
    try {
      const accept = async (email) => {
        await s.json('/api/leads', { email, company: 'KD Test', product_id: 'YR-HB-U2', quantity: 100, consent: true });
        const page = await (await s.admin('/admin')).text();
        const lead = page.split('<tr>').find((r) => r.includes(email)).match(/lead=([\w-]+)/)[1];
        const q = flash(await s.admin(`/admin/quotes/new?lead=${lead}`)).path.split('/').pop();
        flash(await s.form(`/admin/quotes/${q}/status`, { to: 'sent' }));
        const token = (await (await s.admin(`/admin/quotes/${q}`)).text()).match(/\/portal\/pi\/([\w-]+)/)[1];
        await s.form(`/portal/pi/${token}`, {}, { auth: false });
        await new Promise((r) => setTimeout(r, 400));
        const orders = await (await s.admin('/admin/orders')).text();
        return orders.match(/\/admin\/orders\/([\w-]+)/)[1];
      };
      const id = await accept('kd1@test.test');
      assert.match(await (await s.admin(`/admin/orders/${id}`)).text(), /XSDD-KD-1/);
      const saves = kd.calls.filter((c) => c.url.includes('.Save.'));
      assert.deepEqual(saves.map((c) => c.body.formid), ['BD_Customer', 'SAL_SaleOrder']);
      assert.equal(saves[1].body.data.Model.FCustId.FNumber, 'CUST-KD-1');
      assert.equal(saves[1].body.data.IsAutoSubmitAndAudit, false);
      failNext = true;
      const id2 = await accept('kd2@test.test');
      assert.match(await (await s.admin(`/admin/orders/${id2}`)).text(), /物料不存在/);
      failNext = false;
      assert.match(flash(await s.form(`/admin/orders/${id2}/erp`, {})).ok, /已推送到金蝶，销售订单号 XSDD-KD-1/, 'manual retry works');
    } finally { await s.stop(); await kd.close(); }
  });
});

describe('YR GRID site backend', () => {
  test('GR-01 grid server: health, Chinese chat, MCP catalog, Chinese portal', async () => {
    const g = await startServer({ site: 'grid' });
    try {
      assert.equal((await (await g.get('/api/health')).json()).site, 'grid');
      const zh = await (await g.json('/api/chat', { message: '工商业储能柜 215kWh 2 台 报价' })).json();
      assert.match(zh.reply, /仅供参考/);
      const mcp = await (await g.json('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_products', arguments: { query: 'charger' } } })).json();
      assert.ok(mcp.result.structuredContent.products.every((p) => p.id.startsWith('YRG-')));
      assert.match(await (await g.get('/portal?lang=zh')).text(), /查询订单/);
      const calc = await g.json('/api/leads', { email: 'factory@vn.test', consent: true, source: 'calculator', extra: { calculator: { kwp: 480, payback: 4.3 } } });
      assert.equal(calc.status, 200);
      assert.match(await (await g.admin('/admin')).text(), /测算：480 kWp，回本 4\.3 年/);
    } finally { await g.stop(); }
  });
});
