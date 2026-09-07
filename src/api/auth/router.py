"""Auth routes: login, current user, first-admin bootstrap (plan T3)."""

from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import cast
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.engine import CursorResult
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
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Current password is incorrect"
        )
    if body.current_password == body.new_password:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="New password must be different"
        )

    session = get_session()
    try:
        stored_user = session.query(UserRecord).filter(UserRecord.email == user.email).first()
        if stored_user is None or not stored_user.is_active:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated"
            )
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
        result = cast(
            CursorResult,
            session.execute(
                text(
                    "INSERT INTO users (email, password_hash, role, is_active, created_at, password_reset_token_hash, password_reset_expires_at) "
                    "SELECT :email, :password_hash, 'admin', TRUE, :created_at, '', NULL "
                    "WHERE NOT EXISTS (SELECT 1 FROM users)"
                ),
                {
                    "email": body.email,
                    "password_hash": password_hash,
                    "created_at": datetime.now(timezone.utc),
                },
            ),
        )
        session.commit()
        return {"created": bool(result.rowcount), "email": body.email}
    finally:
        session.close()


logger = logging.getLogger(__name__)

RESET_TOKEN_TTL_MINUTES = 30


class PasswordResetRequest(BaseModel):
    email: str = Field(min_length=3, max_length=255)


class PasswordResetConfirm(BaseModel):
    token: str = Field(min_length=16, max_length=256)
    new_password: str = Field(min_length=8, max_length=1024)


def _hash_reset_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


@router.post("/password-reset/request")
def request_password_reset(body: PasswordResetRequest) -> dict:
    """Issue a password-reset token; always succeeds to avoid enumeration."""
    session = get_session()
    try:
        email = body.email.strip().lower()
        user = session.query(UserRecord).filter(UserRecord.email.ilike(email)).first()
        if user is not None and user.is_active:
            token = secrets.token_urlsafe(32)
            user.password_reset_token_hash = _hash_reset_token(token)
            user.password_reset_expires_at = datetime.now(timezone.utc) + timedelta(
                minutes=RESET_TOKEN_TTL_MINUTES
            )
            session.commit()
            logger.info("Password reset requested for %s", email)
        return {"requested": True}
    finally:
        session.close()


@router.post("/password-reset/confirm")
def confirm_password_reset(body: PasswordResetConfirm) -> dict:
    """Redeem a reset token for a new password (single use, 30 min expiry)."""
    session = get_session()
    try:
        token_hash = _hash_reset_token(body.token.strip())
        candidates = (
            session.query(UserRecord)
            .filter(UserRecord.password_reset_token_hash == token_hash)
            .all()
        )
        user = next(
            (
                row
                for row in candidates
                if hmac.compare_digest(row.password_reset_token_hash or "", token_hash)
            ),
            None,
        )
        now = datetime.now(timezone.utc)
        expires_at = user.password_reset_expires_at if user is not None else None
        if expires_at is not None and expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if user is None or not user.is_active or expires_at is None or expires_at <= now:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid or expired reset token",
            )
        user.password_hash = auth_security.hash_password(body.new_password)
        user.password_reset_token_hash = ""
        user.password_reset_expires_at = None
        session.commit()
        return {"reset": True}
    finally:
        session.close()
