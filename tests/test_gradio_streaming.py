"""Regression tests for Gradio live trace formatting."""

from __future__ import annotations

from src.api import gradio_app
from src.utils.observability import RuntimeEvent


def test_tool_target_summary_surfaces_primary_target_fields():
    summary = gradio_app._tool_target_summary(
        "navigate",
        {
            "url": "https://example.com/watch/123",
            "selector": "#player iframe",
            "action": "click",
        },
    )

    assert "url=https://example.com/watch/123" in summary
    assert "selector=#player iframe" in summary
    assert "action=click" in summary


def test_event_to_chat_message_highlights_tool_target_and_output():
    event = RuntimeEvent(
        seq=2,
        actor="hosting",
        kind="tool_call_started",
        message="Calling inspect",
        details={
            "tool_name": "inspect",
            "tool_args": {"url": "https://example.com/embed", "selector": "video"},
        },
    )

    message = gradio_app._event_to_chat_message(event)

    assert "tool `inspect`" in message["content"]
    assert "target `url=https://example.com/embed; selector=video`" in message["content"]
    assert '"selector": "video"' in message["content"]


def test_event_to_chat_message_shows_visible_model_output_and_tool_plan():
    event = RuntimeEvent(
        seq=3,
        actor="landing",
        kind="llm_response",
        message="Model responded",
        details={
            "provider": "google_genai",
            "model_name": "gemini-test",
            "input_tokens": 10,
            "output_tokens": 14,
            "content_preview": "I found a likely match page and I am checking the hosting links now.",
            "tool_call_names": ["query_elements"],
            "tool_calls_payload": [
                {
                    "id": "call-1",
                    "name": "query_elements",
                    "args": {"kind": "link", "selector": "a[href*='watch']"},
                }
            ],
        },
    )

    message = gradio_app._event_to_chat_message(event)

    assert "Visible model output" in message["content"]
    assert "I found a likely match page" in message["content"]
    assert "Planned tool use" in message["content"]
    assert "`query_elements` on `selector=a[href*='watch']; kind=link`" in message["content"] or "`query_elements` on `kind=link; selector=a[href*='watch']`" in message["content"]


def test_provider_markdown_lists_requested_tool_targets():
    event = RuntimeEvent(
        seq=5,
        actor="embedded",
        kind="llm_response",
        message="Model responded",
        details={
            "provider": "google_genai",
            "model_name": "gemini-test",
            "input_tokens": 20,
            "output_tokens": 30,
            "content_preview": "Trying the embedded player and then capturing network streams.",
            "tool_call_names": ["interact", "capture_streams"],
            "tool_calls_payload": [
                {"id": "1", "name": "interact", "args": {"action": "click", "selector": "button.play"}},
                {"id": "2", "name": "capture_streams", "args": {"player_iframe_hint": "player"}},
            ],
            "response_metadata": {"finish_reason": "stop"},
            "usage_metadata": {"input_tokens": 20, "output_tokens": 30},
        },
    )

    markdown = gradio_app._provider_markdown([event])

    assert "Requested tool targets" in markdown
    assert "`interact` on `selector=button.play; action=click`" in markdown or "`interact` on `action=click; selector=button.play`" in markdown
    assert "`capture_streams` on `player_iframe_hint=player`" in markdown
    assert "Visible model output" in markdown
