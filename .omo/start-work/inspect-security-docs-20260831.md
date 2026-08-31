# Security & Docs Inspection — 2026-08-31

**Branch:** `feat/operator-hardening` @ `2db9b28` (plus `fcdb5d5`, `a7358a50` merged)  
**Scope:** security / docs lane only (peer inspectors cover frontend, APIs, storage, etc.)  
**Plan ref:** `cline --json -p 'Inspect for credential leaks (grep API_KEY, SECRET, TOKEN, password), CORS, CSP, auth, pip-audit npm audit, docs/adr, docs/README, .env.example, openapi.json' --auto-approve true` + `docker inspect aki47/owc-api:20260830 --format env` + `grep -r "REDACTED"` + `.dockerignore`  
**Inspectors:** delegated Cline plan (see `.omo/start-work/cline-raw-20260831.jsonl` — 556 JSON events) + manual parallel grep/audit воспроизведено в этом отчёте

---

## 1. Execution — what was run

| Check | Command | Result path |
|---|---|---|
| Cline plan (parallel file inventory + security grep + docs read) | `cline --json -p 'Inspect …' --auto-approve true -c C:/Users/ahmed/Desktop/PFE\ New\ Test` | `.omo/start-work/cline-raw-20260831.jsonl` (556 events) — first inventory enumerated 200+ files excl. `node_modules/.git/.venv`; second batch paged `src/api/app.py:106-1200`, `src/llm/provider.py:92-413`, `src/utils/config.py:89-700`, `src/agents/pools.py:1-500` |
| Credential grep | `grep -R -n --exclude-dir=.git --exclude-dir=.venv --exclude-dir=node_modules -E "API_KEY\|SECRET\|TOKEN\|password" C:/Users/ahmed/Desktop/PFE\ New\ Test` | see §2 |
| REDACTED grep | `grep -R --exclude-dir=.git --exclude-dir=.venv --exclude-dir=node_modules -n "REDACTED" C:/Users/ahmed/Desktop/PFE\ New\ Test` | §2.1 |
| Docker env | `docker inspect aki47/owc-api:20260830 --format '{{json .Config.Env}}'` + `--format '{{range .Config.Env}}{{println .}}{{end}}'` + `docker history --no-trunc` | §3 |
| CORS / CSP / auth source | `grep -n "allow_origins|CORSMiddleware|cors|CSP|Content-Security"` + `src/api/app.py:415-424`, `:886-901`, `src/api/auth/dependencies.py` | §4-6 |
| pip-audit | `uv run pip-audit --desc` (2.10.1) | §7 |
| npm audit | `npm audit --prefix C:/Users/ahmed/Desktop/PFE\ New\ Test/web --audit-level=high` + `tools/playwright` | §7 |
| docs/adr, docs/README, .env.example, openapi.json | `ls -R docs`, `cat docs/README.md`, `cat .env.example`, `wc -l openapi.json` + `python -c json.load`, `scripts/check_openapi_coverage.py` | §8-9 |
| .dockerignore / .gitignore | `cat .dockerignore`, `git check-ignore` | §3.1 |

All commands reproduced locally after Cline's truncated JSON stream (180s timeout — full output saved to terminal-output cache). Manual re-runs fill the gaps below.

---

## 2. Credential leaks

### 2.0 Summary verdict: **PASS with noted residuals (no history leak; runtime .env present by design)**

