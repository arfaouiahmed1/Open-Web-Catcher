# Spike: Streaming Role Contracts (gates Batch W7)

Status: APPROVED SPIKE — satisfies the design-spike precondition of plan task 28 (`.omo/plans/full-audit.md`). Implementation of tasks 27–30 must conform to the contracts here. Authored 2026-08-22 under explicit owner authorization for root-level work on conflict-free lanes.

## 1. Problem

Today each extraction stage is a rigid gather-barrier:

- `hosting_page_node` (orchestrator.py:1033) builds **all** hosting tasks up front and blocks on one `asyncio.gather(*tasks, return_exceptions=True)` (orchestrator.py:1109).
- `embedded_page_node` does the same (orchestrator.py:1235).
- Landing discovers matches, but downstream work cannot start until the landing node returns and the graph transitions.

Consequences: no timeline overlap between landing and hosting, no incremental enqueue of newly discovered hosting pages, and a cancellation bug — `return_exceptions=True` converts a child's `RunCancelledError` into an ordinary result value, which the outcome loop (orchestrator.py:1114-1127) logs as a warning and converts into an `ExtractionResult(status=FAILED)`. The run then completes "normally" — folded into a non-cancelled terminal status (`FAILED`, or `TIMEOUT` when the error text contains "timed out", orchestrator.py:1121-1123). This is finding [AGT-C1].

## 2. Current runtime facts the design builds on

| Fact | Location | Design relevance |
| --- | --- | --- |
| `RunObserver.emit()` appends `RuntimeEvent` to `_RunState.events` under a `threading.Lock`; `seq` is monotonic per run | observability.py:354-373 | Any coroutine in the run process can emit safely; no queue needed for event capture |
| SSE endpoint `_stream_trace` is a poll loop: `while True` → `run_registry.get(run_id)` → yield `events_since(last_seq)` → keepalive timer | app.py:2031-2190 | Out-of-graph children need ZERO SSE changes if they emit through the same observer |
| `RunRegistry` is an in-process `OrderedDict` (max 100, LRU evict) with `restore(trace)` from DB snapshots | observability.py:615-682 | Single-process ownership assumption is already baked in |
| Cancellation is a flag on `_RunState` (`cancel_requested`) checked by `_assert_not_cancelled(observer, phase)` at 6 call sites in base.py (bootstrap ×2, parametrized phase, agent loop, tool dispatch, final answer) | observability.py:572-596, base.py:412-423 | Pool workers reuse the identical check — no new cancel channel required |
| `_active_run_tasks: dict[str, asyncio.Task]` tracks top-level run tasks for the cancel endpoints | app.py:157, 304-313 | Pool tasks must register here too (or in a per-run pool handle hanging off it) |

## 3. Decisions

### D1 — One process, real queues, no thread/process pools

The hosting/embedded worker pools are plain asyncio tasks spawned **inside the same event loop and process as the LangGraph run**. Not `run_in_executor`, not process pools. Rationale: registry, cancellation flag, observer emission, and SSE reads are all in-process objects; crossing process boundaries would force IPC for all four (see D5 for the multi-process endgame).

Each run gets a `RunPools` object created by the orchestrator at run start:

```
RunPools
  hosting_queue: asyncio.Queue[HostingTask]      # unbounded, item = url + handoff payload + attempt count
  embedded_queue: asyncio.Queue[EmbeddedTask]
  workers: list[asyncio.Task]                    # sized by existing settings.max_parallel_hosting_pages
  done: asyncio.Event                            # set when queues drain AND all workers idle
```

### D2 — Producer/consumer rewiring

- `landing_page_node` emits each normalized match into `hosting_queue` **as it discovers it** (inside the match-normalization loop, orchestrator.py:957-972), instead of returning `pending_hosting_urls` for a later graph node.
- Hosting workers consume; when a hosting extraction yields new hosting-page URLs (currently impossible to exploit), they enqueue them — self-feeding frontier with dedupe by URL (a `seen_urls:set` on `RunPools`).
- Embedded is invoked ONLY on one of three triggers, replacing today's `_requires_embedded_followup` fan-out: `activation_failed`, `no_networking`, or `judge_validation_request` (the third becomes live when ValidatorAgent lands in task 24). Everything else terminates the branch.
- Graph edges: the standalone `hosting_page` / `embedded_page` nodes become thin drainers that wait on `pools.done` so LangGraph still has a node to sequence after (provider analysis must wait for extraction completion). The barrier moves from "gather all tasks" to "wait until queues drain".

### D3 — Checkpoint/resume semantics for queue-consumed work

Queue contents are ephemeral by design; durability comes from what is already persisted:

