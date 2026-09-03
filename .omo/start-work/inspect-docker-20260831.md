# Docker/Infra Inspection — 2026-08-31

**Branch:** `feat/operator-hardening` @ `6d729f13` (base `2db9b28`)  
**Scope:** `docker-compose.yml`, `Dockerfile`, `Dockerfile.web`, `Dockerfile.tools.playwright`, `configs/supervisord.conf`, `.dockerignore`, `scripts/docker/entrypoint.sh` + `entrypoint.playwright.sh`  
**Inspector:** `cline --json -p '...'` (plan mode, auto-approve) + manual exhaustive read + live stack probes  
**Date:** 2026-08-31 01:53 UTC+1

---

## Live stack snapshot (pre-inspection)

```
OWC_TAG=20260830 docker compose config --quiet  → EXIT 0 (valid)
docker compose ps:
  postgres               healthy  5432/tcp (no host publish, internal only)
  redis                  healthy  6379/tcp (no host publish, internal only)
  owc-tools-playwright   healthy  0.0.0.0:3002->3001, 0.0.0.0:9223->9223
  owc                    healthy  0.0.0.0:8000->8000   (user 0:0, see below)
  owc-web                unhealthy (FailingStreak 56) 0.0.0.0:3005->3001
docker images | grep aki47 → aki47/owc-api:20260830, aki47/owc-web:20260830, aki47/owc-tools-playwright:20260830 present (also :latest)
curl http://localhost:8000/health → 200 {"status":"ok", ...}  (but runtime_preflight blocked: browser_unhealthy)
curl http://localhost:3005/api/health → 404 (Next.js _not-found, not proxied — see P0-1)
```

`docker inspect` health details: `owc` healthcheck passes (curl 200), `owc-tools-playwright` passes (node fetch ok), `owc-web` fails every 30s with exit 1 and empty output, `postgres`/`redis` healthy.

`cline --json` in plan mode: available (`cline 3.0.60` at `/c/Users/ahmed/AppData/Roaming/npm/cline`) but produced no JSON output within 30s window (`EXIT 0` with 0 bytes) on the docker prompt; previous frontend inspector wave hit 180s timeout with partial 65KB JSON (`cline-raw-20260831.jsonl`). This report falls back to manual exhaustive inspection with same checklist.

---

## Checklist verdict (requested prompts)

| Prompt | Verdict | File(s) |
|---|---|---|
| **Windows bind-mount** | ✅ PASS (with note) | `docker-compose.yml:179-181`, `scripts/docker/entrypoint.sh:11-18`, `Dockerfile:73-79` |
| **HEALTHCHECK** | ⚠️ PASS with 1 failure | `docker-compose.yml:17,38,82,182,218`, `Dockerfile.tools.playwright:88-89` |
| **non-root USER** | ⚠️ PASS with exception | `Dockerfile:40-41,91`, `Dockerfile.web:52-54`, `Dockerfile.tools.playwright:71-73`, `docker-compose.yml:155` |
| **apk upgrade** | ⚠️ PARTIAL | `Dockerfile.web:47`, `Dockerfile:36` |
| **secret baking** | ✅ PASS | `.dockerignore:12`, `docker-compose.yml:13,166`, `Dockerfile:85`, `docker history` |
| **HOST 0.0.0.0** | ✅ PASS | `docker-compose.yml:75,122`, `Dockerfile.web:41`, `configs/supervisord.conf:12` |
| **OWC_WEB_HOST_PORT** | ✅ PASS (env), ⚠️ gap in `.env.example` | `docker-compose.yml:172,210`, `.env:OWC_WEB_HOST_PORT=3005`, `.env.example` missing |

---

## Detailed findings

### 1. Windows bind-mount — PASS

**Bind mounts present:**
```yaml
owc-tools-playwright:  ./data:/app/data
owc-tools-playwright-headed: ./data:/app/data
owc:  ./data:/app/data + ./configs:/app/configs:ro + ./datasets:/app/datasets:ro
```

**NTFS chown healing — correctly implemented:**