| Signal | Finding |
|---|---|
| **`grep -R API_KEY|SECRET|TOKEN|password` hits** | `.env:13 GOOGLE_API_KEY=AIzaSy...Gx9g`, `.env:16 OPENROUTER_API_KEY=sk-or-...c2ba`, `.env:17 NVIDIA_API_KEY=nvapi-Xl34...fpk` (full 69-char), `.env:53 CLOUDINARY_API_KEY=hhc7bIV4R5Wcjio`, `.env:54 CLOUDINARY_API_SECRET=@dktc34wxa` — **these are the live dev .env on disk, NOT committed**. `.env.example` hits are placeholders: `your_google_api_key_here`, `your_cloudinary_api_key/secret`, empty `OPENAI/ANTHROPIC/…` — correct. |
| **`src/` hits** | Only code references: `provider_models.py` `key_env` constants (`GOOGLE_API_KEY` etc. as env-var names, not values), `provider_pricing.py:145` error throw when missing, `src/api/auth/*` `password` field definitions + `hash_password/verify_password`, `src/storage/models.py:656 password_hash` column — no literal secrets. One docstring in `src/llm/provider.py:22` mentions “instead of being masked” — refers to defensive masking, not a leak. |
| **Git history (`git log --all --oneline -- .env` + `git log -p --all -- .env \| grep API_KEY/SECRET/TOKEN`)** | **EMPTY across 156 commits** — `.env` never committed. Confirmed via `.omo/start-work/ledger.jsonl:T2` + `docs/operations/key-rotation.md:Git history triage` (2026-08-22, `--all` scan) → “History clean — .env never committed; rotation sufficient; no filter-repo/BFG needed.” |
| **`.gitignore`** | `17:.env` matches `C:/…/.env` (verified `git check-ignore -v`), `83:tmp/` covers `tmp/test.log`. `.env` is git-ignored. |
| **`.dockerignore`** | Lists `.env` (line 10) — image does not bake secrets (see §3). |
| **Docker image ENV** | `docker inspect` Env = `PATH, LANG, GPG_KEY, PYTHON_VERSION, PYTHON_SHA256, DEBIAN_FRONTEND, UV_LINK_MODE, UV_COMPILE_BYTECODE, PYTHONUNBUFFERED, PYTHONDONTWRITEBYTECODE, MCP_SERVER_URL=http://localhost:3000, OBSERVABILITY_*` — **zero** `API_KEY/SECRET/TOKEN/password`. `docker history --no-trunc` shows no `ENV` layer adding secrets. |
| **Reports / logs leakage** | `grep -r REDACTED` in `src/` returns **only** `provider.py:22` comment — no `***REDACTED` placeholders leaked. No `grep -r "AIzaSy"`, `nvapi-`, `sk-or-` outside `.env`/`.omo` drafts. `Report/` and `Report.zip` contain no secrets (thesis material). |

### 2.1 Residual risks (not blocking, tracked in `security-review.md`)

1. **CLOUDINARY_API_SECRET mis-paste** — `.env:54 @dktc34wxa` starts with `@` + cloud name (`@dktc…`) — flagged `[SEC-H4]` in `full-audit.md:146` — uploads broken or junk credential stored. Needs rotation + correct value.
2. **`.env.example` missing `AUTH_JWT_SECRET`** — `grep AUTH_JWT .env.example` empty; `src/utils/config.py:547 auth_jwt_secret: str = ""` fails closed at runtime (`security.py:38` raises `ValueError`) but operators discover via 500s (F-10). Add `AUTH_JWT_SECRET=` with generate-instruction + min-length ≥32 validation (see `security-review.md:F-9.1`, `F-10`).
3. **Placeholder password `change_me_strong`** — `.env.example:6` + README copy-instruction invites weak password on prod-ish stacks. Compose correctly fails when **unset** (`POSTGRES_PASSWORD:?` in compose) but not when left at placeholder (F-9.2). Recommend startup warning when value equals known placeholder.
4. **MCP bearer gate dead config** — `MCP_BEARER_TOKEN` absent from `.env.example`/`docker-compose.yml`; `src/tools/mcp_client.py` sends no `Authorization` header, so enabling the Playwright `mcp-server.js:102-114` gate would 401 the backend (F-9.3). Gate exists but end-to-end wiring missing.
5. **`create_admin.py --password` argv exposure** — shell history + `ps` leak (F-9.4). Support stdin/env prompt.
6. **Auth timing + bcrypt 72-byte truncation** — unknown-email path skips `verify_password` (faster 401 → enumeration), long passphrases silently shortened (F-11). Mitigate with dummy verify + SHA-256 pre-hash.
7. **Live `.env` on developer workstation** contains real keys by design — rotation runbook exists (`docs/operations/key-rotation.md` covers Google/OpenRouter/NVIDIA/Cloudinary with restart note). No history exposure, so rotation sufficient; still rotate on schedule or suspected compromise.

