"""Unit tests for the LiteLLM provider layer (task 10).

All tests monkeypatch ``litellm.acompletion`` — no network, no API keys.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from types import SimpleNamespace
from typing import Any

import litellm
import pytest
from langchain_core.messages import HumanMessage
from langchain_core.tools import tool

from src.agents.base import build_llm
from src.llm.provider import (
    ChatLiteLLM,
    TokenUsage,
    extract_usage_families,
    normalize_model_name,
)
from src.utils.config import Settings

pytestmark = pytest.mark.unit


def _make_response(
    *,
    content: str | None = "ok",
    tool_calls: list[dict[str, Any]] | None = None,
    finish_reason: str = "stop",
    usage: dict[str, Any] | None = None,
) -> SimpleNamespace:
    message = SimpleNamespace(content=content, tool_calls=tool_calls)
    return SimpleNamespace(
        choices=[SimpleNamespace(message=message, finish_reason=finish_reason)],
        usage=SimpleNamespace(**(usage or {})),
        model="gemini/gemini-2.5-flash",
    )


@pytest.fixture()
def capture_acompletion(monkeypatch: pytest.MonkeyPatch) -> Callable[[Any], dict[str, Any]]:
    """Install a fake ``litellm.acompletion`` returning the given response."""

    def _install(response: Any) -> dict[str, Any]:
        captured: dict[str, Any] = {}

        async def _fake_acompletion(**kwargs: Any) -> Any:
            captured.update(kwargs)
            return response

        monkeypatch.setattr(litellm, "acompletion", _fake_acompletion)
        return captured

    return _install


@pytest.mark.asyncio
async def test_plain_completion_translation(
    capture_acompletion: Callable[[Any], dict[str, Any]],
) -> None:
    response = _make_response(
        content="hello",
        usage={
            "prompt_tokens": 10,
            "completion_tokens": 5,
            "total_tokens": 15,
            "prompt_tokens_details": {"cached_tokens": 4},
        },
    )
    captured = capture_acompletion(response)

    chat = ChatLiteLLM(model="gemini-2.5-flash", temperature=0.2)
    ai_message = await chat.ainvoke([HumanMessage(content="hi")])

    assert captured["model"] == "gemini/gemini-2.5-flash"
    assert captured["messages"] == [{"role": "user", "content": "hi"}]
    assert captured["temperature"] == 0.2
    assert ai_message.content == "hello"
    assert ai_message.usage_metadata == {
        "input_tokens": 10,
        "output_tokens": 5,
        "total_tokens": 15,
        "input_token_details": {"cached_tokens": 4, "cache_read": 4, "cache_creation": 0},
        "output_token_details": {"reasoning": 0},
    }
    assert ai_message.response_metadata["model_name"] == "gemini/gemini-2.5-flash"
    assert ai_message.response_metadata["token_usage"]["prompt_tokens"] == 10


@pytest.mark.asyncio
async def test_tool_call_normalization_produces_consumable_shape(
    capture_acompletion: Callable[[Any], dict[str, Any]],
) -> None:
    @tool
    def navigate(url: str) -> str:
        """Navigate to a URL."""
        return url

    response = _make_response(
        content=None,
        tool_calls=[
            {
                "id": "call_1",
                "type": "function",
                "function": {"name": "navigate", "arguments": '{"url": "https://example.com"}'},
            }
        ],
        finish_reason="tool_calls",
        usage={"prompt_tokens": 20, "completion_tokens": 8},
    )
    captured = capture_acompletion(response)

    chat = ChatLiteLLM(model="gemini-2.5-flash")
    bound = chat.bind_tools([navigate])
    assert bound.bound_tools[0]["function"]["name"] == "navigate"
    assert chat.bound_tools == []

    ai_message = await bound.ainvoke([HumanMessage(content="go")])

    assert captured["tools"][0]["function"]["name"] == "navigate"
    assert ai_message.tool_calls == [
        {
            "name": "navigate",
            "args": {"url": "https://example.com"},
            "id": "call_1",
            "type": "tool_call",
        }
    ]
    serialized = ai_message.model_dump()
    assert serialized["tool_calls"][0]["args"] == {"url": "https://example.com"}
    assert serialized["tool_calls"][0]["id"] == "call_1"


def test_three_family_usage_extraction_into_token_usage_buckets() -> None:
    gemini_usage, gemini_raw = extract_usage_families(
        {
            "promptTokenCount": 100,
            "candidatesTokenCount": 50,
            "cachedContentTokenCount": 40,
            "thoughtsTokenCount": 8,
        }
    )
    assert gemini_usage == TokenUsage(
        input_tokens=100,
        cached_input_tokens=40,
        cache_write_tokens=0,
        output_tokens=50,
        thinking_tokens=8,
    )
    assert gemini_raw["promptTokenCount"] == 100

    openai_usage, openai_raw = extract_usage_families(
        {
            "prompt_tokens": 100,
            "completion_tokens": 50,
            "prompt_tokens_details": {"cached_tokens": 40},
            "completion_tokens_details": {"reasoning_tokens": 8},
        }
    )
    assert openai_usage == TokenUsage(
        input_tokens=100,
        cached_input_tokens=40,
        cache_write_tokens=0,
        output_tokens=50,
        thinking_tokens=8,
    )
    assert openai_raw["prompt_tokens_details"] == {"cached_tokens": 40}

    anthropic_usage, anthropic_raw = extract_usage_families(
        {
            "input_tokens": 60,
            "output_tokens": 50,
            "cache_read_input_tokens": 40,
            "cache_creation_input_tokens": 10,
        }
    )
    assert anthropic_usage == TokenUsage(
        input_tokens=60,
        cached_input_tokens=40,
        cache_write_tokens=10,
        output_tokens=50,
        thinking_tokens=0,
    )
    assert anthropic_raw["cache_creation_input_tokens"] == 10


def test_normalize_model_name_routing() -> None:
    assert normalize_model_name("gemini-2.5-flash", "google") == "gemini/gemini-2.5-flash"
    assert normalize_model_name("gemini-2.5-flash", "litellm") == "gemini/gemini-2.5-flash"
    assert normalize_model_name("gpt-5-mini", "litellm") == "openai/gpt-5-mini"
    assert normalize_model_name("claude-sonnet-4", "anthropic") == "anthropic/claude-sonnet-4"
    assert normalize_model_name("openai/gpt-5", "litellm") == "openai/gpt-5"
    assert normalize_model_name("", "google") == ""


def test_build_llm_honors_model_override_and_agent_selection() -> None:
    settings = Settings()
    settings.prompt_cache_enabled = False

    overridden = build_llm(settings, model_override="gemini-2.5-pro", temperature=0.3)
    assert isinstance(overridden, ChatLiteLLM)
    assert overridden.model == "gemini-2.5-pro"
    assert overridden.temperature == 0.3
    assert overridden.caching is False

    selected = build_llm(settings, agent_id="classification")
    assert selected.model == settings.agent_model

    settings.agent_model_config = {
        "classification": {"provider": "google", "model": "gemini-2.5-flash-lite"}
    }
    per_agent = build_llm(settings, agent_id="classification")
    assert per_agent.model == "gemini-2.5-flash-lite"


def test_cache_disabled_and_enabled_kwarg_paths(
    monkeypatch: pytest.MonkeyPatch,
    capture_acompletion: Callable[[Any], dict[str, Any]],
) -> None:
    monkeypatch.setattr(litellm, "cache", None, raising=False)

    enabled_captured = capture_acompletion(_make_response())
    enabled = ChatLiteLLM(model="gemini-2.5-flash", caching=True)
    asyncio.run(enabled.ainvoke([HumanMessage(content="a")]))
    assert enabled_captured["caching"] is True
    assert litellm.cache is not None

    disabled_captured = capture_acompletion(_make_response())
    disabled = ChatLiteLLM(model="gemini-2.5-flash", caching=False)
    asyncio.run(disabled.ainvoke([HumanMessage(content="b")]))
    assert disabled_captured["caching"] is False

    settings = Settings()
    settings.prompt_cache_enabled = True
    assert build_llm(settings).caching is True
