"""Classification-stage models (plan task 14, batch W3).

Canonical home for ``ClassificationResult`` — the output of the
classification agent deciding which downstream agent owns a URL.
"""

from typing import Any

from pydantic import Field

from src.models.evidence import EvidenceRef
from src.models.common import (
    AgentType,
    Confidence,
    PageType,
    PipelineModel,
)


class ClassificationResult(PipelineModel):
    url: str
    page_type: PageType
    confidence: Confidence
    reasoning: str = ""
    agent_type: AgentType = AgentType.CLASSIFICATION
    confidence_source: str = "parsed"  # parsed | fallback | heuristic_default
    metadata: dict[str, Any] = Field(default_factory=dict)  # e.g. metadata["ocr"] = OcrResult dump
    evidence: list[EvidenceRef] = Field(default_factory=list)
