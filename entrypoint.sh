#!/bin/bash
set -e

echo "=========================================="
echo "  Starting Backend + Frontend (single container)"
echo "=========================================="

# Start backend (internal only, not exposed to host)
cd /app/backend
/app/backend/venv/bin/uvicorn app.main:app --reload --host 127.0.0.1 --port 8000 &

# Start frontend on port 5001, Nuxt proxies /api to backend
cd /app/frontend
npx nuxt dev --host 0.0.0.0 --port 5001 &

echo ""
echo "  App:       http://<your-server-ip>:5001"
echo "  API Docs:  http://<your-server-ip>:5001/api/docs  (proxied)"
echo ""
echo "  Admin: admin / admin123"
echo "=========================================="

# Keep container alive, exit if either process dies
wait -n
exit $?
