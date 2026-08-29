"""LiteLLM-backed LLM provider layer (target-design.md §4).

All model traffic funnels through :class:`LlmProvider`; agents keep their
LangChain call-sites via :class:`ChatLiteLLM`, which delegates to
:class:`LiteLLMProvider`. Family-specific SDKs stay behind this seam.

Model-name routing
------------------
Legacy settings store bare family names such as ``gemini-2.5-flash``.
:func:`normalize_model_name` maps them to LiteLLM's ``provider/model`` routing
format using the ``llm_provider`` setting as the prefix hint:

- names that already contain ``/`` are assumed routed and pass through;
- otherwise the provider hint supplies the prefix (``google``/``gemini``/
  ``google_genai`` -> ``gemini``, ``openai`` -> ``openai``, ``anthropic`` ->
  ``anthropic``, ``openrouter`` -> ``openrouter``, ``nvidia`` ->
  ``nvidia_nim``);
- with the neutral ``litellm`` hint the family is inferred from the name
  itself (``gemini-*`` -> ``gemini/...``, ``gpt-*`` -> ``openai/...``,
  ``claude-*`` -> ``anthropic/...``);
- unrecognized names pass through bare so misconfiguration surfaces at the
  provider instead of being masked.

Caching replaces the managed Gemini explicit-cache flow: when
``Settings.prompt_cache_enabled`` is set, calls pass ``caching=True`` to
``litellm.acompletion`` backed by a process-local in-memory cache instance.
Redis-backed caching arrives in batch W4.

Usage extraction covers the three provider families defensively — Gemini
(``promptTokenCount``/``candidatesTokenCount``/``cachedContentTokenCount``/
``thoughtsTokenCount``), OpenAI (``prompt_tokens_details.cached_tokens``),
and Anthropic (``cache_read_input_tokens``/``cache_creation_input_tokens``) —
into the shared :class:`TokenUsage` buckets. Extraction only: per-family cost
math (Gemini subset rule, Anthropic disjoint read/write buckets) lands with
CostAccounting in task 11.
"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Protocol, Sequence, runtime_checkable

import litellm
from langchain_core.callbacks import (
    AsyncCallbackManagerForLLMRun,
    CallbackManagerForLLMRun,
)
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, SystemMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.utils.function_calling import convert_to_openai_tool
from pydantic import Field

from src.utils.logging import get_logger

logger = get_logger(__name__)

_PROVIDER_PREFIXES = {
    "google": "gemini",
    "gemini": "gemini",
    "google_genai": "gemini",
    "google-vertex": "vertex_ai",
    "vertex": "vertex_ai",
    "openai": "openai",
    "anthropic": "anthropic",
    "openrouter": "openrouter",
    "nvidia": "nvidia_nim",
}

_FAMILY_PREFIX_PATTERNS = (
    ("gemini-", "gemini"),
    ("gemma-", "gemini"),
    ("gpt-", "openai"),
    ("o1", "openai"),
    ("o3", "openai"),
    ("o4", "openai"),
    ("claude-", "anthropic"),
)


def normalize_model_name(model_name: str, provider: str = "") -> str:
    """Map legacy bare model names to LiteLLM's ``provider/model`` format."""
    name = str(model_name or "").strip()
    if not name or "/" in name:
        return name
    prefix = _PROVIDER_PREFIXES.get(str(provider or "").strip().lower(), "")
    if not prefix:
        lowered = name.lower()
        for pattern, family_prefix in _FAMILY_PREFIX_PATTERNS:
            if lowered.startswith(pattern):
                prefix = family_prefix
                break
    return f"{prefix}/{name}" if prefix else name


@dataclass(frozen=True)
class ModelSpec:
    """Routing identity for one completion request (target-design.md §4)."""

    family: str = ""
    model_name: str = ""
    temperature: float | None = None
    max_tokens: int | None = None


@dataclass(frozen=True)
class TokenUsage:
    """Normalized usage buckets shared by every provider family."""

    input_tokens: int = 0
    cached_input_tokens: int = 0
    cache_write_tokens: int = 0
    output_tokens: int = 0
    thinking_tokens: int = 0


