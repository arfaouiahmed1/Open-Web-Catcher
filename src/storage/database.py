"""Database engine, sessions, and migration/bootstrap helpers."""

from __future__ import annotations

import os
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from src.storage.models import (
    AgentOutputRecord,
    AgentRunRecord,
    Base,
    LLMCallRecord,
    MemoryEntryRecord,
    MemoryHintUsedRecord,
    PipelineRunRecord,
    PromptCompilationRecord,
    PromptVersionRecord,
    ProviderAnalysisRecord,
    RunModelUsageRecord,
    RunRecord,
    RunScreenshotRecord,
    RunSnapshotRecord,
    RunStreamRecord,
    RuntimeEventRecord,
    TakedownEmailRecord,
    ToolCallRecord,
)

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./data/open_web_catcher.db")


def _build_engine(database_url: str):
    is_sqlite = database_url.startswith("sqlite")
    connect_args = {"check_same_thread": False} if is_sqlite else {}
    return create_engine(database_url, echo=False, connect_args=connect_args)


engine = _build_engine(DATABASE_URL)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


def get_session() -> Session:
    return SessionLocal()


def run_migrations(database_url: str | None = None) -> None:
    url = database_url or DATABASE_URL
    alembic_ini = Path("alembic.ini")
    if not alembic_ini.exists():
        return

    config = Config(str(alembic_ini))
    config.set_main_option("sqlalchemy.url", url)
    command.upgrade(config, "head")


def create_tables() -> None:
    """Initialize the database schema.

    Production paths use Alembic. Lightweight SQLite test databases fall back to
    metadata.create_all to keep unit tests fast and self-contained.
    """

    if DATABASE_URL == "sqlite:///:memory:" or DATABASE_URL.startswith("sqlite:///"):
        Base.metadata.create_all(bind=engine)
        return

    try:
        run_migrations(DATABASE_URL)
    except Exception:
        Base.metadata.create_all(bind=engine)


__all__ = [
    "AgentOutputRecord",
    "AgentRunRecord",
    "Base",
    "DATABASE_URL",
    "LLMCallRecord",
    "MemoryEntryRecord",
    "MemoryHintUsedRecord",
    "PipelineRunRecord",
    "PromptCompilationRecord",
    "PromptVersionRecord",
    "ProviderAnalysisRecord",
    "RunModelUsageRecord",
    "RunRecord",
    "RunScreenshotRecord",
    "RunSnapshotRecord",
    "RunStreamRecord",
    "RuntimeEventRecord",
    "SessionLocal",
    "TakedownEmailRecord",
    "ToolCallRecord",
    "create_tables",
    "engine",
    "get_session",
    "run_migrations",
]
