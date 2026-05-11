#!/usr/bin/env bash
# 停止 P2P 服务
set -e
cd "$(dirname "$0")"

PID_FILE="run/server.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "未找到 PID 文件，可能没在运行"
  exit 0
fi

PID="$(cat "$PID_FILE")"

if ! kill -0 "$PID" 2>/dev/null; then
  echo "进程 $PID 已不存在，清理 PID 文件"
  rm -f "$PID_FILE"
  exit 0
fi

kill "$PID"

# 等待最多 5 秒优雅退出，否则 SIGKILL
for i in 1 2 3 4 5; do
  if ! kill -0 "$PID" 2>/dev/null; then
    rm -f "$PID_FILE"
    echo "已停止 (PID=$PID)"
    exit 0
  fi
  sleep 1
done

echo "进程未在 5s 内退出，发送 SIGKILL"
kill -9 "$PID" 2>/dev/null || true
rm -f "$PID_FILE"
echo "已强制停止 (PID=$PID)"