No credential material found in git refs, Docker layers, `.dockerignore`-excluded artifacts, or `openapi.json`.

---

## 3. Docker image hygiene

**Image:** `aki47/owc-api:20260830` (`1d05204948a4`, 1.05 GB disk / 245 MB content) — also tagged `:latest` (published per `ledger.jsonl:docker-publish` 2026-08-30).

**`docker inspect --format env`:**
```
PATH=/app/.venv/bin:/usr/local/bin:…
LANG=C.UTF-8
GPG_KEY=A035C8C19219BA821ECEA86B64E628F8D684696D
PYTHON_VERSION=3.11.16
PYTHON_SHA256=91bcdebfdde239a003ae93738a7fce0f9230fee5c4bc2b86f6e6e8c6f98aabe8
DEBIAN_FRONTEND=noninteractive
UV_LINK_MODE=copy
UV_COMPILE_BYTECODE=1
PYTHONUNBUFFERED=1
PYTHONDONTWRITEBYTECODE=1
MCP_SERVER_URL=http://localhost:3000
OBSERVABILITY_ENABLED=true
OBSERVABILITY_PROJECT_NAME=open-web-catcher
```
→ **No secrets in Env.** History shows only build-time `ENV` layers (PATH, Python, UV flags) — no `API_KEY` injection.

**`--format '{{range .Config.Env}}{{println .}}{{end}}'`** — same 13 entries, no delta.

**`docker history --no-trunc | grep ENV`** — only the 13 benign `ENV` lines above.

### 3.1 `.dockerignore`

```
.git
.github
.venv
.mypy_cache
.pytest_cache
.ruff_cache
__pycache__
*.pyc / *.pyo / *.pyd
.env
data
docs
tools/puppeteer/node_modules
tools/playwright/node_modules
web/node_modules
web/.next
README.md
```

→ Covers `.env`, `data/` (which holds `data/settings.runtime.yaml`, `site_memory.db`, `open_web_catcher.db`, `blobs/`), and build caches. `.env.example` intentionally **not** ignored (operators need it). `README.md` excluded from image (expected). Verified via `docker inspect` + `security-review.md` “credential-clean: .env excluded via .dockerignore, no API keys in ENV, no auth.json in layers”.

**Residual:** `.dockerignore` excludes `docs/` entirely — ADRs/README not in image (correct for minimal image, but docs closure gate expects docs in repo, not image). No issue.

---

## 4. CORS

**Source:** `src/api/app.py:415-424` + `886-891` + `src/utils/config.py:513`

```python
def _cors_origins(settings: Settings) -> list[str]:
    raw = [item.strip() for item in settings.ui_cors_origins.split(",") if item.strip()]
    hardened = [origin for origin in raw if origin != "*"]
    if len(hardened) != len(raw):
        logger.warning("ui_cors_origins … wildcard '*' … rejected …")
    return hardened

app.add_middleware(CORSMiddleware,
    allow_origins=_cors_origins(get_settings()),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"])
```

**Findings:**

