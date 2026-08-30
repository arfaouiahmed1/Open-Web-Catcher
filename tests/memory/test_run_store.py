"""ShortTermMemory signal-bucket eviction tests (plan task 17, SCH-H3/H4).

Characterization-first: buckets must behave as newest-wins ring buffers.
Once a bucket reaches its cap, appending a new distinct item must evict the
oldest item instead of silently dropping the new one.
"""

from __future__ import annotations

from src.memory.short_term import ShortTermMemory


class TestSignalBucketRingBuffer:
    """[SCH-H3] Signal buckets keep the newest items once full."""

    def test_remember_signal_evicts_oldest_when_bucket_at_cap(self) -> None:
        # Given: a stream_urls bucket already filled to its cap of 3
        memory = ShortTermMemory(k=4)
        for index in range(3):
            memory._remember_signal("stream_urls", f"s{index}", max_items=3)

        # When: one more distinct signal arrives past the cap
        memory._remember_signal("stream_urls", "s3", max_items=3)

        # Then: the oldest entry is evicted and every newer entry survives
        assert memory._signals["stream_urls"] == ["s1", "s2", "s3"]

    def test_ingest_tool_result_keeps_newest_selector_at_cap(self) -> None:
        # Given: 40 distinct selectors recorded through the public ingest path,
        # saturating the selectors bucket cap (max_items=40)
        memory = ShortTermMemory(k=8)
        for index in range(40):
            memory.ingest_tool_result("inspect", {"selector": f"#old-{index}"}, None)

        # When: a fresh selector arrives after saturation
        memory.ingest_tool_result("inspect", {"selector": "#new-value"}, None)

        # Then: the new selector is remembered, the oldest is gone, len == cap
        selectors = memory.export_run_memory()["common"]["selectors"]
        assert "selector=#new-value" in selectors
        assert "selector=#old-0" not in selectors
        assert len(selectors) == 40

    def test_duplicate_signal_does_not_grow_bucket_past_cap(self) -> None:
        # Given: a bucket at cap
        memory = ShortTermMemory(k=4)
        for index in range(3):
            memory._remember_signal("stream_hosts", f"h{index}", max_items=3)

        # When: an already-known signal is re-observed
        memory._remember_signal("stream_hosts", "h1", max_items=3)

        # Then: dedupe holds and the bucket stays at cap without data loss
        assert memory._signals["stream_hosts"] == ["h0", "h1", "h2"]

import pytest

from src.memory.run_store import RUN_STATE_TTL_SECONDS, RunStore


def _fake_redis():
    fakeredis = pytest.importorskip("fakeredis")
    return fakeredis.aioredis.FakeRedis(decode_responses=True)


class TestRunStoreWrapper:
    @pytest.mark.asyncio
    async def test_two_clients_share_bucket_state(self) -> None:
        first = RunStore(_fake_redis(), "run-a")
        second = RunStore(first._client, "run-a")

        await first.remember_signal("stream_urls", "u1", max_items=5)
        loaded = await second.load_signals("stream_urls")

        assert loaded == ["u1"]

    @pytest.mark.asyncio
    async def test_remember_signal_evicts_oldest_past_cap(self) -> None:
        store = RunStore(_fake_redis(), "run-b")

        for index in range(4):
            await store.remember_signal("stream_urls", f"s{index}", max_items=3)

        kept = await store.load_signals("stream_urls")
        assert kept == ["s1", "s2", "s3"]

    @pytest.mark.asyncio
    async def test_writes_refresh_ttl(self) -> None:
        client = _fake_redis()
        store = RunStore(client, "run-c")

        await store.set_state("stage", "hosting")

        ttl = await client.ttl("owc:run:run-c:state")
        assert 0 < ttl <= RUN_STATE_TTL_SECONDS

    @pytest.mark.asyncio
    async def test_unavailable_store_degrades_to_noops(self) -> None:
        store = RunStore(None, "run-d")

        assert store.available is False
        assert await store.remember_signal("x", "y", max_items=3) == []
        assert await store.get_state("k") is None
        await store.set_state("k", "v")
        await store.drop_run()
