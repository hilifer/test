// Minimal provider-agnostic tool-calling loop over fetch (no SDKs).
//  - anthropic: Claude Messages API
//  - openai:    any OpenAI-compatible Chat Completions API (OpenAI, DeepSeek, Qwen/DashScope, Azure…)
import { config } from './config.js';

const MAX_STEPS = 5;

export async function runAgentLoop({ system, messages, tools, onTool }) {
  const { provider } = config.llm;
  if (provider === 'anthropic') return anthropicLoop({ system, messages, tools, onTool });
  return openaiLoop({ system, messages, tools, onTool });
}

/**
 * Single-shot completion (no tools) used by the content agent and GEO monitor.
 * opts.llm overrides provider settings (e.g. a separate content or GEO model).
 */
export async function complete({ system, user, maxTokens = 4000, temperature = 0.5, llm = {} }) {
  const c = { ...config.llm, ...Object.fromEntries(Object.entries(llm).filter(([, v]) => v)) };
  if (c.provider === 'anthropic') {
    // No temperature for Claude: current models (Opus 4.7+, Sonnet 5.5, Fable) reject sampling parameters with a 400.
    const res = await call(`${c.baseUrl || 'https://api.anthropic.com'}/v1/messages`, { 'x-api-key': c.apiKey, 'anthropic-version': '2023-06-01' }, {
      model: c.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }],
    });
    return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  }
  const res = await call(`${(c.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')}/chat/completions`, { authorization: `Bearer ${c.apiKey}` }, {
    model: c.model, max_tokens: maxTokens, temperature, messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  });
  return res.choices?.[0]?.message?.content || '';
}

/** Single-shot completion with one image (vision). image: { data: Buffer, mime } */
export async function completeWithImage({ system, user, image, maxTokens = 800, llm = {} }) {
  const c = { ...config.llm, ...Object.fromEntries(Object.entries(llm).filter(([, v]) => v)) };
  const b64 = image.data.toString('base64');
  if (c.provider === 'anthropic') {
    const res = await call(`${c.baseUrl || 'https://api.anthropic.com'}/v1/messages`, { 'x-api-key': c.apiKey, 'anthropic-version': '2023-06-01' }, {
      model: c.model, max_tokens: maxTokens, system,
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: image.mime, data: b64 } }, { type: 'text', text: user }] }],
    });
    return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  }
  const res = await call(`${(c.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')}/chat/completions`, { authorization: `Bearer ${c.apiKey}` }, {
    model: c.model, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:${image.mime};base64,${b64}` } }, { type: 'text', text: user }] }],
  });
  return res.choices?.[0]?.message?.content || '';
}

/** Pull the first JSON object out of a model reply. */
export function parseJson(text) {
  const t = String(text).replace(/^```(?:json)?\s*|\s*```$/g, '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('no JSON in model reply');
  return JSON.parse(t.slice(a, b + 1));
}

async function call(url, headers, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(45000) });
  if (!r.ok) throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

async function anthropicLoop({ system, messages, tools, onTool }) {
  const { apiKey, model, maxTokens, baseUrl } = config.llm;
  const url = `${baseUrl || 'https://api.anthropic.com'}/v1/messages`;
  const msgs = messages.map((m) => ({ role: m.role, content: m.content }));
  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await call(url, { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, {
      model, max_tokens: maxTokens, system, messages: msgs,
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
    });
    const uses = res.content.filter((b) => b.type === 'tool_use');
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (!uses.length || res.stop_reason !== 'tool_use') return text;
    msgs.push({ role: 'assistant', content: res.content });
    const results = [];
    for (const u of uses) {
      const out = await onTool(u.name, u.input);
      results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out) });
    }
    msgs.push({ role: 'user', content: results });
  }
  return '';
}

async function openaiLoop({ system, messages, tools, onTool }) {
  const { apiKey, model, maxTokens, baseUrl } = config.llm;
  const url = `${(baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')}/chat/completions`;
  const msgs = [{ role: 'system', content: system }, ...messages.map((m) => ({ role: m.role, content: m.content }))];
  const fns = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await call(url, { authorization: `Bearer ${apiKey}` }, { model, max_tokens: maxTokens, messages: msgs, tools: fns, temperature: 0.3 });
    const m = res.choices?.[0]?.message || {};
    if (!m.tool_calls?.length) return (m.content || '').trim();
    msgs.push({ role: 'assistant', content: m.content || '', tool_calls: m.tool_calls });
    for (const tc of m.tool_calls) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
      const out = await onTool(tc.function.name, args);
      msgs.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(out) });
    }
  }
  return '';
}
