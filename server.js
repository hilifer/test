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

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  // SPA-style: /r/XXXX renders index.html
  if (url === '/' || url.startsWith('/r/')) {
    return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
  }
  const filePath = path.join(PUBLIC_DIR, url);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  serveFile(res, filePath);
});

const wss = new WebSocketServer({ server, path: '/ws' });

const rooms = new Map(); // code -> { hostWs, clients: Map<clientId, ws> }
let nextPeerId = 1;

function code4() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusable chars
  let s = '';
  for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function closeRoom(code, reason) {
  const room = rooms.get(code);
  if (!room) return;
  for (const ws of room.clients.values()) send(ws, { type: 'host_gone', reason });
  rooms.delete(code);
  console.log(`[room] closed ${code} (${reason})`);
}

wss.on('connection', (ws) => {
  ws.role = null; // 'host' | 'client'
  ws.peerId = String(nextPeerId++);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'create_room') {
      let code;
      do { code = code4(); } while (rooms.has(code));
      ws.role = 'host';
      ws.roomCode = code;
      rooms.set(code, { hostWs: ws, clients: new Map() });
      send(ws, { type: 'room_created', code });
      console.log(`[room] created ${code} (host=${ws.peerId})`);
      return;
    }

    if (msg.type === 'join_room') {
      const room = rooms.get(msg.code);
      if (!room) return send(ws, { type: 'join_failed', error: '房间不存在或已关闭' });
      ws.role = 'client';
      ws.roomCode = msg.code;
      room.clients.set(ws.peerId, ws);
      send(ws, { type: 'joined', clientId: ws.peerId });
      send(room.hostWs, { type: 'peer_joined', peerId: ws.peerId });
      console.log(`[room] ${msg.code} client ${ws.peerId} joined`);
      return;
    }

    if (msg.type === 'signal') {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      // host -> client (to=clientId), or client -> host (to ignored)
      if (ws.role === 'host') {
        const target = room.clients.get(msg.to);
        send(target, { type: 'signal', from: 'host', payload: msg.payload });
      } else if (ws.role === 'client') {
        send(room.hostWs, { type: 'signal', from: ws.peerId, payload: msg.payload });
      }
      return;
    }
  });

  ws.on('close', () => {
    if (!ws.roomCode) return;
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    if (ws.role === 'host') {
      closeRoom(ws.roomCode, 'host disconnected');
    } else if (ws.role === 'client') {
      room.clients.delete(ws.peerId);
      send(room.hostWs, { type: 'peer_left', peerId: ws.peerId });
      console.log(`[room] ${ws.roomCode} client ${ws.peerId} left`);
    }
  });
});

server.listen(PORT, () => {
  console.log(`server listening on http://0.0.0.0:${PORT}`);
});
