"""tests/agents/test_plan_tool.py

Contract tests for the backend LangChain plan tool (plan step 5).
Verifies:
- write operation replaces full list, enforces 12-item and 200-char caps
- append operation adds up to 12 items
- complete operation marks item done by 0-indexed ID
- clear operation empties the list
"""

import json

import pytest

from src.agents.runtime.tools_plan import MAX_ITEM_CHARS, MAX_PLAN_ITEMS, build_plan_tool


class DummyWorkingMemory:
    def __init__(self):
        self.working_state_data = {}


@pytest.fixture
def plan_tool():
    mem = DummyWorkingMemory()
    return build_plan_tool(mem)


def test_write_and_read(plan_tool):
    raw = plan_tool.invoke({"op": "write", "items": ["Task 1", "Task 2"]})
    res = json.loads(raw)
    assert res["ok"] is True
    assert res["op"] == "write"
    assert len(res["plan_items"]) == 2
    assert res["plan_items"][0] == {"id": 0, "text": "Task 1", "status": "pending"}
    assert res["plan_items"][1] == {"id": 1, "text": "Task 2", "status": "pending"}


def test_write_caps_at_12_items(plan_tool):
    items = [f"Item {i}" for i in range(20)]
    raw = plan_tool.invoke({"op": "write", "items": items})
    res = json.loads(raw)
    assert len(res["plan_items"]) == MAX_PLAN_ITEMS


def test_write_truncates_item_chars(plan_tool):
    long_text = "a" * 300
    raw = plan_tool.invoke({"op": "write", "items": [long_text]})
    res = json.loads(raw)
    assert len(res["plan_items"][0]["text"]) == MAX_ITEM_CHARS


def test_append_operation(plan_tool):
    plan_tool.invoke({"op": "write", "items": ["Initial 1"]})
    raw = plan_tool.invoke({"op": "append", "items": ["Appended 2", "Appended 3"]})
    res = json.loads(raw)
    assert len(res["plan_items"]) == 3
    assert res["plan_items"][1]["id"] == 1
    assert res["plan_items"][1]["text"] == "Appended 2"
    assert res["plan_items"][2]["id"] == 2
    assert res["plan_items"][2]["text"] == "Appended 3"


def test_append_respects_max_cap(plan_tool):
    plan_tool.invoke({"op": "write", "items": [f"I{i}" for i in range(10)]})
    raw = plan_tool.invoke({"op": "append", "items": ["Extra 1", "Extra 2", "Extra 3", "Extra 4"]})
    res = json.loads(raw)
    assert len(res["plan_items"]) == MAX_PLAN_ITEMS


def test_complete_operation(plan_tool):
    plan_tool.invoke({"op": "write", "items": ["Task 0", "Task 1"]})
    raw = plan_tool.invoke({"op": "complete", "item_id": 1})
    res = json.loads(raw)
    assert res["ok"] is True
    assert res["plan_items"][1]["status"] == "done"
    assert res["plan_items"][0]["status"] == "pending"


def test_complete_invalid_id(plan_tool):
    plan_tool.invoke({"op": "write", "items": ["Task 0"]})
    raw = plan_tool.invoke({"op": "complete", "item_id": 99})
    res = json.loads(raw)
    assert res["ok"] is False


def test_clear_operation(plan_tool):
    plan_tool.invoke({"op": "write", "items": ["T1", "T2"]})
    raw = plan_tool.invoke({"op": "clear"})
    res = json.loads(raw)
    assert res["ok"] is True
    assert res["plan_items"] == []
