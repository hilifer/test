#!/usr/bin/env bash
# 启动 P2P 服务（后台运行，日志写到 logs/server.log）
set -e
cd "$(dirname "$0")"

PORT="${PORT:-5001}"
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
if kill -0 "$PID" 2>/dev/null; then
  echo "已启动，PID=$PID，端口=$PORT"
  echo "日志: tail -f $LOG_FILE"
else
  echo "启动失败，查看日志: $LOG_FILE"
  tail -20 "$LOG_FILE" 2>/dev/null
  rm -f "$PID_FILE"
  exit 1
fi