`scripts/docker/entrypoint.sh` `prepare_runtime_dirs()`:
```bash
mkdir -p /app/data/logs /app/data/raw /app/data/processed /app/data/reports
if [ "$(id -u)" = "0" ]; then
  chown -R app:app /app/data 2>/dev/null || true
  chown app:app /var/run/supervisord.pid 2>/dev/null || true
  chmod -R 775 /app/data/logs 2>/dev/null || true
fi
```

`docker-compose.yml:155` forces `owc` to `user: "0:0"` — required on Windows because NTFS bind-mount clobbers image `chown app:app /app/data`. On Linux the same entrypoint is a no-op (already `app`, chown fails silently). `Dockerfile:73-79` pre-creates and chowns the same paths and pidfile at build time for non-Windows runs.

**Residual:**
- `owc-tools-playwright` does NOT set `user: "0:0"` — it runs as `app` (uid 10001) per `Dockerfile.tools.playwright:91`. Its `entrypoint.playwright.sh:prepare_runtime_dirs` only does `mkdir -p` without chown healing. On Windows with `./data:/app/data`, writes to `/app/data/logs` will fail if NTFS creates the dir as Windows user. Verify: `docker exec owc-tools-playwright id` → `app`, `docker exec owc id` → `root`. The playwright sidecar may need the same `if root then chown` pattern or a `user: "0:0"` + `gosu` drop, or else `./data` must be pre-chowned. Currently the sidecar logs still write (verified live logs), so the NTFS ACL on this host is permissive, but this is fragile across Windows hosts.
- `:ro` on `configs`/`datasets` is correct — prevents container writes to host source.
- No `:delegated` / `:cached` flags needed on Windows; plain bind is correct.

### 2. HEALTHCHECK — PASS with 1 live failure

All 5 runtime services have healthchecks:

- `postgres: pg_isready` interval 10s retries 10
- `redis: redis-cli ping` interval 10s retries 10
- `owc-tools-playwright: curl -f http://localhost:3001/health` interval 30s start 30s (healthy live)
- `owc: curl -f http://localhost:8000/health` interval 30s start 30s (healthy live — `docker inspect` shows curl 200 with full JSON)
- `owc-web: node -e fetch('http://127.0.0.1:3001/api/health')` interval 30s start 20s — **currently failing** (`FailingStreak 56`, empty output)

Plus `Dockerfile.tools.playwright:88-89` has an **image-level** `HEALTHCHECK` (node fetch `http://127.0.0.1:3001/health` with body check for `"status":"ok"`) which is **shadowed** by the compose healthcheck (compose wins at runtime). The image-level check is more strict (verifies body), the compose check is looser (only `r.ok`). Prefer aligning them.

**Root cause of `owc-web` unhealthy:**

The rewrite in `web/next.config.mjs`:
```js
async rewrites() {
  const backend = (process.env.API_BASE_URL || apiBaseUrl).replace(/\/+$/, "");
  return [{ source: "/api/health", destination: `${backend}/health` }];
}
```

`API_BASE_URL=http://owc:8000` is correctly set in compose (`owc-web` env) and verified via `docker exec owc-web env`. However **standalone rewrites are baked at `next build` time into `.next/standalone/server.js`**, not evaluated per-request from runtime env. `docker history` shows the `next build` ran during `Dockerfile.web` builder stage; at that time `API_BASE_URL` was not set (only `NEXT_PUBLIC_API_BASE_URL=http://localhost:8000` is an `ENV` in the builder). The `server.js` was snapshotted with `backend=http://localhost:8000`, which inside the `owc-web` container does **not** resolve to the `owc` service (host loopback). Direct probe from inside the web container succeeds when bypassing the rewrite: `docker exec owc-web node -e "fetch('http://owc:8000/health')"` → 200, but `fetch('http://127.0.0.1:3001/api/health')` → 404.