1. Every dequeued item writes an `ExtractionResult` row (status `running` equivalent = agent_runs row started) BEFORE the browser session opens — this is the ack point.
2. On process crash/restart, recovery = the existing DB reconciliation path: rows stuck in started-without-finished state for a dead run are marked `interrupted` by the startup sweep (D5), and dataset-batch retry logic re-queues them exactly as it does today for crashed jobs. No new checkpoint format is introduced.
3. Idempotency: `seen_urls` dedupe plus the existing per-(run_id, url, agent_type) uniqueness in telemetry means a redelivered item is safe to skip; workers check `seen_urls` before dequeue-processing and drop duplicates silently (emitting `duplicate_suppressed` debug event).
4. Explicitly OUT of scope: resuming mid-run after restart (a restarted run is a NEW run; the old one is terminal-interrupted). Resume-the-same-run would require serializing queue state into snapshots and is rejected as complexity without an operator need.

### D4 — Cancellation propagation into pool workers

Four layers, cheapest first:

1. **Flag check between items**: every worker loop iteration calls `_assert_not_cancelled(observer, "hosting pool")` / `"embedded pool"` before dequeuing the next item. This bounds cancellation latency at "one tool call", matching the T8 acceptance criterion.
2. **Sentinel shutdown**: `request_cancel` paths that own pools call `pools.cancel()` which puts `None` sentinels into both queues; workers exit after their current item (current item is allowed to finish its in-flight tool call — mid-tool abort stays T8's job inside `run_agent_loop`).
3. **Explicit re-raise**: wherever outcomes are folded (worker exception handlers, the draining nodes), `except RunCancelledError: raise` precedes any generic `except Exception`. The gather-barrier pattern that laundered cancellations into FAILED results is deleted outright, so the laundering site no longer exists.
4. **Task-tree teardown**: pool tasks are created with the run's top-level task as parent context via `asyncio.shield`-free plain tasks tracked in `RunPools.workers`; `_track_run_task`'s cancel path additionally cancels `pools.workers` (looked up from a `run_id -> RunPools` map owned by the orchestrator module, mirroring `_active_run_tasks`).

### D5 — Registry ownership, multi-process, and restart orphans

Ownership rule: **the process that created the run owns its pools and is the only writer of its `_RunState`.** `RunRegistry.restore()` remains read-model reconstruction for SSE/history, never a resume mechanism.

Orphan sweep at startup (implemented with T28, tested in `test_streaming_handoffs.py`): on app start, query background jobs in `running` status whose `heartbeat_at` is older than the lease window AND whose run_id is not in the fresh process's `_active_run_tasks`; mark job `failed` with `failure_mode="process_restart_orphan"` and append a synthetic `pipeline_failed` runtime event so the console shows truth instead of an eternal spinner.

Multi-process horizon: horizontal scaling of run execution is explicitly deferred until the Redis run-store (task 17, ADR-002) exists. At that point `RunPools` queues map 1:1 onto Redis lists and `_RunState` onto Redis hashes; the contracts in this document (ack-before-execute, sentinel+flag cancellation, seen-set dedupe) are the ones the Redis implementation must preserve. Nothing in D1-D4 may assume "single process forever" beyond what asyncio already forces.

### D6 — How SSE reads out-of-graph children

No new read path. Children hold `RunObserver` handles (already thread-safe, observability.py:362-373) and emit the existing event vocabulary plus these additions:

| New kind | Emitted when | Details payload |
| --- | --- | --- |
| `hosting_item_started` | worker dequeues + acks | `{url, attempt, queue_depth}` |
| `hosting_item_finished` | worker completes/fails item | `{url, status, streams_found}` |
| `queue_enqueued` | producer adds work | `{role, url, source}` |
| `pool_drained` | role queue empty + workers idle | `{role, processed, duplicates_suppressed}` |

The SSE poll loop picks these up unchanged because they live in the same `_RunState.events` list. Backpressure: queues are unbounded but producers are bounded (landing match count, hosting frontier discoveries), which audit showed stays in the dozens — no `QueueFull` policy needed; revisit only if a site ever yields 4-digit frontiers.

## 4. Consequences

- Positive: true overlap of landing discovery and hosting extraction; cancellation can no longer be swallowed by barrier folding; embedded invocations become a deliberate, auditable decision; SSE/console gains per-item granularity for free.
- Negative/risks: two new failure surfaces (queue starvation deadlock, worker leak) — mitigated by `pool_drained` events and the D5 orphan sweep; graph sequencing subtlety (drainer nodes must not report done while a worker is mid-item) — handled by counting in-flight items on `RunPools`.
- Test seams locked in now: `tests/orchestrator/test_streaming_handoffs.py` will assert (a) timeline overlap via event timestamps (first `hosting_item_started` < landing `agent_finished`), (b) embedded absent on success path, (c) cancel during active queue drains within one tool call with final status `cancelled`, (d) duplicate URL enqueued twice processes once, (e) restart sweep flips orphaned running jobs to failed.

## 5. Implementation order inside task 28

1. `RunPools` + worker loops + drainer nodes behind internal wiring (no settings flag — behavior swap is the deliverable).
2. Cancellation layers D4.1-D4.4 (coordinated with T8 so base.py edits land once).
3. Event kinds D6 + orphan sweep D5.
4. The five test assertions above.
