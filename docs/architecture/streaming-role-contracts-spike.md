# Design Spike: Streaming Role Contracts (gates plan task 28 / Wave W7)

Status: PROPOSED — supersedes `docs/architecture/spikes/streaming-role-contracts.md`,
whose code citations predate the current orchestrator layout (that file cites
`orchestrator.py:1033/1109/1235`; the real anchors today are 1188/1270/1311/1393).
Task 28 implementation must conform to the decisions here.

Grounded against the working tree as of 2026-08-26. All line numbers verified
against `src/agents/orchestrator.py`, `src/utils/observability.py`,
`src/agents/base.py`, `src/api/app.py`.

## 1. Current code reality

### 1.1 The gather-barriers being replaced

| Barrier | Location | Shape |
| --- | --- | --- |
| Hosting | `hosting_page_node` (`orchestrator.py:1188`) builds **all** tasks up front (`tasks.append(_guarded(...))` at :1263), then blocks on one call: `outcomes = await asyncio.gather(*tasks, return_exceptions=True)` (**orchestrator.py:1270**) | Concurrency bounded by `asyncio.Semaphore(settings.max_parallel_hosting_pages)` (:1217–1218, default 5 per `config.py:354`) |
| Embedded | `embedded_page_node` (`orchestrator.py:1311`) does the same: `outcomes = await asyncio.gather(*tasks, return_exceptions=True)` (**orchestrator.py:1393**) | Same semaphore pattern (:1347–1348) |
| Providers | `analyze_providers_node` (`orchestrator.py:1496`) is **not** a gather-barrier: it makes a single batched call `IPInfoTool(...)._arun(stream_urls=...)` (:1524). No change needed beyond its input timing. |

### 1.2 Cancellation laundering at the barriers

With `return_exceptions=True`, a child's `RunCancelledError` arrives as an
ordinary result value. The re-raise loops (`orchestrator.py:1266–1268` hosting,
`:1389–1391` embedded) catch only outcomes that *are* `RunCancelledError`
instances — that part works — but any child exception raised *after* a cancel
flag was set (e.g. an agent converting the abort into its own error type) falls
into the fold loop (:1273–1302 / :1394–1402) and becomes
`ExtractionResult(status=FAILED)` via `_failed_extraction`
(:349–369, `classify_failure_kind` :327–346). The run then finishes "normally"
and `OrchestratorAgent.run` reports a non-cancelled terminal status. This is the
bug class the pool design deletes structurally (D3).

Cancellation today is cooperative polling only:

- Flag on `_RunState`: `RunObserver.request_cancel` (`observability.py:602–618`),
  `is_cancel_requested` (:620–622); registry-level wrapper (:706–712).
- Poll sites: `_assert_not_cancelled(observer, phase)` (`base.py:411–422`) at six
  call sites in base.py (bootstrap ×2 :733/:775, parametrized phase :963,
  agent loop :1037, tool dispatch :1292/:1314, final answer :1687) plus the two
  dispatch guards inside the nodes themselves (`orchestrator.py:1226`, `:1356`).
- Hard teardown: `_cancel_active_run_task(run_id)` cancels the top-level
  `asyncio.Task` tracked in `_active_run_tasks` (`app.py:157`, tracking at
  :304–313, cancel at :316–324).

### 1.3 Discovery/enqueue flow today (batch, not streaming)

- `landing_page_node` (:1032) runs the whole landing agent first, then converts
  matches into work lists in the normalization loop (:1115–1127): provider-style
  URLs become direct streams, everything else lands in `pending_hosting_urls`.
- Work only reaches hosting when the *graph transitions*:
  `route_after_landing` (:1769–1774) → `hosting_page`; `route_after_hosting`
  (:1777–1782) can loop back for newly pending URLs; edges wired at
  `build_graph` :1829–1853 (hosting self-loop :1839–1847).