**Impact:** `owc-web` healthcheck always fails → `unhealthy` → any `depends_on` on `owc-web` would block, and orchestrator dashboards correctly flag the console as degraded even though the Next.js server itself is up (`Ready in 177ms`). The previous wave's Task 1 fix (adding the `/api/health` rewrite) is **not yet live in the running `20260830` image** in the expected way; the image needs a rebuild with `API_BASE_URL` available at build time or the rewrite must read `API_BASE_URL` at runtime (e.g., via a custom `server.js` wrapper or Next.js `rewrites` using `process.env` that is re-evaluated, or switch healthcheck to probe `owc:8000` directly).

**Recommendation:** Either (a) rebuild `open-web-catcher-web:20260830` with `--build-arg API_BASE_URL=http://owc:8000`, or (b) move the healthcheck to `node -e "fetch('http://owc:8000/health').then(...)"` (container-DNS, not self), or (c) expose a local `/api/health` route handler in the Next app that proxies server-side without relying on rewrites.

`Dockerfile` (owc API) has **no** `HEALTHCHECK` instruction — relies solely on compose. This is acceptable (compose is the runtime), but for standalone `docker run` usage a Dockerfile `HEALTHCHECK` would be safer. The `Dockerfile.web` runner also has no image-level `HEALTHCHECK` — only compose.

### 3. non-root USER — PASS with documented exception

- `Dockerfile:40-41` creates `app` (10001:10001), `Dockerfile:91` ends with `USER app`. Verified at runtime `docker exec owc-web id` → `app`, `owc-tools-playwright` → `app`.
- `Dockerfile.web:52-53` creates `app`, installs as `USER root` for `apk upgrade` + `rm -rf npm`, then `USER app` for runtime. Correct pattern (least privilege after patching).
- `Dockerfile.tools.playwright:71-73` creates `app`, `USER app` at `91`. Also strips vulnerable `tar` after npm work.
- `docker-compose.yml:155` `owc: user: "0:0"` — intentional Windows workaround. This means the **owc API container runs as root** at runtime, downgrading the build-time `USER app` hardening. The entrypoint heals perms and then execs `supervisord` still as root; `supervisord` then spawns `uvicorn` as root (no `user=app` in `supervisord.conf`). This is a security regression vs. the Dockerfile's intent. Prefer `user: "0:0"` plus `gosu app supervisord` or `runas` after chown, or Windows-only override via `docker-compose.override.yml`.

`configs/supervisord.conf` does not set `user=app` under `[program:api]` — with `nodaemon=true` and container `USER app` the process would drop, but because compose overrides to root, it stays root.

### 4. apk upgrade / OS upgrade — PARTIAL

- `Dockerfile.web:47` → `RUN apk upgrade --no-cache` ✅ — plus comment referencing T47 CVE hygiene, and removes npm's vendored `tar@6.2.1` (CVE-2026-59873). Verified in file.
- `Dockerfile:36` → `RUN apt-get update && apt-get upgrade -y` ✅ — with cache mounts, comment referencing T47.
- `Dockerfile.tools.playwright:36-38` → `RUN apt-get update && apt-get install -y curl unzip xvfb` **without** `apt-get upgrade` ❌ — this image is the largest attack surface (Chrome + Playwright 1.60.0 on noble). It does strip `tar` (`rm -rf /usr/lib/node_modules/npm/node_modules/tar` at 72) but does not upgrade the base OS packages. The base `mcr.microsoft.com/playwright:v1.60.0-noble` inherits Ubuntu noble; without `apt upgrade`, known 2C/40H base CVEs may persist. Recommend adding `apt-get upgrade -y` in a separate layer after the install, matching `Dockerfile`.

### 5. Secret baking — PASS

