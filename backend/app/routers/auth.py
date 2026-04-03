from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session
from app.database import get_db
from app.models.user import User
from app.models.session import UserSession
from app.schemas.user import UserCreate, UserResponse, Token, LoginRequest
from app.utils.security import hash_password, verify_password, create_access_token, get_current_user, get_current_token_jti

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/register", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
def register(user_in: UserCreate, db: Session = Depends(get_db)):
    if db.query(User).filter(User.username == user_in.username).first():
        raise HTTPException(status_code=400, detail="Username already exists")
    if db.query(User).filter(User.email == user_in.email).first():
        raise HTTPException(status_code=400, detail="Email already exists")

    user = User(
        username=user_in.username,
        email=user_in.email,
        full_name=user_in.full_name,
        hashed_password=hash_password(user_in.password),
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@router.post("/login", response_model=Token)
def login(login_data: LoginRequest, request: Request, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.username == login_data.username).first()
    if not user or not verify_password(login_data.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Invalid username or password")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="User is disabled")

    token, jti = create_access_token({"sub": user.id})

    # Create session record
    device_info = request.headers.get("User-Agent", "")[:255]
    ip_address = request.client.host if request.client else ""
    session = UserSession(
        user_id=user.id,
        token_jti=jti,
        device_info=device_info,
        ip_address=ip_address,
    )
    db.add(session)
    db.commit()

    return {"access_token": token}


@router.post("/logout")
def logout(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
    jti: str | None = Depends(get_current_token_jti),
):
    if jti:
        session = db.query(UserSession).filter(UserSession.token_jti == jti).first()
        if session:
            session.is_active = False
            db.commit()
    return {"message": "Logged out"}