- Embedded follow-up gating is `_requires_embedded_followup`
  (:751–764): fires when metadata `decision ∈ {needs_embed_agent,
  partial_success_needs_embed}`, any server status is `needs_embed_agent`
  (produced by `hosting_page.py:235/:505/:763/:829`), or as fallback when no
  streams exist but embedded candidates do. It is invoked for **every**
  qualifying result — success-path branches still pay the check and can enqueue.
- Provider analysis waits for the full drain because it reads the
  post-transition state snapshot (`state["extraction_results"]`, :1503).

### 1.4 Observability surfaces the design builds on

- `RunObserver.emit()` appends `RuntimeEvent` to `_RunState.events` under a
  lock with a monotonic per-run `seq`; `events_since(seq)` at
  `observability.py:640–642`. Any coroutine in-process can emit safely.
- SSE read path: `_stream_trace` (`app.py`, starts ~:2105) is a pure poll loop —
  `run_registry.get(run_id)` → yield events with `seq > last_seq` →
  `asyncio.sleep(0.8)` → keepalive comment every `_SSE_KEEPALIVE_SECONDS = 20`
  (`app.py:84`) → break when `trace.completed`; wrapped in `StreamingResponse`
  with `media_type="text/event-stream"` (:3029–3031). DB backfill exists when
  the trace is not resident (`_restore_trace_from_db` path, :2119+).
- `RunRegistry` (`observability.py:645`): in-process `OrderedDict`,
  `max_runs=100` with LRU eviction `popitem(last=False)` (:662–663);
  `restore(trace)` (:666) rebuilds a read-model from DB snapshots;
  `create` reuses a live unfinished state if present (:653–660).
- Graceful partial completion already merges node deltas into `live_state`
  (`_consume_graph_stream`, :1868–1882) so the `WorkflowTimeoutError` /
  budget-exceeded path (:2024–2055) can return partial results (T30 contract).
- Failure taxonomy: `FailureKind` (`src/models/common.py:53–70`: UNKNOWN,
  TIMEOUT, WORKFLOW_TIMEOUT, BUDGET_EXCEEDED, CANCELLED, SITE_INACCESSIBLE,
  AGENT_ERROR), mapped by `classify_failure_kind` (`orchestrator.py:327–346`).
- Event kinds are a **closed** enum: `EventKind` (`common.py:74+`). Unknown
  kinds raise in dev and coerce to UNKNOWN in prod — every new event kind in
  §D5 must be registered there or events will be silently degraded.

## 2. Decisions

### D1 — Worker lifecycle: one process, asyncio-only pools, bounded workers

The hosting/embedded worker pools are plain `asyncio.Task`s spawned in the same
event loop and process as the LangGraph run. Not executors, not process pools:
the registry, cancel flag, observer emission, and SSE reads are all in-process
objects; crossing a process boundary would force IPC through all four.

Per run, the orchestrator creates a `RunPools` handle:

```
RunPools
  hosting_queue: asyncio.Queue[WorkItem]     # WorkItem = url + handoff payload + attempt
  embedded_queue: asyncio.Queue[WorkItem]
  seen_urls: set[str]                        # dedupe across producers
  inflight: int                              # items currently being processed
  done: asyncio.Event                        # queues empty AND inflight == 0 AND producers finished
  workers: list[asyncio.Task]
```

- **Bounded**: worker count = `max(1, settings.max_parallel_hosting_pages)`
  (config.py:354, default 5) — the same knob the semaphore uses today, so no
  new Settings field and identical worst-case concurrency. Queues themselves are
  unbounded; producers are inherently bounded (landing match count, hosting
  frontier discoveries — dozens at most), so no `QueueFull` policy.
- **Lifecycle states** per worker: `idle → processing(item) → idle … → exiting`
  (on sentinel or cancel). A worker never exits between items except via
  sentinel/cancel, so there is no respawn logic.
