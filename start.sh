#!/usr/bin/env bash
# 启动 P2P 服务（后台运行，日志写到 logs/server.log）
set -e
cd "$(dirname "$0")"

PORT="${PORT:-80}"
PID_FILE="run/server.pid"
LOG_FILE="logs/server.log"

mkdir -p run logs

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "已在运行，PID=$(cat "$PID_FILE")"
  exit 0
fi

if [ ! -d node_modules ]; then
  echo "首次启动，正在 npm ci…"
  npm ci --omit=dev
fi

PORT="$PORT" nohup node server.js >> "$LOG_FILE" 2>&1 &
PID=$!
echo "$PID" > "$PID_FILE"

# 给进程一秒确认是否真的起来了
sleep 1
if ! kill -0 "$PID" 2>/dev/null; then
  echo "启动失败，查看日志: $LOG_FILE"
  tail -20 "$LOG_FILE" 2>/dev/null
  if [ "$PORT" -lt 1024 ] && [ "$(id -u)" -ne 0 ] && grep -q "EACCES" "$LOG_FILE" 2>/dev/null; then
    echo
    echo "看起来是绑 $PORT 端口权限不足。两种修法："
    echo "  1) 用 root 跑：sudo ./start.sh"
    echo "  2) 一次性授权 node 绑低端口：sudo setcap 'cap_net_bind_service=+ep' \$(which node)"
  fi
  rm -f "$PID_FILE"
  exit 1
fi

echo "已启动，PID=$PID，端口=$PORT"
echo "日志: tail -f $LOG_FILE"

# 探测公网 IP（按优先级尝试几家，每家 2 秒超时）
PUBLIC_IP=""
for SRC in "https://ifconfig.me" "https://api.ipify.org" "https://ip.sb" "https://ifconfig.co"; do
  PUBLIC_IP=$(curl -fsS --max-time 2 "$SRC" 2>/dev/null | tr -d '[:space:]')
  if [[ "$PUBLIC_IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
    break
  fi
  PUBLIC_IP=""
done

# 局域网 IP
LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')

echo
echo "访问地址:"
echo "  本机:    http://localhost:$PORT/"
[ -n "$LAN_IP" ] && echo "  内网:    http://$LAN_IP:$PORT/"
if [ -n "$PUBLIC_IP" ]; then
  echo "  外网:    http://$PUBLIC_IP:$PORT/    <- 把这个链接分享给别人"
  echo
  echo "如果外网打不开，先检查：① 云控制台安全组放行 TCP $PORT  ② 主机防火墙 (ufw/iptables) 放行 TCP $PORT"
else
  echo "  外网:    无法探测公网 IP（可能无外网或被拦截）"
fi
