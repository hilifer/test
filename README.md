# Nuxt 4 + Python FastAPI User Management System

Full-stack user management application with Nuxt 4 frontend and Python FastAPI backend.

## Features

- **User Registration & Login** (JWT authentication)
- **User Profile** management (edit info, change password)
- **Admin Panel** - full CRUD for user management (list, search, edit, enable/disable, delete)
- **Hot Reload** - both frontend and backend auto-reload on code changes
- **One-click Start** - 单容器 Docker Compose，一条命令启动全部

## Quick Start

### 一键启动（单容器，推荐）

```bash
docker compose up --build
```

前后端都在同一个容器内运行，volumes 挂载本地代码，改代码自动热更新。

### 本地开发（不用 Docker）

```bash
bash start.sh
# 或
make local
```

## Access

| Service   | URL                        |
|-----------|----------------------------|
| App       | http://your-server-ip:5001       |
| API Docs  | http://your-server-ip:5001/api/docs |

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
├── Dockerfile             # 单容器构建
├── entrypoint.sh          # 容器入口脚本
├── docker-compose.yml     # Docker 编排 (单容器)
├── start.sh               # 本地启动脚本
└── Makefile               # Make 命令
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
