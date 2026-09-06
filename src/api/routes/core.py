"""Core liveness and blob routes for the FastAPI application."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from src.storage.blob_store import read_blob


@dataclass(frozen=True)
class CoreRouteDependencies:
    """Application services required by the core routes."""

    get_settings: Callable[[], Any]
    runtime_dependency_snapshot: Callable[[Any], dict[str, Any]]
    background_job_health: Callable[[], dict[str, Any]]
    observability_status: Callable[[Any], Any]


def create_core_router(dependencies: CoreRouteDependencies) -> APIRouter:
    """Build core routes without importing the application module."""

    router = APIRouter()

    @router.get("/health")
    def health() -> dict[str, Any]:
        settings = dependencies.get_settings()
        runtime = dependencies.runtime_dependency_snapshot(settings)
        background_status = dependencies.background_job_health()

        return {
            "status": "ok",
            "orchestrator_model": settings.orchestrator_model,
            "agent_model": settings.agent_model,
            "browser_ws_endpoint": settings.browser_ws_endpoint,
            "mcp_server_url": settings.mcp_server_url,
            "dependencies": {
                "browser": runtime["browser"],
                "mcp": runtime["mcp"],
                "background_jobs": background_status,
            },
            "runtime_preflight": runtime["preflight"],
            "observability": dependencies.observability_status(settings).model_dump(),
        }

    @router.get("/blobs/{key}")
    def read_blob_endpoint(key: str) -> Response:
        """Resolve an authenticated blobref into its stored bytes."""

        data = read_blob(f"blobref:{key}")
        if data is None:
            raise HTTPException(status_code=410, detail="blob unavailable")
        png_magic = b"\x89PNG\x0d\x0a\x1a\x0a"
        if data[:8] == png_magic:
            media_type = "image/png"
        elif len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            media_type = "image/webp"
        else:
            media_type = "application/octet-stream"
        return Response(
            content=data,
            media_type=media_type,
            headers={"Cache-Control": "private, max-age=86400"},
        )

    return router
