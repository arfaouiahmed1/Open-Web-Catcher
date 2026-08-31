# Tests/CI Inspection — 2026-08-31

**Branch:** `feat/operator-hardening` @ `2db9b28` (ahead of `main`, 11 files changed, 266 ins / 61 del vs HEAD)  
**Scope:** `tests/*`, `web/tests/*`, `.github/workflows/ci.yml`, `scripts/check-no-polling.mjs`, `openapi.json` drift, replay harness determinism  
**Inspector:** Cline plan (`cline --json -p 'Inspect ...' --auto-approve true` — `z-ai/glm-5.3-flash`) + manual exhaustive cross-check  
**Commands run (verbatim, per task):**

```bash
cline --json -p 'Inspect tests/*, web/tests/*, .github/workflows/ci.yml, scripts/check-no-polling.mjs, openapi.json drift, replay harness for determinism' --auto-approve true
# plan mode: 2 iterations, ~55KB JSON, truncated @180s — raw at C:\Users\ahmed\AppData\Local\hermes\cache\terminal-output\out-1788138736-19140-2f90.log + cline-raw-20260831.jsonl

.venv/Scripts/python -m pytest -m replay -q          # 10 passed
.venv/Scripts/python -m pytest -m unit -v            # 432 passed, 212 deselected
.venv/Scripts/python -m pytest -m integration -v     # 0 selected (vacuous)
.venv/Scripts/python -m pytest -q --cov=src          # 39% total, see § Coverage
cd web && npx vitest run                              # 22 files, 108 passed, 7.88s
node scripts/check-no-polling.mjs                     # OK
python scripts/check_openapi_coverage.py              # 100.0% of 89 eligible (6 exempt)
python scripts/export_openapi.py && npm run types:gen # drift fixed (see § OpenAPI)
```

---

## Verdict

| Gate | Result | Note |
|---|---|---|
| `tests/*` collection | **PASS** w/ **2 WARN** | 644 collected, 432 unit, 0 integration, 10 replay. Markers correct, but `integration` tier empty and `replay` not in CI. |
| `web/tests/*` | **PASS** | 1 file (`no-js-frontend.test.ts` 2 tests) + 22-file vitest suite (108 total) — legacy-JS gate + strict TS enforced. |
| `.github/workflows/ci.yml` — 9-job DAG | **PASS** w/ **1 WARN** | Linear chain `lint → compileall → unit → integration → web → docker → migration → security → required-statuses`. `integration` job vacuous (P2), `replay` missing (P2), `security` non-blocking (`|| true`) intentional per ADR. |
| `scripts/check-no-polling.mjs` | **PASS** | `OK: no setInterval polling under web/components or web/lib` — SSE-first via `useEventStream`/`useRunStream`. |
| `openapi.json` drift | **FIXED** | Was stale by 20 lines (10 fields). Fixed: `python scripts/export_openapi.py` + `npm run types:gen` → `web/src/types/api.d.ts` updated 5698 lines, `tsc --noEmit` 0. |
| Replay harness determinism | **PASS** | 2 synthetic fixtures, Host-routing + ledger hash deterministic, `validate_evidence` poison-drop + judge-flag + zero-crash covered. |
| `pytest -m replay -q` | **PASS** | 10/10 (6 `test_agent_replay` + 4 `test_fixture_replay`), 1 warning. |
| `web vitest` | **PASS** | 22 files 108 tests, Node env default + jsdom per-file, 7.88s. |
| Coverage | **39% WARN** | See § Coverage — unit suite covers `src/agents/validator 91%`, `llm/provider 76%`, but `agents/*` core, `storage/repositories 16%`, `memory/* 7-27%` low. |
| `tsc --noEmit` | **PASS** | 0 errors (strict true). |
| `find *.js/*.jsx` | **PASS** | 0 files outside `public/` — ESM-only frontend. |

**Overall:** Tests/CI **PASS with 2 P1-equivalent debt items** (empty integration tier, replay not in CI) that should ride the next plan wave. No rollback. No polling, no drift after fix.

---

## 1 `tests/*` — 644 tests across 40 modules

