"""Password hashing and JWT encode/decode for the auth foundation (plan T3)."""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import bcrypt
import jwt

from src.utils.config import Settings


def _auth_settings() -> Settings:
    """Indirection point so tests can inject a settings instance."""
    return Settings()


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    if not password_hash:
        return False
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except ValueError:
        return False


def get_jwt_secret(settings: Settings | None = None) -> str:
    resolved = settings or _auth_settings()
    secret = (resolved.auth_jwt_secret or "").strip()
    if not secret:
        raise ValueError(
            "AUTH_JWT_SECRET is empty: set auth_jwt_secret in Settings/.env "
            "before using any authenticated endpoint"
        )
    return secret


def _default_now() -> datetime:
    return datetime.now(UTC)


def create_access_token(
    *,
    email: str,
    role: str,
    secret: str,
    expires_minutes: int,
    now: Callable[[], datetime] | None = None,
) -> str:
    moment = (now or _default_now)()
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    payload: dict[str, Any] = {
        "sub": email,
        "role": role,
        "iat": int(moment.timestamp()),
        "exp": int((moment + timedelta(minutes=expires_minutes)).timestamp()),
    }
    return jwt.encode(payload, secret, algorithm="HS256")


def decode_token(token: str, secret: str) -> dict[str, Any]:
    """Raise jwt.PyJWTError on tampered/expired/malformed tokens."""
    return jwt.decode(token, secret, algorithms=["HS256"])


def mint_access_token(user: Any) -> str:
    settings = _auth_settings()
    return create_access_token(
        email=user.email,
        role=user.role,
        secret=get_jwt_secret(settings),
        expires_minutes=settings.auth_token_expiry_minutes,
    )