- **Timeouts inherit the taxonomy**: each item wraps the agent call in
  `asyncio.wait_for(..., timeout=settings.agent_timeout_seconds)` (config.py,
  currently 2700). A `TimeoutError` becomes `_failed_extraction(...)`, whose
  `classify_failure_kind` already maps to `FailureKind.TIMEOUT`
  (orchestrator.py:339–340). `WorkflowTimeoutError` stays a *workflow*-level
  concern: the outer `asyncio.wait_for` deadline (:2135–2140) keeps governing
  total wall clock including pool time, preserving the T30 graceful-partial
  behavior unchanged.
- **Drainer nodes**: `hosting_page` / `embedded_page` remain as thin LangGraph
  nodes whose body is now `await pools.wait_until_drained(role)` plus folding
  nothing (workers append results themselves). This keeps graph sequencing —
  `route_after_hosting`/provider analysis must still observe a completed
  extraction phase — while moving the barrier from "gather all tasks" to
  "wait until queues drain". `done` requires `inflight == 0`; a drainer must
  not report complete while a worker is mid-item.

### D2 — Producer/consumer rewiring (implementation outline)

1. **Landing streams each match immediately.** Inside the match-normalization
   loop (`landing_page_node`, orchestrator.py:1115–1127), each normalized
   `MatchInfo` is enqueued to `pools.hosting_queue` the moment it is classified
   as a hosting target (direct-stream URLs still go into
   `landing_outcome.streams` exactly as today, :1134–1157). Hosting workers
   therefore start while the landing agent is still running. The node still
   *returns* `pending_hosting_urls` (now informational/empty) so the
   `PipelineState` shape and `_build_pipeline_result`'s `pending_followups`
   check (:2239) stay compatible during migration.
2. **Hosting enqueues newly discovered hosting pages.** After each extraction a
   hosting worker checks the result for additional same-event hosting targets
   (the mini-listing case the handoff text already promises,
   orchestrator.py:817) and enqueues them after `seen_urls` dedupe. This
   replaces the `route_after_hosting` graph self-loop (:1839–1847) as the
   frontier mechanism.
