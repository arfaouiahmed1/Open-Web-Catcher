"""Auth routes: login, current user, first-admin bootstrap (plan T3)."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import text

from src.api.auth import security as auth_security
from src.api.auth.dependencies import get_current_user, user_payload
from src.storage.database import get_session
from src.storage.models import UserRecord

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=1, max_length=1024)


class BootstrapAdminRequest(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=8, max_length=1024)


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=1024)
    new_password: str = Field(min_length=8, max_length=1024)


@router.post("/login")
def login(body: LoginRequest) -> dict:
    session = get_session()
    try:
        user = session.query(UserRecord).filter(UserRecord.email == body.email).first()
        if (
            user is None
            or not user.is_active
            or not auth_security.verify_password(body.password, user.password_hash)
        ):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid email or password",
            )
        token = auth_security.mint_access_token(user)
        return {
            "access_token": token,
            "token_type": "bearer",
            "user": user_payload(user),
        }
    finally:
        session.close()


@router.get("/me")
def me(user: UserRecord = Depends(get_current_user)) -> dict:
    return {"user": user_payload(user)}


@router.post("/change-password")
def change_password(
    body: ChangePasswordRequest,
    user: UserRecord = Depends(get_current_user),
) -> dict[str, bool]:
    """Change the authenticated user's password after verifying the old one."""
    if not auth_security.verify_password(body.current_password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Current password is incorrect")
    if body.current_password == body.new_password:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="New password must be different")

    session = get_session()
    try:
        stored_user = session.query(UserRecord).filter(UserRecord.email == user.email).first()
        if stored_user is None or not stored_user.is_active:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
        stored_user.password_hash = auth_security.hash_password(body.new_password)
        session.commit()
        return {"updated": True}
    finally:
        session.close()


@router.post("/bootstrap-admin")
def bootstrap_admin(body: BootstrapAdminRequest) -> dict:
    """Create the first admin account; no-op success once any user exists.

    F-3 (security review): the claim is a single
    ``INSERT ... SELECT ... WHERE NOT EXISTS`` statement so concurrent
    different-email requests can create at most one admin while the table is
    empty — the previous count-then-insert sequence had a TOCTOU window.
    Identical semantics on SQLite and Postgres.
    """
    password_hash = auth_security.hash_password(body.password)
    session = get_session()
    try:
        result = session.execute(
            text(
                "INSERT INTO users (email, password_hash, role, is_active, created_at) "
                "SELECT :email, :password_hash, 'admin', TRUE, :created_at "
                "WHERE NOT EXISTS (SELECT 1 FROM users)"
            ),
            {
                "email": body.email,
                "password_hash": password_hash,
                "created_at": datetime.now(timezone.utc),
            },
        )
        session.commit()
        return {"created": bool(result.rowcount), "email": body.email}
    finally:
        session.close()
