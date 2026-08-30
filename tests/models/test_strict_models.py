"""Plan task 14 (batch W3): strict-model contracts for src/models/.

Acceptance criteria under test:
1. Every stage-result model lives in a domain module and rejects unknown
   fields with ``pydantic.ValidationError`` (``model_config extra="forbid"``).
2. Legacy import paths (``src.models.schemas`` / ``src.models.enums``) remain
   pure re-export shims that resolve to the SAME class objects as the
   canonical homes.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from src.models.classification import ClassificationResult
from src.models.common import (
    AgentType,
    Confidence,
    ExtractionStatus,
    FailureKind,
    PageType,
    PipelineModel,
)
from src.models.hosting import ExtractionResult, ServerResult, StreamURL
from src.models.judge import ProviderInfo, StreamEvidence, TakedownEmail
from src.models.landing import MatchInfo
from src.models.ocr import OcrResult
from src.models.orchestrator import ModelUsage, PipelineResult, RunMetrics

STRICT_STAGE_RESULTS: tuple[type[PipelineModel], ...] = (
    ClassificationResult,
    OcrResult,
    StreamURL,
    ServerResult,
    ExtractionResult,
    MatchInfo,
    ProviderInfo,
    TakedownEmail,
    StreamEvidence,
    ModelUsage,
    RunMetrics,
    PipelineResult,
)


@pytest.mark.unit
@pytest.mark.parametrize("model_cls", STRICT_STAGE_RESULTS, ids=lambda c: c.__name__)
def test_stage_result_rejects_unknown_field(model_cls: type[PipelineModel]) -> None:
    """Instantiating any stage result with an unknown field raises ValidationError."""
    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        model_cls.model_validate({"__unknown_field_t14__": "nope"})


@pytest.mark.unit
def test_every_domain_model_is_strict() -> None:
    """No model in any canonical domain module silently accepts extra fields."""

    def _walk(module: object) -> list[type[PipelineModel]]:
        found = []
        for name in dir(module):
            obj = getattr(module, name)
            if (
                isinstance(obj, type)
                and issubclass(obj, PipelineModel)
                and obj is not PipelineModel
                and obj.__module__ == module.__name__
            ):
                found.append(obj)
        return found

    from src.models import classification, common, hosting, judge, landing, ocr, orchestrator

    modules = [classification, common, hosting, judge, landing, ocr, orchestrator]
    models = [m for mod in modules for m in _walk(mod)]
    assert models, "domain modules must define models"
    for model in models:
        assert model.model_config.get("extra") == "forbid", (
            f"{model.__module__}.{model.__name__} must set extra='forbid'"
        )


@pytest.mark.unit
@pytest.mark.parametrize(
    ("shim_name", "canonical"),
    [
        ("ClassificationResult", ClassificationResult),
        ("OcrResult", OcrResult),
        ("StreamURL", StreamURL),
        ("ServerResult", ServerResult),
        ("ExtractionResult", ExtractionResult),
        ("MatchInfo", MatchInfo),
        ("ProviderInfo", ProviderInfo),
        ("TakedownEmail", TakedownEmail),
        ("StreamEvidence", StreamEvidence),
        ("ModelUsage", ModelUsage),
        ("RunMetrics", RunMetrics),
        ("PipelineResult", PipelineResult),
    ],
)
def test_schemas_shim_reexports_canonical_classes(shim_name: str, canonical: type) -> None:
    from src.models import schemas as schemas_shim

    assert getattr(schemas_shim, shim_name) is canonical


@pytest.mark.unit
@pytest.mark.parametrize(
    "enum_name", ["PageType", "Confidence", "ExtractionStatus", "AgentType", "FailureKind"]
)
def test_enums_shim_reexports_common_enums(enum_name: str) -> None:
    import src.models.common as common_mod
    import src.models.enums as enums_shim

    assert getattr(enums_shim, enum_name) is getattr(common_mod, enum_name)


@pytest.mark.unit
def test_enums_values_unchanged() -> None:
    assert PageType.HOSTING == "hosting_page"
    assert ExtractionStatus.SUCCESS == "success"
    assert AgentType.CLASSIFICATION == "classification"
    assert FailureKind.TIMEOUT == "timeout"
    assert Confidence.HIGH == "high"
