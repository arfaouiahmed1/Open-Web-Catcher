"""Async Redis wrapper for run-scoped short-term state (plan T17, ADR-002).

Key contract
------------
Every key lives under ``owc:run:{run_id}:...`` and carries a 24h TTL that is
refreshed on every write, so abandoned runs age out without a sweeper.

Fallback semantics (explicit, never silent)
-------------------------------------------
``RunStore.connect()`` returns a store whose ``available`` flag reports whether
Redis answered. When it did not, callers keep using in-process structures; the
connection failure is logged exactly once per process via module logger.
"""

from __future__ import annotations

import logging
from types import TracebackType
from typing import Final

logger = logging.getLogger(__name__)

RUN_KEY_PREFIX: Final[str] = "owc:run"
RUN_STATE_TTL_SECONDS: Final[int] = 24 * 60 * 60


class RunStore:
    """Run-scoped Redis access with newest-wins capped buckets."""

    def __init__(self, client, run_id: str) -> None:
        self._client = client
        self._run_id = run_id
        self.available = client is not None

    @classmethod
    async def connect(cls, redis_url: str, run_id: str) -> "RunStore":
        try:
            import redis.asyncio as aioredis

            client = aioredis.from_url(
                redis_url,
                decode_responses=True,
                socket_connect_timeout=2.0,
                socket_timeout=2.0,
            )
            await client.ping()
            return cls(client, run_id)
        except Exception as exc:  # noqa: BLE001 - single explicit degradation point
            logger.warning(
                "Redis run store unavailable (%s); short-term signals stay "
                "in-process for run %s",
                type(exc).__name__,
                run_id,
            )
            await cls._quiet_close(locals().get("client"))
            return cls(None, run_id)

    @staticmethod
    async def _quiet_close(client) -> None:
        if client is None:
            return
        try:
            await client.aclose()
        except Exception:  # noqa: BLE001 - best-effort teardown
            pass

    def _key(self, suffix: str) -> str:
        return f"{RUN_KEY_PREFIX}:{self._run_id}:{suffix}"

    async def aclose(self) -> None:
        if not self.available:
            return
        try:
            await self._client.aclose()
        except Exception:  # noqa: BLE001
            pass

    async def remember_signal(self, bucket: str, value: str, *, max_items: int) -> list[str]:
        """Append to a bucket with dedupe-keep-order and newest-wins cap.

        Returns the resulting bucket contents. Mirrors ShortTermMemory's
        in-process semantics so both backends stay interchangeable.
        """
        if not self.available:
            return []

        key = self._key(f"signals:{bucket}")
        async with self._client.pipeline(transaction=True) as pipe:
            pipe.lrem(key, 0, value)
            pipe.rpush(key, value)
            pipe.ltrim(key, -max_items, -1)
            pipe.lrange(key, 0, -1)
            pipe.expire(key, RUN_STATE_TTL_SECONDS)
            results = await pipe.execute()

        return [str(item) for item in results[-2]]

    async def load_signals(self, bucket: str) -> list[str]:
        if not self.available:
            return []
        return list(await self._client.lrange(self._key(f"signals:{bucket}"), 0, -1))

    async def set_state(self, field: str, value: str) -> None:
        if not self.available:
            return
        key = self._key("state")
        await self._client.hset(key, field, value)
        await self._client.expire(key, RUN_STATE_TTL_SECONDS)

    async def get_state(self, field: str) -> str | None:
        if not self.available:
            return None
        value = await self._client.hget(self._key("state"), field)
        return str(value) if value is not None else None

    async def drop_run(self) -> None:
        if not self.available:
            return
        cursor = 0
        pattern = f"{RUN_KEY_PREFIX}:{self._run_id}:*"
        while True:
            cursor, keys = await self._client.scan(cursor=cursor, match=pattern, count=100)
            if keys:
                await self._client.delete(*keys)
            if cursor == 0:
                break


__all__ = [
    "RUN_KEY_PREFIX",
    "RUN_STATE_TTL_SECONDS",
    "RunStore",
]
