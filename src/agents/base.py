"""Shared LangGraph-based agent infrastructure."""

from __future__ import annotations

import asyncio
import json
import re
import time
from typing import TYPE_CHECKING, Annotated, Any, Callable, TypedDict

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import BaseTool
from langchain_google_genai import ChatGoogleGenerativeAI
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages

from src.utils.config import Settings
from src.utils.logging import get_logger
from src.utils.observability import RunObserver
from src.utils.instrumentation import (
    observability_span,
    resolve_model_pricing,
    set_span_attributes,
    set_span_output,
    using_observability_context,
)

logger = get_logger(__name__)

if TYPE_CHECKING:
    from src.memory.short_term import ShortTermMemory


class RunCancelledError(Exception):
    """Raised when a live run is cancelled from the UI."""


class BudgetExceededError(Exception):
    """Raised when the agent cannot make more tool calls."""


class AgentLoopResult:
    def __init__(self, final_text: str, tool_calls_made: int, messages: list[BaseMessage]) -> None:
        self.final_text = final_text
        self.tool_calls_made = tool_calls_made
        self.messages = messages

    def parse_json(self) -> dict[str, Any]:
        """Try to parse the final text as JSON. Strips markdown fences."""
        text = self.final_text.strip()
        if text.startswith("```"):
            lines = text.splitlines()
            text = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            logger.warning("Could not parse agent output as JSON")
            return {}


class AgentGraphState(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]
    tool_calls_made: int
    max_tool_calls: int
    budget_exhausted: bool


def _json_ready(value: Any) -> Any:
    """Convert provider payloads into JSON-safe data for runtime events."""
    if value is None:
        return {}
    if hasattr(value, "model_dump"):
        value = value.model_dump(mode="json")
    try:
        return json.loads(json.dumps(value, default=str))
    except Exception:
        return {"repr": repr(value)}


def _extract_usage(usage: Any) -> tuple[int, int]:
    usage_dict = usage if isinstance(usage, dict) else getattr(usage, "__dict__", {})
    input_tokens = int(
        usage_dict.get("input_tokens")
        or usage_dict.get("prompt_tokens")
        or usage_dict.get("input_token_count")
        or usage_dict.get("prompt_token_count")
        or 0
    )
    output_tokens = int(
        usage_dict.get("output_tokens")
        or usage_dict.get("completion_tokens")
        or usage_dict.get("candidates_token_count")
        or usage_dict.get("output_token_count")
        or 0
    )
    return input_tokens, output_tokens


def _extract_retry_seconds(error_text: str) -> int | None:
    """Best-effort parsing of retry delay hints from provider error text."""
    if not error_text:
        return None
    match = re.search(r"retry in\s+([0-9]+(?:\.[0-9]+)?)s", error_text, flags=re.IGNORECASE)
    if match:
        try:
            return int(float(match.group(1)))
        except ValueError:
            return None
    match = re.search(r"'retryDelay'\s*:\s*'([0-9]+)s'", error_text)
    if match:
        try:
            return int(match.group(1))
        except ValueError:
            return None
    return None


def _assert_not_cancelled(observer: RunObserver | None, phase: str) -> None:
    if observer is None or not observer.is_cancel_requested():
        return

    reason = observer.cancel_reason() or "Cancelled from the control room."
    observer.emit(
        "run_cancelled",
        f"Run cancelled during {phase}",
        status="warning",
        details={"phase": phase, "cancel_reason": reason},
    )
    raise RunCancelledError(reason)


def _last_ai_message(messages: list[BaseMessage]) -> AIMessage | None:
    for message in reversed(messages):
        if isinstance(message, AIMessage):
            return message
    return None


def _serialize_tool_output(raw: Any) -> str:
    if isinstance(raw, str):
        return raw
    if raw is None:
        return json.dumps({})
    return json.dumps(raw, default=str)


async def _invoke_tool(tool: BaseTool, tool_args: dict[str, Any]) -> Any:
    """Invoke a tool in the most compatible async-safe way possible."""
    try:
        return await tool.ainvoke(tool_args)
    except (AttributeError, NotImplementedError, TypeError):
        return await asyncio.to_thread(tool.invoke, tool_args)


_PROVIDER_CANONICAL = {
    "google": "google_genai",
    "openai": "openai",
    "anthropic": "anthropic",
    "openrouter": "openrouter",
}


