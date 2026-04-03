from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from app.database import get_db
from app.models.user import User
from app.models.session import UserSession
from app.schemas.user import SessionResponse
from app.utils.security import get_current_user, get_current_token_jti

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


@router.get("/", response_model=list[SessionResponse])
def list_sessions(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
    current_jti: str | None = Depends(get_current_token_jti),
):
    sessions = (
        db.query(UserSession)
        .filter(UserSession.user_id == current_user.id, UserSession.is_active == True)
        .order_by(UserSession.last_active_at.desc())
        .all()
    )
    result = []
    for s in sessions:
        resp = SessionResponse.model_validate(s)
        resp.is_current = (s.token_jti == current_jti)
        result.append(resp)
    return result


@router.delete("/{session_id}")
def revoke_session(
    session_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
    current_jti: str | None = Depends(get_current_token_jti),
):
    session = db.query(UserSession).filter(
        UserSession.id == session_id,
        UserSession.user_id == current_user.id,
        UserSession.is_active == True,
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.token_jti == current_jti:
        raise HTTPException(status_code=400, detail="Cannot revoke current session")
    session.is_active = False
    db.commit()
    return {"message": "Session revoked"}


@router.delete("/")
def revoke_other_sessions(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
    current_jti: str | None = Depends(get_current_token_jti),
):
    sessions = db.query(UserSession).filter(
        UserSession.user_id == current_user.id,
        UserSession.is_active == True,
        UserSession.token_jti != current_jti,
    ).all()
    count = len(sessions)
    for s in sessions:
        s.is_active = False
    db.commit()
    return {"message": f"Revoked {count} other session(s)"}
