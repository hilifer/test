from fastapi import FastAPI
from app.database import engine, Base
from app.models.user import User  # noqa: F401 - ensure model is registered
from app.routers import auth, users
from app.utils.security import hash_password
from app.database import SessionLocal

Base.metadata.create_all(bind=engine)

app = FastAPI(title="User Management API", version="1.0.0", docs_url="/api/docs", redoc_url="/api/redoc")

app.include_router(auth.router)
app.include_router(users.router)


@app.on_event("startup")
def create_default_admin():
    db = SessionLocal()
    try:
        admin = db.query(User).filter(User.username == "admin").first()
        if not admin:
            admin = User(
                username="admin",
                email="admin@example.com",
                full_name="Administrator",
                hashed_password=hash_password("admin123"),
                is_superuser=True,
            )
            db.add(admin)
            db.commit()
    finally:
        db.close()


@app.get("/api/health")
def health():
    return {"status": "ok"}
