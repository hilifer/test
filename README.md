# P2P 文件分享

基于 WebRTC DataChannel 的浏览器端点对点文件分享。文件直接在浏览器之间走，不经过服务器；服务器只转发 WebRTC 信令（SDP / ICE）。

## 使用

```bash
npm install
npm start
```

打开 http://localhost/ ：

1. **分享者**：选择/拖入文件 → 自动创建房间，得到一个 `/r/XXXX` 链接，复制后发给别人。可以继续添加更多文件，多个访客可同时连入。
2. **接收者**：打开链接 → 自动建立 P2P → 看到文件列表 → 点「下载」拉取（文件由分享者浏览器实时流式发送）。
3. 打开页面时会自动检测网络是否支持 P2P；若是对称型 NAT 或 STUN 不通会在顶部提示，引导换网络或部署 TURN。

文件留在分享者浏览器内存中，**关闭分享者页面，分享立即失效**。

## 架构

```
Sharer (host)  ──signal──┐
                         │      Node.js (ws)
Guest 1        ──signal──┼─────  /ws relay  ─────  (no file data)
Guest 2        ──signal──┘

Sharer ⟷ Guest 1   WebRTC DataChannel (直连)
Sharer ⟷ Guest 2   WebRTC DataChannel (直连)
```

- `server.js` — HTTP 静态 + WebSocket 信令；维护 `rooms = { code → { host, clients[] } }`
- `public/app.js` — host/guest 双模式：
  - host：`createDataChannel` + 队列化按需流式发送（`bufferedAmountLow` 背压）
  - guest：`ondatachannel` 接收文件列表 / 二进制分片 / 组装 Blob 自动下载
  - 启动时 STUN 探测：用两台 STUN 比对 srflx 端口判断是否对称型 NAT
- `scripts/screenshot.mjs` — Playwright 端到端冒烟测试 + 截图

## 公网部署（HTTP）

WebRTC DataChannel 本身不强制 HTTPS，本项目在纯 HTTP 下完全可用。

**最小部署（一次性）**：
```bash
# 在 VPS 上（确保已安装 Node 18+ 和 git）
git clone https://github.com/hilifer/test.git p2p
cd p2p
PORT=80 ./start.sh        # 后台启动，写 PID 到 run/server.pid，日志到 logs/server.log
```

**管理**：
```bash
./start.sh        # 启动（已启动则报告 PID）
./stop.sh         # 停止（先 SIGTERM，5s 没退出再 SIGKILL）
tail -f logs/server.log
```

**绑 80 端口的两种方式**：
- 用 root 直接 `PORT=80 ./start.sh`
- 或允许普通用户绑低端口：`sudo setcap 'cap_net_bind_service=+ep' $(which node)`

**开机自启**：把启动放进 systemd
```ini
# /etc/systemd/system/p2p.service
[Unit]
After=network.target
[Service]
WorkingDirectory=/opt/p2p
Environment=PORT=80
ExecStart=/usr/bin/node server.js
Restart=on-failure
[Install]
WantedBy=multi-user.target
```
`sudo systemctl enable --now p2p`

防火墙放行 80（或你选的端口）的 TCP，把 `http://your-server/` 给别人就行。

**HTTP 下的小注意**：
- 复制按钮已做兜底（不支持 `navigator.clipboard` 时降级到 `execCommand('copy')`，再不行就提示按 Ctrl+C）
- Chrome 地址栏会显示「不安全」，但功能不受影响
- 公网若想跨对称型 NAT，需配 TURN（自建 `coturn` 或买 Twilio TURN）

## 已知限制

- 无 TURN 中继。对称型 NAT 下可能连不通（前端会提示）。
- 文件只存在于分享者内存；不支持断点续传 / 完整性校验。
- 多接收者会瓜分分享者上行带宽（每个接收者一条独立 DataChannel）。
