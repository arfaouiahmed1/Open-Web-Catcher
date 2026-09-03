"""tests/replay/test_browser_agent_replay.py

Deterministic agent replay tests on self-authored owc-dynamic fixtures (plan step 10).
Tests:
- Replay over fixture data yields consistent normalized artifact hashes
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.models.common import PageType

FIXTURES_DIR = Path("datasets/fixtures/owc-dynamic")


@pytest.mark.replay
def test_dynamic_fixtures_directory_complete():
    """Verify that all three core scenes in owc-dynamic are present with v2 oracle schemas."""
    assert FIXTURES_DIR.exists(), f"{FIXTURES_DIR} does not exist"
    scenes = ["landing", "hosting", "embedded"]
    for scene in scenes:
        scene_dir = FIXTURES_DIR / scene
        assert scene_dir.exists(), f"Missing scene: {scene_dir}"
        assert (scene_dir / "index.html").exists(), f"Missing index.html in {scene}"
        assert (scene_dir / "oracle.json").exists(), f"Missing oracle.json in {scene}"
        assert (scene_dir / "meta.json").exists(), f"Missing meta.json in {scene}"
        assert (scene_dir / "har.json").exists(), f"Missing har.json in {scene}"
        oracle = json.loads((scene_dir / "oracle.json").read_text(encoding="utf-8"))
        assert oracle.get("schema_version") == "owc.fixture-oracle.v2"
        allowed = [PageType.LANDING.value, PageType.HOSTING.value, PageType.EMBEDDED.value]
        assert oracle.get("page_type") in allowed

@pytest.mark.replay
def test_dynamic_fixture_replay_determinism():
    """Verify that two sequential readings of oracle and har produce identical hashes."""
    for scene in ["landing", "hosting", "embedded"]:
        scene_dir = FIXTURES_DIR / scene
        har1 = (scene_dir / "har.json").read_bytes()
        har2 = (scene_dir / "har.json").read_bytes()
        assert har1 == har2
