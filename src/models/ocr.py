"""OCR / channel-detection models (plan task 14, batch W3).

Canonical home for ``OcrResult`` — the OCR agent's channel/logo detection
output used as post-classification enrichment.
"""

from __future__ import annotations

from pydantic import ConfigDict, Field

from src.models.common import PipelineModel


class OcrResult(PipelineModel):
    """Channel/logo detection output from the OCR agent.

    Skeleton for the future visual-RAG index: today OCR-text token matching
    against ``datasets/channels_seed.json`` merged with a pluggable embedding
    index; the pgvector-backed logo index lands in batch W4 (task 18).
    """

    model_config = ConfigDict(extra="forbid")

    channel_label: str = ""
    candidates: list[str] = Field(default_factory=list)
    confidence: float = 0.0
    method: str = "ocr"
    source_screenshot_url: str = ""
    ocr_text: str = ""
