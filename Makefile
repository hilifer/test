.PHONY: start stop docker local backend frontend

# One-click start (auto-detect Docker or local)
start:
	bash start.sh

# Docker mode
docker:
	docker compose up --build

# Local mode - start both services
local: backend frontend

# Backend only
backend:
	cd backend && \
	python3 -m venv venv 2>/dev/null || true && \
	. venv/bin/activate && \
	pip install -q -r requirements.txt && \
	uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# Frontend only
frontend:
	cd frontend && \
	npm install && \
	npm run dev

# Stop Docker services
stop:
	docker compose down
