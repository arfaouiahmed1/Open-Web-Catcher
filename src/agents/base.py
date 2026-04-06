"""Shared agent infrastructure.

run_agent_loop() - async Gemini function-calling loop.

Why async?
    The MCP client (langchain-mcp-adapters) is async-native. Making the loop
    async lets us keep one MCP connection open for the entire agent session
    instead of reconnecting on every tool call.

Why not LangChain create_react_agent / AgentExecutor?
    Those force the ReAct text format (Thought/Action/Observation).
    Gemini natively supports structured tool calls via bind_tools().
    A direct loop is simpler, gives full budget control, and works
    cleanly with MCP-sourced tools.
"""

from __future__ import annotations

import json
import time
from typing import Any

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import BaseTool
from langchain_google_genai import ChatGoogleGenerativeAI

from src.utils.config import Settings
from src.utils.logging import get_logger
from src.utils.observability import RunObserver
from src.utils.phoenix import (
    phoenix_span,
    resolve_model_pricing,
    set_span_attributes,
    set_span_output,
    using_phoenix_attributes,
)

logger = get_logger(__name__)


class RunCancelledError(Exception):
    """Raised when a live run is cancelled from the UI."""

    pass


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


# ── LLM factory ────────────────────────────────────────────────────────────────

def build_llm(
    settings: Settings,
    temperature: float | None = None,
    model_override: str | None = None,
) -> ChatGoogleGenerativeAI:
    """Build a Gemini LLM instance.

    Args:
        settings: Application settings.
        temperature: Override the default temperature.
        model_override: Specific model ID (e.g. settings.orchestrator_model).
                        Defaults to settings.agent_model.
    """
    model_name = model_override or settings.agent_model
    return ChatGoogleGenerativeAI(
        model=model_name,
        google_api_key=settings.google_api_key,
        temperature=temperature if temperature is not None else settings.gemini_temperature,
        convert_system_message_to_human=True,
        metadata={
            "provider": "google_genai",
            "model": model_name,
            "ls_provider": "google_genai",
            "ls_model_name": model_name,
        },
    )


# ── Agent loop result ──────────────────────────────────────────────────────────

class AgentLoopResult:
    def __init__(self, final_text: str, tool_calls_made: int, messages: list) -> None:
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


# ── Generic async agent loop ───────────────────────────────────────────────────