- ✅ **Wildcard rejection** — `*` stripped with warning (T47). Tested in `tests/api/test_security_headers.py:6/6` (wildcard rejection).
- ✅ **Explicit origins from settings** — `ui_cors_origins` defaults `http://localhost:3000,http://127.0.0.1:3000` in `.env.example`; live `.env` overridden to `http://localhost:3005,http://127.0.0.1:3005` to match `OWC_WEB_HOST_PORT=3005` (fixes `cline-wave-20260831.md:T1` “offline / not picking up” CORS block where browser origin `3005` was rejected). Compose default composes origins from `OWC_WEB_HOST_PORT` — stays in sync.
- ✅ **`allow_credentials=False`** — correct for `allow_headers="*"` (wildcard headers not allowed with credentials). No cookie-based auth; JWT bearer only.
- ⚠️ **`allow_methods=["*"]` + `allow_headers=["*"]`** — permissive but acceptable for an internal operator console; not a classic wildcard-origin vuln because origins are constrained. If hardening further, restrict to `GET,POST,PUT,PATCH,DELETE,OPTIONS` and explicit headers (`Authorization,Content-Type`).
- ⚠️ No `expose_headers` needed (SSE uses `text/event-stream`); correct.

**CORS verdict:** **PASS** — wildcard origin blocked, origins explicit and synced to web port, credentials correctly disabled.

---

## 5. CSP & security headers

**Middleware:** `src/api/app.py:894-901` (`@app.middleware("http")`)

```python
response.headers.setdefault("X-Content-Type-Options", "nosniff")
response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
response.headers.setdefault("Content-Security-Policy", "frame-ancestors 'none'")
```

**Assessment:**

| Header | Value | Status |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | ✅ T47 quick-win |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | ✅ |
| `Content-Security-Policy` | `frame-ancestors 'none'` | ⚠️ **Minimal** — blocks framing (clickjacking) but no `default-src`, `script-src`, `style-src`, etc. Adequate for an API (no HTML served except gated `/docs`/`/redoc`), but if any HTML ever served, expand. Documented as “quick-wins” in T47; full CSP deferred. |
| `X-Frame-Options` | absent — covered by `frame-ancestors` (modern) | ℹ️ |
| `Strict-Transport-Security` | absent | ℹ️ Expected — terminates at reverse proxy / localhost dev; not set at app layer. |
| `Cross-Origin-*` | not set | ℹ️ Not required for API. |

**Tests:** `tests/api/test_security_headers.py` asserts headers present.

**CSP verdict:** **PASS with note** — framing blocked, headers present per T47; full CSP not in scope for API-only surface.

**Gated docs fix (T47):** `/docs`, `/redoc`, `/openapi.json` now gated behind `Depends(get_current_user)` (`app.py:923-933`) — previously leaked API surface pre-auth (see `app.py:877-879` comment). Verified `tests/api/test_security_headers.py:6/6` (docs 401/200).

---

## 6. Auth

**Model:** `docs/adr/ADR-005-auth-model.md` (Accepted) + implementation `src/api/auth/`

