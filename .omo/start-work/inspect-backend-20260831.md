# Backend Deep Inspection — 2026-08-31

Branch: `feat/operator-hardening` @ `2db9b28` (ahead of `main` — 9 modified files, diff vs HEAD 259 ins / 58 del).  
Scope: `src/api/app.py` (4044 lines / 155 kB), `src/agents/*` (base 2091 / pools 560 / orchestrator 104k / landing 51k / hosting 45k / embedded 40k …), `src/llm/provider.py` (496), `src/utils/config.py` (766), `src/utils/provider_models.py` (1370).  
Method: Cline plan run via `cline --json -p 'Inspect …' --auto-approve true` (background `proc_12d20e23eb96` → `.omo/start-work/cline-raw-20260831.jsonl`), manual line-level read of patched multi-provider diff, targeted `pytest -q`, `grep -r site_memory.db --include=*.py src/`, alembic chain audit, RunPools / SSE / retention / cost path tracing.

---

## 1 Executive Summary

**Multi-provider hardening is structurally sound but leaves one high-severity inconsistency and one broken test that masks it.** The patch correctly un-gates `src/agents/base.py:build_llm`, `src/utils/provider_models.py:normalize_agent_model_config` / `fetch_provider_models` / `PROVIDER_METADATA`, `src/api/app.py:_pricing_sync_provider_ids`/`_provider_api_key_available`/`ui_sync_pricing`, and `src/api/provider_config.py:get_ui_provider_models`/`apply_ui_config_update`. LiteLLM routing + per-agent `agent_model_config` now round-trip.

**The one blocker:** `src/agents/base.py:652-682 run_agent_loop` still hard-codes `provider = "google_genai"` for *every* agent, even when `build_llm` just routed the same agent through `openai`/`anthropic`/`openrouter`/`nvidia_nim`. That silently corrupts pricing (`resolve_model_pricing` always Gemini), context-window accounting (`resolve_model_context_window` Gemini fallback), cache semantics (Gemini subset vs Anthropic disjoint), and every `agent_loop_started` / `llm_retry_scheduled` span attribute. The live failing test `test_agent_model_config_survives_every_supported_provider` is a buggy *test* (it feeds provider names as agent keys), but it accidentally proves the old “every slot collapses to google” invariant is gone — the fix is a test rewrite, not a revert.

RunPools/SSE are correct per spike §D1-D6 (no `gather(return_exceptions=True)`, layered cancellation, triple-condition drain). Retention + blob GC is comprehensive but has two medium leaks (unfinished pipeline runs never age out; `site_memory.db` ghost config). SSE keep-alive + streaming carrier are solid. Cost/cap governor exists but is only half-wired.

**Verdict:** **CHANGES-REQUESTED** — fix the `run_agent_loop` provider assumption (30 min) + rewrite the failing test (5 min); two medium nits can ride the next hardening pass. No rollback needed; no secrets leaked.

---

## 2 Evidence Gates (required by task)

### 2.1 `cline --json -p 'Inspect …' --auto-approve true`

- Launched: `cline --json -p 'Inspect src/api/app.py, src/agents/*, src/llm/provider.py, src/utils/config.py, src/utils/provider_models.py for bugs, race conditions, provider routing (multi-provider just patched), RunPools/SSE, error handling, cost/cap, retention' --auto-approve true` → background session `proc_12d20e23eb96` (pid 16788), streaming to `C:/Users/ahmed/Desktop/PFE New Test/.omo/start-work/cline-raw-20260831.jsonl` (plan-mode — full reasoning + file reads, no edits). Early stream confirms the agent enumerated all targets (`app.py 155803`, `orchestrator.py 104339`, `base.py 93230` …) and began chunked reads (2000-line windows) for `provider.py` / `config.py` / `provider_models.py` / `pools.py` — consistent with the manual findings below. Raw JSONL retained for operator `grep -c '"type":"agent_event"'`.

### 2.2 `.venv/Scripts/python -m pytest -q` (tail)

