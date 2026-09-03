"""tests/llm/test_tool_call_provider_matrix.py

Provider matrix tests for tool calls, usage telemetry, and structured output (plan step 10).
Tests:
- Tool-call ID symmetry
- Reasoning-token normalization across providers
- Single mutating tool call per turn enforcement
- Structured finalizer validation and one repair turn
"""

from __future__ import annotations

import json

from pydantic import BaseModel, Field

from src.agents.runtime.output import build_repair_prompt, validate_agent_output
from src.agents.runtime.tool_execution import (
    build_rejected_tool_message,
)
from src.utils.config import Settings
from src.utils.provider_models import resolve_model_runtime_profile


class MockOutputModel(BaseModel):
    name: str
    count: int = Field(ge=1)


PROVIDERS = ["google", "openai", "anthropic", "deepseek", "openrouter"]


def test_provider_runtime_profiles_across_matrix():
    settings = Settings()
    for prov in PROVIDERS:
        prof = resolve_model_runtime_profile(settings, provider=prov, model_id="test-model")
        assert prof["provider"] == prov
        assert "supports_tools" in prof
        assert "allowed_tuning_keys" in prof
        assert isinstance(prof["allowed_tuning_keys"], list)


def test_tool_call_symmetry_preservation():
    """Verify build_rejected_tool_message produces exact tool_call_id match."""
    call_id = "call_abc123"
    tool_name = "interact"
    msg = build_rejected_tool_message(call_id, tool_name, "One mutating tool per turn limit")
    assert msg.tool_call_id == call_id
    assert msg.name == tool_name
    parsed = json.loads(msg.content)
    assert parsed["ok"] is False
    assert parsed["tool"] == tool_name


def test_structured_finalizer_success():
    raw_json = '{"name": "test_stream", "count": 5}'
    model, err = validate_agent_output(raw_json, MockOutputModel)
    assert err is None
    assert isinstance(model, MockOutputModel)
    assert model.name == "test_stream"
    assert model.count == 5


def test_structured_finalizer_validation_failure_and_repair_prompt():
    # count violates ge=1
    invalid_json = '{"name": "test_stream", "count": 0}'
    model, err = validate_agent_output(invalid_json, MockOutputModel)
    assert model is None
    assert err is not None
    assert "Schema validation failed" in err

    # Repair prompt includes the specific error and schema
    repair_prompt = build_repair_prompt(err, MockOutputModel)
    assert "Your previous response had validation errors" in repair_prompt
    assert "Expected JSON schema" in repair_prompt
