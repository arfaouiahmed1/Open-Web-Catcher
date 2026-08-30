"""Database engine, sessions, and migration/bootstrap helpers."""

from __future__ import annotations

import logging
import os
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from src.storage.models import (
    AgentOutputRecord,
    AgentRunRecord,
    BackgroundJobRecord,
    Base,
    DatasetBatchRecord,
    DatasetSiteRecord,
    DatasetSiteRunRecord,
    LLMCallRecord,
    MemoryEntryRecord,
    MemoryHintUsedRecord,
    PipelineRunRecord,
    PricingConfigRecord,
    ProviderLookupCheckRecord,
    PromptCompilationRecord,
    PromptVersionRecord,
    ProviderAnalysisRecord,
    RunModelUsageRecord,
    RunDecisionRecord,
    RunRecord,
    RunScreenshotRecord,
    RunSnapshotRecord,
    RunStreamRecord,
    RunTaskRecord,
    RuntimeEventRecord,
    TakedownEmailRecord,
    ToolCallRecord,
    ToolPlaygroundCallRecord,
)

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./data/open_web_catcher.db")

logger = logging.getLogger(__name__)

# parents[2] = repo root (src/storage/ -> src/ -> root), where alembic.ini lives.
_PROJECT_ROOT = Path(__file__).resolve().parents[2]


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
    config = Config(str(_PROJECT_ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(_PROJECT_ROOT / "alembic"))
    config.set_main_option("sqlalchemy.url", url)
    command.upgrade(config, "head")


def create_tables() -> None:
    """Initialize the database schema.

    In-memory SQLite test databases use metadata.create_all to stay fast and
    self-contained. Every other database runs the Alembic chain; a migration
    failure is logged and re-raised instead of silently falling back to
    create_all.
    """

    if DATABASE_URL == "sqlite:///:memory:":
        Base.metadata.create_all(bind=engine)
        return

    try:
        run_migrations(DATABASE_URL)
    except Exception:
        logger.exception("Database migration failed for %s", DATABASE_URL)
        raise


__all__ = [
    "AgentOutputRecord",
    "AgentRunRecord",
    "BackgroundJobRecord",
    "Base",
    "DATABASE_URL",
    "DatasetBatchRecord",
    "DatasetSiteRecord",
    "DatasetSiteRunRecord",
    "LLMCallRecord",
    "MemoryEntryRecord",
    "MemoryHintUsedRecord",
    "PipelineRunRecord",
    "PricingConfigRecord",
    "ProviderLookupCheckRecord",
    "PromptCompilationRecord",
    "PromptVersionRecord",
    "ProviderAnalysisRecord",
    "RunModelUsageRecord",
    "RunDecisionRecord",
    "RunRecord",
    "RunScreenshotRecord",
    "RunSnapshotRecord",
    "RunStreamRecord",
    "RunTaskRecord",
    "RuntimeEventRecord",
    "SessionLocal",
    "TakedownEmailRecord",
    "ToolCallRecord",
    "ToolPlaygroundCallRecord",
    "create_tables",
    "engine",
    "get_session",
    "run_migrations",
]