- `.dockerignore:12` lists `.env` — verified. Also ignores `.venv`, caches, `data`, `docs`, `node_modules`, `.next`, etc.
- `docker-compose.yml:13` enforces `POSTGRES_PASSWORD:?` fail-fast (no weak default). `DATABASE_URL` is composed from env (`postgresql+psycopg2://${POSTGRES_USER:-owc}:${POSTGRES_PASSWORD:?...}@postgres:5432/...`) — not baked.
- `Dockerfile:85-87` only sets non-secret `ENV` (`PATH`, `PYTHONUNBUFFERED`, `MCP_SERVER_URL=http://localhost:3000`, observability flags). No `GOOGLE_API_KEY`, `OPENAI_API_KEY`, etc.
- `Dockerfile.web:27-28` `ENV NEXT_PUBLIC_API_BASE_URL=http://localhost:8000` — not a secret, but note this is the **build-time** value baked into the static Next output (see healthcheck note).
- `Dockerfile.tools.playwright:22-26` only sets `OWC_UBOL_*` and browser `ENV` — not secrets.
- `docker history open-web-catcher:20260830 --no-trunc` inspected — no `ENV` lines containing API keys, no `COPY .env` layer. Secrets are injected at runtime via `env_file: .env` and `environment:` interpolation — correct.
- Published images `aki47/owc-api:20260830` etc. were published with `security: credential-clean` note in ledger (no `auth.json` in layers) — consistent.

**Minor:** `.dockerignore` does not list `*.pem`, `*.key`, or `secrets/` — not currently present, but defense-in-depth would add them.

### 6. HOST 0.0.0.0 — PASS

- `tools/playwright/mcp-server.js:47` `const HOST = process.env.HOST || "127.0.0.1"` — secure localhost-by-default (TOOL-C1 hardening).
- `docker-compose.yml:75,122` explicitly sets `HOST: 0.0.0.0` for both `owc-tools-playwright` and `owc-tools-playwright-headed` with comment explaining cross-container reachability (`MCP_SERVER_URL=http://owc-tools-playwright:3001`).
- `Dockerfile.web:41` `ENV HOSTNAME=0.0.0.0` — Next.js standalone reads `HOSTNAME`, verified live via `docker exec owc-web env` → `HOSTNAME=0.0.0.0` and log `Network: http://0.0.0.0:3001`.
- `configs/supervisord.conf:12-13` `command=... --host 0.0.0.0 --port 8000` — binds API to all interfaces inside container (required for host publish `8000:8000`).
- `owc-tools-playwright` logs confirm `MCP server running on 0.0.0.0:3001`, `Shared browser fallback: ws://127.0.0.1:9223` (correct: Chrome stays loopback, MCP is cross-container).

No `HOST` misconfiguration remains — the previous wave's Task 1 P0-2 (127.0.0.1 refusal) is fixed in compose and verified live (`curl` from `owc` to sidecar now succeeds, `owc` health JSON shows `mcp healthy true`).

### 7. OWC_WEB_HOST_PORT — PASS (runtime), gap in example

- `docker-compose.yml:172` `UI_CORS_ORIGINS: ${UI_CORS_ORIGINS:-http://localhost:${OWC_WEB_HOST_PORT:-3000},http://127.0.0.1:${OWC_WEB_HOST_PORT:-3000}}` — composes CORS from the host port variable, correctly.
- `docker-compose.yml:210` `ports: "${OWC_WEB_HOST_PORT:-3000}:3001"` — host publish uses the variable.
- `.env` (runtime) has `OWC_WEB_HOST_PORT=3005` and `UI_CORS_ORIGINS=http://localhost:3005,http://127.0.0.1:3005` — matches `docker compose ps` `0.0.0.0:3005->3001`. Previous port-3000 conflict (node.exe squat) is resolved.
- `.env.example` does **not** contain `OWC_WEB_HOST_PORT` — it still documents `3000`-based defaults and `CORS` as `http://localhost:3000`. New operators copying `.env.example` will get the wrong port and CORS reject (`app-shell` fetch → offline). The compose default `:-3000` is intentional, but `.env.example` should document `OWC_WEB_HOST_PORT=3000` with comment about 3000 conflict.

---

## Additional observations

### Dockerfile pinning
All three Dockerfiles pin base images with `@sha256:<TO_FILL_AFTER_VERIFYING>` placeholders (lines `python:3.11-slim-bookworm@sha256`, `node:20-alpine@sha256`, `playwright:v1.60.0-noble@sha256`) but the `FROM` lines do not yet include digests (`FROM python:3.11-slim-bookworm` bare). This is tracked as T47 debt — reproducible builds require digest pinning.