def build_llm(
    settings: Settings,
    temperature: float | None = None,
    model_override: str | None = None,
):
    """Build an LLM instance for the configured provider.

    Imports for non-default providers are deferred so that the container
    works with only langchain-google-genai installed (the default).
    """
    model_name = model_override or settings.agent_model
    temp = temperature if temperature is not None else settings.gemini_temperature
    provider = (settings.llm_provider or "google").lower()

    if provider == "openai":
        from langchain_openai import ChatOpenAI  # noqa: PLC0415
        return ChatOpenAI(
            model=model_name,
            api_key=settings.openai_api_key or None,
            temperature=temp,
        )

    if provider == "anthropic":
        from langchain_anthropic import ChatAnthropic  # noqa: PLC0415
        return ChatAnthropic(
            model=model_name,
            api_key=settings.anthropic_api_key or None,
            temperature=temp,
        )

    if provider == "openrouter":
        from langchain_openai import ChatOpenAI  # noqa: PLC0415
        return ChatOpenAI(
            model=model_name,
            api_key=settings.openrouter_api_key or None,
            base_url=settings.openrouter_base_url,
            temperature=temp,
        )

    # default: google / gemini
    return ChatGoogleGenerativeAI(
        model=model_name,
        google_api_key=settings.google_api_key,
        temperature=temp,
        convert_system_message_to_human=True,
    )


