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

// beforeEach clears srv.calls, so tests split from one scenario keep a copy of the calls they need.
describe('llm', () => {
  let calls1;
  test('LL-01a Claude loop: a tool_use runs our tool with its input and the final text is returned', async () => {
    script.push(
      { json: { stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'tool_use', id: 'tu1', name: 'search_products', input: { query: 'ufo' } }] } },
      { json: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Here are two models.' }] } },
    );
    const seen = [];
    const text = await runAgentLoop({ system: 'S', messages: [{ role: 'user', content: 'hi' }], tools, onTool: async (n, i) => { seen.push([n, i]); return { count: 1 }; } });
    calls1 = [...srv.calls];
    assert.equal(text, 'Here are two models.');
    assert.deepEqual(seen, [['search_products', { query: 'ufo' }]]);
  });
  test('LL-01b Claude loop: the assistant content (incl. thinking blocks) is passed back unchanged', () => {
    const second = calls1[1].body;
    assert.equal(second.messages[1].role, 'assistant');
    assert.equal(second.messages[1].content[0].type, 'thinking', 'assistant content (incl. thinking blocks) is passed back unchanged');
  });
  test('LL-01c Claude loop: the tool result is sent back as a tool_result block', () => {
    assert.deepEqual(calls1[1].body.messages[2].content[0], { type: 'tool_result', tool_use_id: 'tu1', content: '{"count":1}' });
  });
  test('LL-01d Claude requests carry the anthropic-version header', () => {
    assert.equal(calls1[0].headers['anthropic-version'], '2023-06-01');
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
  let calls4;
  test('LL-04a OpenAI-compatible loop (DeepSeek / Qwen) runs tool_calls and returns the final text', async () => {
    config.llm.provider = 'openai';
    try {
      script.push(
        { json: { choices: [{ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_products', arguments: '{"query":"储能"}' } }] } }] } },
        { json: { choices: [{ message: { content: '推荐两款储能柜。' } }] } },
      );
      const out = await runAgentLoop({ system: 'S', messages: [{ role: 'user', content: '储能' }], tools, onTool: async (n, i) => ({ n, i }) });
      calls4 = [...srv.calls];
      assert.equal(out, '推荐两款储能柜。');
    } finally { config.llm.provider = 'anthropic'; }
  });
  test('LL-04b OpenAI-compatible requests go to /chat/completions with a Bearer key', () => {
    assert.equal(calls4[0].url, '/chat/completions');
    assert.equal(calls4[0].headers.authorization, 'Bearer k');
  });
  test('LL-04c OpenAI-compatible loop sends the tool result back as a tool message', () => {
    assert.equal(calls4[1].body.messages.at(-1).role, 'tool');
  });
  let calls5;
  test('LL-05a complete() uses the per-task model override (content / GEO model)', async () => {
    script.push({ json: { content: [{ type: 'text', text: 'ok' }] } });
    await complete({ system: 's', user: 'u', llm: { model: 'claude-sonnet-5-5', apiKey: '' } });
    calls5 = [...srv.calls];
    assert.equal(calls5[0].body.model, 'claude-sonnet-5-5');
  });
  test('LL-05b complete() keeps the base API key when the override key is empty', () => {
    assert.equal(calls5[0].headers['x-api-key'], 'k', 'empty override keeps the base key');
  });
  test('LL-06a parseJson reads a fenced JSON reply', () => {
    assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
  });
  test('LL-06b parseJson reads JSON embedded in a chatty reply', () => {
    assert.deepEqual(parseJson('Sure! {"a":{"b":2}} hope this helps'), { a: { b: 2 } });
  });
  test('LL-06c parseJson throws when there is no JSON', () => {
    assert.throws(() => parseJson('nothing'), /no JSON/);
  });
});

describe('alerts', () => {
  let calls1;
  test('AL-01a grade at/above ALERT_MIN_GRADE fans out to WeCom, Feishu and the generic webhook', async () => {
    await alertLead({ grade: 'A', company: 'Acme', email: 'b@acme.test', quantity: 1000, reasons: ['company email'] });
    calls1 = [...srv.calls];
    const urls = calls1.map((c) => c.url).sort();
    assert.deepEqual(urls, ['/hook/feishu', '/hook/generic', '/hook/wecom']);
  });
  test('AL-01b the WeCom message is markdown with the grade and the grading reasons', () => {
    const wecom = calls1.find((c) => c.url === '/hook/wecom').body;
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
  test('AL-04a ops alerts are sent to every configured webhook', async () => {
    await alertOps('物流异常', ['SH-1']);
    assert.equal(srv.calls.length, 3);
  });
  test('AL-04b a failing webhook never throws', async () => {
    config.alerts.wecomWebhook = 'http://127.0.0.1:1/unreachable';
    await assert.doesNotReject(alertOps('x', []));
  });
});
