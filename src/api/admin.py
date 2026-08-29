"""Admin APIs (plan T35): role-gated user, metric, prompt, agent-test, cost routes.

Every route requires the ``admin`` role via ``require_role("admin")`` — the
same role system introduced with auth (plan T3). The global bearer guard in
``src.api.app`` already rejects unauthenticated callers (401); these routes
additionally reject authenticated non-admin callers (403).

Prompt-version rollback flips the active ``PromptVersionRecord`` for an agent
AND restores its text to the on-disk prompt file at ``source_path``, so the
next compile (which reads configs/prompts/*.md) picks up the rolled-back
content and records it under the original version's content_hash.
"""

from __future__ import annotations

import difflib
import logging
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError

from src.api.auth import security as auth_security
from src.api.auth.dependencies import require_role
from src.storage.database import get_session
from src.storage.models import BackgroundJobRecord, UserRecord
from src.storage.ui_repository import OperatorConsoleRepository

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/admin", tags=["admin"])

require_admin = require_role("admin")

VALID_ROLES = ("admin", "operator", "viewer")
AGENT_TEST_ACTOR = "admin-agent-test"


# ── Users CRUD ────────────────────────────────────────────────────────────


class AdminUserCreateRequest(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=8, max_length=1024)
    role: str = "viewer"


class AdminUserUpdateRequest(BaseModel):
    role: str | None = None
    is_active: bool | None = None
    password: str | None = Field(default=None, min_length=8, max_length=1024)


def _user_row(user: UserRecord) -> dict[str, Any]:
    return {
        "id": int(user.id or 0),
        "email": str(user.email or ""),
        "role": str(user.role or ""),
        "is_active": bool(user.is_active),
        "created_at": user.created_at.isoformat() if user.created_at else None,
    }


def _load_user_or_404(session: Any, user_id: int) -> UserRecord:
    user = session.query(UserRecord).filter(UserRecord.id == user_id).first()
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return user


def _validate_role(role: str) -> str:
    normalized = str(role or "").strip().lower()
    if normalized not in VALID_ROLES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Role must be one of: {', '.join(VALID_ROLES)}",
        )
    return normalized


@router.get("/users")
def list_users(_: UserRecord = Depends(require_admin)) -> dict[str, Any]:
    session = get_session()
    try:
        rows = session.query(UserRecord).order_by(UserRecord.id.asc()).all()
        return {"users": [_user_row(row) for row in rows], "total": len(rows)}
    finally:
        session.close()


@router.post("/users", status_code=status.HTTP_201_CREATED)
def create_user(
    body: AdminUserCreateRequest, _: UserRecord = Depends(require_admin)
) -> dict[str, Any]:
    role = _validate_role(body.role)
    email = body.email.strip().lower()
    session = get_session()
    try:
        existing = session.query(UserRecord).filter(UserRecord.email == email).first()
        if existing is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail="Email already registered"
            )
        user = UserRecord(
            email=email,
            password_hash=auth_security.hash_password(body.password),
            role=role,
            is_active=True,
        )
        session.add(user)
        session.commit()
        session.refresh(user)
        return _user_row(user)
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Email already registered"
        ) from exc
    finally:
        session.close()


@router.patch("/users/{user_id}")
def update_user(
    user_id: int,
    body: AdminUserUpdateRequest,
    admin: UserRecord = Depends(require_admin),
) -> dict[str, Any]:
    session = get_session()
    try:
        user = _load_user_or_404(session, user_id)
        if body.role is not None:
            new_role = _validate_role(body.role)
            if user.id == admin.id and new_role != "admin":
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Cannot demote your own admin account",
                )
            user.role = new_role
        if body.is_active is not None:
            if user.id == admin.id and not body.is_active:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Cannot deactivate your own account",
                )
            user.is_active = bool(body.is_active)
        if body.password is not None:
            user.password_hash = auth_security.hash_password(body.password)
        session.commit()
        session.refresh(user)
        return _user_row(user)
    finally:
        session.close()


@router.delete("/users/{user_id}")
def delete_user(
    user_id: int, admin: UserRecord = Depends(require_admin)
) -> dict[str, Any]:
    session = get_session()
    try:
        user = _load_user_or_404(session, user_id)
        if user.id == admin.id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cannot delete your own account",
            )
        if user.role == "admin":
            remaining_admins = (
                session.query(UserRecord)
                .filter(UserRecord.role == "admin", UserRecord.id != user.id)
                .count()
            )
            if remaining_admins == 0:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Cannot delete the last remaining admin",
                )
        session.delete(user)
        session.commit()
        return {"deleted": True, "id": user_id}
    finally:
        session.close()


# ── Model-performance metrics (SUM-based; T35 fix) ────────────────────────


@router.get("/metrics/model-performance")
def model_performance_metrics(
    limit: int = Query(50, ge=1, le=500),
    _: UserRecord = Depends(require_admin),
) -> dict[str, Any]:
    session = get_session()
    try:
        return OperatorConsoleRepository(session).admin_model_performance_metrics(limit=limit)
    finally:
        session.close()


# ── Prompt versions: list / diff / activate-rollback ──────────────────────


@router.get("/prompt-versions")
def list_prompt_versions(
    agent_id: str = Query("", description="filter by agent id"),
    limit: int = Query(100, ge=1, le=500),
    _: UserRecord = Depends(require_admin),
) -> dict[str, Any]:
    session = get_session()
    try:
        return OperatorConsoleRepository(session).admin_list_prompt_versions(
            agent_id=agent_id, limit=limit
        )
    finally:
        session.close()


