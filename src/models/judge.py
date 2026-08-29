"""Judge-stage models: provider analysis and takedown judgment (plan T14).

Canonical home for the models produced by the provider-analysis /
takedown-email judging half of the pipeline:

- ``ProviderInfo`` — IPInfo/Whois analysis of a single stream URL,
- ``StreamEvidence`` — correlated stream-to-screenshot evidence,
- ``TakedownEmail`` — a rendered takedown notice draft (for human review).
"""

from __future__ import annotations

from datetime import UTC, datetime

from pydantic import Field

from src.models.common import PipelineModel


class ProviderInfo(PipelineModel):
    """IPInfo / Whois result for a single stream URL."""

    stream_url: str
    ip: str = ""
    hostname: str = ""
    org: str = ""  # e.g. "AS12345 SomeHostingProvider"
    provider: str = ""  # cleaned provider name
    country: str = ""
    region: str = ""
    city: str = ""
    abuse_email: str = ""  # from whois abuse contact
    whois_raw: str = ""


class StreamEvidence(PipelineModel):
    """Correlated stream-to-screenshot evidence for takedown drafts."""

    stream_url: str
    protocol: str = ""
    source_layer: str = ""
    server_label: str = ""
    channel_name: str = ""
    screenshot_urls: list[str] = Field(default_factory=list)
    page_url: str = ""
    provider_hostname: str = ""
    ocr_text: str = ""


class TakedownEmail(PipelineModel):
    """A takedown notice email (not sent — written for human review)."""

    provider: str
    abuse_email: str
    channel_name: str = ""
    subject: str
    body: str
    # Evidence attached
    infringing_url: str  # original streaming site URL
    stream_urls: list[str] = Field(default_factory=list)
    screenshot_urls: list[str] = Field(default_factory=list)
    server_labels: list[str] = Field(default_factory=list)
    stream_evidence: list[StreamEvidence] = Field(default_factory=list)
    provider_info: ProviderInfo | None = None
    rights_owner_reference_url: str = ""
    generated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


# ── Evidence-validation gate (plan T24 / VAL-C1/C2, U10, D14) ────────────────


class JudgeVerdict(PipelineModel):
    """LLM-as-judge scoring of extracted evidence sufficiency (target-design §1).

    Produced by ``ValidatorAgent.score_evidence`` before the provider stage;
    consumed by the ``validate_evidence`` node to decide pass vs bounded replan.
    """

    verdict: str = "fail"  # pass | replan | fail
    evidence_score: float = 0.0  # 0..1 overall evidence sufficiency
    playback_confidence: float = 0.0  # 0..1 how likely the streams actually play
    channel_match: bool = False  # screenshots↔claims consistency
    reasoning: str = ""
    required_fixes: list[str] = Field(default_factory=list)
    flagged_urls: list[str] = Field(default_factory=list)  # suspected-hallucinated streams


class ReachabilityProbe(PipelineModel):
    """Result of the mandatory pre-evidence HEAD/short-GET probe (VAL-C2)."""

    url: str
    reachable: bool = False
    status_code: int = 0
    method: str = ""  # "HEAD" or "GET" (short-GET fallback)
    latency_ms: float = 0.0
    error: str = ""


class ReplanRequest(PipelineModel):
    """Bounded replan marker (max 1 per stage, plan D14)."""

    stage: str
    reason: str = ""
    attempt: int = 1


class ValidationReport(PipelineModel):
    """Output of the ``validate_evidence`` node (target-design §1)."""

    passed: bool = False
    issues: list[str] = Field(default_factory=list)
    probes: list[ReachabilityProbe] = Field(default_factory=list)
    dropped_streams: list[str] = Field(default_factory=list)
    kept_streams: list[str] = Field(default_factory=list)
    verdict: JudgeVerdict | None = None
    replan: ReplanRequest | None = None
    schema_version: int = 1
