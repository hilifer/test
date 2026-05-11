import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 5001;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const url = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const filePath = path.join(PUBLIC_DIR, url);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws' });
const peers = new Map();

function shortId() {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

wss.on('connection', (ws) => {
  let id = shortId();
  while (peers.has(id)) id = shortId();
  peers.set(id, ws);
  ws.peerId = id;
  send(ws, { type: 'welcome', id });
  console.log(`[ws] connected ${id} (total=${peers.size})`);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'signal' && msg.to) {
      const target = peers.get(msg.to);
      if (!target) {
        send(ws, { type: 'error', error: `peer ${msg.to} not found` });
        return;
      }
      send(target, { type: 'signal', from: ws.peerId, payload: msg.payload });
    }
  });

  ws.on('close', () => {
    peers.delete(id);
    console.log(`[ws] disconnected ${id} (total=${peers.size})`);
  });
});

server.listen(PORT, () => {
  console.log(`server listening on http://0.0.0.0:${PORT}`);
});
