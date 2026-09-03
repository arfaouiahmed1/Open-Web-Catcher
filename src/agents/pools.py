"""Per-run streaming worker pools (plan T28 / streaming role contracts spike).

Replaces the two ``asyncio.gather(..., return_exceptions=True)`` barriers in
the orchestrator with bounded worker pools fed by unbounded queues:

- producers (landing match normalization, hosting frontier discovery,
  embedded triggers) enqueue :class:`WorkItem`s immediately;
- workers dequeue, run the page agent with the shared per-agent timeout, and
  append their ``ExtractionResult`` themselves;
- drainer nodes (:func:`wait_until_drained`) keep LangGraph sequencing by
  blocking until * queues empty ∧ inflight == 0 ∧ producers finished *.

Cancellation follows spike §D4 layers 1–4:
1. flag check between items via ``_assert_not_cancelled``;
2. sentinel shutdown via :meth:`RunPools.cancel` (O(workers), not O(queue));
3. no laundering — ``except RunCancelledError: raise`` precedes any
   ``except Exception`` and there is no ``return_exceptions=True`` anywhere;
4. module-level ``run_id -> RunPools`` map lets ``_cancel_active_run_task``
   tear down workers outside the awaited task subtree.

Observability follows §D6: workers emit through the same in-process
``RunObserver`` so the SSE poll loop picks events up unchanged.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from src.agents.runtime import _assert_not_cancelled
from src.agents.errors import RunCancelledError
from src.models.common import EventKind
from src.utils.logging import get_logger

if TYPE_CHECKING:  # pragma: no cover - typing only
    from src.models.schemas import ExtractionResult, MatchInfo
    from src.utils.config import Settings
    from src.utils.observability import RunObserver

logger = get_logger(__name__)

HOSTING_ROLE = "hosting"
EMBEDDED_ROLE = "embedded"


@dataclass
class WorkItem:
    """One unit of pool work: a target URL plus its handoff payload."""

    role: str
    url: str
    handoff: str = ""
    source: str = ""
    attempt: int = 0


@dataclass
class _PoolRoleState:
    queue: asyncio.Queue = field(default_factory=asyncio.Queue)
    inflight: int = 0
    live_workers: int = 0
    producers_done: bool = False
    drained: asyncio.Event = field(default_factory=asyncio.Event)
    processed: int = 0
    duplicates_suppressed: int = 0
    # Own bookkeeping of queued-but-unfinished work items (sentinels excluded):
    # ``asyncio.Queue`` does not expose a portable unfinished-task count.
    pending_items: int = 0


class RunPools:
    """Hosting/embedded worker pools for a single pipeline run (spike §D1)."""

    def __init__(
        self,
        *,
        run_id: str,
        settings: Settings,
        observer: RunObserver | None = None,
        memory: Any | None = None,
    ) -> None:
        self.run_id = str(run_id or "")
        self.settings = settings
        self.observer = observer
        self.memory = memory
        self.seen_urls: set[str] = set()
        self.results: list[ExtractionResult] = []
        self._role_results: dict[str, list[ExtractionResult]] = {
            HOSTING_ROLE: [],
            EMBEDDED_ROLE: [],
        }
        self.embedded_enqueued_urls: list[str] = []
        self.workers: list[asyncio.Task] = []
        self.cancelled_reason: str | None = None
        self.worker_errors: list[BaseException] = []
        # Snapshot of pipeline context used to build handoffs for dynamically
        # discovered targets (matches/classification land here as producers run).
        self.handoff_state: dict[str, Any] = {}
        self._roles: dict[str, _PoolRoleState] = {
            HOSTING_ROLE: _PoolRoleState(),
            EMBEDDED_ROLE: _PoolRoleState(),
        }

    # ── producer API ─────────────────────────────────────────────────────

    @property
    def hosting_queue(self) -> asyncio.Queue:
        """Spike §D1 surface: the hosting work queue."""
        return self._roles[HOSTING_ROLE].queue

    @property
    def embedded_queue(self) -> asyncio.Queue:
        """Spike §D1 surface: the embedded work queue."""
        return self._roles[EMBEDDED_ROLE].queue

    def register_match(self, match: MatchInfo) -> None:
        """Make a landing-discovered match visible to handoff builders."""
        matches = list(self.handoff_state.get("matches") or [])
        matches.append(match)
        self.handoff_state["matches"] = matches

    def set_handoff_context(self, **context: Any) -> None:
        """Merge orchestration context (classification, url, ...) for handoffs."""
        self.handoff_state.update(context)

    def enqueue(
        self,
        role: str,
        url: str,
        *,
        source: str = "",
        handoff: str = "",
    ) -> bool:
        """Deduplicate against ``seen_urls`` then queue the item (spike §D2/§D3).

        Returns True when the URL was newly enqueued; duplicates are counted
        and silently suppressed.
        """
        role_state = self._role(role)
        candidate = str(url or "").strip()
        if not candidate:
            return False
        if candidate in self.seen_urls:
            role_state.duplicates_suppressed += 1
            self._emit(
                "orchestrator_decision",
                f"Duplicate {role} target suppressed",
                status="info",
                details={
                    "reason": "duplicate_suppressed",
                    "role": role,
                    "url": candidate,
                    "source": source,
                },
            )
            return False
        if self.cancelled_reason is not None:
            return False
        self.seen_urls.add(candidate)
        role_state.queue.put_nowait(
            WorkItem(role=role, url=candidate, handoff=handoff, source=source)
        )
        role_state.pending_items += 1
        self._emit(
            "queue_enqueued",
            f"{role} work queued: {candidate}",
            details={"role": role, "url": candidate, "source": source},
        )
        if role == HOSTING_ROLE:
            self._emit(
                EventKind.HOSTING_PAGE_DISCOVERED,
                f"Hosting page discovered: {candidate}",
                status="info",
                details={"url": candidate, "source": source},
            )
        self.ensure_workers(role)
        return True

    def open_cycle(self, role: str) -> None:
        """Reopen a drain cycle so late producers (e.g. validator replans) work."""
        role_state = self._role(role)
        role_state.producers_done = False
        role_state.drained.clear()

    def ensure_workers(self, role: str) -> None:
        """Spawn the bounded worker set once, on first use (spike §D1)."""
        role_state = self._role(role)
        if role_state.live_workers > 0 or self.cancelled_reason is not None:
            return
        count = max(1, int(getattr(self.settings, "max_parallel_hosting_pages", 5) or 1))
        # Counted synchronously so a drainer racing ahead of the first worker
        # step still sees live workers.
        role_state.live_workers += count
        for idx in range(count):
            self.workers.append(asyncio.create_task(self._worker_loop(role, idx)))

    # ── drainer API (spike §D1: thin LangGraph node bodies) ──────────────

    async def wait_until_drained(self, role: str) -> None:
        """Close producers for this cycle and wait for full drainage."""
        role_state = self._role(role)
        role_state.producers_done = True
        self._check_drained(role)
        await role_state.drained.wait()
        if self.cancelled_reason is not None:
            raise RunCancelledError(self.cancelled_reason)
        for error in self.worker_errors:
            if isinstance(error, RunCancelledError):
                raise error
        if self.worker_errors:
            raise self.worker_errors[0]
        self._emit(
            "pool_drained",
            f"{role} pool drained",
            status="success",
            details={
                "role": role,
                "processed": role_state.processed,
                "duplicates_suppressed": role_state.duplicates_suppressed,
            },
        )

    def results_since(self, marker: int) -> tuple[list[Any], int]:
        """Return results appended after ``marker`` plus the new marker."""
        new_marker = len(self.results)
        return list(self.results[marker:new_marker]), new_marker

    def consume_results(self, role: str) -> list[Any]:
        """Return every not-yet-consumed result produced by ``role`` workers.

        Consumption is the drainer's job, and the buffer is emptied atomically
        so results produced *before* the drainer ran (e.g. items a worker
        finished while the landing agent was still running) are never lost.
        """
        taken = list(self._role_results[role])
        self._role_results[role].clear()
        return taken

    def has_pending_work(self, role: str) -> bool:
        """True when items are queued or being processed for ``role``."""
        state = self._role(role)
        return state.pending_items > 0 or state.inflight > 0

    def cancel(self, reason: str = "") -> None:
        """Sentinel shutdown (§D4.2): wake workers and drainers immediately."""
        if self.cancelled_reason is not None:
            return
        self.cancelled_reason = reason or "Cancelled from the control room."
        for role_state in self._roles.values():
            for _ in range(max(1, role_state.live_workers)):
                role_state.queue.put_nowait(None)
            role_state.drained.set()

    async def aclose(self) -> None:
        """Stop workers, reap their tasks, and deregister from the run map."""
        self.request_stop()
        if self.workers:
            await asyncio.gather(*self.workers, return_exceptions=True)
            self.workers.clear()
        unregister_run_pools(self.run_id, self)

    def request_stop(self) -> None:
        """Synchronously place sentinels without touching drained events."""
        for role_state in self._roles.values():
            for _ in range(max(1, role_state.live_workers)):
                role_state.queue.put_nowait(None)

    # ── worker internals ─────────────────────────────────────────────────

    def _role(self, role: str) -> _PoolRoleState:
        return self._roles[role if role in self._roles else HOSTING_ROLE]

    def _check_drained(self, role: str) -> None:
        state = self._role(role)
        if state.drained.is_set() or self.cancelled_reason is not None:
            if self.cancelled_reason is not None:
                state.drained.set()
            return
        if not state.producers_done:
            return
        pending_items = state.pending_items
        if pending_items == 0 and state.inflight == 0:
            state.drained.set()
        elif pending_items > 0 and state.live_workers == 0:
            # Every worker died with items still queued; nothing will process
            # them, so report drained instead of deadlocking to the deadline.
            state.drained.set()

    def _mark_cancelled(self, reason: str) -> None:
        if self.cancelled_reason is None:
            self.cancelled_reason = reason or "Cancelled from the control room."
        for role_state in self._roles.values():
            role_state.drained.set()

    async def _worker_loop(self, role: str, worker_idx: int) -> None:
        state = self._role(role)
        try:
            while True:
                # D4.1: flag check between items, before dequeuing.
                _assert_not_cancelled(self.observer, f"{role} pool")
                item = await state.queue.get()
                if item is None:  # D4.2: sentinel shutdown
                    state.queue.task_done()
                    return
                try:
                    await self._process_item(item)
                finally:
                    state.queue.task_done()
                    state.pending_items -= 1
                    # Re-check drainage now that the queue count dropped.
                    self._check_drained(item.role)
        except RunCancelledError as exc:
            self._mark_cancelled(str(exc) or "Cancelled from the control room.")
            raise
        except Exception as exc:  # noqa: BLE001 — surface via the drainer
            self.worker_errors.append(exc)
            logger.exception("Pool worker %s/%s crashed", role, worker_idx)
            state.drained.set()
        finally:
            state.live_workers -= 1
            self._check_drained(role)

    async def _process_item(self, item: WorkItem) -> None:
        from src.agents.orchestrator import (
            _agent_type_for_role,
            _collect_embedded_urls,
            _failed_extraction,
            _page_type_for_role,
            _requires_embedded_followup,
        )

        state = self._role(item.role)
        state.inflight += 1
        try:
            child = None
            if self.observer is not None:
                child = self.observer.child(item.role, _agent_type_for_role(item.role))
            self._emit(
                "hosting_item_started",
                f"{item.role} item started: {item.url}",
                status="started",
                details={
                    "role": item.role,
                    "url": item.url,
                    "attempt": item.attempt,
                    "queue_depth": state.pending_items,
                },
            )
            timeout = max(30, int(getattr(self.settings, "agent_timeout_seconds", 2700) or 2700))
            try:
                result = await asyncio.wait_for(
                    self._run_agent(item, child), timeout=timeout
                )
            except RunCancelledError:
                raise  # D4.3: never launder cancellation into FAILED/TIMEOUT
            except Exception as exc:  # noqa: BLE001
                result = _failed_extraction(
                    item.url, _page_type_for_role(item.role), _agent_type_for_role(item.role), exc
                )
            self.results.append(result)
            self._role_results[item.role].append(result)
            state.processed += 1
            for server in getattr(result, "servers", []):
                self._emit(
                    EventKind.SERVER_ACTIVATED,
                    f"Server activated on {item.url}",
                    status="info",
                    details={
                        "url": item.url,
                        "server_label": server.label if hasattr(server, "label") else str(server),
                        "server_up": getattr(server, "server_up", None),
                        "playback_confirmed": getattr(server, "playback_confirmed", None),
                        "down_reason": getattr(server, "down_reason", None),
                    },
                )
            for stream in getattr(result, "streams", []):
                self._emit(
                    EventKind.STREAM_EXTRACTED,
                    f"Stream extracted from {item.url}",
                    status="success",
                    details={
                        "url": item.url,
                        "stream_url": stream.url if hasattr(stream, "url") else str(stream),
                        "protocol": getattr(stream, "protocol", "") or "unknown",
                        "quality": getattr(stream, "quality", "") or "unknown",
                    },
                )
            self._emit(
                "hosting_item_finished",
                f"{item.role} item finished: {item.url} ({result.status.value})",
                status="success" if result.status.value in {"success", "partial"} else "warning",
                details={
                    "role": item.role,
                    "url": item.url,
                    "status": result.status.value,
                    "streams_found": len(result.streams),
                },
            )
            if item.role == HOSTING_ROLE:
                self._post_process_hosting(
                    result, _requires_embedded_followup, _collect_embedded_urls
                )
        finally:
            state.inflight -= 1
            self._check_drained(item.role)

    async def _run_agent(self, item: WorkItem, child: Any) -> Any:
        from src.agents.orchestrator import _build_embedded_handoff, _build_hosting_handoff
        from src.memory.long_term import LongTermMemory

        handoff = item.handoff
        if not handoff:
            memory_hint = ""
            memory = self.memory
            if isinstance(memory, LongTermMemory):
                try:
                    memory_hint = memory.build_prompt_context(
                        url=item.url, page_type=item.role, limit=3
                    )
                except Exception:  # noqa: BLE001 — hints are soft guidance
                    memory_hint = ""
            # Handoff builders expect pipeline-state keys; the pool snapshot is
            # partial, so default what producers have not supplied yet.
            snapshot = dict(self.handoff_state)
            snapshot.setdefault("url", item.url)
            snapshot.setdefault("matches", [])
            snapshot.setdefault("extraction_results", [])
            snapshot.setdefault("classification", None)
            if item.role == HOSTING_ROLE:
                handoff = _build_hosting_handoff(
                    snapshot, target_url=item.url, memory_hint_text=memory_hint
                )
            else:
                handoff = _build_embedded_handoff(
                    snapshot, target_url=item.url, memory_hint_text=memory_hint
                )
        if item.role == HOSTING_ROLE:
            from src.agents.hosting_page import HostingPageAgent

            return await HostingPageAgent(self.settings).run(
                url=item.url, observer=child, orchestrator_handoff=handoff
            )
        from src.agents.embedded_page import EmbeddedPageAgent

        return await EmbeddedPageAgent(self.settings).run(
            url=item.url, observer=child, orchestrator_handoff=handoff
        )

    def _post_process_hosting(
        self, result: Any, requires_followup: Any, collect_embedded: Any
    ) -> None:
        """Frontier discovery + explicit-trigger embedded fan-out (spike §D2.2/3)."""
        # Newly discovered same-event hosting pages re-enter the hosting pool.
        for extra_url in self._same_event_hosting_targets(result):
            self.enqueue(HOSTING_ROLE, extra_url, source=f"hosting_frontier:{result.url}")

        decision = str((result.metadata or {}).get("decision", "") or "").strip().lower()
        if not requires_followup(result):
            return  # clean success path enqueues nothing
        candidates = collect_embedded(result)
        if not candidates:
            self._emit(
                "embedded_handoff_missing",
                "Hosting result requested embedded follow-up without an explicit embedded target",
                status="warning",
                details={"hosting_url": result.url, "decision": decision},
            )
            return
        for candidate in candidates:
            if self.enqueue(EMBEDDED_ROLE, candidate, source=str(result.url)):
                self.embedded_enqueued_urls.append(candidate)

    def _same_event_hosting_targets(self, result: Any) -> list[str]:
        from src.agents.orchestrator import (
            _looks_like_provider_stream_url,
            _same_site_or_subdomain,
        )

        metadata = result.metadata if isinstance(result.metadata, dict) else {}
        raw_candidates: list[Any] = []
        for key in ("same_event_hosting_urls", "additional_hosting_urls"):
            values = metadata.get(key, [])
            if isinstance(values, list):
                raw_candidates.extend(values)
        pages = metadata.get("hosting_pages", [])
        if isinstance(pages, list):
            raw_candidates.extend(pages)

        targets: list[str] = []
        seen: set[str] = set()
        for candidate in raw_candidates:
            url = ""
            if isinstance(candidate, dict):
                url = str(candidate.get("url") or "").strip()
            elif isinstance(candidate, str):
                url = candidate.strip()
            if (
                url
                and url not in seen
                and url != str(result.url or "").strip()
                and url.startswith(("http://", "https://"))
                and not _looks_like_provider_stream_url(url)
                and _same_site_or_subdomain(url, str(result.url or ""))
            ):
                seen.add(url)
                targets.append(url)
        return targets

    def _emit(
        self,
        kind: str,
        message: str,
        *,
        status: str = "info",
        details: dict[str, Any] | None = None,
    ) -> None:
        if self.observer is None:
            return
        try:
            self.observer.emit(kind, message, status=status, details=details or {})
        except Exception:  # noqa: BLE001 — observability must never break extraction
            logger.debug("Failed to emit %s event", kind)


# ── Module-level registry (spike §D4.4 / §D5) ────────────────────────────

_active_run_pools: dict[str, RunPools] = {}


def register_run_pools(run_id: str, pools: RunPools) -> None:
    if run_id:
        _active_run_pools[run_id] = pools


def unregister_run_pools(run_id: str, pools: RunPools | None = None) -> None:
    current = _active_run_pools.get(run_id)
    if current is None or (pools is not None and current is not pools):
        return
    _active_run_pools.pop(run_id, None)


def get_active_run_pools(run_id: str) -> RunPools | None:
    return _active_run_pools.get(run_id)


async def cancel_run_pools(run_id: str) -> bool:
    """Cancel the pools owning ``run_id`` (called from the app cancel hook)."""
    pools = _active_run_pools.get(run_id)
    if pools is None:
        return False
    pools.cancel("Cancelled from the control room.")
    if pools.workers:
        done, pending = await asyncio.wait(set(pools.workers), timeout=10)
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
    unregister_run_pools(run_id, pools)
    return True