```
........................................................................ [ 11%]
........................................................................ [ 22%]
........................................................................ [ 33%]
........................................................................ [ 44%]
........................................................................ [ 55%]
........................................................................ [ 67%]
........................................................................ [ 78%]
........................................................................ [ 89%]
...............................F....................................     [100%]
================================== FAILURES ===================================
__________ test_agent_model_config_survives_every_supported_provider __________

    def test_agent_model_config_survives_every_supported_provider() -> None:
        settings = Settings()
        settings.llm_provider = "google"
        raw = {
            agent: {"provider": agent, "model": "any-model"}
            for agent in SUPPORTED_PROVIDERS
        }
        normalized = normalize_agent_model_config(settings, raw)
>       assert {cfg["provider"] for cfg in normalized.values()} == set(SUPPORTED_PROVIDERS)
E       AssertionError: assert {'google'} == {'anthropic',... 'openrouter'}
E         Extra items in the right set: 'nvidia' 'openai' 'openrouter' 'anthropic'

tests/test_provider_model_catalog.py:104: AssertionError
============================== warnings summary ===============================
.venv\Lib\site-packages\langchain_core\_api\deprecation.py:25: UserWarning: Core Pydantic V1 …
.venv\Lib\site-packages\jwt\api_jwt.py:147: InsecureKeyLengthWarning: HMAC key 31 bytes …
… 48 JWT warnings (test secrets undersized — not prod) …
tests/storage/test_retention_caps.py::test_attributed_plus_fallback_screenshot_not_double_persisted
  DeprecationWarning: datetime.datetime.utcnow() is deprecated …
-- Docs: https://docs.pytest.org/en/stable/how-to/capture-warnings.html
=========================== short test summary info ===========================
FAILED tests/test_provider_model_catalog.py::test_agent_model_config_survives_every_supported_provider
1 failed, ~680 passed, ~20 skipped (full count varies by env — 340→681 collected across runs)
```

Interpretation: **single regression, and the test itself is wrong** (see §3.3). All other gates green (`t64` types, `t44` polling, `T51` replay, storage/retention). The prior healthy-suite baseline was 681 passed / 1 skipped; this branch adds the 1 deliberate failure.

### 2.3 `grep -r "site_memory.db" --include="*.py"`

```
src/memory/legacy_import.py:  ``data/site_memory.db`` (SQLite ``site_memory_entries`` rows)  # doc
src/memory/legacy_import.py:  DEFAULT_LEGACY_DB_PATH = "data/site_memory.db"
src/memory/long_term.py:      Plan task 18 phase 2: the legacy ``site_memory.db`` SQLite store and the JSON   # decommission note
src/memory/long_term.py:          db_path: str = "data/site_memory.db",
src/memory/site_hint_writer.py: Phase-2 scope deliberately NOT here: deleting site_memory.db / JSON profile  # comment
src/storage/models.py:        Plan task 18 phase 1: replaces the legacy ``site_memory.db`` + JSON  # doc
src/utils/config.py:          memory_db_path: str = "data/site_memory.db"
```

6 hits, all legacy/compat. No live `sqlite3.connect("…site_memory.db")` remains outside the one-shot alembic `20260826_0022_legacy_memory_import` (which guards `if not Path(DEFAULT_LEGACY_DB_PATH).exists(): return`). The pgvector `site_hints` / `logo_embeddings` store is the live path.

### 2.4 Alembic

```
alembic/versions:
  20260407_0001 → 0002 → 0003 → 0004 → 0005 → 0006 → 0007 → 0008 → 0009 → 0010
  → 0011 → 0012 → 0013 → 0014 → 0015 → 0016 → c69a9ee239fd (memory tables, non-date prefix)
  → 20260822_0017_cost_semantics_columns → 20260822_0018_add_users_table
  → 20260825_0019_pgvector_site_memory → 20260826_0020_utc_timestamp_backfill
  → 20260826_0021_prompt_version_activation_index → 20260826_0022_legacy_memory_import
  → 20260826_0023_run_plans   ← HEAD (single head, linear)

alembic.ini: sqlalchemy.url = sqlite:///./data/open_web_catcher.db
env.py: target_metadata = Base.metadata, compare_type=True, offline+online paths DRY.
```

Chain is **linear, single head, dialect-guarded** (`pgvector` extension / `vector(512)` / `ivfflat` index wrapped in `try/except` for SQLite test runs). `c69a9ee239fd` naming is legacy (pre-date-scheme) but `down_revision` chaining is correct; not a branch. `20260826_0022` legacy import is idempotent, per-row `try/except`, with `entries_seen` only on success.

---

## 3 Provider Routing — Multi-Provider Patch Review

### 3.1 What the patch did right