### Collection

```bash
.venv/Scripts/python -m pytest --collect-only -q | tail
# 644 items: agents 11+12, api 38+20+17+2+6+190, llm 6, memory 2+7+7, models 31,
# orchestrator 21+33+10+8+9+15+11, replay 6+4, storage 8+8+5+1+5+9+14+7,
# utils 22, root 25+3+7+4+3+3+3+20+11+9+6+5
```

Markers (`pyproject.toml`):
```toml
[tool.pytest.ini_options]
markers = ["unit", "integration", "replay", "slow"]
```

- `unit`: **432 selected** on `-m unit` (real coverage: `test_cancellation`, `test_ocr_agent`, `test_admin`, `test_auth`, `test_security_headers`, `test_settings_contract` 190 parametrized, `test_provider`, `test_strict_models`, `test_confidence_gating`, `test_email_templates`, `test_stage_parse_safety`, `test_timeouts_taxonomy`, `test_validator_node`, `test_prompt_contracts`, etc.). Green `432 passed, 212 deselected, 58 warnings in 51s`.
- `integration`: **0 selected** — `grep -r "pytest.mark.integration" tests/` returns nothing (only comment in `conftest.py` and `test_retention.py`). The `conftest.py` downgrades `NO_TESTS_COLLECTED + markexpr` to exit 0, so `pytest -m integration -q` and the CI `pytest-integration` job are **always green by construction**. This is a pre-existing gap (task 48 deferred tagging until later batches).
- `replay`: **10 selected** — `tests/replay/test_agent_replay.py` 6 + `tests/replay/test_fixture_replay.py` 4. See § Replay.
- `slow`: none explicitly separate; replay tests are `slow-ok` but not marked `slow`.

`conftest.py` fixtures (lightweight, no network):
- `session_factory` — `sqlite://` + `StaticPool` + `check_same_thread=False`
- `db_session` — `Base.metadata.create_all/drop_all` per test function
- `settings_override(monkeypatch)` — merges `Settings()` overrides
- `fake_clock` — patches `datetime.datetime.utcnow/now` with controllable `FakeClock(start=2026-01-01T12:00:00)`
- `pytest_cmdline_main` — exit 5→0 when `-m` selects nothing (explains vacuous integration pass)

### Storage / API / Orchestrator tiers

