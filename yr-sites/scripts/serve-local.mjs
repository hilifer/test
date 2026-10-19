// Local stand-in for Caddy: serves a built site and proxies /api, /mcp, /admin to the sales server.
// Usage: node scripts/serve-local.mjs <dist-dir> <port> <api-port>
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
const [dist, port = 4321, api = 8787] = process.argv.slice(2);
const root = resolve(dist);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml' };
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (/^\/(api|mcp|admin|portal|media)(\/|$)/.test(url.pathname)) {
    const p = http.request({ host: '127.0.0.1', port: api, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    p.on('error', () => { res.writeHead(502); res.end('API not running'); });
    return req.pipe(p);
  }
  let f = join(root, decodeURIComponent(url.pathname));
  if (!f.startsWith(root)) { res.writeHead(403); return res.end(); }
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404, { 'content-type': types['.html'] }); return createReadStream(join(root, '404.html')).on('error', () => res.end('Not found')).pipe(res); }
  res.writeHead(200, { 'content-type': types[extname(f)] || 'application/octet-stream' });
  createReadStream(f).pipe(res);
}).listen(port, () => console.log(`serving ${root} on :${port} → api :${api}`));
