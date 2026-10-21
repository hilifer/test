// Tiny programmable HTTP server for faking external services (LLM APIs, Kingdee, WeCom, RSS…).
import http from 'node:http';

export async function mockServer(handler) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = raw;
    try { body = raw ? JSON.parse(raw) : null; } catch { /* keep text */ }
    const call = { method: req.method, url: req.url, headers: req.headers, body };
    calls.push(call);
    try {
      const out = (await handler(call, calls)) ?? { status: 200, json: {} };
      const headers = { ...(out.headers || {}) };
      if (out.json !== undefined) headers['content-type'] = 'application/json';
      res.writeHead(out.status || 200, headers);
      res.end(out.json !== undefined ? JSON.stringify(out.json) : out.body ?? out.text ?? ''); // body: Buffer for binary files
    } catch (e) {
      res.writeHead(500); res.end(String(e.stack || e));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, calls, close: () => new Promise((r) => server.close(r)) };
}
