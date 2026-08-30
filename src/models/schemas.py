"""Pydantic data models for the pipeline — COMPAT SHIM (plan task 14).

Batch W3 split the former monolithic schema file into per-domain modules:

- ``src/models/classification.py`` → ``ClassificationResult``
- ``src/models/landing.py``        → ``MatchInfo``
- ``src/models/hosting.py``        → ``StreamURL``, ``ServerResult``, ``ExtractionResult``
- ``src/models/ocr.py``            → ``OcrResult``
- ``src/models/judge.py``          → ``ProviderInfo``, ``StreamEvidence``, ``TakedownEmail``
- ``src/models/orchestrator.py``   → run metrics/results + operator/workflow DTOs
- ``src/models/common.py``         → shared enums + strict ``PipelineModel`` base

This module is now a pure re-export shim so existing
``from src.models.schemas import ...`` call sites keep working unchanged.
"""

from __future__ import annotations

from src.models.classification import ClassificationResult
from src.models.common import AgentType, Confidence, ExtractionStatus, PageType
from src.models.hosting import ExtractionResult, ServerResult, StreamURL
from src.models.judge import ProviderInfo, StreamEvidence, TakedownEmail
from src.models.landing import MatchInfo
from src.models.ocr import OcrResult
from src.models.orchestrator import (
    AgentTestRequest,
    DatabaseTableResponse,
    ModelUsage,
    OperatorOverview,
    PipelineResult,
    PricingConfig,
    ProviderLookupRequest,
    RunMetrics,
    ToolPlaygroundRequest,
    WorkflowRunRequest,
)

__all__ = [
    "ClassificationResult",
    "OcrResult",
    "StreamURL",
    "ServerResult",
    "ExtractionResult",
    "MatchInfo",
    "ProviderInfo",
    "StreamEvidence",
    "TakedownEmail",
    "ModelUsage",
    "RunMetrics",
    "PipelineResult",
    "PricingConfig",
    "OperatorOverview",
    "AgentTestRequest",
    "WorkflowRunRequest",
    "ToolPlaygroundRequest",
    "ProviderLookupRequest",
    "DatabaseTableResponse",
    # Enum re-exports: HEAD-era callers sometimes pulled these from schemas.
    "AgentType",
    "Confidence",
    "ExtractionStatus",
    "PageType",
]