@router.get("/prompt-versions/diff")
def diff_prompt_versions(
    from_id: int = Query(..., alias="from", description="base version id"),
    to_id: int = Query(..., alias="to", description="target version id"),
    _: UserRecord = Depends(require_admin),
) -> dict[str, Any]:
    session = get_session()
    try:
        repo = OperatorConsoleRepository(session)
        base = repo.admin_get_prompt_version(from_id)
        target = repo.admin_get_prompt_version(to_id)
        if base is None or target is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Prompt version not found"
            )
        diff_text = "\n".join(
            difflib.unified_diff(
                str(base.get("prompt_text", "")).splitlines(),
                str(target.get("prompt_text", "")).splitlines(),
                fromfile=f"{base['agent_id']}#{base['id']}",
                tofile=f"{target['agent_id']}#{target['id']}",
                lineterm="",
            )
        )
        return {
            "from": {k: v for k, v in base.items() if k != "prompt_text"},
            "to": {k: v for k, v in target.items() if k != "prompt_text"},
            "identical": base["content_hash"] == target["content_hash"],
            "diff": diff_text,
        }
    finally:
        session.close()


@router.get("/prompt-versions/{version_id}")
def get_prompt_version(
    version_id: int, _: UserRecord = Depends(require_admin)
) -> dict[str, Any]:
    session = get_session()
    try:
        record = OperatorConsoleRepository(session).admin_get_prompt_version(version_id)
        if record is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Prompt version not found"
            )
        return record
    finally:
        session.close()


def _restore_prompt_file(record: dict[str, Any]) -> bool:
    """Best-effort write of the activated prompt text back to disk.

    Compiles read configs/prompts/*.md, so restoring the file makes the next
    compile use the rolled-back content — flipping `active` alone would stay
    write-only bookkeeping. Returns True when a file was written.
    """
    source_path = str(record.get("source_path", "") or "").strip()
    prompt_text = str(record.get("prompt_text", "") or "")
    if not source_path:
        return False
    path = Path(source_path)
    if not path.parent.exists():
        logger.warning(
            "Prompt restore skipped; directory missing for %s", source_path
        )
        return False
    try:
        path.write_text(prompt_text, encoding="utf-8")
    except OSError as exc:
        logger.warning("Prompt restore failed for %s: %s", source_path, exc)
        return False
    return True


@router.post("/prompt-versions/{version_id}/activate")
def activate_prompt_version(
    version_id: int, _: UserRecord = Depends(require_admin)
) -> dict[str, Any]:
    session = get_session()
    try:
        repo = OperatorConsoleRepository(session)
        record = repo.admin_activate_prompt_version(version_id)
        if record is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Prompt version not found"
            )
        full = repo.admin_get_prompt_version(version_id) or {}
        restored = _restore_prompt_file(full)
        return {
            **record,
            "restored_to_disk": restored,
        }
    finally:
        session.close()


# ── Agent tests runner ────────────────────────────────────────────────────


class AgentTestLaunchRequest(BaseModel):
    agent: str = Field(min_length=1, max_length=64)
    url: str = Field(min_length=1, max_length=2048)
    prompt_override: str = ""
    idempotency_key: str = Field(default="", max_length=128)


@router.post("/agent-tests", status_code=status.HTTP_202_ACCEPTED)
def launch_agent_test(
    body: AgentTestLaunchRequest, admin: UserRecord = Depends(require_admin)
) -> dict[str, Any]:
    run_id = str(uuid.uuid4())
    session = get_session()
    try:
        from src.storage.repositories import BackgroundJobRepository

        record = BackgroundJobRepository(session).enqueue(
            run_id=run_id,
            job_type="agent",
            url=body.url,
            actor=AGENT_TEST_ACTOR,
            payload={
                "agent": body.agent,
                "url": body.url,
                "prompt_override": body.prompt_override,
                "replay_target": body.url,
                "launched_by": admin.email,
            },
            idempotency_key=(body.idempotency_key or "").strip(),
        )
        return {
            "job_id": record.job_id,
            "run_id": record.run_id,
            "status": record.status,
            "agent": body.agent,
            "url": body.url,
        }
    finally:
        session.close()


@router.get("/agent-tests")
def list_agent_tests(
    limit: int = Query(50, ge=1, le=500),
    _: UserRecord = Depends(require_admin),
) -> dict[str, Any]:
    session = get_session()
    try:
        return OperatorConsoleRepository(session).admin_list_agent_tests(limit=limit)
    finally:
        session.close()


@router.get("/agent-tests/{run_id}")
def get_agent_test(run_id: str, _: UserRecord = Depends(require_admin)) -> dict[str, Any]:
    session = get_session()
    try:
        record = (
            session.query(BackgroundJobRecord)
            .filter(
                BackgroundJobRecord.run_id == run_id,
                BackgroundJobRecord.job_type == "agent",
            )
            .first()
        )
        if record is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Agent test not found"
            )
        return {
            "job_id": str(record.job_id or ""),
            "run_id": str(record.run_id or ""),
            "status": str(record.status or ""),
            "url": str(record.url or ""),
            "payload": dict(record.payload_json or {}),
            "error": str(record.error_text or ""),
            "result": dict(record.result_json or {}),
        }
    finally:
        session.close()


# ── Cost deltas (COST proposal) ───────────────────────────────────────────


@router.get("/costs")
def cost_deltas(
    window_days: int = Query(30, ge=1, le=365),
    limit: int = Query(100, ge=1, le=500),
    _: UserRecord = Depends(require_admin),
) -> dict[str, Any]:
    session = get_session()
    try:
        return OperatorConsoleRepository(session).admin_cost_deltas(
            window_days=window_days, limit=limit
        )
    finally:
        session.close()
