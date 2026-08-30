"""FastAPI dependencies enforcing bearer authentication and role gating."""

from __future__ import annotations

import re
from typing import Any, Final

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from src.api.auth.security import decode_token, get_jwt_secret
from src.storage.database import get_session
from src.storage.models import UserRecord

_bearer_scheme = HTTPBearer(auto_error=False)
_SSE_QUERY_TOKEN_PATH: Final[re.Pattern[str]] = re.compile(
    r"(?:/api/datasets/stream|/ui/runs/[^/]+/stream)"
)

PUBLIC_ROUTES: set[tuple[str, str]] = {
    ("POST", "/api/auth/login"),
    ("POST", "/api/auth/bootstrap-admin"),
    ("GET", "/health"),
}

_INVALID_CREDENTIALS = "Invalid email or password"
_NOT_AUTHENTICATED = "Not authenticated"


def _unauthorized(detail: str = _NOT_AUTHENTICATED) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


def _accepts_query_token(method: str, path: str) -> bool:
    return method == "GET" and _SSE_QUERY_TOKEN_PATH.fullmatch(path) is not None


def _extract_token(
    request: Request, credentials: HTTPAuthorizationCredentials | None
) -> str:
    if credentials is not None and credentials.credentials:
        return credentials.credentials
    if _accepts_query_token(request.method, request.url.path):
        return (request.query_params.get("token") or "").strip()
    return ""


def _load_user(session: Session, email: str) -> UserRecord | None:
    return session.query(UserRecord).filter(UserRecord.email == email).first()


def get_current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer_scheme),
) -> UserRecord | None:
    """Global guard: resolve the caller or reject with 401.

    Applied app-wide via app.dependencies; public routes listed in
    PUBLIC_ROUTES pass through untouched (returns None there — no route that
    consumes the user object is public).
    """
    if (request.method, request.url.path) in PUBLIC_ROUTES:
        return None

    token = _extract_token(request, credentials)
    if not token:
        raise _unauthorized()

    try:
        payload = decode_token(token, get_jwt_secret())
    except jwt.PyJWTError as exc:
        raise _unauthorized() from exc

    email = str(payload.get("sub") or "")
    if not email:
        raise _unauthorized()

    session = get_session()
    try:
        user = _load_user(session, email)
    finally:
        session.close()

    if user is None or not user.is_active:
        raise _unauthorized()
    return user


def require_role(*roles: str):
    """Dependency factory: 403 unless the authenticated user has one of roles."""

    def checker(user: UserRecord = Depends(get_current_user)) -> UserRecord:
        if user.role not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Requires one of roles: {', '.join(sorted(roles))}",
            )
        return user

    return checker


def user_payload(user: Any) -> dict[str, str]:
    return {"email": user.email, "role": user.role}