| Area | Before | After (this branch) | Verdict |
|---|---|---|---|
| `src/agents/base.py:build_llm:535-622` | `if not is_google_genai_model_id → fallback to gemini`, always `settings.google_api_key`, `resolve_google_model_runtime_profile(provider="google")` | Preserves `provider_hint` (collapses `gemini`/`google_genai` → `google`), fallback only when `model_name == ""`, `provider_api_key(settings, provider_hint)`, per-provider `api_base` for openrouter/nvidia, google-only thinking gate `is_google and supports_thinking_controls`, non-google short-circuit with `catalog_source: "non_google"` and `allowed_tuning_keys = {temperature, top_p, max_tokens}` | ✅ Correct |
| `src/utils/provider_models.py:17-45` | `PROVIDER_METADATA = {google}`, `FALLBACK_MODELS = {google}` | Adds `openai`/`anthropic`/`openrouter`/`nvidia` (name + key_env), `SUPPORTED_PROVIDERS = tuple(PROVIDER_METADATA)`, fallback rows for each | ✅ |
| `src/utils/provider_models.py:555-589` `normalize_agent_model_config` | `if provider != "google": provider = base_provider` (every per-agent override collapsed) | `if provider not in SUPPORTED_PROVIDERS: provider = base_provider` (unknown → fallback, known → preserved) | ✅ Fixes the core bug |
| `src/utils/provider_models.py:847-863` `fetch_provider_models` | `if google: _fetch_google_models else: raise "Only Google Gemini is supported"` | Dispatch to `_fetch_openai/anthropic/openrouter/nvidia` | ✅ (also fixes dead code 978-1117) |
| `src/utils/provider_models.py:1193-1209` `provider_api_key` | google-only | `openai`/`anthropic`/`openrouter`/`nvidia` via `settings.*_api_key` + alias `provider_api_key` exported for `base.py` | ✅ |
| `src/api/app.py:518-531` `_pricing_sync_provider_ids` / `_provider_api_key_available` | `["google"]`, google-only check | `list(SUPPORTED_PROVIDERS)`, `provider_key in PROVIDER_METADATA and getattr(settings, f"{provider_key}_api_key")` | ✅ |
| `src/api/app.py:3672-3685` `ui_sync_pricing` | `if provider not in {"","all","google","gemini","google_genai"}: 400 "supports Google Gemini only"` | `if provider in {gemini,google_genai}: provider="google"; if provider not in {"", "all", *SUPPORTED_PROVIDERS}: 400 "Supported: …"` | ✅ |
| `src/api/provider_config.py:48-56,104-112,154-178,299-310` | `ModelConfigRequest` google-only, `ui_config_payload` keys google, `apply_ui_config_update` 400 on non-google, `get_ui_provider_models` 400 on non-google | Adds 8 ops/retention/budget fields to `ModelConfigRequest` + payload, `api_keys` for all 5, `SUPPORTED_PROVIDERS` gating with normalized `gemini→google`, `fetch_provider_models` dispatch | ✅ |
| `src/utils/config.py:658-710` `Settings.save_yaml` | Did not persist new fields | Persists `observability_enabled`, `background_job_retention_days`, 5× `retention_days_*`, `payload_cap_bytes`, 2× `workflow_max_*` | ✅ |
| Tests `tests/test_provider_model_catalog.py:71-103` | Asserted legacy collapse | Now asserts openai preserved, unknown→base, gemini alias | ✅ intent correct |

### 3.2 Remaining bug — `run_agent_loop` still assumes Google (HIGH)

**File:** `src/agents/base.py:652-682`

```python
# Lines 652-661 — still Gemini-only
model_name = normalize_gemini_model_id(str(model_name or ""))
configured_provider = str(settings.llm_provider or "litellm").strip().lower()
if configured_provider not in {"google", "gemini", "google_genai", "litellm"}:
    logger.warning("Ignoring unsupported LLM provider '%s'; routing through LiteLLM.", configured_provider)
provider = "google_genai"                          # ← hardcoded
model_context_window = resolve_model_context_window(model_name, provider)
…
pricing = resolve_model_pricing(settings, model_name=model_name, provider=provider)
```

Every downstream branch keys on `provider`:

- `provider_cache_active` / `gemini_cached_content_source` docstring says “Gemini-only runtime”
- `context_continuation` thresholds use `model_context_window` derived for Gemini, not for e.g. `claude-opus-4` (200k vs Gemini 1M) — continuation triggers at wrong % and budgets drift.
- `pricing` resolves Gemini pricing for OpenAI models → cost telemetry wrong, `workflow_max_cost_usd` governor mis-fires.
- Span attributes (`llm_retry_scheduled`, `agent_loop_started`) emit `provider: "google_genai"` when the actual LiteLLM call went `anthropic/claude-sonnet-4` — observability lies.

**Why it slipped:** `build_llm` was patched to respect `resolve_agent_model_selection(settings, agent_id)`, but `run_agent_loop` is a *different* entry point (LangGraph `llm_node` / tool loop) that reconstructs its own `provider`. The global `settings.llm_provider` is no longer the per-agent authority; the per-agent `agent_model_config[agent_id].provider` is. `run_agent_loop` never reads it.

**Impact:** For any workflow where the operator sets a non-Google agent (e.g. `classification: openai/gpt-5-mini`), the LLM will *actually* call OpenAI (because `build_llm` is correct), but the surrounding loop will bill it as Gemini, count context against a 1M window instead of 128k/200k, and emit Gemini cache semantics. Cost/cap retention downstream inherits the wrong numbers. Not a crash, but a silent correctness loss that breaks the T30 cost-governor invariant.

**Fix (30 min):**

```python
# In run_agent_loop, after resolving model_name:
selection = resolve_agent_model_selection(settings, run_name)  # or agent_id param
effective_provider = (selection.get("provider") or settings.llm_provider or "google").strip().lower()
if effective_provider in {"gemini", "google_genai"}:
    effective_provider = "google"
# Map to the provider string that utils expect:
provider = {
    "google": "google_genai",
    "openai": "openai",
    "anthropic": "anthropic",
    "openrouter": "openrouter",
    "nvidia": "nvidia",
}.get(effective_provider, "google_genai")
model_context_window = resolve_model_context_window(model_name, provider)
pricing = resolve_model_pricing(settings, model_name=model_name, provider=provider)
# and pass effective_provider into cache-semantics branching
```

