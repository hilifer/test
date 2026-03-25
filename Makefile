.PHONY: start stop docker local backend frontend

# One-click Docker start (single container)
start:
	docker compose up --build

# Same as start
docker:
	docker compose up --build

# Local mode - start both services without Docker
local: backend frontend

# Backend only (local)
backend:
	cd backend && \
	python3 -m venv venv 2>/dev/null || true && \
	. venv/bin/activate && \
	pip install -q -r requirements.txt && \
	uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# Frontend only (local)
frontend:
	cd frontend && \
	npm install && \
	npm run dev

# Stop container
stop:
	docker compose down
