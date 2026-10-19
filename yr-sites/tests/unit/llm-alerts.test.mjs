// Modules: server/src/llm.js (tool-calling loop for Claude and OpenAI-compatible APIs) and
// server/src/alerts.js (WeCom / Feishu / generic webhook). IDs LL-xx, AL-xx.
import { test, describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTempEnv } from '../helpers/env.mjs';
import { mockServer } from '../helpers/mock-http.mjs';

const script = [];
const srv = await mockServer((call) => {
  if (call.url.startsWith('/hook')) return { json: { errcode: 0 } };
  const next = script.shift();
  return typeof next === 'function' ? next(call) : next;
});
after(() => srv.close());
beforeEach(() => { srv.calls.length = 0; script.length = 0; });

useTempEnv({ site: 'led', LLM_PROVIDER: 'anthropic', LLM_API_KEY: 'k', LLM_MODEL: 'claude-opus-5-5', LLM_BASE_URL: srv.url,
  WECOM_WEBHOOK_URL: `${srv.url}/hook/wecom`, FEISHU_WEBHOOK_URL: `${srv.url}/hook/feishu`, ALERT_WEBHOOK_URL: `${srv.url}/hook/generic`, ALERT_MIN_GRADE: 'B' });
const { runAgentLoop, complete, parseJson } = await import('../../server/src/llm.js');
const { alertLead, alertOps } = await import('../../server/src/alerts.js');
const { config } = await import('../../server/src/config.js');

const tools = [{ name: 'search_products', description: 'x', input_schema: { type: 'object', properties: {} } }];

describe('llm', () => {
  test('LL-01 Claude loop: tool_use → our tool runs → tool_result sent back → final text', async () => {
    script.push(
      { json: { stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'tool_use', id: 'tu1', name: 'search_products', input: { query: 'ufo' } }] } },
      { json: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Here are two models.' }] } },
    );
    const seen = [];
    const text = await runAgentLoop({ system: 'S', messages: [{ role: 'user', content: 'hi' }], tools, onTool: async (n, i) => { seen.push([n, i]); return { count: 1 }; } });
    assert.equal(text, 'Here are two models.');
    assert.deepEqual(seen, [['search_products', { query: 'ufo' }]]);
    const second = srv.calls[1].body;
    assert.equal(second.messages[1].role, 'assistant');
    assert.equal(second.messages[1].content[0].type, 'thinking', 'assistant content (incl. thinking blocks) is passed back unchanged');
    assert.deepEqual(second.messages[2].content[0], { type: 'tool_result', tool_use_id: 'tu1', content: '{"count":1}' });
    assert.equal(srv.calls[0].headers['anthropic-version'], '2023-06-01');
  });
  test('LL-02 loop stops after 5 tool rounds', async () => {
    for (let i = 0; i < 6; i++) script.push({ json: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `t${i}`, name: 'search_products', input: {} }] } });
    assert.equal(await runAgentLoop({ system: 'S', messages: [{ role: 'user', content: 'x' }], tools, onTool: async () => ({}) }), '');
    assert.equal(srv.calls.length, 5);
  });
  test('LL-03 HTTP errors are raised (agent falls back to rules)', async () => {
    script.push({ status: 529, text: 'overloaded' });
    await assert.rejects(runAgentLoop({ system: 'S', messages: [], tools, onTool: async () => ({}) }), /LLM 529/);
  });
  test('LL-04 OpenAI-compatible loop (DeepSeek / Qwen) with tool_calls', async () => {
    config.llm.provider = 'openai';
    try {
      script.push(
        { json: { choices: [{ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_products', arguments: '{"query":"储能"}' } }] } }] } },
        { json: { choices: [{ message: { content: '推荐两款储能柜。' } }] } },
      );
      const out = await runAgentLoop({ system: 'S', messages: [{ role: 'user', content: '储能' }], tools, onTool: async (n, i) => ({ n, i }) });
      assert.equal(out, '推荐两款储能柜。');
      assert.equal(srv.calls[0].url, '/chat/completions');
      assert.equal(srv.calls[0].headers.authorization, 'Bearer k');
      assert.equal(srv.calls[1].body.messages.at(-1).role, 'tool');
    } finally { config.llm.provider = 'anthropic'; }
  });
  test('LL-05 complete() honours per-task overrides (content / GEO model)', async () => {
    script.push({ json: { content: [{ type: 'text', text: 'ok' }] } });
    await complete({ system: 's', user: 'u', llm: { model: 'claude-sonnet-5-5', apiKey: '' } });
    assert.equal(srv.calls[0].body.model, 'claude-sonnet-5-5');
    assert.equal(srv.calls[0].headers['x-api-key'], 'k', 'empty override keeps the base key');
  });
  test('LL-06 parseJson handles fenced and chatty replies', () => {
    assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(parseJson('Sure! {"a":{"b":2}} hope this helps'), { a: { b: 2 } });
    assert.throws(() => parseJson('nothing'), /no JSON/);
  });
});

describe('alerts', () => {
  test('AL-01 grade at/above ALERT_MIN_GRADE fans out to WeCom, Feishu and the generic webhook', async () => {
    await alertLead({ grade: 'A', company: 'Acme', email: 'b@acme.test', quantity: 1000, reasons: ['company email'] });
    const urls = srv.calls.map((c) => c.url).sort();
    assert.deepEqual(urls, ['/hook/feishu', '/hook/generic', '/hook/wecom']);
    const wecom = srv.calls.find((c) => c.url === '/hook/wecom').body;
    assert.equal(wecom.msgtype, 'markdown');
    assert.match(wecom.markdown.content, /新A级线索/);
    assert.match(wecom.markdown.content, /评级依据：company email/);
  });
  test('AL-02 grades below the threshold are not sent', async () => {
    await alertLead({ grade: 'C', email: 'x@y.test' });
    assert.equal(srv.calls.length, 0);
  });
  test('AL-03 handoff requests are always sent', async () => {
    await alertLead({ grade: 'D' }, { handoff: true, reason: 'OEM' });
    assert.match(srv.calls.find((c) => c.url === '/hook/wecom').body.markdown.content, /客户请求人工[\s\S]*转人工原因：OEM/);
  });
  test('AL-04 ops alerts and failing webhooks never throw', async () => {
    await alertOps('物流异常', ['SH-1']);
    assert.equal(srv.calls.length, 3);
    config.alerts.wecomWebhook = 'http://127.0.0.1:1/unreachable';
    await assert.doesNotReject(alertOps('x', []));
  });
});