async def run_agent_loop(
    settings: Settings,
    llm: ChatGoogleGenerativeAI,
    tools: list[BaseTool],
    system_prompt: str,
    initial_message: str,
    max_tool_calls: int = 20,
    budget_exhausted_message: str = "Budget exhausted. Output your final JSON now.",
    observer: RunObserver | None = None,
    run_name: str = "agent_loop",
) -> AgentLoopResult:
    """Run an async Gemini function-calling loop."""
    tool_map: dict[str, BaseTool] = {t.name: t for t in tools}
    llm_with_tools = llm.bind_tools(tools)
    model_name = getattr(llm, "model", "") or ""
    provider = "google_genai"
    pricing = resolve_model_pricing(settings, model_name=model_name, provider=provider)

    messages: list = [
        SystemMessage(content=system_prompt),
        HumanMessage(content=initial_message),
    ]
    tool_calls_made = 0

    if observer is not None:
        observer.record_message("system")
        observer.record_message("human")
        observer.emit(
            "agent_loop_started",
            f"{run_name} started",
            details={"max_tool_calls": max_tool_calls, "model_name": model_name},
        )

    context_metadata = {
        "actor": observer.actor if observer is not None else run_name,
        "run_name": run_name,
        "model_name": model_name,
        "provider": provider,
        "tool_names": list(tool_map.keys()),
        "max_tool_calls": max_tool_calls,
    }
    context_tags = ["open-web-catcher", run_name, "agent-loop"]

    with using_phoenix_attributes(
        session_id=observer.run_id if observer is not None else "",
        metadata=context_metadata,
        tags=context_tags,
    ):
        with phoenix_span(
            run_name,
            kind="agent",
            input_value={"initial_message": initial_message},
            attributes={
                "owc.run_name": run_name,
                "owc.model_name": model_name,
                "owc.provider": provider,
                "owc.max_tool_calls": max_tool_calls,
            },
        ) as loop_span:
            while tool_calls_made < max_tool_calls:
                _assert_not_cancelled(observer, "agent loop")
                message_count = len(messages)
                with phoenix_span(
                    f"{run_name}.llm_turn",
                    kind="chain",
                    input_value={
                        "message_count": message_count,
                        "tool_calls_made": tool_calls_made,
                    },
                    attributes={
                        "owc.run_name": run_name,
                        "owc.message_count_before_call": message_count,
                        "owc.tool_calls_made_before_call": tool_calls_made,
                    },
                ) as llm_span:
                    response: AIMessage = await llm_with_tools.ainvoke(
                        messages,
                        config={"run_name": run_name},
                    )
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

                messages.append(response)

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
                            "message_count": len(messages),
                            "input_tokens": input_tokens,
                            "output_tokens": output_tokens,
                            "usage_metadata": _json_ready(getattr(response, "usage_metadata", None)),
                            "response_metadata": _json_ready(getattr(response, "response_metadata", None)),
                            "additional_kwargs": _json_ready(getattr(response, "additional_kwargs", None)),
                            "response_class": type(response).__name__,
                            "content_preview": (response.content or "")[:1200],
                        },
                    )

                if not response.tool_calls:
                    logger.debug("Agent finished after %d tool calls", tool_calls_made)
                    if observer is not None:
                        observer.emit(
                            "agent_loop_finished",
                            f"{run_name} finished",
                            details={
                                "tool_calls_made": tool_calls_made,
                                "message_count": len(messages),
                            },
                            status="success",
                        )
                    set_span_output(
                        loop_span,
                        {
                            "tool_calls_made": tool_calls_made,
                            "message_count": len(messages),
                            "final_text_preview": (response.content or "")[:2000],
                        },
                    )
                    return AgentLoopResult(
                        final_text=response.content or "",
                        tool_calls_made=tool_calls_made,
                        messages=messages,
                    )

                for tc in response.tool_calls:
                    _assert_not_cancelled(observer, "tool dispatch")
                    tool_name: str = tc["name"]
                    tool_args: dict = tc["args"]
                    tool_id: str = tc["id"]
                    tool_calls_made += 1

                    logger.debug(
                        "Tool call [%d/%d]: %s(%s)",
                        tool_calls_made,
                        max_tool_calls,
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
                                "tool_call_budget": max_tool_calls,
                            },
                        )

                    with phoenix_span(
                        tool_name,
                        kind="tool",
                        input_value=tool_args,
                        attributes={
                            "tool.name": tool_name,
                            "owc.tool_call_number": tool_calls_made,
                            "owc.tool_call_budget": max_tool_calls,
                        },
                    ) as tool_span:
                        tool = tool_map.get(tool_name)
                        if tool is None:
                            result_content = json.dumps({"error": f"Unknown tool: {tool_name}"})
                            tool_status = "error"
                        else:
                            try:
                                raw = await tool.arun(tool_args)
                                result_content = raw if isinstance(raw, str) else json.dumps(raw)
                                tool_status = "success"
                            except Exception as e:
                                logger.warning("Tool %s raised: %s", tool_name, e)
                                result_content = json.dumps({"error": str(e)})
                                tool_status = "error"
                                set_span_attributes(
                                    tool_span,
                                    {
                                        "error.type": type(e).__name__,
                                        "error.message": str(e),
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

                    messages.append(ToolMessage(content=result_content, tool_call_id=tool_id))
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
                                "message_count": len(messages),
                            },
                        )

                    if tool_calls_made >= max_tool_calls:
                        break

            logger.info("Budget exhausted (%d calls). Forcing final answer.", tool_calls_made)
            if observer is not None:
                observer.emit(
                    "budget_exhausted",
                    "Tool-call budget exhausted; requesting final answer",
                    status="warning",
                    details={"tool_calls_made": tool_calls_made, "max_tool_calls": max_tool_calls},
                )
                observer.record_message("human")
            messages.append(HumanMessage(content=budget_exhausted_message))
            _assert_not_cancelled(observer, "final answer preparation")
            with phoenix_span(
                f"{run_name}.final_answer",
                kind="chain",
                input_value={"message_count": len(messages), "tool_calls_made": tool_calls_made},
                attributes={
                    "owc.run_name": run_name,
                    "owc.tool_calls_made": tool_calls_made,
                    "owc.reason": "budget_exhausted",
                },
            ) as final_span:
                final: AIMessage = await llm.ainvoke(messages, config={"run_name": f"{run_name}_final"})
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
                observer.emit(
                    "agent_loop_finished",
                    f"{run_name} finished after budget exhaustion",
                    details={"tool_calls_made": tool_calls_made, "message_count": len(messages)},
                    status="warning",
                )

            set_span_output(
                loop_span,
                {
                    "tool_calls_made": tool_calls_made,
                    "message_count": len(messages),
                    "final_text_preview": (final.content or "")[:2000],
                    "reason": "budget_exhausted",
                },
            )
            return AgentLoopResult(
                final_text=final.content or "",
                tool_calls_made=tool_calls_made,
                messages=messages,
            )


class BudgetExceededError(Exception):
    pass
