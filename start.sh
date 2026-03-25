#!/bin/bash
set -e

echo "=========================================="
echo "  Nuxt 4 + Python User Management System"
echo "=========================================="

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Check if Docker is available
if command -v docker &> /dev/null && docker compose version &> /dev/null; then
    echo -e "${GREEN}Docker detected! Starting with Docker Compose...${NC}"
    docker compose up --build
    exit 0
fi

echo -e "${YELLOW}Docker not found. Starting services locally...${NC}"

# --- Backend Setup ---
echo ""
echo ">>> Setting up Python backend..."
cd backend

if [ ! -d "venv" ]; then
    python3 -m venv venv
fi
source venv/bin/activate
pip install -q -r requirements.txt

echo -e "${GREEN}>>> Starting backend (port 8000)...${NC}"
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000 &
BACKEND_PID=$!

cd ..

# --- Frontend Setup ---
echo ""
echo ">>> Setting up Nuxt frontend..."
cd frontend

if [ ! -d "node_modules" ]; then
    npm install
fi

echo -e "${GREEN}>>> Starting frontend (port 3000)...${NC}"
npm run dev &
FRONTEND_PID=$!

cd ..

echo ""
echo "=========================================="
echo -e "${GREEN}  Services are starting up!${NC}"
echo ""
echo "  Frontend:  http://localhost:3000"
echo "  Backend:   http://localhost:8000"
echo "  API Docs:  http://localhost:8000/docs"
echo ""
echo "  Default admin account:"
echo "    Username: admin"
echo "    Password: admin123"
echo "=========================================="
echo ""
echo "Press Ctrl+C to stop all services."

# Cleanup on exit
trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit" SIGINT SIGTERM

wait