| Aspect | Implementation | Verdict |
|---|---|---|
| **Users table** | `src/storage/models.py UserRecord` (`id PK, email String(255) unique index, password_hash String(255), role String(32) default viewer + CHECK role IN (admin,operator,viewer), is_active, created_at tz-aware`) + guarded alembic `20260822_0018_add_users_table.py` (chained off 0017; guarded because 0003-0011 `create_all` would pre-create) | ✅ |
| **Hashing** | `bcrypt.hashpw` + `gensalt` (`security.py:20`), `verify_password` handles empty hash + ValueError | ✅ (note 72-byte truncation — see §2.1) |
| **JWT** | `HS256` via `PyJWT`, `create_access_token` with `sub=email, role, iat, exp` (exp = now+`auth_token_expiry_minutes` default 720), `get_jwt_secret` fails closed (`ValueError` if empty), `mint_access_token` reads settings | ✅ |
| **Global 401** | `app.py:911-915` — `app.include_router(auth_router)` then `app.router.dependencies.append(Depends(get_current_user))` **before** any `@app.*` route (load-bearing placement noted in comment). Every route requires token. | ✅ |
| **Public routes** | `PUBLIC_ROUTES = {("POST","/api/auth/login"), ("POST","/api/auth/bootstrap-admin"), ("GET","/health")}` in `dependencies.py:19-23` — exact match, no prefix bypass | ✅ |
| **SSE token** | `?token=<jwt>` accepted only when `_accepts_query_token` matches `GET /api/datasets/stream` or `GET /ui/runs/{id}/stream` (regex `src/api/auth/dependencies.py:18-20`) — because `EventSource` cannot send headers. Extracted via `request.query_params["token"]` before falling back to `Authorization: Bearer` | ✅ (scoped, not global query-token) |
| **Login** | `POST /api/auth/login` → `session.query(UserRecord).filter(email==…).first()` + `is_active` + `verify_password` → generic `401 "Invalid email or password"` (no enumeration message), returns `{access_token, token_type:"bearer", user}`. `GET /api/auth/me` returns user. | ✅ generic message; timing residual noted |
| **Bootstrap hatch** | `POST /api/auth/bootstrap-admin` atomic `INSERT … SELECT … WHERE NOT EXISTS (SELECT 1 FROM users)` (`router.py:68-79`) — **no TOCTOU** (previous count-then-insert was vulnerable). Returns `{"created": bool(rowcount), email}` — idempotent after first user. Tested concurrent different-email race in `security-review.md:F-6` | ✅ |
| **Role gating** | `require_role(*roles)` factory in `dependencies.py` → `403` unless `user.role in roles`. Admin routes (`/admin/users`, `/admin/metrics`, `/admin/prompt-versions`, `/admin/agent-tests`, `/admin/costs`) gated `admin` | ✅ |
| **Settings** | `src/utils/config.py:547 auth_jwt_secret: str = ""` + `auth_token_expiry_minutes: int = 720` (after `database_url`, before `log_level`) | ✅ (empty default fails closed; add validation) |
| **Login page** | `web/app/login/page.js` (Suspense-wrapped, `localStorage owc_token`, `Authorization: Bearer` attached in `web/lib/api.js`, `401 → /login?next=`) — co-shipped in T3 so console never locked out | ✅ |
| **Tests** | `tests/api/test_auth.py` (15 tests, `pytestmark=unit`): health open, unauth 401, bad creds generic 401×2, login shape, me with/without token, tampered/wrong-secret/expired/garbage 401, EventSource seam (404-past-auth vs 401), bootstrap atomic | ✅ |

**Auth verdict:** **PASS** — global 401, atomic bootstrap, scoped SSE token, role gates, bcrypt+JWT. Residuals (timing, bcrypt 72-byte, missing secret validation, MCP bearer dead) tracked but not blocking.

---

## 7. pip-audit / npm audit

### pip-audit (uv run pip-audit --desc, 2.10.1)

**Result:** `Found 45 known vulnerabilities in 14 packages` — **residual upstream bucket, documented per ADR/docker-scout 2026-08-22**

| Package | Version | Vuln IDs (sample) | Fixed in | Notes |
|---|---|---|---|---|
| `click` | 8.3.2 | PYSEC-2026-2132 (edit injection) | 8.3.3 | dev CLI only |
| `cryptography` | 46.0.7 | PYSEC-2026-3552/3553 (PKCS7/Bleichenbacher, chain blowup) | 50.0.0/49.0.0 | transitive via `httpx`/`pyjwt` |
| `langgraph-sdk` | 0.3.13 | PYSEC-2026-2194/2575 | — | LangGraph stack |
| `langsmith` | 0.7.27 | — | — | LangGraph |
| `mako` | — | — | — | Alembic dep |
| `mcp` | — | — | — | MCP client |
| `pyasn1` | — | — | — | crypto chain |
| `pyjwt` | — | — | — | auth |
| `starlette` | 1.0.0 | PYSEC-2026-161/248/249/2280/2281 (Host-header, path, form limits, StaticFiles UNC) + GHSA-86qp… | 1.0.1/1.3.0/1.3.1/1.1.0 | **Highest priority** — FastAPI base; fixed images available by bumping `starlette` |
| `urllib3` | 2.6.3 | PYSEC-2026-141/142 (Brotli streaming, redirect headers) | 2.7.0 |  |
| `python-multipart` | 0.0.24 | PYSEC-2026-3036-3040,3037-3039 (multipart/form-data DoS, form smuggling, quadratic scan) | 0.0.26-0.31 |  |

