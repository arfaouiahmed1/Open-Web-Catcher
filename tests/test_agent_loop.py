"""Direct LangGraph tool-dispatch tests."""

from __future__ import annotations

from langchain_core.messages import AIMessage, HumanMessage

from src.agents.base import run_agent_loop


class DummyTool:
    def __init__(self, name: str, result):
        self.name = name
        self.result = result
        self.calls: list[dict] = []

    async def ainvoke(self, args):
        self.calls.append(args)
        return self.result

    def invoke(self, args):
        self.calls.append(args)
        return self.result


class BoundLLMStub:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    async def ainvoke(self, messages, config=None):
        self.calls.append(list(messages))
        return self.responses.pop(0)


class LLMStub:
    model = "gemini-test"

    def __init__(self, bound_responses, final_responses=None):
        self.bound_responses = list(bound_responses)
        self.final_responses = list(final_responses or [])
        self.bound_llm = BoundLLMStub(self.bound_responses)
        self.final_calls = []

    def bind_tools(self, tools):
        self.bound_tools = tools
        return self.bound_llm

    async def ainvoke(self, messages, config=None):
        self.final_calls.append(messages)
        return self.final_responses.pop(0)


async def test_run_agent_loop_invokes_requested_tool_with_args(settings):
    query_tool = DummyTool("query_elements", {"ok": True, "matches": []})
    llm = LLMStub(
        bound_responses=[
            AIMessage(
                content="",
                tool_calls=[{"id": "call-1", "name": "query_elements", "args": {"kind": "link", "limit": 5}}],
            ),
            AIMessage(content='{"status":"done"}'),
        ],
    )

    result = await run_agent_loop(
        settings=settings,
        llm=llm,
        tools=[query_tool],
        system_prompt="Use tools carefully.",
        initial_message="Inspect the page.",
        max_tool_calls=2,
        run_name="test_agent_loop",
    )

    assert query_tool.calls == [{"kind": "link", "limit": 5}]
    assert result.tool_calls_made == 1
    assert result.parse_json() == {"status": "done"}


async def test_run_agent_loop_stops_at_budget_and_requests_final_answer(settings):
    first_tool = DummyTool("query_elements", {"ok": True})
    second_tool = DummyTool("open_url", {"ok": True})
    llm = LLMStub(
        bound_responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {"id": "call-1", "name": "query_elements", "args": {"kind": "link"}},
                    {"id": "call-2", "name": "open_url", "args": {"url": "https://example.com/watch"}},
                ],
            ),
        ],
        final_responses=[AIMessage(content='{"status":"budget_exhausted"}')],
    )

    result = await run_agent_loop(
        settings=settings,
        llm=llm,
        tools=[first_tool, second_tool],
        system_prompt="Use tools carefully.",
        initial_message="Inspect the page.",
        max_tool_calls=1,
        budget_exhausted_message="Stop and summarize now.",
        run_name="test_agent_loop_budget",
    )

    assert first_tool.calls == [{"kind": "link"}]
    assert second_tool.calls == []
    assert result.tool_calls_made == 1
    assert any(
        isinstance(message, HumanMessage) and message.content == "Stop and summarize now."
        for message in llm.final_calls[0]
    )
    assert result.parse_json() == {"status": "budget_exhausted"}


async def test_run_agent_loop_appends_turn_context_without_persisting_it(settings):
    query_tool = DummyTool("query_elements", {"ok": True})
    llm = LLMStub(
        bound_responses=[
            AIMessage(
                content="",
                tool_calls=[{"id": "call-1", "name": "query_elements", "args": {"kind": "button"}}],
            ),
            AIMessage(content='{"status":"done"}'),
        ],
    )

    def turn_context_provider(_state):
        return "WORKING STATE\n- next best move: inspect the primary controls"

    result = await run_agent_loop(
        settings=settings,
        llm=llm,
        tools=[query_tool],
        system_prompt="Use tools carefully.",
        initial_message="Inspect the page.",
        max_tool_calls=2,
        run_name="test_agent_loop_turn_context",
        turn_context_provider=turn_context_provider,
    )

    assert query_tool.calls == [{"kind": "button"}]
    assert result.parse_json() == {"status": "done"}
    assert any(
        "WORKING STATE" in getattr(message, "content", "")
        for message in llm.bound_llm.calls[0]
        if hasattr(message, "content")
    )
    assert all(
        "WORKING STATE" not in getattr(message, "content", "")
        for message in result.messages
        if hasattr(message, "content")
    )
