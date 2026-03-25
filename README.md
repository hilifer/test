# Nuxt 4 + Python FastAPI User Management System

Full-stack user management application with Nuxt 4 frontend and Python FastAPI backend.

## Features

- **User Registration & Login** (JWT authentication)
- **User Profile** management (edit info, change password)
- **Admin Panel** - full CRUD for user management (list, search, edit, enable/disable, delete)
- **Hot Reload** - both frontend and backend auto-reload on code changes
- **One-click Start** - Docker Compose or local dev with a single command

## Quick Start

### Option 1: Docker (recommended)

```bash
docker compose up --build
```

### Option 2: Local Development

```bash
# One-click start (auto-detects Docker, falls back to local)
bash start.sh

# Or use Make
make start
```

### Option 3: Start Separately

**Backend:**
```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

**Frontend:**
```bash
cd frontend
npm install
npm run dev
```

## Access

| Service   | URL                        |
|-----------|----------------------------|
| Frontend  | http://localhost:3000       |
| Backend   | http://localhost:8000       |
| API Docs  | http://localhost:8000/docs  |

## Default Admin Account

- **Username:** `admin`
- **Password:** `admin123`

## Tech Stack

- **Frontend:** Nuxt 4, Vue 3, Nuxt UI, TypeScript
- **Backend:** Python, FastAPI, SQLAlchemy, SQLite, JWT
- **DevOps:** Docker, Docker Compose

## Project Structure

```
├── frontend/              # Nuxt 4 app
│   ├── pages/             # Route pages
│   ├── composables/       # Shared composable functions
│   ├── middleware/         # Route middleware (auth, admin)
│   └── layouts/           # App layouts
├── backend/               # FastAPI app
│   └── app/
│       ├── main.py        # App entry point
│       ├── models/        # SQLAlchemy models
│       ├── schemas/       # Pydantic schemas
│       ├── routers/       # API routes
│       └── utils/         # Security utilities
├── docker-compose.yml     # Docker orchestration
├── start.sh               # One-click startup script
└── Makefile               # Make commands
```

## API Endpoints

### Auth
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login, returns JWT token

### Users (authenticated)
- `GET /api/users/me` - Get current user
- `PUT /api/users/me` - Update profile
- `POST /api/users/me/change-password` - Change password

### Admin (superuser only)
- `GET /api/users/` - List users (with search & pagination)
- `GET /api/users/count` - Count users
- `GET /api/users/{id}` - Get user by ID
- `PUT /api/users/{id}` - Update user
- `DELETE /api/users/{id}` - Delete user