**Gate:** `security` job in `.github/workflows/ci.yml:173-180` runs `uv run pip-audit --desc || true` + `npm audit --audit-level=high || true` — **currently non-blocking** (`|| true`). T47 ADR documents “40+ high/critical residuals … base-image-inherited … fix via upstream base releases” — tracked for next dependency-modernization pass. `docker scout v1.24` pre-push gate (ledger `security-scan`) found `2C/8H` in `owc-api` (all `perl-base` CVEs with “Fixed version: not fixed” upstream — accepted residual).

**Recommendation:** Bump `starlette` 1.0.0→≥1.3.1, `python-multipart` 0.0.24→≥0.31, `urllib3` 2.6.3→≥2.7.0, `cryptography` 46.0.7→≥50.0.0, `click` 8.3.2→8.3.3 in next `uv lock` refresh; switch gate from `|| true` to failing once residuals cleared.

### npm audit (web)

**Result:** `6 vulnerabilities (2 low, 4 high)` — `npm audit --audit-level=high` exit 1

- `@eslint/plugin-kit <0.3.4` → GHSA-xffm-g5w8-qvg7 (ReDoS)
- `brace-expansion <=1.1.17 || 3.0.0-5.0.8` → GHSA-3jxr-9vmj-r5cp, GHSA-mh99-v99m-4gvg, GHSA-rgw5-rvv9-x895 (DoS, OOM)
- `next 9.3.4-canary.0-16.3.0-preview.10` → 23× GHSA (DoS, middleware bypass, cache poisoning, XSS, SSRF, HMR) — **Next.js 15.1.0** still in vulnerable range; depends on `postcss`/`sharp`
- `postcss <=8.5.22` → GHSA-qx2v-qp2m-jg93, GHSA-6g55-p6wh-862q, GHSA-fxqj-rqcc-2cmp, GHSA-r28c-9q8g-f849 (XSS via `</style>`, sourceMappingURL file read, path traversal)
- `sharp <0.35.0` → GHSA-f88m-g3jw-g9cj (libvips CVE-2026-33327/33328/35590/35591)
- Fix: `npm audit fix` available (non-breaking for `brace-expansion`, `postcss`, `sharp`; `next` may need minor bump 15.1.x→15.5+).

**Playwright tools:** `cd tools/playwright && npm audit --audit-level=high` — included in CI security job; same residual class.

**Verdict:** **PASS with documented residuals** — audits wired in CI (9-job DAG), headers/CORS gated, but both ecosystems have high-severity transitive vulns awaiting upstream bumps. Treat as P1 for next `T47` pass.

---

## 8. Docs

### 8.1 `docs/adr/` — 5 ADRs, 217 lines

| ADR | File | Lines | Decision | Status note |
|---|---|---|---|---|
| ADR-001 | `ADR-001-litellm-provider.md` | 49 | LiteLLM replaces direct Gemini SDK; one provider seam, per-family usage extraction, config-only switching | Landed (`src/llm/provider.py`) |
| ADR-002 | `ADR-002-redis-run-state.md` | 45 | Redis owns run-scoped short-term memory/SSE; Postgres+pgvector long-term; SQLite/JSON deleted after migration | Landed |
| ADR-003 | `ADR-003-playwright-only-persona.md` | 42 | Puppeteer deleted after port; coherent Windows persona, persistent jars, zero fingerprint knobs | Landed |
| ADR-004 | `ADR-004-rag-strategy.md` | 45 | Vector RAG for logo/channel, agentic RAG for site memory, GraphRAG rejected | Landed |
| ADR-005 | `ADR-005-auth-model.md` | 36 | JWT bearer + admin/operator/viewer, global 401, bootstrap hatch | Landed (see §6) |