async def run_agent_loop(
    settings: Settings,
    llm: Any,
    tools: list[BaseTool],
    system_prompt: str,
    initial_message: str,
    max_tool_calls: int = 20,
    budget_exhausted_message: str = "Budget exhausted. Output your final JSON now.",
    observer: RunObserver | None = None,
    run_name: str = "agent_loop",
    working_memory: "ShortTermMemory | None" = None,
    prompt_metadata: dict[str, Any] | None = None,
    turn_context_provider: Callable[[AgentGraphState], str] | None = None,
) -> AgentLoopResult:
    """Run an async LangGraph agent loop with structured tool calling."""
    tool_map: dict[str, BaseTool] = {tool.name: tool for tool in tools}
    llm_with_tools = llm.bind_tools(tools)
    # Support model name attribute differences across providers
    model_name = (
        getattr(llm, "model", None)
        or getattr(llm, "model_name", None)
        or ""
    )
    provider = _PROVIDER_CANONICAL.get(
        (settings.llm_provider or "google").lower(), "google_genai"
    )
    pricing = resolve_model_pricing(settings, model_name=model_name, provider=provider)
    tool_timeout_seconds = max(1, int(settings.tool_timeout_seconds))
    llm_timeout_seconds = max(5, tool_timeout_seconds * 3)

    if observer is not None:
        observer.record_message("system")
        observer.record_message("human")
        observer.emit(
            "agent_loop_started",
            f"{run_name} started",
            details={
                "max_tool_calls": max_tool_calls,
                "model_name": model_name,
                "prompt": prompt_metadata or {},
            },
        )

    async def llm_node(state: AgentGraphState) -> dict[str, Any]:
        _assert_not_cancelled(observer, "agent loop")
        invocation_messages = list(state["messages"])
        turn_context = ""
        if turn_context_provider is not None:
            turn_context = str(turn_context_provider(state) or "").strip()
            if turn_context:
                invocation_messages.append(HumanMessage(content=turn_context))
        message_count = len(invocation_messages)
        with observability_span(
            f"{run_name}.llm_turn",
            kind="chain",
            input_value={
                "message_count": message_count,
                "tool_calls_made": state["tool_calls_made"],
            },
            attributes={
                "owc.run_name": run_name,
                "owc.message_count_before_call": message_count,
                "owc.tool_calls_made_before_call": state["tool_calls_made"],
            },
        ) as llm_span:
            if observer is not None:
                observer.emit(
                    "llm_turn_started",
                    "Calling model",
                    details={
                        "provider": provider,
                        "model_name": model_name,
                        "message_count": message_count,
                        "timeout_seconds": llm_timeout_seconds,
                    },
                )
            try:
                response: AIMessage = await asyncio.wait_for(
                    llm_with_tools.ainvoke(
                        invocation_messages,
                        config={"run_name": run_name},
                    ),
                    timeout=llm_timeout_seconds,
                )
            except asyncio.TimeoutError as exc:
                if observer is not None:
                    observer.emit(
                        "llm_timeout",
                        f"Model call timed out after {llm_timeout_seconds}s",
                        status="error",
                        details={
                            "provider": provider,
                            "model_name": model_name,
                            "message_count": message_count,
                            "timeout_seconds": llm_timeout_seconds,
                        },
                    )
                raise RuntimeError(f"LLM turn timed out after {llm_timeout_seconds}s") from exc
            except Exception as exc:
                error_text = str(exc)
                is_rate_limited = "RESOURCE_EXHAUSTED" in error_text or "429" in error_text
                if observer is not None:
                    if is_rate_limited:
                        observer.emit(
                            "llm_rate_limited",
                            "Provider quota exceeded for model call",
                            status="error",
                            details={
                                "provider": provider,
                                "model_name": model_name,
                                "retry_after_seconds": _extract_retry_seconds(error_text),
                                "error_type": type(exc).__name__,
                                "error_preview": error_text[:1200],
                            },
                        )
                    else:
                        observer.emit(
                            "llm_error",
                            f"Model call failed: {type(exc).__name__}",
                            status="error",
                            details={
                                "provider": provider,
                                "model_name": model_name,
                                "error_type": type(exc).__name__,
                                "error_preview": error_text[:1200],
                            },
                        )
                raise
            usage = getattr(response, "usage_metadata", None)
            input_tokens, output_tokens = _extract_usage(usage)
            set_span_attributes(
                llm_span,
                {
                    "owc.model_name": model_name,
                    "owc.provider": provider,
                    "owc.input_tokens": input_tokens,
                    "owc.output_tokens": output_tokens,
                    "owc.tool_calls_requested": len(response.tool_calls or []),
                },
            )
            set_span_output(
                llm_span,
                {
                    "has_text": bool(response.content),
                    "tool_calls_requested": len(response.tool_calls or []),
                },
            )

        if observer is not None:
            observer.record_message("ai")
            observer.add_llm_usage(
                getattr(response, "usage_metadata", None),
                model_name=model_name,
                provider=provider,
                pricing=pricing,
            )
            observer.emit(
                "llm_response",
                "Model responded",
                details={
                    "provider": provider,
                    "model_name": model_name,
                    "tool_calls": len(response.tool_calls or []),
                    "tool_call_names": [call.get("name", "") for call in (response.tool_calls or [])],
                    "tool_calls_payload": _json_ready(response.tool_calls or []),
                    "has_text": bool(response.content),
                    "message_count": message_count + 1,
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "usage_metadata": _json_ready(getattr(response, "usage_metadata", None)),
                    "response_metadata": _json_ready(getattr(response, "response_metadata", None)),
                    "additional_kwargs": _json_ready(getattr(response, "additional_kwargs", None)),
                    "response_class": type(response).__name__,
                    "content_preview": (response.content or "")[:1200],
                    "prompt": prompt_metadata or {},
                    "turn_context_preview": turn_context[:600],
                },
            )
        if working_memory is not None and response.content:
            working_memory.record_observation(
                str(response.content)[:500],
                source=f"{run_name}.llm",
            )

        return {"messages": [response], "budget_exhausted": False}

    async def tool_node(state: AgentGraphState) -> dict[str, Any]:
        _assert_not_cancelled(observer, "tool dispatch")
        response = _last_ai_message(state["messages"])
        if response is None or not response.tool_calls:
            return {}

        remaining_budget = state["max_tool_calls"] - state["tool_calls_made"]
        allowed_tool_calls = list(response.tool_calls[: max(remaining_budget, 0)])
        tool_messages: list[ToolMessage] = []
        tool_calls_made = state["tool_calls_made"]
        budget_exhausted = len(response.tool_calls) > len(allowed_tool_calls)

        for tc in allowed_tool_calls:
            tool_name: str = tc["name"]
            tool_args: dict[str, Any] = tc.get("args", {})
            tool_id: str = tc["id"]
            tool_calls_made += 1

            logger.debug(
                "Tool call [%d/%d]: %s(%s)",
                tool_calls_made,
                state["max_tool_calls"],
                tool_name,
                list(tool_args.keys()),
            )
            started_at = time.perf_counter()
            if observer is not None:
                observer.increment_tool_calls()
                observer.emit(
                    "tool_call_started",
                    f"Calling {tool_name}",
                    details={
                        "tool_name": tool_name,
                        "tool_args": tool_args,
                        "tool_call_number": tool_calls_made,
                        "tool_call_budget": state["max_tool_calls"],
                    },
                )
            if working_memory is not None:
                working_memory.record_tool(
                    tool_name,
                    tool_args,
                    status="started",
                )
                for key in ("url", "mainUrl", "player_iframe_url", "base_url"):
                    if tool_args.get(key):
                        working_memory.record_navigation(
                            str(tool_args[key]),
                            via=tool_name,
                        )

            with observability_span(
                tool_name,
                kind="tool",
                input_value=tool_args,
                attributes={
                    "tool.name": tool_name,
                    "owc.tool_call_number": tool_calls_made,
                    "owc.tool_call_budget": state["max_tool_calls"],
                },
            ) as tool_span:
                tool = tool_map.get(tool_name)
                if tool is None:
                    result_content = json.dumps({"error": f"Unknown tool: {tool_name}"})
                    tool_status = "error"
                else:
                    try:
                        try:
                            raw = await asyncio.wait_for(
                                _invoke_tool(tool, tool_args),
                                timeout=tool_timeout_seconds,
                            )
                            result_content = _serialize_tool_output(raw)
                            tool_status = "success"
                        except asyncio.TimeoutError:
                            result_content = json.dumps(
                                {
                                    "error": (
                                        f"Tool '{tool_name}' timed out after {tool_timeout_seconds}s"
                                    )
                                }
                            )
                            tool_status = "error"
                    except Exception as exc:
                        logger.warning("Tool %s raised: %s", tool_name, exc)
                        result_content = json.dumps({"error": str(exc)})
                        tool_status = "error"
                        set_span_attributes(
                            tool_span,
                            {
                                "error.type": type(exc).__name__,
                                "error.message": str(exc),
                            },
                        )

                tool_duration = round(time.perf_counter() - started_at, 3)
                set_span_attributes(
                    tool_span,
                    {
                        "owc.tool_status": tool_status,
                        "owc.tool_duration_seconds": tool_duration,
                    },
                )
                set_span_output(tool_span, result_content[:4000])

            tool_messages.append(ToolMessage(content=result_content, tool_call_id=tool_id))
            if observer is not None:
                observer.record_message("tool")
                observer.emit(
                    "tool_call_finished",
                    f"{tool_name} completed",
                    status=tool_status,
                    details={
                        "tool_name": tool_name,
                        "duration_seconds": tool_duration,
                        "result_preview": result_content[:800],
                        "message_count": len(state["messages"]) + len(tool_messages),
                    },
                )
            if working_memory is not None:
                working_memory.record_tool(
                    tool_name,
                    tool_args,
                    status=tool_status,
                    result_preview=result_content[:400],
                )

        return {
            "messages": tool_messages,
            "tool_calls_made": tool_calls_made,
            "budget_exhausted": budget_exhausted or tool_calls_made >= state["max_tool_calls"],
        }

    async def budget_exhausted_node(state: AgentGraphState) -> dict[str, Any]:
        logger.info("Budget exhausted (%d calls). Forcing final answer.", state["tool_calls_made"])
        if observer is not None:
            observer.emit(
                "budget_exhausted",
                "Tool-call budget exhausted; requesting final answer",
                status="warning",
                details={
                    "tool_calls_made": state["tool_calls_made"],
                    "max_tool_calls": state["max_tool_calls"],
                },
            )
            observer.record_message("human")

        budget_message = HumanMessage(content=budget_exhausted_message)
        _assert_not_cancelled(observer, "final answer preparation")
        with observability_span(
            f"{run_name}.final_answer",
            kind="chain",
            input_value={
                "message_count": len(state["messages"]) + 1,
                "tool_calls_made": state["tool_calls_made"],
            },
            attributes={
                "owc.run_name": run_name,
                "owc.tool_calls_made": state["tool_calls_made"],
                "owc.reason": "budget_exhausted",
            },
        ) as final_span:
            try:
                final: AIMessage = await asyncio.wait_for(
                    llm.ainvoke(
                        [*state["messages"], budget_message],
                        config={"run_name": f"{run_name}_final"},
                    ),
                    timeout=llm_timeout_seconds,
                )
            except asyncio.TimeoutError as exc:
                if observer is not None:
                    observer.emit(
                        "llm_timeout",
                        f"Final model call timed out after {llm_timeout_seconds}s",
                        status="error",
                        details={
                            "provider": provider,
                            "model_name": model_name,
                            "timeout_seconds": llm_timeout_seconds,
                            "phase": "budget_exhausted_final_answer",
                        },
                    )
                raise RuntimeError(f"Final LLM call timed out after {llm_timeout_seconds}s") from exc
            except Exception as exc:
                error_text = str(exc)
                is_rate_limited = "RESOURCE_EXHAUSTED" in error_text or "429" in error_text
                if observer is not None:
                    if is_rate_limited:
                        observer.emit(
                            "llm_rate_limited",
                            "Provider quota exceeded for final model call",
                            status="error",
                            details={
                                "provider": provider,
                                "model_name": model_name,
                                "retry_after_seconds": _extract_retry_seconds(error_text),
                                "phase": "budget_exhausted_final_answer",
                                "error_type": type(exc).__name__,
                                "error_preview": error_text[:1200],
                            },
                        )
                    else:
                        observer.emit(
                            "llm_error",
                            f"Final model call failed: {type(exc).__name__}",
                            status="error",
                            details={
                                "provider": provider,
                                "model_name": model_name,
                                "phase": "budget_exhausted_final_answer",
                                "error_type": type(exc).__name__,
                                "error_preview": error_text[:1200],
                            },
                        )
                raise
            final_usage = getattr(final, "usage_metadata", None)
            input_tokens, output_tokens = _extract_usage(final_usage)
            set_span_attributes(
                final_span,
                {
                    "owc.model_name": model_name,
                    "owc.provider": provider,
                    "owc.input_tokens": input_tokens,
                    "owc.output_tokens": output_tokens,
                },
            )
            set_span_output(final_span, (final.content or "")[:4000])

        if observer is not None:
            observer.record_message("ai")
            observer.add_llm_usage(
                getattr(final, "usage_metadata", None),
                model_name=model_name,
                provider=provider,
                pricing=pricing,
            )

        return {"messages": [budget_message, final], "budget_exhausted": False}

    def route_after_llm(state: AgentGraphState) -> str:
        response = _last_ai_message(state["messages"])
        if response is None or not response.tool_calls:
            return "end"
        return "tools"

    def route_after_tools(state: AgentGraphState) -> str:
        return "budget_exhausted" if state.get("budget_exhausted", False) else "llm"

    graph = StateGraph(AgentGraphState)
    graph.add_node("llm", llm_node)
    graph.add_node("tools", tool_node)
    graph.add_node("budget_exhausted", budget_exhausted_node)
    graph.add_edge(START, "llm")
    graph.add_conditional_edges("llm", route_after_llm, {"tools": "tools", "end": END})
    graph.add_conditional_edges(
        "tools",
        route_after_tools,
        {"llm": "llm", "budget_exhausted": "budget_exhausted"},
    )
    graph.add_edge("budget_exhausted", END)
    compiled = graph.compile()

    initial_state: AgentGraphState = {
        "messages": [
            SystemMessage(content=system_prompt),
            HumanMessage(content=initial_message),
        ],
        "tool_calls_made": 0,
        "max_tool_calls": max_tool_calls,
        "budget_exhausted": False,
    }

    context_metadata = {
        "actor": observer.actor if observer is not None else run_name,
        "run_name": run_name,
        "model_name": model_name,
        "provider": provider,
        "tool_names": list(tool_map.keys()),
        "max_tool_calls": max_tool_calls,
        "prompt": prompt_metadata or {},
    }
    context_tags = ["open-web-catcher", run_name, "agent-loop", "langgraph"]

    with using_observability_context(
        session_id=observer.run_id if observer is not None else "",
        metadata=context_metadata,
        tags=context_tags,
    ):
        with observability_span(
            run_name,
            kind="agent",
            input_value={"initial_message": initial_message},
            attributes={
                "owc.run_name": run_name,
                "owc.model_name": model_name,
                "owc.provider": provider,
                "owc.max_tool_calls": max_tool_calls,
                "owc.runtime": "langgraph",
            },
        ) as loop_span:
            final_state = await compiled.ainvoke(initial_state)
            messages = list(final_state["messages"])
            final_ai = _last_ai_message(messages)
            final_text = (
                final_ai.content
                if final_ai is not None and isinstance(final_ai.content, str)
                else str(final_ai.content) if final_ai is not None
                else ""
            )
            budget_was_exhausted = any(
                isinstance(message, HumanMessage) and message.content == budget_exhausted_message
                for message in messages[1:]
            )

            if observer is not None:
                observer.emit(
                    "agent_loop_finished",
                    f"{run_name} finished",
                    details={
                        "tool_calls_made": final_state["tool_calls_made"],
                        "message_count": len(messages),
                    },
                    status="warning" if budget_was_exhausted else "success",
                )

            set_span_output(
                loop_span,
                {
                    "tool_calls_made": final_state["tool_calls_made"],
                    "message_count": len(messages),
                    "final_text_preview": (final_text or "")[:2000],
                    "runtime": "langgraph",
                },
            )

    return AgentLoopResult(
        final_text=final_text or "",
        tool_calls_made=final_state["tool_calls_made"],
        messages=messages,
    )
