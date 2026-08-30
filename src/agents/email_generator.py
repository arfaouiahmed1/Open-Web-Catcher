"""Generate DMCA takedown email drafts from provider analysis and extraction results.

Compatibility shim (plan task 29, batch W7): rendering ownership moved to
``src/orchestrator/emailing.py`` (pure Jinja2-backed module with versioned
templates under ``configs/email_templates/``). This module keeps the
historical import surface stable for existing callers — ``EmailTool`` and
the API recovery path — while delegating all render logic to the owned
module. Output is golden-locked byte-for-byte; see
``tests/orchestrator/test_email_templates.py``.
"""

from __future__ import annotations

from src.models.schemas import ExtractionResult, ProviderInfo, TakedownEmail
from src.orchestrator.emailing import (
    TakedownEmailRenderInput,
    collect_stream_evidence,
    render_takedown_emails,
)

__all__ = ["generate_takedown_emails", "collect_stream_evidence"]


def generate_takedown_emails(
    *,
    infringing_url: str,
    extraction_results: list[ExtractionResult],
    provider_analysis: list[ProviderInfo],
) -> list[TakedownEmail]:
    """Build one takedown draft per unique provider/contact pair."""
    return render_takedown_emails(
        TakedownEmailRenderInput(
            infringing_url=infringing_url,
            extraction_results=extraction_results,
            provider_analysis=provider_analysis,
        )
    )
