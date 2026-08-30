"""Shared enumerations used across the pipeline — COMPAT SHIM (plan task 14).

The canonical definitions moved to ``src.models.common`` in batch W3
(plan task 14). This module is a pure re-export shim so existing
``from src.models.enums import ...`` call sites keep working unchanged.
"""

from __future__ import annotations

from src.models.common import (
    AgentType,
    Confidence,
    EventKind,
    EventStatus,
    ExtractionStatus,
    FailureKind,
    PageType,
)

__all__ = [
    "PageType",
    "Confidence",
    "ExtractionStatus",
    "AgentType",
    "FailureKind",
    # Event schema v2 (plan T31 / SCH-M6/H5).
    "EventKind",
    "EventStatus",
]
