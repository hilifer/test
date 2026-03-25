#!/bin/bash
set -e

echo "=========================================="
echo "  Starting Backend + Frontend (single container)"
echo "=========================================="

# Start backend
cd /app/backend
/app/backend/venv/bin/uvicorn app.main:app --reload --host 0.0.0.0 --port 8000 &

# Start frontend
cd /app/frontend
npm run dev -- --host 0.0.0.0 &

echo ""
echo "  Frontend:  http://localhost:3000"
echo "  Backend:   http://localhost:8000"
echo "  API Docs:  http://localhost:8000/docs"
echo ""
echo "  Admin: admin / admin123"
echo "=========================================="

# Keep container alive, exit if either process dies
wait -n
exit $?