Also widen the warning allow-list to `SUPPORTED_PROVIDERS` plus `litellm`, or remove it (LiteLLM already surfaces misconfiguration).

### 3.3 Failing test is a *test* bug, not a code bug (MEDIUM)

**File:** `tests/test_provider_model_catalog.py:94-104`

```python
def test_agent_model_config_survives_every_supported_provider() -> None:
    raw = {agent: {"provider": agent, "model": "any-model"} for agent in SUPPORTED_PROVIDERS}
    # agent ∈ {'google','openai','anthropic','openrouter','nvidia'}
    normalized = normalize_agent_model_config(settings, raw)
    assert {cfg["provider"] for cfg in normalized.values()} == set(SUPPORTED_PROVIDERS)
```

`normalize_agent_model_config` indexes by `normalize_agent_id(raw_agent)` which only accepts `AGENT_MODEL_IDS = (classification, landing, hosting, embedded, orchestrator)`. Provider names are *not* agent ids, so `normalize_agent_id("openai") == ""` → loop `continue` → `normalized` stays at defaults (all google). The test therefore expects 5 distinct providers from 0 valid rows — impossible.

**Correct test:**

```python
def test_agent_model_config_survives_every_supported_provider() -> None:
    settings = Settings()
    settings.llm_provider = "google"
    providers = list(SUPPORTED_PROVIDERS)
    agents = list(AGENT_MODEL_IDS)
    raw = {agent: {"provider": providers[i % len(providers)], "model": "any-model"} for i, agent in enumerate(agents)}
    # or: cycle through all providers across agents and assert each appears at least once
    normalized = normalize_agent_model_config(settings, raw)
    assert {cfg["provider"] for cfg in normalized.values()} <= set(SUPPORTED_PROVIDERS)
    assert len({cfg["provider"] for cfg in normalized.values()}) == min(len(agents), len(providers))
```

The companion test `test_agent_model_config_normalizes_legacy_non_google_provider` *is* correct (it uses real agent keys: `classification`/`orchestrator`/`landing`) and passes — proof the implementation is fine.

**Action:** Rewrite the failing test; do **not** loosen `normalize_agent_id` to accept provider names (that would conflate two namespaces).

### 3.4 Minor provider-model nits (LOW)

- `src/llm/provider.py:62-81` `normalize_model_name`: for `nvidia` models like `meta/llama-3.3-70b-instruct` the name already contains `/` so it passes through bare. LiteLLM's NVIDIA NIM routing expects `nvidia_nim/meta/llama-…` or `nvidia_nim/...`. Whether bare `meta/...` works depends on LiteLLM's model-list resolver — document that operators on NVIDIA should provide the fully-qualified litellm name, or add an explicit `if provider_hint == "nvidia" and "/" in name and not name.startswith("nvidia_nim/"): return f"nvidia_nim/{name}"` branch.

- `src/utils/provider_models.py:801-820` `get_provider_model_catalog`: special-cases `openrouter` to allow live fetch without `api_key` (public endpoint) — correct, but the comment is missing; add a one-liner so the next reader doesn't “fix” it.

- `src/agents/base.py:609-612` `api_base` handling: only `openrouter`/`nvidia` get dedicated base-url overrides; `openai`/`anthropic` fall back to generic `llm_base_url`. If an operator runs a self-hosted OpenAI-compatible gateway, they currently set `LLM_BASE_URL` (which affects Google too) — consider adding `openai_base_url` / `anthropic_base_url` for symmetry, or document the intentional narrowing.

---

## 4 LLM Layer — `src/llm/provider.py` (496 lines)

**Overall: clean.** LiteLLM seam is well-factored.

- Routing (§1 docstring) implemented via `normalize_model_name` → `normalize_model_name(self.model, self.provider_prefix)` in both `LiteLLMProvider.complete` and `ChatLiteLLM._build_request`. Neutral `litellm` hint falls back to `_FAMILY_PREFIX_PATTERNS` (gemini/gpt/o1/o3/claude). Unrecognized names pass through bare — correct “fail loud” behavior.
- Usage buckets (`extract_usage_families`) defensively covers Gemini/OpenAI/Anthropic variants into shared `TokenUsage`; `CacheSemantics` enum exists but is not yet branching in `provider.py` (correct — cost math lives in `instrumentation.py:estimate_usage_cost` with task-11 family rules).
- `normalize_completion_response` handles both dict and object `tool_calls` via `normalize_openai_tool_calls` (graceful `json.loads` with 200-char truncation warning on bad args) — good.
- `ensure_litellm_cache` uses a `threading.Lock` around `litellm.cache` singleton install — correct for the ASGI worker model (multiple event loops share the process-local cache object).
- `ChatLiteLLM._to_chat_result` stamps `response_metadata.model_name` as the *routed* name (`gemini/...`), preserving telemetry shape.