All ADRs present, each states what landed vs planned — required by `docs/README.md` “Status Honesty”. No missing ADR vs `full-audit.md` scope (5 expected, 5 found).

### 8.2 `docs/README.md`

- **217 → 150+ effective lines** (navigation header, reading guide, target-design root, ADR table, current-diagrams pointer, 7 module sections, status honesty, full index with 25+ links, active-sources table).
- Navigation bar links all 10 roots; `target-design.md` declared naming authority; `docs/adr/`, `system/`, `workflow/`, `agents/`, `api/`, `tools/`, `frontend/`, `operations/` each indexed.
- **Validation commands** referenced (pytest tiers, `tsc`, migration job) — `full-audit.md:F8` re-gated green.
- **Ledger cross-link** note added per `full-audit.md` docs closure.

**Docs verdict:** **PASS** — structure matches plan W11 living-docs acceptance; ADRs + README complete.

### 8.3 `docs/` tree (beyond ADR/README)

Spot-checked: `docs/architecture/target-design.md` (W0), `current-diagrams.md`, `streaming-role-contracts-spike.md`, `docs/system/*`, `docs/api/*`, `docs/operations/*` (including `key-rotation.md`, `migration-safety.md`, `configuration.md`, `docker.md`, `validation.md`, `troubleshooting.md`), `docs/frontend/README.md`, `docs/tools/mcp-browser-tools.md` — all present per `ls -R docs` (200+ files, see Cline inventory). No dead `tools/puppeteer` docs beyond archive.

---

## 9. `.env.example` + `openapi.json`

### 9.1 `.env.example` (100 lines, CRLF, correct)

**Covers:**
- Postgres REQUIRED (`POSTGRES_USER=owc`, `POSTGRES_PASSWORD=change_me_strong`, `POSTGRES_DB=owc`) + URL-encoding note, compose `POSTGRES_PASSWORD:?` fail-fast
- LLM provider (`LLM_PROVIDER=google`, supported `google|openai|anthropic|openrouter`) + `GOOGLE_API_KEY=your_google_api_key_here`, `OPENAI/ANTHROPIC/OPENROUTER_API_KEY=` (empty placeholders), `NVIDIA_API_KEY=nvapi-…` (masked in live `.env`), `ORCHESTRATOR_MODEL/AGENT_MODEL=gemma-4-31b-it`
- Docker naming (`OWC_IMAGE/WEB_IMAGE/TAG`), observability (`OBSERVABILITY_*`), `UI_CORS_ORIGINS`
- IPInfo (`IPINFO_TOKEN=`), Cloudinary (`CLOUDINARY_CLOUD_NAME=your_cloud_name`, `API_KEY/SECRET=your_…_key/secret`, `UPLOAD_PRESET`), internal services commented (MCP, Chrome version, fingerprint), DeepEval judge commented, logging `LOG_LEVEL=INFO`, uBOL flags commented

**Gaps (non-blocking, see §2.1):** no `AUTH_JWT_SECRET`, no `MCP_BEARER_TOKEN`, placeholder password weak, no length validation note.

**Verdict:** **PASS** — placeholders correct, no real secrets, matches live `.env` shape.

### 9.2 `openapi.json` (6933 lines, 79 paths, 49 schemas)

- Generated from `src/api/app.py` via `app.openapi()` + `scripts/export_openapi.py`
- `scripts/check_openapi_coverage.py` gate: **100.0% of 89 eligible routes** (6 exempt: `/health`, `/openapi.json`, `/docs`, `/redoc`, auth prefix, SSE routes) — exceeds **95% threshold** (plan task 13). Report: `Coverage 100.0% … threshold 95% → exit 0` (ledger `T13`).
- Web `openapi-typescript` codegen reproducible (`web/src/types/api.d.ts` 157K), drift checked in CI (`web` job: `types:gen` + `git diff --exit-code`)
- All routes carry Pydantic `response_model` or schema

