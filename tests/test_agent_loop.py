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

    async def ainvoke(self, messages, config=None, **kwargs):
        self.calls.append({"messages": list(messages), "config": config, "kwargs": kwargs})
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

    async def ainvoke(self, messages, config=None, **kwargs):
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
        for message in llm.bound_llm.calls[0]["messages"]
        if hasattr(message, "content")
    )
    assert all(
        "WORKING STATE" not in getattr(message, "content", "")
        for message in result.messages
        if hasattr(message, "content")
    )


async def test_run_agent_loop_provider_cache_passes_openrouter_header(settings):
    settings.llm_provider = "openrouter"
    settings.provider_cache_enabled = True
    settings.prompt_cache_enabled = True

    llm = LLMStub(
        bound_responses=[AIMessage(content='{"status":"done"}')],
    )

    result = await run_agent_loop(
        settings=settings,
        llm=llm,
        tools=[],
        system_prompt="Use tools carefully.",
        initial_message="Inspect the page.",
        max_tool_calls=1,
        run_name="test_provider_cache_header",
        prompt_metadata={
            "cache_mode": "provider_hook",
            "provider_cache_eligible": True,
            "provider_cache_key": "classification:abc123",
        },
    )

    assert result.parse_json() == {"status": "done"}
    headers = llm.bound_llm.calls[0]["kwargs"].get("extra_headers", {})
    assert headers.get("x-openrouter-prompt-cache-key") == "classification:abc123"


async def test_run_agent_loop_tool_cache_requires_identical_outputs(settings):
    settings.tool_result_cache_enabled = True
    settings.tool_result_cache_min_identical_observations = 2

    query_tool = DummyTool("query_elements", {"ok": True, "matches": [{"id": 1}]})
    llm = LLMStub(
        bound_responses=[
            AIMessage(content="", tool_calls=[{"id": "call-1", "name": "query_elements", "args": {"kind": "link", "limit": 5}}]),
            AIMessage(content="", tool_calls=[{"id": "call-2", "name": "query_elements", "args": {"kind": "link", "limit": 5}}]),
            AIMessage(content="", tool_calls=[{"id": "call-3", "name": "query_elements", "args": {"kind": "link", "limit": 5}}]),
            AIMessage(content='{"status":"done"}'),
        ],
    )

    result = await run_agent_loop(
        settings=settings,
        llm=llm,
        tools=[query_tool],
        system_prompt="Use tools carefully.",
        initial_message="Inspect the page.",
        max_tool_calls=4,
        run_name="test_tool_cache_identical",
    )

    # Third identical call should be served from cache after two observed identical outputs.
    assert len(query_tool.calls) == 2
    assert result.parse_json() == {"status": "done"}


async def test_run_agent_loop_bootstrap_navigates_and_collects_context_first(settings):
    open_url_tool = DummyTool("open_url", {"ok": True, "final_url": "https://example.com", "screenshot_url": "https://res.cloudinary.com/demo/image/upload/v1/nav.png"})
    context_tool = DummyTool("get_page_context", {"ok": True, "page_summary": {"links": 10}, "screenshot_url": "https://res.cloudinary.com/demo/image/upload/v1/context.png"})
    llm = LLMStub(bound_responses=[AIMessage(content='{"status":"done"}')])

    result = await run_agent_loop(
        settings=settings,
        llm=llm,
        tools=[open_url_tool, context_tool],
        system_prompt="Use tools carefully.",
        initial_message="Inspect the page.",
        max_tool_calls=5,
        run_name="test_bootstrap_sequence",
        bootstrap_url="https://example.com",
        bootstrap_context_first=True,
    )

    assert open_url_tool.calls == [{"url": "https://example.com"}]
    assert context_tool.calls == [{"frame_path": "root"}]
    first_call_messages = llm.bound_llm.calls[0]["messages"]
    assert any("BOOTSTRAP RESULT (open_url)" in getattr(message, "content", "") for message in first_call_messages)
    assert any("BOOTSTRAP RESULT (get_page_context)" in getattr(message, "content", "") for message in first_call_messages)
    assert result.parse_json() == {"status": "done"}
