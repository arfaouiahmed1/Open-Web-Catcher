"""FastAPI application for Open Web Catcher.

Endpoints:
    GET  /health                    — liveness check
    POST /classify                  — classification agent only
    POST /extract                   — single extraction agent for a known page_type
    POST /run                       — full pipeline: classify → extract → analyze → emails
    GET  /runs                      — list recent runs from the database
    GET  /runs/{run_id}             — get a specific run result
    GET  /runs/{run_id}/emails      — get takedown emails for a run
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from src.models.schemas import ClassificationResult, ExtractionResult, PipelineResult
from src.storage.database import create_tables, get_session
from src.storage.repositories import RunRepository
from src.utils.config import Settings
from src.utils.logging import get_logger, setup_logging

logger = get_logger(__name__)

_settings: Settings | None = None


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings.from_yaml()
    return _settings


# ── Lifespan ──────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    setup_logging(level=settings.log_level, log_file=settings.log_file)
    create_tables()
    logger.info(
        "Open Web Catcher API started | orchestrator=%s | agents=%s",
        settings.orchestrator_model,
        settings.agent_model,
    )
    yield
    logger.info("Open Web Catcher API shutting down")


app = FastAPI(
    title="Open Web Catcher",
    description=(
        "Multi-agent anti-piracy pipeline: classify → extract streams → "
        "provider analysis → DMCA takedown emails."
    ),
    version="0.1.0",
    lifespan=lifespan,
)


# ── Request models ────────────────────────────────────────────────────────────

class ClassifyRequest(BaseModel):
    url: str


class ExtractRequest(BaseModel):
    url: str
    page_type: Literal["landing_page", "hosting_page", "embedded_page"]


class RunRequest(BaseModel):
    url: str


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    """Liveness check."""
    settings = get_settings()
    return {
        "status": "ok",
        "orchestrator_model": settings.orchestrator_model,
        "agent_model": settings.agent_model,
    }


@app.post("/classify", response_model=ClassificationResult)
async def classify(req: ClassifyRequest):
    """Run only the classification agent on a URL."""
    from src.agents.classification import ClassificationAgent
    return await ClassificationAgent(get_settings()).run(url=req.url)


@app.post("/extract", response_model=ExtractionResult)
async def extract(req: ExtractRequest):
    """Run a single extraction agent when you already know the page type."""
    settings = get_settings()
    if req.page_type == "landing_page":
        from src.agents.landing_page import LandingPageAgent
        return await LandingPageAgent(settings).run(req.url)
    if req.page_type == "hosting_page":
        from src.agents.hosting_page import HostingPageAgent
        return await HostingPageAgent(settings).run(req.url)
    if req.page_type == "embedded_page":
        from src.agents.embedded_page import EmbeddedPageAgent
        return await EmbeddedPageAgent(settings).run(req.url)
    raise HTTPException(status_code=400, detail=f"Unknown page_type: {req.page_type}")


@app.post("/run", response_model=PipelineResult)
async def run_pipeline(req: RunRequest):
    """Run the full pipeline on a URL.

    Orchestrator coordinates:
      classify → [landing →] hosting(s) → [embedded fallbacks]
      → analyze_providers (IPInfo/Whois)
      → generate_takedown_emails (one per provider)
    """
    from src.agents.orchestrator import run_pipeline as _run_pipeline

    settings = get_settings()
    result = await _run_pipeline(url=req.url, settings=settings)

    try:
        session = get_session()
        RunRepository(session).save(result)
        session.close()
    except Exception as e:
        logger.warning("DB persist failed: %s", e)

    return result


@app.get("/runs")
def list_runs(limit: int = 50):
    """List the most recent pipeline runs."""
    session = get_session()
    try:
        records = RunRepository(session).list_recent(limit=limit)
        return [
            {
                "run_id": r.run_id,
                "url": r.url,
                "page_type": r.page_type,
                "status": r.status,
                "streams_found": r.streams_found,
                "emails_generated": len((r.result_json or {}).get("takedown_emails", [])),
                "success": r.success,
                "duration_seconds": r.duration_seconds,
                "created_at": r.created_at.isoformat(),
            }
            for r in records
        ]
    finally:
        session.close()


@app.get("/runs/{run_id}", response_model=PipelineResult)
def get_run(run_id: str):
    """Get the full PipelineResult for a specific run."""
    session = get_session()
    try:
        record = RunRepository(session).get_by_run_id(run_id)
        if record is None:
            raise HTTPException(status_code=404, detail=f"Run '{run_id}' not found")
        return record.result_json
    finally:
        session.close()


@app.get("/runs/{run_id}/emails")
def get_run_emails(run_id: str):
    """Get only the takedown emails for a specific run."""
    session = get_session()
    try:
        record = RunRepository(session).get_by_run_id(run_id)
        if record is None:
            raise HTTPException(status_code=404, detail=f"Run '{run_id}' not found")
        result_json = record.result_json or {}
        return {
            "run_id": run_id,
            "url": result_json.get("url", ""),
            "emails": result_json.get("takedown_emails", []),
        }
    finally:
        session.close()
