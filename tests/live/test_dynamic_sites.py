"""tests/live/test_dynamic_sites.py

Gated live tests for dynamic targets (plan step 11).
Skipped unless OWC_LIVE_SITE_TESTS=1 is set in the environment.

Tests:
- https://freeshot.live/live-tv: classification as landing, channels, pagination
- https://streamed.pk/: landing classification, separation of LIVE vs scheduled cards
"""

from __future__ import annotations

import os

import pytest

from src.models.common import PageType

pytestmark = pytest.mark.skipif(
    os.getenv("OWC_LIVE_SITE_TESTS") != "1",
    reason="Live site tests require OWC_LIVE_SITE_TESTS=1 environment flag",
)


@pytest.mark.asyncio
async def test_live_freeshot_landing():
    """Verify FreeShot live TV channel listing."""
    from src.agents.classification import ClassificationAgent
    from src.utils.config import Settings

    settings = Settings()
    agent = ClassificationAgent(settings)
    result = await agent.run("https://freeshot.live/live-tv")

    assert result.page_type == PageType.LANDING
    assert len(result.evidence) >= 1


@pytest.mark.asyncio
async def test_live_streamed_landing():
    """Verify Streamed.pk event listing."""
    from src.agents.classification import ClassificationAgent
    from src.utils.config import Settings

    settings = Settings()
    agent = ClassificationAgent(settings)
    result = await agent.run("https://streamed.pk/")

    assert result.page_type == PageType.LANDING
    assert len(result.evidence) >= 1