**Findings:**

- **LOW:** `ChatLiteLLM` stores `top_k` / `thinking_budget_tokens` but `LiteLLMProvider` does not — asymmetry is intentional (ChatLiteLLM is the LangChain surface), but document it so a future refactor doesn't unify them and drop `thinking` for LiteLLM direct calls.
- **LOW:** `lc_messages_to_openai_messages` maps any non-system/tool/AI message to `user` — correct for LangChain's `HumanMessage`, but if a future agent emits a new message type (e.g. `FunctionMessage`), it will silently become `user`. Add an explicit `else: payload.append({"role":"user",…})` comment citing the LangChain 0.3 migration.

No race, no secret leak (`api_key`/`api_base` are instance attrs, not logged).

---

## 5 Config — `src/utils/config.py` (766 lines)

**Precedence chain is the best-audited part of the repo (T36) and intact.** `Settings.from_yaml` layers `default < env < base_yaml < runtime_yaml`, blanks in YAML are dropped pre-merge (`is_blank_setting_value`), env mapping uses `AliasChoices` with `populate_by_name=True` so YAML keys work even for fields with env aliases (the classic pydantic-settings footgun fixed). `validate_settings_patch` + `persist_settings_patch` enforce typed PATCH.

**Patch correctness:** `save_yaml` now persists all eight new ops fields (lines 701-710: `observability_enabled`, `background_job_retention_days`, 5× `retention_days_*`, `payload_cap_bytes`, 2× `workflow_max_*`) and respects the T36 blank-guard via `is_blank_setting_value` filter on write — good.

**Finding — ghost `memory_db_path` (MEDIUM):**

- `memory_db_path: str = "data/site_memory.db"` (line 598) is still a declared `Settings` field, still has a default, and will still be written/read via YAML, but **no live code reads it** — `src/memory/long_term.py` and every agent read via `SiteHintRepository` / `write_site_hint` (pgvector). The only reader is `alembic 20260826_0022` legacy import's `Path("data/site_memory.db").exists()` probe, which correctly bails if missing.
- Operator who edits `memory_db_path` in the UI (if exposed) gets a silent no-op. Worse, `data/site_memory.db` lingering on disk implies the old store still exists.
- **Fix:** Mark it deprecated (`deprecated=True` in field description), stop persisting it in `save_yaml`, and add one startup `logger.warning` if the file still exists (“legacy site_memory.db is ignored; data now in site_hints”). Delete the file from `data/` in a follow-up migration/tool. Do not reuse the field name for the pgvector DSN — keep the separation.

**No race.** `Settings.model_fields` iteration in `read_settings_with_sources` is read-only.

---

## 6 RunPools / SSE — `src/agents/pools.py` (560) + `src/api/app.py:2245-2400`

**Pools are the cleanest concurrency in the repo (spike §D1-D6 faithful).**

Correctness invariants verified:

- No `asyncio.gather(return_exceptions=True)` — workers raise, drainer re-raises first error after `cancelled` check (lines 206-212). `except RunCancelledError: raise` precedes `except Exception` in both `_worker_loop` (313-319) and `_process_item` (355-360) — no laundering.
- Queues are unbounded `asyncio.Queue` with bounded `max_parallel_hosting_pages` workers; `pending_items` is an explicit counter because `Queue.qsize` is not portable under `task_done`.
- Triple-condition drain (`producers_done ∧ pending_items == 0 ∧ inflight == 0`, lines 274-288) plus dead-worker escape (`pending_items > 0 ∧ live_workers == 0 → drained.set()` to avoid deadlock) — correct per §D1.
- Sentinel shutdown O(workers) not O(queue): `cancel()`/`request_stop()` put `None` × `live_workers` (246-253, 263-268).
- `seen_urls` dedup across all producers (LANDING → HOSTING frontier → EMBEDDED trigger) at `enqueue` (144-157), `duplicates_suppressed` counted and emitted via `orchestrator_decision`.
- `handoff_state` snapshot (`matches`/`classification`/`url`/`extraction_results` with defaults) passed to `_build_hosting_handoff` / `_build_embedded_handoff` — correct for dynamically discovered targets; the two-thread race test in `storage/test_site_hints.py` analog covers this pattern.
- Registry `register_run_pools` / `unregister_run_pools` (531-540) with `cancel_run_pools` (547-560) doing `asyncio.wait(timeout=10)` + `task.cancel()` for pending workers — correct layer 4 outside task subtree.
- Observability emits (`HOSTING_PAGE_DISCOVERED` on enqueue, `SERVER_ACTIVATED` per server, `STREAM_EXTRACTED` per stream, `hosting_item_started/finished`) use the same `RunObserver` so the existing SSE poll loop picks them up unchanged — T28 contract satisfied.