@dataclass(frozen=True)
class LlmResponse:
    """Family-neutral completion result returned by :class:`LlmProvider`."""

    content: str = ""
    tool_calls: list[dict[str, Any]] | None = None
    usage: TokenUsage | None = None
    stop_reason: str = ""


class CacheSemantics(StrEnum):
    """Per-family cache accounting rules applied by CostAccounting (task 11)."""

    GEMINI_SUBSET = "gemini_subset"
    ANTHROPIC_DISJOINT_READ_WRITE = "anthropic_disjoint_read_write"


def _usage_mapping(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    return dict(getattr(value, "__dict__", {}) or {})


def _usage_int(*values: Any) -> int:
    for value in values:
        try:
            number = int(value or 0)
        except (TypeError, ValueError):
            continue
        if number > 0:
            return number
    return 0


def extract_usage_families(usage: Any) -> tuple[TokenUsage, dict[str, Any]]:
    """Extract Gemini/OpenAI/Anthropic usage payloads into TokenUsage buckets.

    Returns the normalized buckets plus a raw passthrough dict preserving the
    per-family fields for ``response_metadata`` telemetry.
    """
    raw = _usage_mapping(usage)
    prompt_details = _usage_mapping(
        raw.get("prompt_tokens_details") or raw.get("input_token_details")
    )
    completion_details = _usage_mapping(
        raw.get("completion_tokens_details") or raw.get("output_token_details")
    )

    openai_input = _usage_int(raw.get("prompt_tokens"))
    openai_output = _usage_int(raw.get("completion_tokens"))
    openai_cached = _usage_int(prompt_details.get("cached_tokens"), raw.get("cached_tokens"))
    openai_thinking = _usage_int(completion_details.get("reasoning_tokens"))

    anthropic_input = _usage_int(raw.get("input_tokens"))
    anthropic_output = _usage_int(raw.get("output_tokens"))
    anthropic_cache_read = _usage_int(
        raw.get("cache_read_input_tokens"),
        prompt_details.get("cache_read_input_tokens"),
        prompt_details.get("cache_read"),
    )
    anthropic_cache_write = _usage_int(
        raw.get("cache_creation_input_tokens"),
        prompt_details.get("cache_creation_input_tokens"),
        prompt_details.get("cache_creation"),
    )

    gemini_input = _usage_int(raw.get("prompt_token_count"), raw.get("promptTokenCount"))
    gemini_output = _usage_int(raw.get("candidates_token_count"), raw.get("candidatesTokenCount"))
    gemini_cached = _usage_int(
        raw.get("cached_content_token_count"),
        raw.get("cachedContentTokenCount"),
        prompt_details.get("cached_content_token_count"),
    )
    gemini_thinking = _usage_int(
        raw.get("thoughts_token_count"),
        raw.get("thoughtsTokenCount"),
        completion_details.get("thoughts_token_count"),
    )

    token_usage = TokenUsage(
        input_tokens=openai_input or anthropic_input or gemini_input,
        cached_input_tokens=max(openai_cached, gemini_cached, anthropic_cache_read),
        cache_write_tokens=anthropic_cache_write,
        output_tokens=openai_output or anthropic_output or gemini_output,
        thinking_tokens=max(openai_thinking, gemini_thinking),
    )

    passthrough = {
        "prompt_tokens_details": dict(prompt_details) if prompt_details else None,
        "completion_tokens_details": dict(completion_details) if completion_details else None,
        **{key: value for key, value in raw.items() if isinstance(value, (int, float))},
    }
    return token_usage, passthrough


def _stringify_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text", "")))
            elif isinstance(block, str):
                parts.append(block)
        return "\n".join(parts)
    return str(content) if content is not None else ""


def lc_messages_to_openai_messages(messages: Sequence[BaseMessage]) -> list[dict[str, Any]]:
    """Convert LangChain messages into LiteLLM/OpenAI message dicts."""
    payload: list[dict[str, Any]] = []
    for message in messages:
        if isinstance(message, SystemMessage):
            payload.append({"role": "system", "content": _stringify_content(message.content)})
        elif isinstance(message, ToolMessage):
            payload.append(
                {
                    "role": "tool",
                    "tool_call_id": str(getattr(message, "tool_call_id", "") or ""),
                    "content": _stringify_content(message.content),
                }
            )
        elif isinstance(message, AIMessage):
            entry = {"role": "assistant", "content": _stringify_content(message.content)}
            if message.tool_calls:
                entry["tool_calls"] = [
                    {
                        "id": str(call.get("id") or ""),
                        "type": "function",
                        "function": {
                            "name": str(call.get("name") or ""),
                            "arguments": json.dumps(call.get("args", {})),
                        },
                    }
                    for call in message.tool_calls
                ]
            payload.append(entry)
        else:
            payload.append({"role": "user", "content": _stringify_content(message.content)})
    return payload


def normalize_openai_tool_calls(raw_tool_calls: Any) -> list[dict[str, Any]]:
    """Normalize OpenAI-style tool calls into LangChain ToolCall dicts."""
    normalized: list[dict[str, Any]] = []
    for index, call in enumerate(raw_tool_calls or []):
        call_dict = call if isinstance(call, dict) else getattr(call, "__dict__", {})
        function = call_dict.get("function") or {}
        function = function if isinstance(function, dict) else getattr(function, "__dict__", {})
        arguments = function.get("arguments")
        try:
            args = json.loads(arguments) if arguments else {}
        except (TypeError, ValueError):
            args = {}
            logger.warning("Dropping unparseable tool-call arguments: %s", str(arguments)[:200])
        normalized.append(
            {
                "name": str(function.get("name") or ""),
                "args": args if isinstance(args, dict) else {},
                "id": str(call_dict.get("id") or f"call_{index}"),
                "type": "tool_call",
            }
        )
    return normalized


def normalize_completion_response(response: Any) -> LlmResponse:
    """Map an OpenAI-style litellm response into a family-neutral LlmResponse."""
    choices = list(getattr(response, "choices", None) or [])
    choice = choices[0] if choices else None
    message = getattr(choice, "message", None)
    finish_reason = str(getattr(choice, "finish_reason", "") or "") if choice else ""
    tool_calls = normalize_openai_tool_calls(getattr(message, "tool_calls", None))
    usage, _raw_passthrough = extract_usage_families(getattr(response, "usage", None))
    return LlmResponse(
        content=_stringify_content(getattr(message, "content", None)),
        tool_calls=tool_calls,
        usage=usage,
        stop_reason=finish_reason,
    )


_litellm_cache_lock = threading.Lock()


def ensure_litellm_cache() -> None:
    """Install the process-local in-memory response cache once."""
    with _litellm_cache_lock:
        if getattr(litellm, "cache", None) is None:
            litellm.cache = litellm.Cache(type="local")


@runtime_checkable
class LlmProvider(Protocol):
    """Single seam for all model traffic (target-design.md §4)."""

    async def complete(
        self,
        messages: Sequence[BaseMessage],
        model_spec: ModelSpec,
        tools: list[dict[str, Any]] | None = None,
    ) -> LlmResponse: ...

    async def count_tokens(self, text: str, model_spec: ModelSpec | None = None) -> int: ...


class LiteLLMProvider:
    """LlmProvider implementation delegating to ``litellm.acompletion``."""

    def __init__(
        self,
        *,
        api_base: str | None = None,
        api_key: str | None = None,
        caching: bool = False,
    ) -> None:
        self.api_base = api_base
        self.api_key = api_key
        self.caching = caching
        if caching:
            ensure_litellm_cache()

    async def complete(
        self,
        messages: Sequence[BaseMessage],
        model_spec: ModelSpec,
        tools: list[dict[str, Any]] | None = None,
    ) -> LlmResponse:
        request: dict[str, Any] = {
            "model": normalize_model_name(model_spec.model_name, model_spec.family),
            "messages": lc_messages_to_openai_messages(messages),
            "caching": self.caching,
        }
        if model_spec.temperature is not None:
            request["temperature"] = model_spec.temperature
        if model_spec.max_tokens is not None:
            request["max_tokens"] = model_spec.max_tokens
        if tools:
            request["tools"] = tools
        if self.api_base:
            request["api_base"] = self.api_base
        if self.api_key:
            request["api_key"] = self.api_key
        response = await litellm.acompletion(**request)
        return normalize_completion_response(response)

    async def count_tokens(self, text: str, model_spec: ModelSpec | None = None) -> int:
        stripped = str(text or "")
        if not stripped:
            return 0
        model = normalize_model_name(model_spec.model_name, model_spec.family) if model_spec else None
        try:
            count = litellm.token_counter(text=stripped) if not model else litellm.token_counter(
                model=model, text=stripped
            )
            return int(count or 0)
        except Exception:  # noqa: BLE001 - token counting must never break agents
            return max(len(stripped) // 4, 0)


class ChatLiteLLM(BaseChatModel):
    """LangChain chat model backed by :class:`LiteLLMProvider`.

    Keeps agent call-sites unchanged (``bind_tools``/``ainvoke``) while routing
    every turn through the provider layer. ``model`` stores the legacy bare
    model name so run telemetry keeps its current shape; LiteLLM routing happens
    at request time via :func:`normalize_model_name`.
    """

    model: str = ""
    provider_prefix: str = ""
    api_key: str | None = None
    api_base: str | None = None
    temperature: float | None = None
    max_tokens: int | None = None
    top_p: float | None = None
    top_k: int | None = None
    thinking_budget_tokens: int | None = None
    caching: bool = False
    bound_tools: list[dict[str, Any]] = Field(default_factory=list)

    @property
    def _llm_type(self) -> str:
        return "litellm"

    @classmethod
    def is_lc_serializable(cls) -> bool:
        return False

    def bind_tools(self, tools: Any, **kwargs: Any) -> "ChatLiteLLM":
        converted = [convert_to_openai_tool(tool) for tool in tools]
        return self.model_copy(update={"bound_tools": converted})

    def _build_request(
        self, messages: Sequence[BaseMessage], stop: list[str] | None = None
    ) -> dict[str, Any]:
        if self.caching:
            ensure_litellm_cache()
        request: dict[str, Any] = {
            "model": normalize_model_name(self.model, self.provider_prefix),
            "messages": lc_messages_to_openai_messages(messages),
            "caching": self.caching,
        }
        if self.temperature is not None:
            request["temperature"] = self.temperature
        if self.max_tokens is not None:
            request["max_tokens"] = self.max_tokens
        if self.top_p is not None:
            request["top_p"] = self.top_p
        if self.top_k is not None:
            request["top_k"] = self.top_k
        if self.thinking_budget_tokens is not None:
            request["thinking"] = {
                "type": "enabled",
                "budget_tokens": self.thinking_budget_tokens,
            }
        if stop:
            request["stop"] = stop
        if self.bound_tools:
            request["tools"] = self.bound_tools
        if self.api_base:
            request["api_base"] = self.api_base
        if self.api_key:
            request["api_key"] = self.api_key
        return request

    def _to_chat_result(self, response: Any) -> ChatResult:
        llm_response = normalize_completion_response(response)
        routed_model = normalize_model_name(self.model, self.provider_prefix)
        usage_metadata = {
            "input_tokens": llm_response.usage.input_tokens,
            "output_tokens": llm_response.usage.output_tokens,
            "total_tokens": (
                llm_response.usage.input_tokens + llm_response.usage.output_tokens
            ),
            "input_token_details": {
                "cached_tokens": llm_response.usage.cached_input_tokens,
                "cache_read": llm_response.usage.cached_input_tokens,
                "cache_creation": llm_response.usage.cache_write_tokens,
            },
            "output_token_details": {"reasoning": llm_response.usage.thinking_tokens},
        }
        _, raw_usage = extract_usage_families(getattr(response, "usage", None))
        message = AIMessage(
            content=llm_response.content,
            tool_calls=llm_response.tool_calls,
            additional_kwargs={"usage": raw_usage},
            response_metadata={
                "model_name": routed_model,
                "finish_reason": llm_response.stop_reason,
                "token_usage": raw_usage,
                "thought_token_count": llm_response.usage.thinking_tokens,
            },
            usage_metadata=usage_metadata,
        )
        return ChatResult(generations=[ChatGeneration(message=message)])

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        response = litellm.completion(**self._build_request(messages, stop))
        return self._to_chat_result(response)

    async def _agenerate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: AsyncCallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        response = await litellm.acompletion(**self._build_request(messages, stop))
        return self._to_chat_result(response)
