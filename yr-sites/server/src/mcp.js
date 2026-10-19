// Public MCP endpoint (Streamable HTTP, JSON responses) so buyers' AI agents can
// search the catalog, read specs, get reference prices and submit an inquiry.
import { config } from './config.js';
import { toolDefs, runTool } from './tools.js';

const PROTOCOL = '2025-06-18';

export async function handleMcp(body) {
  const batch = Array.isArray(body) ? body : [body];
  const out = [];
  for (const msg of batch) {
    const r = await one(msg);
    if (r) out.push(r);
  }
  if (!out.length) return null; // notifications only → 202
  return Array.isArray(body) ? out : out[0];
}

async function one(msg) {
  const { id, method, params = {} } = msg || {};
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  if (id === undefined || id === null) return null; // notification
  try {
    switch (method) {
      case 'initialize':
        return ok({
          protocolVersion: params.protocolVersion || PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: `${config.profile.brand} catalog`, version: '1.0.0' },
          instructions: `Official product catalog of ${config.profile.brand} (${config.profile.company}). Prices are public reference ranges (${config.catalog.priceTerm}); a formal PI is issued by our sales team after submit_inquiry.`,
        });
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: toolDefs({ forMcp: true }).map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })) });
      case 'tools/call': {
        const allowed = toolDefs({ forMcp: true }).map((t) => t.name);
        if (!allowed.includes(params.name)) return err(-32602, `Unknown tool: ${params.name}`);
        const res = await runTool(params.name, params.arguments || {}, { source: 'mcp' });
        return ok({ content: [{ type: 'text', text: JSON.stringify(res, null, 2) }], structuredContent: res, isError: Boolean(res.error) });
      }
      default:
        return err(-32601, `Method not found: ${method}`);
    }
  } catch (e) {
    return err(-32603, e.message);
  }
}