3. **Embedded invoked only on explicit triggers.** Replace
   `_requires_embedded_followup`'s broad conditions (:751–764) with a narrow
   predicate: enqueue embedded work **only** when the hosting result carries
   one of:
   - `activation_failed` — player activation failed but an embedded/player URL exists (today's `needs_embed_agent` server status, hosting_page.py:505/:763);
   - `no_networking` — no network-extracted stream and no player activation, embed is the only remaining layer (today's final fallback branch, :764);
   - `judge_validation_request` — reserved trigger for the ValidatorAgent seam (`repair_malformed_payload`, orchestrator.py:1410–1423; live when task 24 lands).
   These three strings become the new `metadata.decision` vocabulary emitted by
   the hosting agent, replacing `needs_embed_agent` /
   `partial_success_needs_embed` (hosting_page.py:235/:505/:763/:829). A
   success-path hosting result enqueues nothing — the audit finding that every
   semi-successful branch pays an embedded fan-out disappears.
4. **Provider analysis unchanged** except timing: it runs after both drainer
   nodes complete, reading the same accumulated `extraction_results`.
   `generate_takedown_emails_node` (:1564) untouched.

### D3 — Checkpoint/resume semantics for queue-consumed work

Queue contents are ephemeral by design; durability comes from what is already
persisted. No new checkpoint format.

- **Ack point**: before a worker opens the browser session it writes the
  started-agent row (the same telemetry row the agent loop writes today) and
  emits `hosting_item_started` (§D5). That write *is* the ack; a crash after it
  leaves a "started without finished" trail.
- **Restart mid-pool-drain**: a restarted process is a NEW run. On startup the
  app already sweeps stale jobs — `_recover_background_jobs` calls
  `BackgroundJobRepository.recover_stale_running(stale_after_seconds=180)`
  (app.py:553) and job claims carry a 90 s lease (:567). The sweep is extended
  (§D4) to also mark the orphaned run's trace terminal so SSE clients stop
  spinning. Unfinished queue items are simply lost with the old process; the
  dataset-batch retry path re-runs them as it does today for crashed jobs.
- **Idempotency within a run**: `seen_urls` dedupe plus the existing
  per-(run_id, url, agent_type) telemetry uniqueness means a redelivered item
  is skipped silently (emit `duplicate_suppressed` debug event).
- **Explicitly rejected**: resuming the *same* run after restart. It would
  require serializing queue/handoff state into snapshots; there is no operator
  need while runs are minutes-scale and retry is cheap. Revisit only if
  multi-hour runs appear.

### D4 — Cancellation propagation into pool workers

Four layers, cheapest first; layers 1–2 give sub-tool-call latency, 3–4 give
correctness:

1. **Flag check between items** — every worker loop iteration calls
   `_assert_not_cancelled(observer, "hosting pool" / "embedded pool")`
   (base.py:411–422) before dequeuing. Matches today's dispatch-guard latency
   (orchestrator.py:1226/:1356).
2. **Sentinel shutdown** — the cancel paths that own pools additionally call
   `pools.cancel()`, which places `None` sentinels in both queues. Workers exit
   after finishing their current item (mid-tool abort remains base.py's job
   inside `run_agent_loop`). Sentinels make shutdown O(workers), not
   O(queue_depth).
3. **No laundering, ever** — the pool replaces the `return_exceptions=True`
   gather (orchestrator.py:1270/:1393) entirely. Worker exception handlers use
   `except RunCancelledError: raise` *before* any `except Exception`, and
   results are appended by workers themselves, so the fold-loop conversion of
   cancellations into FAILED extractions (:1273–1302) cannot recur. A cancelled
   item records `failure_kind="cancelled"` (FailureKind.CANCELLED,
   common.py:65) only when the abort raced mid-item; otherwise it raises.
4. **Task-tree teardown** — pool tasks register in a module-level
   `run_id -> RunPools` map mirroring `_active_run_tasks` (app.py:157).
   `_cancel_active_run_task` (:316–324) additionally cancels `pools.workers`
   after setting the flag, so a hard teardown cannot leave orphaned workers
   holding browser sessions.

Because the top-level task cancel (`task.cancel()`) already unwinds everything
awaited under `OrchestratorAgent.run`, layer 4 is belt-and-braces for workers
created outside the awaited subtree.

### D5 — Registry ownership vs multi-process/restart orphans

Ownership rule: **the process that created a run owns its pools and is the sole
writer of that run's `_RunState`.** `RunRegistry.restore()`
(observability.py:666) is read-model reconstruction for SSE/history only — it
must never be treated as a resume mechanism. `create()`'s reuse of an unfinished
resident state (:653–660) is safe only because of the single-writer rule.

Who GCs dead pool entries:

- **Live process**: pool entries die with their run — drainer completion sets
  `done`, `OrchestratorAgent.run` finishes, and the `run_id -> RunPools` map
  entry is popped in a `finally`. Registry memory is bounded independently by
  the existing LRU cap (`max_runs=100`, observability.py:662–663).
- **Dead process (restart orphans)**: the startup sweep owns them. Extend
  `_recover_background_jobs` (app.py:553): for background jobs in `running`
  whose heartbeat exceeds the lease window **and** whose `run_id` is absent
  from the fresh process's `_active_run_tasks`, mark the job failed with
  `failure_mode="process_restart_orphan"` and append a synthetic
  `pipeline_failed` runtime event (kind already in `EventKind`, common.py) so
  the console shows truth instead of an eternal spinner. The 180 s
  `stale_after_seconds` and 90 s lease stay as-is.
- **Multi-process horizon**: horizontal scaling is deferred until the Redis
  run-store exists. At that point `RunPools` queues map 1:1 onto Redis lists
  and `_RunState` onto Redis hashes; contracts that must survive the move are
  ack-before-execute (D3), sentinel+flag cancellation (D4), and seen-set dedupe
  (D3). Nothing in D1–D4 may assume single-process beyond what asyncio already
  forces.

### D6 — How SSE reads state for out-of-graph children

**Zero changes to the read path.** Pool workers hold `observer.child(...)`
handles (created exactly as the nodes do today, e.g. orchestrator.py:1235) and
emit through the same thread-safe `_RunState.events` list; `_stream_trace`'s
poll loop picks up anything with `seq > last_seq` regardless of which coroutine
appended it. Event flow:

```
landing agent ──match discovered──▶ enqueue(hosting_queue)          [queue_enqueued]
                                        │
                             hosting worker dequeues                     [hosting_item_started]
                                        │
                        agent runs (emits existing event vocabulary)
                                        │
              ┌── new hosting URL found ──▶ enqueue(hosting_queue)    [queue_enqueued]
              ├── trigger ∈ {activation_failed, no_networking,
              │              judge_validation_request} ──▶ enqueue(embedded_queue)
              └── else: terminal
                                        │
                             worker appends ExtractionResult             [hosting_item_finished]
                                        │
                    queues empty ∧ inflight == 0 ∧ producers done        [pool_drained]
                                        │
                          drainer node returns → graph proceeds
                                        │
              SSE: _stream_trace poll (0.8 s) yields all seq-new events;
              keepalive comment every 20 s; stream ends on trace.completed
```

New event kinds to register in `EventKind` (closed enum, common.py):

| Kind | Emitted when | Details |
| --- | --- | --- |
| `queue_enqueued` | producer adds work | `{role, url, source}` |
| `hosting_item_started` | worker dequeues + acks | `{url, attempt, queue_depth}` |
| `hosting_item_finished` | worker completes/fails item | `{url, status, streams_found}` |
| `pool_drained` | role drained + workers idle | `{role, processed, duplicates_suppressed}` |

Backpressure note: unbounded queues are acceptable because both producers are
structurally bounded (landing match count, per-page frontier discoveries —
historically dozens). Revisit only if a site ever yields a 4-digit frontier.

## 3. Consequences & test seams

- Positive: true overlap of landing discovery and hosting extraction;
  cancellation can no longer be folded into FAILED results (structural fix, not
  a patch at orchestrator.py:1266); embedded invocations become deliberate and
  auditable; per-item console granularity for free via the existing SSE loop.
- Risks: queue-starvation deadlock and worker leaks — mitigated by `pool_drained`
  heartbeats, the drainer `inflight == 0` rule, and the D4/D5 teardown+sweep;
  drainer/graph sequencing subtlety covered by the same rule.
- Tests (`tests/orchestrator/test_streaming_handoffs.py`) will assert:
  (a) timeline overlap — first `hosting_item_started` precedes landing
  `agent_finished`; (b) no embedded enqueue on a clean hosting success; (c)
  cancel during an active queue terminates within one tool call and the final
  status is `cancelled`, not FAILED/TIMEOUT; (d) a duplicate URL enqueued twice
  processes once; (e) the restart sweep flips an orphaned running job to
  `process_restart_orphan`.

## 4. Implementation order inside task 28

1. `RunPools` (queues, `seen_urls`, inflight counter, `done`) + worker loops +
   drainer-node swap behind the existing settings knob; landing producer
   rewired per D2.1; delete the two gathers (orchestrator.py:1270, :1393).
2. Embedded trigger vocabulary (`activation_failed` / `no_networking` /
   `judge_validation_request`) in the hosting agent, narrowing
   `_requires_embedded_followup` (orchestrator.py:751–764) and the
   hosting_page.py decision sites (:235/:505/:763/:829).
3. Cancellation layers D4.1–D4.4 (coordinate with T8 so base.py edits land once).
4. Event kinds (register in `EventKind`) + restart-orphan sweep extension (D5).
5. The five test assertions above.