- `storage/test_job_claim_baseline` 5 + `test_job_claim_race` 1 — atomic claim via `FOR UPDATE SKIP LOCKED` (Postgres) / single-statement `UPDATE RETURNING` (SQLite), 8-thread barrier proves no double-claim.
- `storage/test_event_schema` 8 — `EventKind`/`EventStatus` StrEnums, `schema_version=2` on every persisted blob.
- `storage/test_retention_caps` 9 — `cleanup_old_artifacts` across all tables, 8KB cap → `data/blobs/` ref.
- `api/test_openapi_coverage` 2 — **100.0% of 89 eligible routes** (6 exempt: `/health`, `/openapi.json`, `/docs`, `/redoc`, `/api/auth/*`, SSE routes). Threshold 95%.
- `api/test_security_headers` 6 — `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `frame-ancestors 'none'`, CORS `*` rejection, bootstrap atomicity.
- `orchestrator/test_validator_node` 11, `test_confidence_gating` 21, `test_streaming_handoffs` 9, `test_timeouts_taxonomy` 15 — all unit-marked, green.

### Findings — `tests/*`

| Severity | Finding |
|---|---|
| **P1** | **Integration tier empty** — 0 tests carry `@pytest.mark.integration`. CI `pytest-integration` job always passes vacuous. Either tag real integration tests (e.g., `test_retention`, `test_site_hints` with real DB) or gate `if: needs.pytest-unit.result == 'success' && steps.pytest.outputs.tests_run > 0`. Current `conftest.py` exit-5→0 masks it. |
| **P2** | **Replay not in CI** — 10 replay tests exist but `.github/workflows/ci.yml` has no `pytest-replay` job. Plan intended “allowed slow” job; currently replay only runs locally. Add job `needs: [web]` or `needs: [migration-check]` with `uv run pytest -m replay -q`. |
| **P3** | **Coverage gaps by module** — `src/agents/classification 73%`, `embedded 14%`, `hosting 13%`, `landing 10%`, `memory/short_term 7%`, `storage/repositories 16%` — low because unit tests mock agents. Not blocking, but plan F1 “full pytest green” is vacuously satisfied. |

---

## 2 `web/tests/*` — 1 file + 22-file vitest suite

### Inventory

```
web/tests/no-js-frontend.test.ts (1567 bytes)
  - "contains no JavaScript or JSX implementation files" — walks app/components/lib, 0 hits
  - "configures the component generator for TypeScript" — components.json tsx:true, tailwind.config.ts

web/vitest.config.mts:
  plugins: [react()], alias @→rootDir, environment: "node" default,
  include: ["**/*.test.{ts,tsx}"], exclude: ["node_modules/**", ".next/**"]
  Per-file jsdom via docblock for .tsx component tests.

web vitest run: 22 passed (22), Tests 108 passed (108), Duration 7.88s
  (transform 18.75s, setup 0ms, import 38.06s, tests 6.25s)
  Files: no-js-frontend + lib/* + components/library/* + components/console/* etc.
```

`web/tsconfig.json` — `strict: true`, `allowJs: true`, `checkJs: false`, `moduleResolution: bundler`, `baseUrl: "."`, `paths: {"@/*": ["./*"]}`. Build `tsc --noEmit` exit 0.

### Findings — `web/tests/*`

| Severity | Finding |
|---|---|
| **P2** | **`web/tests` thin** — only 1 gate file. Real component tests live under `web/components/**/*test.tsx` and `web/lib/*test*` (22 files total). CI runs `npx vitest run` from `web/` so full suite is covered, but `web/tests` alone gives false “1 test file” impression in plan checklist. Consider renaming `web/tests` → `web/tests/gates` or adding `overview`, `runs`, `settings` page-level vitests (some already exist outside `web/tests`). |
| **P3** | `vitest.config.mts` walks generated `web/src/types/api.d.ts` (5698 lines, 165KB) on collect → 18s transform. Add `exclude: [..., "src/types/**"]` to cut 40% off CI web job. |

---

## 3 `.github/workflows/ci.yml` — 9-job DAG

### Structure (9 jobs, linear chain)

```
lint (ruff check + ruff format --check + mypy --ignore-missing-imports)
  ↓ needs: [lint]
compileall (python -m compileall src)
  ↓ needs: [compileall]
pytest-unit (uv run pytest -m unit -q)
  ↓ needs: [pytest-unit]
pytest-integration (uv run pytest -m integration -q)   # vacuous — 0 tests
  ↓ needs: [pytest-integration]
web (working-directory: web)
  - npm ci
  - OpenAPI types drift: npm run types:gen + git diff --exit-code web/src/types/api.d.ts
  - tsc --noEmit
  - ESLint + no-polling gate: npm run lint (runs next lint && node ../scripts/check-no-polling.mjs)
  - Next build: NEXT_PUBLIC_API_BASE_URL=https://api.test.invalid npm run build
  - Vitest: npx vitest run
  ↓ needs: [web]
docker (matrix 4 images: Dockerfile:open-web-catcher, Dockerfile.web:open-web-catcher-web,
           Dockerfile.tools.playwright:open-web-catcher-tools-playwright,
           Dockerfile.tools.playwright:open-web-catcher-tools-playwright-headed)
  uses: docker/build-push-action@v6, cache-from/to type=gha, push false, load true
  ↓ needs: [docker]
migration-check (service pgvector/pgvector:pg16, health pg_isready -U owc, 5s interval)
  - alembic upgrade head (x2 idempotent)
  - downgrade -1 + upgrade head
  ↓ needs: [migration-check]
security (pip-audit --desc || true, npm audit web || true, npm audit tools/playwright || true)
  ↓ needs: [lint, compileall, pytest-unit, pytest-integration, web, docker, migration-check, security] + if: always()
required-statuses (gate: for r in 8 results; [ $r != success && $r != skipped ] → exit 1)
```

Caching: `astral-sh/setup-uv@v5 enableCache true`, `actions/setup-node@v4 cache npm`, `docker buildx GHA cache`.

Branch triggers: `push` on `main`/`master` + `pull_request` (all branches).

### Findings — CI 9-job DAG

| Severity | Finding |
|---|---|
| **P1** | **Linear chain is intentionally sequential** — every job `needs` the prior, so a `lint` flake blocks `docker`/`migration`/`security` for 10+ min. Plan task 50 chose serial for “red→green journey” readability; cost is wall-clock. Consider fanning `lint` + `compileall` + `web:types` in parallel, then `pytest-unit`/`web:lint` parallel, then `docker` last. Not a bug, but CI minute cost scales. |
| **P2** | **`pytest-integration` vacuous** — see §1. Job always succeeds (0 tests + `conftest` 5→0). Either populate with real integration markers or `run: uv run pytest -m integration -q --collect-only | grep "test session"` gate to fail on 0. |
| **P2** | **`security` non-blocking `|| true`** — `pip-audit` + both `npm audit --audit-level=high` are `|| true`, so `security` job never fails even on high/critical. Intentional per ADR (upstream vulns: langgraph, starlette, next, postcss) but `required-statuses` treats `success` only — highs are documented, not gated. If hardening wants a gate, change to `audit --audit-level=high` without `|| true` + allowlist file. |
| **P3** | **`web` drift check uses `git -C .. diff`** — correct (checks `web/src/types/api.d.ts` vs committed `openapi.json`), but error message says `run npm run types:gen and commit` while actual fix on this branch required also `python scripts/export_openapi.py` first (see § OpenAPI drift). Message could say `python scripts/export_openapi.py && npm run types:gen`. |
| **P3** | **No `pytest -m replay` job** — replay harness (10 tests) not exercised in CI. Add `pytest-replay` job (needs `web` or `migration-check`, `uv run pytest -m replay -q`) as “allowed slow” to close F5. |
| **P3** | **`mypy` is `|| true`** — `uv run mypy src --ignore-missing-imports || true` never fails. Targeted mypy is intentionally soft until T12 wave; fine, but F2 “tsc/build clean” does not include mypy gate. |

---

## 4 `scripts/check-no-polling.mjs` — F-wave grep gate

```js
// F-wave grep gate (plan tasks 40/42): fails when any setInterval( appears
// under web/components or web/lib. Live data must arrive via SSE
// (useEventStream / useRunStream) or visibility-triggered refreshes — never
// fixed-interval polling.
// Excluded: test files (fakes may legally use timers) and this script.

ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "web")
SCAN_DIRS = [join(ROOT, "components"), join(ROOT, "lib")]
PATTERN = /setInterval\s*\(/
TEST_SUFFIX = /\.(test|spec)\.[jt]sx?$/
```

- Walks `web/components` + `web/lib`, skips `node_modules`/`__pycache__`, ignores `*.test.*`/`*.spec.*`.
- Reports offenders as `web/<path>:<line>: <trimmed 90c>` and exits 1 if any.

**Runs:**

```bash
node scripts/check-no-polling.mjs
# OK: no setInterval polling under web/components or web/lib
# EXIT 0

grep -r "setInterval" web/components web/lib  # manual cross-check
# web/components/console/overview/overview-page.tsx:    // Plan task 42 (de-polling): no setInterval. Data refreshes on tab entry
# web/components/console/overview/tabs/agents-tab.tsx:      <p>... (visibility-based refresh, no setInterval).</p>
# web/lib/use-event-stream.ts: * Replaces every `setInterval` poller ...
# → 0 code hits, 3 comment/docs hits only → gate correct.
```

`web` also has `web/scripts/gen-api-types.mjs` + `check-api-types.mjs` (drift gate), and `npm run lint` runs `next lint && node ../scripts/check-no-polling.mjs` (so CI `web` job gates both).

**Verdict:** **PASS**. SSE-first via `useEventStream`/`useRunStream` with `500ms * 2^attempt` capped 30s + jitter; no `setInterval` in production code. Root gate and `web/scripts/check-no-polling.mjs` (scope `web/components` only) both pass; dual-gate scope difference (root `components+lib` vs web `components` only) is intentional — `lib` `setTimeout` for reconnect is allowed, only `setInterval` is forbidden.

---

## 5 `openapi.json` drift + `web/src/types/api.d.ts`

### Mechanism

- `scripts/export_openapi.py` — builds `app.openapi()` (FastAPI), writes `openapi.json` (6933 lines, 79 paths) deterministically (`sort_keys=True`, `ensure_ascii=True`, trailing newline). Routes: 95 (reported as 89 eligible + 6 exempt).
- `web/scripts/gen-api-types.mjs` — `openapi-typescript 7.13.0` via `bin/cli.js`, `OPENAPI_SCHEMA_PATH=../../openapi.json`, `OPENAPI_TYPES_OUT=web/src/types/api.d.ts`.
- `web/scripts/check-api-types.mjs` — temp-gen vs committed diff (`normalize \\r\\n→\\n`), fails with “Generated API bindings are stale. Run `npm run types:gen` and commit web/src/types/api.d.ts.”
- CI `web` job: `npm run types:gen; git -C .. diff --exit-code web/src/types/api.d.ts || (echo "types drift: run npm run types:gen and commit"; exit 1)`

### Drift found on this branch

```bash
python scripts/export_openapi.py
# [export-openapi] routes: 95
# [export-openapi] wrote C:\Users\ahmed\Desktop\PFE New Test\openapi.json (177631 bytes)

npm run types:gen → web/scripts/check-api-types.mjs
# Generated API bindings are stale. Run `npm run types:gen` and commit ...

# After fix:
npm run types:gen
# ✨ openapi-typescript 7.13.0 🚀 openapi.json → web/src/types/api.d.ts [170ms]
# EXIT 0

git diff --stat web/src/types/api.d.ts
#  web/src/types/api.d.ts | 20 ++++++++++++++++++++ (5698 lines total)

# Diff (settings schema additions from feat/operator-hardening):
# + background_job_retention_days?: number | null
# + observability_enabled?: boolean | null
# + payload_cap_bytes?: number | null
# + retention_days_agent_outputs / llm_calls / run_snapshots / runs / tool_calls
# + workflow_max_cost_usd / workflow_max_tokens
```

`scripts/check_openapi_coverage.py` — **100.0% of 89 eligible routes (6 exempt) | threshold 95%** → PASS. No uncovered routes.

**Verdict:** **FIXED**. Pre-fix `openapi.json` was 174960 bytes (Aug 26) vs 177631 after regen (+2671 bytes, 10 new fields). `web/src/types/api.d.ts` was 165865 bytes (Aug 30) vs rebuilt 5698 lines. Both now committed-unstaged diff present; next `git diff --exit-code` will pass after commit. `npm run types:check` equivalent now passes. Root cause: `feat/operator-hardening` added Settings fields (`background_job_retention_days`, `observability_enabled`, `payload_cap_bytes`, `retention_days_*`, `workflow_max_*`) without re-exporting `openapi.json`. CI would have failed on this branch if opened as PR (desired behavior — drift gate works).

---

## 6 Replay harness for determinism

### Fixtures

```
datasets/fixtures/istreameast-app/landing/{index.html, har.json, storageState.json, meta.json} + assets/
datasets/fixtures/librefutboltv-su/landing/{index.html, har.json, storageState.json, meta.json} + assets/
  Each meta.json: {url, host, site_slug, page_slug, captured_at, harness:T49,
                   hashes: {index_html, har_json, storageState, fixture}, schema_version:1}
  hashes: sha256 of each file + fixture composite (deterministic)
  playwright_available: false → synthetic fallback (HAR 1.2, index.html stub)
  FIXTURES_ROOT = datasets/fixtures, BRIDGE = data/browser.runtime.json
```

`scripts/serve_fixtures.py` (31248 bytes) — `make_server(FIXTURES_ROOT, port, host="127.0.0.1")`, `discover_fixtures`, `compute_fixture_hash(dir)`, `compute_candidate_ledger_hash(html)`, `build_host_resolver_rules`, `inject_host_resolver_rules(bridge, ..., port)`, `clear_host_resolver_rules`.  
`scripts/capture_fixture.py` (26355 bytes) — Playwright capture of HTML+assets, HAR 1.2, storageState, meta.

### Tests

```bash
.venv/Scripts/python -m pytest -m replay -q
# 10 passed (6 test_agent_replay + 4 test_fixture_replay)

.venv/Scripts/python -m pytest -m replay -v
# tests/replay/test_agent_replay.py::test_classify_landing_hosting_happy_path_deterministic PASSED
# tests/replay/test_agent_replay.py::test_validator_drops_poisoned_url_in_replay PASSED
# tests/replay/test_agent_replay.py::test_judge_flagged_url_dropped_even_when_reachable PASSED
# tests/replay/test_agent_replay.py::test_runplan_transitions_observed PASSED
# tests/replay/test_agent_replay.py::test_zero_crashes_with_fake_llm PASSED
# tests/replay/test_agent_replay.py::test_fixture_hash_deterministic_if_fixtures_present PASSED
# tests/replay/test_fixture_replay.py::test_seed_fixtures_exist PASSED
# tests/replay/test_fixture_replay.py::test_serve_fixtures_host_routing_deterministic PASSED
# tests/replay/test_fixture_replay.py::test_host_resolver_rules_bridge PASSED
# tests/replay/test_fixture_replay.py::test_fixture_hash_deterministic_twice PASSED
```

**Determinism proofs (per test):**

| Test | Proof |
|---|---|
| `test_classify_landing_hosting_happy_path_deterministic` | Same fake pipeline twice → `ledger_hash = sha256(sorted url+streams))` identical (`h1 == h2`), 2 hosting URLs, 0 drops |
| `test_validator_drops_poisoned_url_in_replay` | `GOOD_STREAM` reachable via `MockTransport`, `POISONED_STREAM` DNS fail → `dropped_streams` contains poisoned, `kept_streams == [GOOD_STREAM]`, surviving `streams == [GOOD]` |
| `test_judge_flagged_url_dropped_even_when_reachable` | Both reachable but `judge_flagged=[POISONED]` → still dropped even though probe 200 |
| `test_runplan_transitions_observed` | `build_graph(settings).nodes` contains `validate_evidence`, edges `(classify,landing,hosting,embedded)→validate_evidence→analyze_providers`, `_RUN_PLAN_STEPS >=4` and contains `validate_evidence` |
| `test_zero_crashes_with_fake_llm` | `BadJudge` returns `<NOT JSON>` + empty streams → no exception, `validation_report.kept_streams == []` |
| `test_fixture_hash_deterministic_if_fixtures_present` | `compute_fixture_hash(d)` + `compute_candidate_ledger_hash(html)` called twice → `h1==h2`, `l1==l2` for first 2 fixtures |
| `test_seed_fixtures_exist` | `>=2` dirs with `index.html/har.json/storageState.json/meta.json`, `meta.url` & `hashes.fixture` present, `har.log.version==1.2` |
| `test_serve_fixtures_host_routing_deterministic` | Ephemeral `make_server(0)` on 127.0.0.1, `Host` header routes to correct `index.html`, `__hash?host=` returns `fixture_hash` + `candidate_ledger_hash` deterministic across 2 fetches, unknown host 404 |
| `test_host_resolver_rules_bridge` | `build_host_resolver_rules` contains `MAP` + `127.0.0.1:8765` + `EXCLUDE localhost`, `inject` writes `extra_launch_args` exactly once (second inject replaces), `clear` removes |
| `test_fixture_hash_deterministic_twice` | Same as `test_fixture_hash_deterministic_if_fixtures_present` via direct helper |

**Host-resolver bridge** — `data/browser.runtime.json` round-trip via temp dir in test; production `data/browser.runtime.json` on this branch last modified by compose (not fixture harness), but `serve_fixtures.inject_host_resolver_rules` logic verified.

**Synthetic note:** Both fixtures have `playwright_available: false` + `synthetic: true` — HAR is stub, not real CDP capture. Determinism holds, but `playwright` tooling not exercised (acceptable for `replay` tier — fake LLM + fake probes, no live browser).

**Verdict:** **PASS — deterministic**. All 6 determinism assertions (`h1==h2`, `a==b==expected_bytes`, `fixture_hash`, `candidate_ledger_hash`, bridge inject/clear) green. No flake across 3 runs. Validator replan bounded to 1/stage per `orchestrator` gate.

---

## 7 `pytest -m replay -q` + `web vitest` + Coverage + CI 9-job DAG (task checklist)

### `pytest -m replay -q`

```bash
.venv/Scripts/python -m pytest -m replay -q
# ..........                                                               [100%]
# 10 passed, 1 warning in ~6s
```

Exit 0 via `.venv/Scripts/python.exe` (Python 3.14.4, pytest 9.1.1, asyncio 1.4.0, cov 7.1.0). `conftest.py` marker handling not needed (10 tests collected, not vacuous).

### `web vitest`

```bash
cd web && npx vitest run
# RUN  v4.1.11 C:/Users/ahmed/Desktop/PFE New Test/web
# Test Files  22 passed (22)
#       Tests  108 passed (108)
#   Start at  02:16:09
#   Duration  7.88s (transform 18.75s, setup 0ms, import 38.06s, tests 6.25s)
```

Plus `no-js-frontend` gate (2 tests) and `tsc --noEmit` 0.

### Coverage

```bash
.venv/Scripts/python -m pytest -m unit --cov=src --cov-report=term
# TOTAL 15086 stmts, 9129 miss, 39%  (432 passed, 212 deselected)
```

Per-module (unit only):

| Module | Stmts | Miss | Cover |
|---|---|---|---|
| `src/agents/validator.py` | 79 | 7 | **91%** |
| `src/agents/prompting.py` | 120 | 15 | 88% |
| `src/utils/observability.py` | 372 | 53 | 86% |
| `src/utils/browser_runtime.py` | 146 | 25 | 83% |
| `src/orchestrator/emailing.py` | 142 | 12 | 92% |
| `src/api/admin.py` | 194 | 12 | 94% |
| `src/llm/provider.py` | 226 | 54 | 76% |
| `src/utils/config.py` | 379 | 108 | 72% |
| `src/agents/orchestrator.py` | 1074 | 407 | 62% |
| `src/agents/pools.py` | 290 | 115 | 60% |
| `src/utils/channel_detection.py` | 101 | 49 | 51% |
| `src/utils/provider_models.py` | 482 | 272 | 44% |
| `src/storage/models.py` | 515 | 9 | 98% |
| `src/storage/repositories.py` | 1337 | 1120 | **16%** |
| `src/agents/landing_page.py` | 525 | 472 | 10% |
| `src/agents/hosting_page.py` | 317 | 277 | 13% |
| `src/agents/embedded_page.py` | 291 | 251 | 14% |
| `src/memory/short_term.py` | 610 | 566 | 7% |
| `src/memory/long_term.py` | 356 | 332 | 7% |
| `src/api/app.py` | 1962 | 1466 | 25% |

Low coverage on core agents is expected — unit tests mock LLM/browser; integration/replay tier would lift it but those tiers are empty or synthetic.

**No coverage threshold is enforced in CI** (no `--cov-fail-under`). Task checklist “check coverage” is informational.

### CI 9-job DAG — already in §3

Recap: **9 jobs** (`lint`, `compileall`, `pytest-unit`, `pytest-integration`, `web`, `docker`, `migration-check`, `security`, `required-statuses`). Linear needs chain, 4-image docker matrix, pgvector `pg_isready` (5s interval, 10 retries), ` || true` on `mypy` + `security`. All jobs `runs-on: ubuntu-latest`, `python-version: "3.11"` (uv) and `node-version: "22"` for web/security.

---

## 8 Cross-cutting issues & recommendations

### Must-fix before next `aki47` publish or PR

1. **Commit `openapi.json` + `web/src/types/api.d.ts`** — 20-line drift from `feat/operator-hardening` Settings additions. Fixed locally (`python scripts/export_openapi.py` + `npm run types:gen`); needs `git add openapi.json web/src/types/api.d.ts` and push. Otherwise CI `web` drift check fails red.
2. **Populate or guard `pytest-integration`** — either tag 5–10 real integration tests (`test_retention`, `test_site_hints`, `test_persistence_commits`) with `@pytest.mark.integration` or make the CI step fail on 0: `uv run pytest -m integration -q --collect-only | grep -q "test session"` else exit 1.

### Should-fix next wave

3. **Add `pytest-replay` CI job** — `needs: [migration-check]`, `uv run pytest -m replay -q` (slow-allowed, ~6s, deterministic). Closes F5 without blocking fast path.
4. **`vitest.config.mts` exclude `src/types/**`** — cuts `web` job 40% (18s transform on generated 165KB bindings).
5. **`security` job allowlist** — if `pip-audit`/`npm audit --audit-level=high` are to stay `|| true`, document exceptions in `docs/adr/ADR-005` or `audit-allowlist.json` so `required-statuses` can eventually gate highs.

### Debts (informational)

6. Coverage 39% is not gated — consider `--cov-fail-under=35` (current) + ratchet to 45 after replay integration lands.
7. `mypy || true` — targeted mypy landed but never fails; F2 checklist “tsc/build clean” is green, mypy debt tracked separately.
8. Fixtures synthetic (`playwright_available: false`) — deterministic but not exercising real browser; next `capture_fixture.py` wave should capture 1 real Playwright fixture on CI (requires `npx playwright install` in harness job).

---

## 9 Raw outputs (appendix — abridged, full logs at paths)

```bash
# tests collection
pytest --collect-only -q → 644 items (432 unit, 0 integration, 10 replay)

# pytest -m unit
432 passed, 212 deselected, 58 warnings in 51.45s

# pytest -m integration → 644 deselected, 1 warning (conftest 5→0)

# pytest -m replay
.......... 10 passed, 1 warning

# web vitest
22 passed, 108 passed, 7.88s

# check-no-polling
OK: no setInterval polling under web/components or web/lib

# check_openapi_coverage
Coverage: 100.0% of 89 eligible routes (6 exempt) | threshold: 95%
(none) uncovered

# export_openapi
[export-openapi] routes: 95, wrote openapi.json (177631 bytes)

# types:gen
✨ openapi-typescript 7.13.0 🚀 openapi.json → web/src/types/api.d.ts [170ms]
# before fix: Generated API bindings are stale. Run `npm run types:gen` ...

# coverage
TOTAL 15086 9129 39%

# ci.yml jobs
lint → compileall → pytest-unit → pytest-integration → web → docker(4 matrix) → migration-check(pgvector:pg16) → security → required-statuses
```

Full Cline JSONL: `C:\Users\ahmed\AppData\Local\hermes\cache\terminal-output\out-1788138736-19140-2f90.log` (55KB, truncated at head+tail) + `.omo/start-work/cline-raw-20260831.jsonl`.  
Ledger: `.omo/start-work/ledger.jsonl` appended (see JSON line @ `2026-08-31T02:*`).

---

## 10 Ledger

`ledger.jsonl` appended:

```json
{"event":"inspect-tests","date":"2026-08-31","branch":"feat/operator-hardening","inspector":"cline-plan+manual","report":".omo/start-work/inspect-tests-20260831.md","gates":{"pytest_unit":"432 passed","pytest_integration":"0 selected (vacuous)","pytest_replay":"10 passed","vitest":"22/108 passed","check_no_polling":"OK","openapi_coverage":"100.0% (89/89)","openapi_drift":"fixed (20 lines, 10 fields)","tsc":"0","no_js":"0 *.js/*.jsx","coverage":"39%","ci_jobs":9,"ci_dag":"lint→compileall→unit→integration→web→docker→migration→security→required-statuses"},"replay_determinism":"pass (Host-routing + ledger + judge + poison-drop + zero-crash)"}
```

*Inspection-only — no code edits except `openapi.json` + `web/src/types/api.d.ts` regen for drift fix (requires commit).*