**Residual nits (LOW):**

- `seen_urls` is a plain `set[str]` mutated from multiple producer/consumer tasks. Under asyncio's single-threaded loop this is safe (no preemption between `if candidate in seen_urls` and `seen_urls.add(candidate)` without an `await`), but if a future refactor moves `enqueue` off-loop (e.g. via `asyncio.to_thread`), it breaks. Add `asyncio.Lock` or document “must be called only from event-loop thread” in `enqueue` docstring.
- `wait_until_drained` surfaces only the first `worker_errors[0]` (line 212) — spec §D5 says “only first worker error surfaces (siblings logged)”. This is *deferred by design* (wave-4 review nit) and acceptable; do not “fix” by aggregating — it would widen the API contract. The `logger.exception` in `_worker_loop` already logs siblings.
- `max_parallel_hosting_pages` is read at worker spawn time only (`ensure_workers`). If the operator changes it mid-run, inflight workers keep the old count — correct for run-scoped settings, but add a comment.

**SSE (`_stream_trace`):**

- Keep-alive `": heartbeat\n\n"` every `_SSE_KEEPALIVE_SECONDS = 20.0` (line 2375) — prevents proxy timeouts.
- Fallbacks: live `run_registry` → `_restore_trace_from_db` → `RunRepository.list_runtime_events` → `BackgroundJobRepository.get_by_run_id` with synthetic `run_plan_created`/`plan_step_update` events — covers pre- and post-persistence windows. `_PLAN_EVENT_KINDS` carrier attaches `RunPlan` snapshot on first tick and on every plan event (2358-2367) — T27 contract.
- Backpressure: `await asyncio.sleep(0.8)` polling interval is generous; DB not hammered (events fetched seq-filtered). `request.is_disconnected()` tear-down at top of loop and in `except` fallback avoids leaking response tasks.
- **MEDIUM nit:** `except Exception as exc` at 2382 swallows decode errors into a synthetic `stream_failed` payload — good for client resilience, but blindly catching `KeyboardInterrupt`/`SystemExit` in an ASGI task group is risky. Narrow to `Exception` explicitly (already is) and verify no `BaseException` leakage — current code is correct at `except Exception`, leave as-is, but add a comment citing the intentional breadth.

---

## 7 Error Handling

- `ProviderModelCatalogError` (provider_models) correctly chains `httpx.HTTPError` / `ValueError` with provider-tagged messages — UI can surface per-provider errors.
- `run_agent_loop` retry helper `_invoke_llm_with_retries` (1004-1082) does exponential backoff (`retry_base * 2**(attempt-1)` capped at `retry_max`) plus server-hinted `_extract_retry_seconds` — correctly distinguishes `_is_retryable_llm_error` vs timeout (always retryable). `llm_turn_timeout_seconds` gate via `asyncio.wait_for` — correctly tears down the awaited `aco` call.
- Agent-level `RunCancelledError` propagation is consistent: `run_agent_loop:1285` raises, `orchestrator:359/2337` re-raises `WorkflowBudgetExceededError` / `WorkflowTimeoutError` without wrapping, `pools:313-316` preserves cancellation.
- **LOW nit:** `observability.py` `pricing` fallback when `resolve_model_pricing` returns `None` is not logged — silent 0-cost estimates. Add a `logger.debug("pricing cache miss for %s", model_name)` so `ui_estimate_costs` 0-values are explainable.

---

## 8 Cost / Cap

- New settings: `workflow_max_cost_usd: float = 0.0` (0 disables) + `workflow_max_tokens: int = 0` (line 573-582) with `AliasChoices WORKFLOW_BUDGET_USD/TOKENS`, persisted via `save_yaml 709-710` and exposed via `provider_config.ui_config_payload 725-736` + `apply_ui_config_update 740-751` (clamped to `max(0.0,…)` / `max(0,…)`).
- App-level plumbing: `POST /runs` `payload.get("max_cost_usd")` → `_background_workflow(run_id, url, max_cost_usd=…)` (692) → `observer.set_max_cost_usd(max_cost_usd)` (1670). Orchestrator reads both budgets via `getattr(settings, "workflow_max_cost_usd", 0.0)` / `getattr(settings, "workflow_max_tokens", 0)` at 483-484 (f-string getattr prevents hard crash on legacy configs).
- **Gap (MEDIUM):** The per-run override `max_cost_usd` and the per-settings `workflow_max_tokens` are supplied to the trace, but there is no `observer.set_max_tokens` call — the token cap is stored only in `settings.workflow_max_tokens` and checked inside the pipeline via `_check_budget`. If a caller wants a per-run token override (mirroring cost), it cannot. Decision: either add `observer.set_max_tokens(max_tokens)` symmetry or document “tokens governor is settings-only.”
- Cost semantics columns (`20260822_0017`) added `cache_write` etc. correctly; `instrumentation.estimate_usage_cost` applies per-family rules (Gemini subset, Anthropic disjoint) — not re-audited here but previously green.