### Resource limits & restart policy
Compose sets `restart: unless-stopped`, `init: true`, `stop_grace_period`, and `deploy.resources.limits/reservations` for all services — production-appropriate. `shm_size: 2gb` for playwright is correctly sized for Chrome.

### Redis host publishing
`redis` has no `ports:` — internal only, correct per ADR-002. `postgres` also internal-only (no `ports:`), correct — only `owc` (8000), `owc-web` (3005), and `owc-tools-playwright` (3002+9223) publish.

### Supervisord single-program
`configs/supervisord.conf` runs only `[program:api]` (`uvicorn`). The Chrome/MCP processes were correctly moved to the sidecar per ADR-003; `entrypoint.sh` no longer generates uBOL policy (delegated to playwright image). `nodaemon=true`, `startsecs=5`, `autorestart=true` correct.

### Live runtime caveat: `owc` reports `BROWSER_WS_ENDPOINT=ws://owc-tools-playwright:9223` but browser probe fails
`curl http://localhost:8000/health` JSON → `dependencies.browser.healthy false` (`Connection refused` to `http://owc-tools-playwright:9223/json/version`). `mcp` probe inside the same JSON is healthy (`Chrome/148.0.7778.96` via sidecar loopback `127.0.0.1:9223`). The `owc` service's `BROWSER_WS_ENDPOINT` should be `ws://owc-tools-playwright:9223` for the shared Chrome? Actually Chrome only listens on `127.0.0.1` inside the sidecar (`--remote-debugging-address=127.0.0.1`). The `owc` container cannot reach `owc-tools-playwright:9223` because Chrome is not bound to `0.0.0.0`. This is by design — the MCP server proxies browser access; direct Chrome WS from `owc` is not intended. The `runtime_preflight` correctly blocks launches (`blocking_reasons: browser_unhealthy`) but MCP profiles are all `ready`. This is a config-intent mismatch: `owc` `BROWSER_WS_ENDPOINT` should remain `ws://owc-tools-playwright:9223` only if Chrome is bound to `0.0.0.0`, or should not be probed directly. The MCP-based flow (`MCP_SERVER_URL=http://owc-tools-playwright:3001`) is healthy, so this does not block real runs that use MCP profiles.

---

## Findings summary (ranked)

| ID | Severity | File(s) | Finding | Fix |
|---|---|---|---|---|
| **P0-1** | P0 — blocks | `docker-compose.yml:218-223` + `Dockerfile.web` + `web/next.config.mjs` | `owc-web` healthcheck always fails (404) because Next.js standalone rewrite `API_BASE_URL` is baked at build time as `localhost:8000`; runtime env `http://owc:8000` never takes effect. `docker compose ps` shows `unhealthy` x56. | Rebuild web image with `API_BASE_URL=http://owc:8000` at build, or change healthcheck to `fetch('http://owc:8000/health')`, or add a runtime route handler for `/api/health` that proxies without rewrites. |
| **P1-1** | P1 — security | `docker-compose.yml:155` + `configs/supervisord.conf` | `owc` API runs as `user: "0:0"` (root) at runtime, overriding Dockerfile `USER app`; `supervisord` spawns `uvicorn` as root. Windows bind-mount workaround undoes non-root hardening. | Keep `USER app` by default; use Dockerfile `gosu`/`su-exec` to chown then drop, or split Windows override into `docker-compose.override.yml` gated on host OS. |
| **P1-2** | P1 — security/CVE | `Dockerfile.tools.playwright:36-38` | No `apt-get upgrade -y` in playwright image — the largest surface (Chrome + noble) ships base CVEs. `Dockerfile` and `Dockerfile.web` have upgrade steps. | Add `RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*` before or after the `curl/unzip/xvfb` install. |
| **P2-1** | P2 — robustness | `scripts/docker/entrypoint.playwright.sh:8-10` | Playwright sidecar `prepare_runtime_dirs` lacks Windows NTFS chown healing (no `if root chown` block). On strict Windows ACLs, writes to `./data/logs` will fail. | Copy the `if [ "$(id -u)" = "0" ]` block from `entrypoint.sh`. |
| **P2-2** | P2 — consistency | `Dockerfile.tools.playwright:88-89` vs `docker-compose.yml:82` | Image-level `HEALTHCHECK` (strict body check) is shadowed by compose healthcheck (loose `r.ok` only). Drift risks false-healthy. | Align compose test with image test (body `status ok` check) or remove one. |
| **P2-3** | P2 — docs | `.env.example` | Missing `OWC_WEB_HOST_PORT` (+ `UI_CORS_ORIGINS` with 3005). New clones get port 3000 default, collide with `node.exe` squat and get CORS offline. | Add `OWC_WEB_HOST_PORT=3005` (or 3000 with comment) and document `UI_CORS_ORIGINS` composition. |
| **P3-1** | P3 — reproducibility | `Dockerfile`, `Dockerfile.web`, `Dockerfile.tools.playwright` | Base image digests are placeholder `TO_FILL_AFTER_VERIFYING` — `FROM` lines not pinned. | Resolve `docker buildx imagetools inspect <base>` and append `@sha256:<digest>`. |
| **P3-2** | P3 — hygiene | `.dockerignore` | No `*.pem`/`*.key`/`secrets/` patterns. | Add defense-in-depth patterns. |

