# Cline wave 20260831 — findings and progress

Branch: main @ 2db9b28 (+ fcdb5d5, a7358a50 merged). Stack: owc healthy :8000, owc-web :3005, owc-tools-playwright :3002->3001 healthy, postgres/redis healthy.

## Task 1 — owc-web "offline / not picking up owc/containers"

Root causes found (all reproduced live):

1. **CORS blocks the browser → offline indicator.** `.env` pinned
   `UI_CORS_ORIGINS=http://localhost:3000,...,3001` but the console actually serves on
   host port **3005**. `app-shell.tsx` probes `fetch(apiUrl("/ui/overview"))` from the
   browser at origin `http://localhost:3005` → CORS reject → `connected=false` →
   "offline" dot in sidebar. Fix: `.env` now sets `OWC_WEB_HOST_PORT=3005` and the 3005
   CORS origin set (compose default already composes origins from `OWC_WEB_HOST_PORT`).
2. **owc → owc-tools-playwright:3001 connection refused.** `tools/playwright/mcp-server.js`
   binds `HOST=127.0.0.1` by default ([TOOL-C1] hardening). The container-internal
   healthcheck (localhost) passes, but the cross-container probe from `owc`
   (`MCP_SERVER_URL=http://owc-tools-playwright:3001`) is refused → browser/mcp runtime
   probes unhealthy → "not picking up owc/containers". Verified live: curl from owc to
   the sidecar returned `000`. Fix: set `HOST: 0.0.0.0` env for the tools services in
   compose (deliberate override for container deployments; source default stays
   localhost-safe for host runs).
3. **`/api/health` 404 via Next.js.** The backend exposes `/health` (no `/api/health`
   route; verified 404 on :8000 too) and the web container had no proxy. Fix:
   `next.config.mjs` adds rewrite `/api/health` → `${API_BASE_URL || NEXT_PUBLIC_API_BASE_URL}/health`
   (API_BASE_URL=http://owc:8000 is read by the standalone server at boot) plus a compose
   healthcheck for owc-web probing `http://localhost:3001/api/health`.
4. `NEXT_PUBLIC_API_BASE_URL=http://localhost:8000` is correct for the host browser
   (owc publishes 8000); SSR keeps using `API_BASE_URL=http://owc:8000`. No change needed.

## Task 2 — settings gemini-only → multi-provider

Findings:
- `build_llm` (src/agents/base.py:535-608) hard-gates: rejects any non-Google model id
  (falls back to gemini) and always passes `settings.google_api_key`.
- `normalize_agent_model_config` (src/utils/provider_models.py:511) **forces every
  per-agent provider back to `settings.llm_provider`** (lines 536-537) — per-agent
  provider selection can never survive normalization.
- `fetch_provider_models` dispatches google only; `_fetch_openai_models`,
  `_fetch_anthropic_models`, `_fetch_openrouter_models`, `_fetch_nvidia_models` exist but
  are **dead code** (lines 978-1117). `PROVIDER_METADATA`/`FALLBACK_MODELS` and
  `_provider_api_key` are google-only.
- `provider_config.get_ui_provider_models` 400s "Only the Google Gemini provider is
  supported."; `apply_ui_config_update` has the same gate for `llm_provider`.
- `app.py`: `_pricing_sync_provider_ids()` returns `["google"]`;
  `_provider_api_key_available` is google-only; `/ui/pricing/sync` rejects non-google.
- UI (settings-page.tsx) already has AGENT_SLOTS + catalog plumbing but PROVIDERS=[google]
  and providersToLoad=["google"].
- PUT /ui/config already validates arbitrary typed Settings fields via
  validate_settings_patch → new settings only need ModelConfigRequest + apply + payload.

Status: IN PROGRESS
