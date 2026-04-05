"""Shared agent infrastructure.

run_agent_loop() — async Gemini function-calling loop.

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
from typing import Any

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import BaseTool
from langchain_google_genai import ChatGoogleGenerativeAI

from src.utils.config import Settings
from src.utils.logging import get_logger

logger = get_logger(__name__)


# ── LLM factory ──────────────────────────────────────────────────────────────

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
    return ChatGoogleGenerativeAI(
        model=model_override or settings.agent_model,
        google_api_key=settings.google_api_key,
        temperature=temperature if temperature is not None else settings.gemini_temperature,
        convert_system_message_to_human=True,
    )


# ── Agent loop result ─────────────────────────────────────────────────────────

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


# ── Generic async agent loop ──────────────────────────────────────────────────

async def run_agent_loop(
    llm: ChatGoogleGenerativeAI,
    tools: list[BaseTool],
    system_prompt: str,
    initial_message: str,
    max_tool_calls: int = 20,
    budget_exhausted_message: str = "Budget exhausted. Output your final JSON now.",
) -> AgentLoopResult:
    """Run an async Gemini function-calling loop.

    Flow:
        1. Build messages: [SystemMessage, HumanMessage(initial)]
        2. Call LLM via ainvoke (async) with tools bound
        3. If response has tool_calls → execute each → append ToolMessages → goto 2
        4. If no tool_calls → model is done → return
        5. If budget exhausted → force a final answer call without tools

    Args:
        llm: ChatGoogleGenerativeAI instance.
        tools: LangChain BaseTool instances (sourced from MCP or direct wrappers).
        system_prompt: Agent system prompt.
        initial_message: First human message (usually just the URL + task).
        max_tool_calls: Hard budget.
        budget_exhausted_message: Injected when budget runs out.

    Returns:
        AgentLoopResult with final_text, tool_calls_made, full message history.
    """
    tool_map: dict[str, BaseTool] = {t.name: t for t in tools}
    llm_with_tools = llm.bind_tools(tools)

    messages: list = [
        SystemMessage(content=system_prompt),
        HumanMessage(content=initial_message),
    ]
    tool_calls_made = 0

    while tool_calls_made < max_tool_calls:
        response: AIMessage = await llm_with_tools.ainvoke(messages)
        messages.append(response)

        if not response.tool_calls:
            logger.debug("Agent finished after %d tool calls", tool_calls_made)
            return AgentLoopResult(
                final_text=response.content or "",
                tool_calls_made=tool_calls_made,
                messages=messages,
            )

        for tc in response.tool_calls:
            tool_name: str = tc["name"]
            tool_args: dict = tc["args"]
            tool_id: str   = tc["id"]
            tool_calls_made += 1

            logger.debug(
                "Tool call [%d/%d]: %s(%s)",
                tool_calls_made, max_tool_calls, tool_name, list(tool_args.keys()),
            )

            tool = tool_map.get(tool_name)
            if tool is None:
                result_content = json.dumps({"error": f"Unknown tool: {tool_name}"})
            else:
                try:
                    # Use arun if available, otherwise fall back to sync _run
                    raw = await tool.arun(tool_args)
                    result_content = raw if isinstance(raw, str) else json.dumps(raw)
                except Exception as e:
                    logger.warning("Tool %s raised: %s", tool_name, e)
                    result_content = json.dumps({"error": str(e)})

            messages.append(ToolMessage(content=result_content, tool_call_id=tool_id))

            if tool_calls_made >= max_tool_calls:
                break

    # Budget exhausted — force final answer without tools
    logger.info("Budget exhausted (%d calls). Forcing final answer.", tool_calls_made)
    messages.append(HumanMessage(content=budget_exhausted_message))
    final: AIMessage = await llm.ainvoke(messages)

    return AgentLoopResult(
        final_text=final.content or "",
        tool_calls_made=tool_calls_made,
        messages=messages,
    )


class BudgetExceededError(Exception):
    pass