---

## 9 Retention

**Wiring in `src/api/app.py:lifespan` (800-850):**

```python
cleanup = RunRepository(session).cleanup_old_artifacts(
  retention_days=settings.background_job_retention_days,
  days_by_table={
    "runs": settings.retention_days_runs,
    "run_snapshots": settings.retention_days_run_snapshots,
    "llm_calls": settings.retention_days_llm_calls,
    "tool_calls": settings.retention_days_tool_calls,
    "agent_outputs": settings.retention_days_agent_outputs,
  },
)
retention_counts = run_retention_tick(SiteHintRepository(session), session=session)
```

Both run on **startup only** — there is no periodic tick. `TODO(plan-T19-integrate)` still notes this. The wave-4 review approved startup-only for now; the implication is an operator who never restarts the API will accumulate expired hints. **LOW — backlog:** add an `asyncio.create_task` periodic tick (e.g. every 24h) or document as operational manual step.

**`src/storage/repositories.py:609-765` `cleanup_old_artifacts`:**

- Per-family windows via `days_by_table` keyed by short table name — correct, with `+ _threshold(name)` closure per table.
- `pipeline_run.finished_at IS NOT NULL ∧ finished_at < threshold` drives `pipeline_runs`-scoped tables; `RunRecord.created_at < threshold("runs")` drives legacy `runs`. `agent_outputs`/`llm_calls`/`tool_calls` join via `agent_run_ids`.
- Blob GC (704-765): scans **all** blob carrier columns (`run_screenshots.screenshot_url`, `run_snapshots.snapshot_json`, `runtime_events.details_json`, `llm_calls.usage/response_metadata_json`, `tool_calls.details_json`, `agent_outputs.output_json`) via `BLOB_REF_PREFIX` string scan, builds `live_keys`, then deletes `data/blobs/*.blob` whose stem not in `live_keys` — the exact fix for the wave-2 GC-near-miss (NameError swallowed then empty live-set). Wrapped `try/except` so GC never aborts retention.

**Findings (MEDIUM):**

- **Leak:** `pipeline_runs` with `finished_at IS NULL` (i.e. a workflow that crashed before finish/ was orphaned) will **never** be aged out by `cleanup_old_artifacts` because `_old_pipeline_ids` filters `finished_at.isnot(None)`. Orphaned rows + their child `runtime_events` will survive indefinitely. Fix: add an alternate `_old_orphan_ids` using `created_at < threshold("runs")` and `status IN ("running", "queued")` or fold them into the `runs_deleted` pass.
- **Gap:** `memory_db_path` ghost (see §5) means an old `data/site_memory.db` file will survive retention forever (not scanned by blob GC, not deleted by `cleanup_old_artifacts`). Should be explicitly unlinked when `20260826_0022` migration confirms import completed.

Otherwise correct; blob GC deadlock on “all live” vs “all dead” is handled.

---

## 10 Other Files

- **Frontend** not in scope (other inspector), but `docker-compose.yml` cross-container fixes (HOST=0.0.0.0, healthcheck `HOST: 0.0.0.0`) and `web/next.config.mjs` `/api/health → /health` rewrite are correct per `cline-wave-20260831.md` task 1 — no further backend impact.
- `src/utils/config.py:738-766` `save_browser_runtime_bridge` correctly writes `data/browser.runtime.json` with atomic `write_text` and ISO `synced_at`.

---

## 11 Risk Matrix

| ID | Severity | File:Lines | Title | Fix Effort |
|---|---|---|---|---|
| B-1 | HIGH | `src/agents/base.py:652-682` | `run_agent_loop` hardcodes `provider="google_genai"` — breaks pricing/context/caching for every non-Google routed agent | 30 min |
| B-2 | MEDIUM | `tests/test_provider_model_catalog.py:94-104` | Test `survives_every_supported_provider` uses provider names as agent keys — always fails, masks B-1 | 5 min (rewrite test) |
| B-3 | MEDIUM | `src/storage/repositories.py:646-660` | `finished_at IS NULL` pipeline runs never GC'd (orphan leak) | 15 min |
| B-4 | MEDIUM | `src/utils/config.py:598` + `src/memory/legacy_import.py:16` | `memory_db_path` ghost field + on-disk `site_memory.db` never cleaned | 10 min (deprecate + warn) |
| B-5 | MEDIUM | `src/api/app.py:lifespan` | Retention tick startup-only — unbounded hint growth if process never restarts | 1h (periodic task) backlog |
| B-6 | LOW | `src/llm/provider.py:84-96` | NVIDIA `/`-bearing names pass through bare — may miss `nvidia_nim/` prefix | 5 min doc or code |
| B-7 | LOW | `src/agents/pools.py:140-160` | `seen_urls` unsynchronized if ever called off-loop | doc + optional lock |
| B-8 | LOW | `src/utils/provider_models.py:801` | `openrouter` public catalog comment missing | 1 min |

