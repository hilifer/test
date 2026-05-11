# P2P 文件传输

基于 WebRTC DataChannel 的浏览器端点对点文件传输。文件直接在两个浏览器之间走，不经过服务器，服务器只做信令转发。

## 快速开始

```bash
npm install
npm start
```

打开 http://localhost:5001 ，在两台机器（或两个标签页）各打开一次，把对方的 4 位 ID 填到「连接对方」里点连接，然后拖拽文件即可。

## 架构

```
浏览器 A  ──signaling──  Node.js (ws)  ──signaling──  浏览器 B
   └────────────── WebRTC DataChannel 直连 ──────────────┘
```

- `server.js` — HTTP 静态服务 + WebSocket 信令（`/ws`）
- `public/index.html` — 单页界面
- `public/app.js` — WebRTC 客户端逻辑（offer/answer、ICE、文件分片）
- `public/style.css` — 样式

## 已知限制

- 没有 TURN 中继。对称型 NAT 下可能连不通；同一局域网或公网友好 NAT 没问题。
- 没有断点续传 / 完整性校验。
