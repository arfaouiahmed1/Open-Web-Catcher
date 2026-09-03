"""Evidence reference model for the v2 browser-tool contract.

Every MCP tool call that succeeds produces a v2 envelope whose ``proof``
block contains ``before_screenshot_ref``, ``after_screenshot_ref``, and
``network_evidence``.  ``EvidenceRef`` captures a pointer to one piece of
that proof so that downstream models (ClassificationResult, MatchInfo,
ServerResult, ExtractionResult) can be validated against real tool output.

The validator rejects any claimed URL, page type, server success, or
playback success whose ``proof_refs`` are absent, stale, or contradictory
(plan step 12).
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal

from pydantic import Field

from src.models.common import PipelineModel


class EvidenceRef(PipelineModel):
    """A pointer to one piece of proof emitted by a v2 tool call."""

    # What kind of evidence this is.
    kind: Literal[
        "screenshot",       # blobref:sha256[:16] stored in data/blobs
        "network_entry",    # one entry from network_ledger captured at harvest/navigate
        "dom_snapshot",     # aria/DOM snapshot blobref
        "manifest_probe",   # HEAD/Range result for an HLS/DASH manifest
        "media_sample",     # bounded first-segment hash (never persisted beyond hash)
        "page_state",       # page_state.id snapshot pointer
    ]

    # The tool_call_id from the LangChain ToolMessage that produced this proof.
    tool_call_id: str

    # The page_state.id at the moment the evidence was captured.
    # Validators reject proof whose page_state_id no longer matches the
    # current page state when the claim was made.
    page_state_id: str

    # For screenshot/dom_snapshot: "blobref:<sha256[:16]>"
    # For network_entry: the request URL
    # For manifest_probe: the manifest URL
    # For media_sample: sha256 hex of the first segment (file is deleted by default)
    # For page_state: the page_state.id string itself
    ref: str

    # One-line human description, e.g. "HLS master playlist confirmed HTTP 200"
    summary: str = ""

    captured_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