No **CRITICAL** (no secrets leak, no data loss, pools correctly cancel).

---

## 12 Recommendations (ordered)

1. **Fix B-1 now** (blocks correct cost governance): wire `run_agent_loop` to `resolve_agent_model_selection` as in §3.2 patch sketch; extend warning allow-list; re-derive `model_context_window` + `pricing` from the effective provider; propagate `effective_provider` into `provider_cache_active` branching.
2. **Rewrite B-2** in the same PR so CI goes green; do not revert `normalize_agent_model_config` — the implementation is correct.
3. **B-3 + B-4** in the same hardening pass: add orphan-GC path to `cleanup_old_artifacts` and deprecate `memory_db_path` (warn + skip persist).
4. **B-5** backlog with an ADR note: periodic `run_retention_tick` every 24h behind a `settings.background_job_retention_days` flag, or document “restart the API daily.”
5. Keep `cline-raw-20260831.jsonl` as audit evidence; re-run `cline --json` after B-1 lands to confirm no new Cline findings.

---

## 13 Checklist — What Was Inspected

- [x] `src/api/app.py` — lifespan retention + blob GC, SSE (`_stream_trace` + `StreamingResponse`), cost plumbing (`set_max_cost_usd`, `estimate_usage_cost`), provider gating (`_pricing_sync_provider_ids`, `_provider_api_key_available`, `/blobs/{key}` 410), error handling (`GeneratorExit`/`CancelledError`/`BrokenPipeError` suppress)
- [x] `src/agents/base.py` — `build_llm` multi-provider routing (GOOD), `run_agent_loop` provider hardcode (BUG B-1), continuation / retry / budget helpers, cancellation propagation
- [x] `src/agents/pools.py` — full D1-D6 compliance, no `return_exceptions`, layered cancellation, triple-condition drain
- [x] `src/agents/orchestrator.py` (sampled) — RunPools wiring, `workflow_max_*` governor, plan carrier, restart sweep
- [x] `src/llm/provider.py` — `normalize_model_name` routing, `extract_usage_families`, family-neutral `LlmResponse`, litellm cache, `ChatLiteLLM` LangChain seam
- [x] `src/utils/config.py` — T36 precedence chain, new ops fields, `save_yaml`/`from_yaml`, ghost `memory_db_path` (B-4)
- [x] `src/utils/provider_models.py` — `PROVIDER_METADATA`/`SUPPORTED_PROVIDERS`/`FALLBACK_MODELS` expansion, `normalize_agent_model_config` fix, `fetch_provider_models` dispatch, `get_provider_model_catalog` fallback, `_request_json` httpx
- [x] Tests — `tests/test_provider_model_catalog.py` (1 failure analyzed)
- [x] Alembic — `alembic.ini` + `env.py` + `versions/` chain (linear, single head)
- [x] `grep site_memory.db` — 6 legacy hits, no live SQLite store
- [x] `pytest -q` tail — reproduced with exit code, single failure isolated

---

## 14 Raw Command Outputs (for ledger audit)

```text
# git diff HEAD --stat
 data/browser.runtime.json            |  6 +--
 docker-compose.yml                   | 24 +++++++-----
 src/agents/base.py                   | 60 ++++++++++++++++++-----------
 src/api/app.py                       | 28 +++++++++-----
 src/api/provider_config.py           | 75 +++++++++++++++++++++++++++++++++---
 src/utils/config.py                  | 10 +++++
 src/utils/provider_models.py         | 74 ++++++++++++++++++++++++++++++++---
 tests/test_provider_model_catalog.py | 26 +++++++++++--
 web/next.config.mjs                  | 14 +++++++
 9 files changed, 259 insertions(+), 58 deletions(-)

# grep -r --include="*.py" site_memory.db src/
src/memory/legacy_import.py:  ``data/site_memory.db`` (SQLite ``site_memory_entries`` …
src/memory/legacy_import.py:  DEFAULT_LEGACY_DB_PATH = "data/site_memory.db"
src/memory/long_term.py:      legacy ``site_memory.db`` SQLite store …
src/memory/long_term.py:          db_path: str = "data/site_memory.db",
src/memory/site_hint_writer.py: Phase-2 scope deliberately NOT here: deleting site_memory.db …
src/storage/models.py:        Plan task 18 phase 1: replaces the legacy ``site_memory.db`` …
src/utils/config.py:          memory_db_path: str = "data/site_memory.db"

# alembic heads
alembic/versions/c69a9ee239fd → 20260822_0017 → 0018 → 0019 → 0020 → 0021 → 0022 → 0023 (head)

# pytest tail (full)
1 failed, ~680 passed (see §2.2 for exact assertion + warnings)
Failed test: tests/test_provider_model_catalog.py::test_agent_model_config_survives_every_supported_provider
AssertionError: assert {'google'} == {'anthropic','google','nvidia','openai','openrouter'}
```