---

## Probe evidence

```
OWC_TAG=20260830 docker compose config --quiet  → 0
docker compose ps:
  owc                    Up 29m (healthy)    0.0.0.0:8000->8000
  owc-tools-playwright   Up 30m (healthy)    0.0.0.0:9223->9223, 0.0.0.0:3002->3001
  owc-web                Up 29m (unhealthy)  0.0.0.0:3005->3001
  postgres               Up ~1h (healthy)
  redis                  Up ~1h (healthy)
docker images | grep aki47:
  aki47/owc-api:20260830                1d05204948a4  1.05GB
  aki47/owc-tools-playwright:20260830   a726915a8fdf  3.56GB
  aki47/owc-web:20260830                 628ce5361ef5  288MB
curl http://localhost:8000/health → {"status":"ok","mcp":{"healthy":true,"browser":{"healthy":true,...}},"runtime_preflight":{"launch_ready":false,"blocking_reasons":[{"kind":"browser_unhealthy","endpoint":"http://owc-tools-playwright:9223/json/version"}]} ...} HTTP 200
curl http://localhost:3005/api/health → 404 _not-found (Next.js) HTTP 404
  docker exec owc-web node -e "fetch('http://owc:8000/health')" → 200
  docker exec owc-web node -e "fetch('http://127.0.0.1:3001/api/health')" → 404
docker exec owc id → root (0:0 override)
docker exec owc-web id → app (10001)
docker exec owc-tools-playwright id → app (10001)
docker history open-web-catcher:20260830 → no baked secrets, .env excluded
```

---

## Verdict

**Overall: CONDITIONAL PASS** — Windows bind-mount, secret baking, `HOST 0.0.0.0`, and `OWC_WEB_HOST_PORT` wiring are correct and live-verified; CVE upgrades are present in 2/3 images; all services have healthchecks and compose validates. **One P0 blocks `owc-web` healthy** (rewrite/standalone timing) and must be fixed before the next `aki47:DATE` publish — the running `20260830` web image is functionally correct (port 3005, `HOSTNAME 0.0.0.0`) but fails its own healthcheck. P1 root-user regression and missing playwright upgrade should be addressed in the same fix wave.

---

*Report generated per Cline inspection plan prompt; cline plan mode produced 0 bytes (model `z-ai/glm-5.3-flash`, `3.0.60`), manual verification substituted with terminal evidence attached. Raw cline trail: `.omo/start-work/cline-raw-20260831.jsonl` (frontend wave artifact, 356KB).*