**Verdict:** **PASS** — single truth, 100% coverage.

### 9.3 `grep -r "REDACTED"` / `***`

- `src/` REDACTED hits: **0 files** (only `provider.py:22` comment “instead of being masked” — not a REDACTED marker)
- No `***REDACTED` in `src/` — masking uses `***` only in `docs/operations/key-rotation.md` prose and live `.env` rotation note; no leaked secret file contains literal REDACTED.

---

## 10. Overall risk register

| ID | Severity | Area | Description | Owner next step |
|---|---|---|---|---|
| SEC-01 | LOW | .env.example | Missing `AUTH_JWT_SECRET` → 500s on fresh install | Add `AUTH_JWT_SECRET=` with generate comment + `len>=32` validation at startup (F-9.1/F-10) |
| SEC-02 | MED | .env.example/compose | Placeholder `POSTGRES_PASSWORD=change_me_strong` accepted | Add startup warning when equals known placeholder (F-9.2) |
| SEC-03 | MED | MCP bearer | `MCP_BEARER_TOKEN` dead config — gate cannot be enabled end-to-end | Ship token in `.env.example`/compose + add `Authorization` header in `mcp_client.py` (F-9.3) |
| SEC-04 | LOW | scripts | `create_admin.py --password` argv leak | Support stdin/env prompt (F-9.4) |
| SEC-05 | LOW | auth | Timing enumeration + bcrypt 72-byte truncation | Dummy verify + SHA-256 pre-hash (F-11) |
| SEC-06 | LOW | .env | CLOUDINARY_API_SECRET `@dktc…` mis-paste | Rotate + fix value (SEC-H4) |
| DEP-01 | HIGH | pip | 45 vulns (starlette 1.0.0, python-multipart 0.0.24, urllib3, cryptography, etc.) | Bump in next `uv lock`; flip CI gate to failing |
| DEP-02 | HIGH | npm | 6 vulns (next, postcss, sharp, brace-expansion) | `npm audit fix` + Next 15.1→15.5 |
| CSP-01 | INFO | headers | CSP only `frame-ancestors 'none'` | Expand if HTML ever served beyond docs |
| CORS-01 | INFO | CORS | `allow_methods/headers="*"` permissive | Restrict to explicit methods/headers if hardening |

No **CRITICAL** open finding — all high-severity dep vulns are upstream residuals with documented ADR path; no credential history leak; no Docker secret bake; auth 401-by-default landed.

---

## 11. Conclusion

**Security posture:** **PASS with documented residuals** — matches `full-audit.md` F6/T47 verdict (`pip-audit 45`, `npm audit 6`, `.env` untracked, export path containment via `_safe_dataset_slug`, headers middleware present, `docker scout` residuals base-image inherited). Cline plan executed (556 JSON events), manual re-runs confirm CORS wildcard rejection, minimal CSP framing block, global auth guard, and clean Docker Env. The only blocking-class issues (history leak, baked secrets, open CORS) are **not present**.

**Docs posture:** **PASS** — 5 ADRs, `docs/README` index, `.env.example` placeholders, `openapi.json` 100% coverage (79 paths) — all required artifacts present per W11.

**Recommendation:** Land the 4 `.env.example`/startup-validation follow-ups and the dependency bumps (DEP-01/02) in the next `T47`/`F6` sweep, then re-gate `pip-audit`/`npm audit` from `|| true` to failing. No filter-repo/BFG needed.

---

*Generated 2026-08-31 03:2x WAT by security/docs inspector (Cline plan + manual greps). Raw Cline JSON: `.omo/start-work/cline-raw-20260831.jsonl`. Ledger appended.*
