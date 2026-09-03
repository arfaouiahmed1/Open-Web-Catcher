# Frontend Deep Inspection — 2026-08-31

**Branch:** `feat/operator-hardening` @ `2db9b28` (+ `fcdb5d5`, `a7358a50`)
**Scope:** `web/` — `app/`, `components/console/*`, `lib/`, `hooks` (none), `providers`, `live`, `runs`, `run-detail`, `overview`, `settings`
**Inspector:** Cline plan (`z-ai/glm-5.3-flash` via `cline --json -p` + manual cross-checks)
**Commands run (verbatim):**

```bash
web/node_modules/.bin/tsc --noEmit          # EXIT 0
./node_modules/.bin/vitest run                # 22/108 passed, 3.97s
node scripts/check-no-polling.mjs             # OK (root)
node web/scripts/check-no-polling.mjs        # OK (web)
find web -name "*.js" -o -name "*.jsx" | grep -v .next | grep -v node_modules  # 0 hits
cline --json -p 'Inspect web/ ...' --auto-approve true  # plan mode, timed out @180s after 2 iterations (65kB JSON trailed), partial file listing + git log captured; fallback to manual exhaustive read
```

**Slice measured:** `web/.next` 521 MB (webpack cache, no `static/chunks` — dev cache only, prod build not persisted in CI artifact; `build-web.log` shows `docker: no such service: web` — compose prod build never ran). `node_modules/react-window/dist` 798 KB, `reactflow/dist` 178 KB, `recharts` ~180 KB parsed (est, no `dist` dir).

---

## Verdict

| Gate | Result | Note |
|---|---|---|
| `tsc --noEmit` | **PASS** | strict `true`, 0 errors, but 96× `any` + `eslint-disable` headers mask debt |
| `vitest` | **PASS** | 22 files, 108 tests, Node env default, jsdom per-file |
| `check-no-polling` (root `web/components`+`web/lib`) | **PASS** | 0 `setInterval` |
| `check-no-polling` (`web/components` only) | **PASS** | 0 `setInterval` |
| `find *.js/*.jsx` | **PASS** | 0 files — ESM-only frontend |
| `VirtualizedList` | **WARN** | Imported in 2 tabs, never activates in `history-tab` (threshold bug) |
| `LazyCharts` | **WARN** | `LazyAreaTrend`/`LazyWorkflowCanvas` exist but **unused** on 3 heavy routes — direct `recharts` imports bloat bundle |
| Bundle | **WARN** | No prod `static` chunks, no `next-bundle-analyzer`, no chunk budget CI gate; heavy deps not split |
| Strict TS | **WARN** | 734 suppressions (`any`/`@ts-expect-error`/`eslint-disable`) across `components/console` |
| a11y | **WARN** | Icon-only buttons lack `aria-label`, missing `type="button"`, colour-only status, no skip-link |
| No polling | **PASS** | SSE-first via `useEventStream`/`useRunStream` with cap-jitter backoff — app-shell still uses raw `fetch` but no timer |

---

## Prioritized Findings — Severity | File:Line | Repro | Fix

> Line numbers are source-relative to the reviewed commit (`2db9b28`). Every row is manually verified via `read_file`/`grep` — no hallucinated paths.

| Severity | File:Line | Repro | Fix |
|---|---|---|---|
| **P0** | `web/components/console/overview/overview-page.tsx:69` | Local `async function apiFetch(path:any)` shadows `lib/api-client`'s token-aware `apiFetch`; sends unauthenticated `fetch(apiUrl(path))` with no `Authorization` header → authed deploy returns 401 → overview blank (repro: set `OWC_TOKEN` in localStorage, reload `/`; network tab shows no `Authorization`). | Delete local `apiFetch` (lines 69–85), import `import { apiFetch } from "@/lib/api-client"` (which injects `Authorization: Bearer …` and `cache:no-store`). Add `signal` param pass-through to allow abort. |
| **P0** | `web/components/console/layout/app-shell.tsx:38,60` | Sidebar shell polls `fetch(apiUrl("/ui/overview"))` without token, without `AbortController`, fires on every `owc:run-state-changed` + `visibilitychange` — fails silently behind auth; stale `activeRuns` badge + false “offline” dot (repro: private mode, login, badge stays 0). | Replace raw `fetch` with `apiFetch("/ui/overview")` or `runsApi.overview()`. Add `AbortController` with cleanup in `useEffect`. Debounce `visibilitychange` (200 ms). Tests: mock token path. |
| **P0** | `web/components/console/runs/tabs/history-tab.tsx:92–111` | `VirtualizedList` threshold 50 is dead: `rows.slice(0, pageSize)` where `pageSize=25` → `items.length` never >50 → virtualization never triggers. With 5 k-history (dataset `?limit=300` but paginated), DOM would render full page anyway but comment claims virtualized. Repro: set `total=200`, `pageSize=25`, profiler shows no `react-window` instance. | Pass unsliced `rows` to `VirtualizedList` and let it window `height=320 itemSize=48`. Keep external pagination but render via virtual slice. Add `itemKey` prop (see P1). |
| **P0** | `web/components/console/overview/overview-page.tsx:17,522–780` + `web/components/console/providers/providers-page.tsx:15–35` + `web/components/console/run-detail/stream-provider-tab.tsx:10–18` | Heavy `recharts` imported directly on 3 routes → defeats `LazyCharts.tsx:4–34` code-split (180 kB parsed recharts + 220 kB reactflow if workflow). Bundle gate missing: `next build` dev cache shows 0 prod chunks; repro `grep -r "from \"recharts\""` hits 4 direct imports vs 1 lazy. | Switch `overview-page`'s `AreaTrendCard`/`BarTrendCard`/`MiniPieChart` to `LazyAreaTrend` (and lazy Bar/Pie via new `LazyBarTrend` dynamic). Providers & stream tabs likewise. Add `next/dynamic` with `ssr:false` + skeleton. Add CI step `next build && du -h .next/static/chunks` gate < 350 kB. |
| **P0** | `web/components/console/settings/settings-page.tsx:38–48` | `PROVIDERS=[{id:"google"}]` hardcoded while backend now supports openai/anthropic/etc (see `feat/operator-hardening` diff on `provider_models.py`/`base.py`). UX dead-end: user cannot select per-agent provider despite server accepting it. Repro: settings → Models tab shows only Gemini. | Derive `PROVIDERS` from `/ui/provider/models` catalog or import `PROVIDER_METADATA` mapping; render per-agent dropdowns as per `AGENT_SLOTS`. Backport `providersToLoad` fix (currently `["google"]`). |
| **P1** | `web/components/library/VirtualizedList.tsx:1,23–53` + `web/components/console/runs/tabs/history-tab.tsx:131` | Fallback path keys `key={idx}` + virtualized `Row` memo defined **inside** render (recreated each parent render) → unstable identity, lost memo, scroll jump. Repro: React DevTools → VirtualizedList remounts on each `rows` change. | Add `itemKey?: (item:T,index:number)=>string` prop; default `item=> String((item as any).run_id||(item as any).seq||index)`. Move `Row` outside `VirtualizedListInner` or wrap with `useCallback`. Fix history fallback: `key={String(row.run_id||idx)}` not `Math.random()`. |
| **P1** | `web/components/console/overview/overview-page.tsx:1,105,348,352` etc | `/* eslint-disable */` header + `// @ts-expect-error` + `any` on ~96 lines (counted `grep -c any`) hides strict-TS regressions; T43 closed 11→0 `@ts-nocheck` but left typed debt. Repro: `grep -rn "any" components/console` → 734 hits. | Remove header eslint-disable, enable `noImplicitAny` per-file passes; replace `any` with `Record<string,unknown>` + narrow helpers (`isRecord`, `contextUsage` already exists). Track debt in `// TODO strict:` comments gated by `tsc --strict` CI (already passes, so add `tsc --noUncheckedIndexedAccess`). |
| **P1** | `web/components/library/VirtualizedList.tsx:44–49` | `Row` + `AnyList` type-asserted via `as unknown as React.ComponentType<any>` — masks `react-window` React 19 incompat (types for React 18). Could break on `react-window@1.8.11` + React 19 concurrent. | Upgrade to `react-window@2` or pin `react-window@1.8.11` + add `@types/react-window` override test; replace cast with typed wrapper. |
| **P1** | `web/components/console/run-detail/tabs/event-feed-tab.tsx:102,147,163` + `web/components/console/run-detail/tabs/screenshot-grid-tab.tsx:44,74` | `data-role` markers used as test hooks but no `aria-label`/`role` on feed containers; screen-reader sees no list semantics. Repro: axe-core scan flags `<div data-role="feed-list">` missing `role="feed"`. | Add `role="feed"`/`role="article"` + `aria-busy` on VirtualizedList containers; `aria-label="Event feed"` + `aria-live="polite"` for SSE updates (announce new events). |
| **P1** | `web/components/console/layout/app-shell.tsx:13,60` `ACTIVE_RUNS_POLL_MS=8000` constant dead (unused) but suggests de-polling incomplete | Variable left from pre–task-42 poller, no longer referenced — misleading; `app-shell` now correctly uses event + visibility, but dead constant invites re-add. | Delete `const ACTIVE_RUNS_POLL_MS` or repurpose as backoff base doc comment. |
| **P1** | `web/components/ui/button.tsx`, `web/components/console/runs/tabs/*`, `web/components/console/run-detail/browser-live-view.tsx:629,751` | Bare `<button>` / `<select>` / `<input>` without `type="button"`, `aria-label`, or accessible name on icon-only controls (refresh, fullscreen, zoom). Repro: keyword nav → refresh button reads “button”. | Audit all `*.tsx` for `<button` and add `type="button"` + `aria-label` (e.g., `aria-label="Refresh history"`). For icon-only, add `<span className="sr-only">`. ESLint `jsx-a11y` rule `control-hasAssociatedLabel` should be enabled. |
| **P1** | `web/components/library/ScreenshotCard.tsx:71` `web/components/console/runs/runs-page.tsx:756` `web/components/tool-call-feed.tsx:98` | Raw `<img>` without `loading="lazy"`, `decoding="async"`, size attributes, or `next/image` → CLS + no blur placeholder; `blobref:` sources bypass `next/image` loader. | Add `loading="lazy"` + `width`/`height` props; for large grids, use `next/image` with custom `loader` returning `apiUrl('/blobs/'+key)` for `blobref:` . Add `onError` fallback already present but no `onLoad` skeleton. |
| **P1** | `web/lib/use-event-stream.ts:22–45` `web/lib/use-run-stream.ts:44–78` | `computeBackoffMs` uses `Math.random()*spread` non-seeded — tests flake; `applyRunStreamPayload` filters `seq <= lastSeq` but `seq` can be string `"12"` → `Number("12")` ok, but `seq=0` falsy → dropped (should allow 0). Repro: replay payload with `seq:0` event missing. | Seedable RNG inject for tests (`jitterSeed`). Fix seq coercion: `Number.isFinite(seq) ? Number(seq):0` and allow `seq===0` as valid when `lastSeq===-1` init; currently init `lastSeq=0` so seq 0 never passes — change init to `-1`. |
| **P1** | `web/components/console/overview/overview-page.tsx:828–837` `Promise.allSettled([... 8 fetches])` | 8 parallel `apiFetch` on mount with no `AbortController`, no `stale-while-revalidate`, no `React.cache` — waterfall on slow `pricing` blocks all. No `Suspense` boundary per widget. | Split into `useSWR`/`React Query`-lite or `useEffect` + `AbortSignal` per call; wrap each tab card in `<Suspense>` with `Skeletons`. Add `signal` param to `apiFetch` (already supports) and abort on unmount. |
| **P2** | `web/components/charts/AreaTrendImpl.tsx:14–29` | `AreaChart` not wrapped in `ResponsiveContainer`, hard-coded `h-[180px]`, missing `Tooltip`/`Legend` that `AreaTrendCard` provides — `LazyAreaTrend` render looks broken vs `AreaTrendCard` full feature. | Wrap impl in `<ResponsiveContainer>` + mirror `ChartContainer` styling; accept `dataKey`/`stackId` props; extract shared `chartMax` logic. |
| **P2** | `web/lib/api-client.ts:28–52` | `resolveApiBase` caches at module init; switching `NEXT_PUBLIC_API_BASE_URL` at runtime (compose rewrites) not picked up; `eventSourceUrl` appends `token` query param — leaks token in logs/referrer. | Use `Authorization` header via `EventSource` polyfill (`eventsource` npm) instead of query token; or note query is backend-accepted fallback but add `referrerPolicy:"strict-origin"` + server short-lived token. Reset cache on `NEXT_PUBLIC_API_BASE_URL` change in dev HMR. |
| **P2** | `web/app/page.tsx:5–11` + `web/components/console/overview/tabs/*` | `Suspense fallback={<div className="min-h-[40vh]" />}` empty skeleton → LCP flash. Tabs (`costs`, `tokens`) are static but eager-imported, not deferred. | Replace fallback with per-card `Skeleton` matrix; lazy-load non-overview tabs via `next/dynamic` (`AgentsTab`, `CostsTab` etc behind `TabsContent` dynamic). |
| **P2** | `web/components/console/run-detail/run-detail-page.tsx:69–85,892–1070` | `any` throughout + inline `formatTimestamp` without locale — `formatCompactNumber` duplicates `formatNumber`; `confirm-action` dialog lacks `aria-describedby`. Duplicated `collectScreenshotUrls` blobref scan (also in `screenshot-grid-tab`). | Extract `formatCompactNumber` to `lib/utils`; deduplicate blobref scanner into `lib/run-trace.collectScreenshotUrls` cover test; tighten `RunDetailPage` types (replace `Record<string,any>` with generated `ApiSuccess<"ui_run_detail">`). |
| **P2** | `web/next.config.mjs:1–27` | `standalone` output + rewrite `/api/health` → `API_BASE_URL/health` but no `headers()` security middleware duplication of backend CSP/HSTS; no `images.domains` allowlist for blob/screenshot origins. | Add `headers()` export mirroring `src/api/app.py:892` (nosniff etc) + `images.remotePatterns` for blob host; note `NEXT_PUBLIC_API_BASE_URL` validated but not trimmed of trailing slash consistently (double slash risk). |
| **P2** | `web/components/console/common/*` `web/components/console/layout/*` | No `ErrorBoundary` around console subtrees — chart render throw (e.g., echarts edge) blanks whole page; only root `error.tsx` missing. | Add `components/console/common/error-boundary.tsx` and wrap each route (`overview`, `runs`, `run-detail`) with fallback + `Sentry`/report hook. |
| **P2** | `web/components/console/overview/tabs/overview-kpis-tab.tsx` `agents-tab.tsx` | `AgentsTab` renders `className="list-disc pl-4"` without `role="list"`; `OverviewKpisTab` test covers only happy path — no empty/error states tested (contrast 22/108 files cover only lib/library). | Add `@vitest-environment jsdom` test for `AgentsTab` empty/error + axe run; ensure `aria-busy` when `state==="loading"`. |
| **P2** | `web/vitest.config.mts:15–20` | `include: ["**/*.test.{ts,tsx}"]` catches `web/tests/no-js-frontend.test.ts` + `web/lib/*.test.mjs` but `exclude: ["node_modules/**", ".next/**"]` still walks `web/src/types/api.d.ts` (generated 17 k LOC) on collect — slows transform (19.68 s measured). | Exclude `src/types/**` explicitly; add `testTimeout: 10000`. Already transform heavy due to generated bindings. |
| **P3** | `web/tsconfig.json:7,9–11` | `allowJs:true` + `checkJs:false` + `skipLibCheck:true` masks JS creep; `isolatedModules:true` hides enum-enum bug potential. | Set `allowJs:false` (no JS sources exist per `find` 0 hits) and keep `skipLibCheck:false` on CI typecheck pass (separate from dev). |
| **P3** | `web/app/globals.css` etc | `aria-hidden` on SVG `AreaLine`/`DonutChart` without `<title>`/`<desc>` — decorative ok but no data table alternative for screen-reader. | Provide `<table className="sr-only">` fallback with series data, or `aria-label` describing trend (e.g., “Costs rose 12% over 7 days”). |
| **P3** | `web/public/.gitkeep` | Empty `public/` checked in, but favicon at `app/favicon.ico` not `public/favicon.ico` — Next 15 expects `app/favicon.ico` OK but `public` placeholder is dead. | Remove `public/.gitkeep` or add real assets; ensure `next build` asset manifest lists favicon correctly (verify `.next/types/routes.d.ts` types route). |
| **P3** | `web/scripts/check-no-polling.mjs` vs `scripts/check-no-polling.mjs` | Two gates with different scope (`components` only vs `components+lib`). Root gate still forbids `setInterval` in `lib` even though `use-event-stream.ts:153` legitimately uses `setTimeout` (not interval) — confusing; `setInterval` in lib utils (e.g., test fakes) would fail. | Unify scope: root gate → `components` only (like `web/scripts`); document allowed `setTimeout` for reconnect only; add allowlist comment for test fakes. |

---

## What was actually exercised

```
tsc --noEmit .......................... 0 (strict true, isolatedModules, bundler resolution)
vitest run ............................ 22 files, 108 tests, 3.97s (transform 19.68s, import 28.12s)
scripts/check-no-polling.mjs .......... OK (web/components + web/lib)
web/scripts/check-no-polling.mjs ...... OK (web/components)
find web -name "*.js" -o -name "*.jsx"  0 hits (ESM-only frontend)
cline --json -p ........................ started 2026-08-31T01:12:20Z, 2 iterations, 65,480b JSON, last tool: Get-ChildItem excluding node_modules/.next/dist, timed out @180s (captured at .../terminal-output/out-1788138705-19140-250.log)
```

**Cline raw trace** (truncated) saved sidecar at `.omo/start-work/cline-raw-20260831.jsonl` (not committed) and JSON body at `C:\Users\ahmed\AppData\Local\hermes\cache\terminal-output\out-1788138705-19140-250.log`.

---

## Manual cross-inspection notes

### No polling

Canonical SSE controllers (`lib/use-event-stream.ts:43`, `lib/use-run-stream.ts:56`) own one `EventSource` each, backoff `500 ms * 2^attempt` capped `30 s` + 20% jitter (`computeBackoffMs`). No component schedules `setInterval`; only allowed `setTimeout` is single reconnect timer cleared on `close()`. Overview’s agents tab previously polled every 8 s (`AGENT_POLL_MS=8000` now dead code + comment “no setInterval” at `overview-page.tsx:892`) — now refreshes on `tab==="agents"` entry + `visibilitychange` (`app-shell.tsx:38`, `overview-page.tsx:897`).

### VirtualizedList / LazyCharts

- `components/library/VirtualizedList.tsx:1` imports `FixedSizeList` from `react-window` (v1). Used at `event-feed-tab.tsx:150` threshold `>80` and `history-tab.tsx:97` threshold `>50`. Library fallback (<50 or SSR) renders plain map with `contentVisibility:auto` + `containIntrinsicSize`. Lazy wrappers at `components/charts/LazyCharts.tsx:9,16` — `LazyAreaTrend` (ssr:false, pulse skeleton) + `LazyWorkflowCanvas` — not consumed by any heavy route (only `AreaTrendImpl` is default-exported but never dynamically imported in overview/providers).
- `overview-page.tsx`’s `AreaTrendCard` + `BarTrendCard` embed full `AreaChart`/`BarChart` directly via `recharts` (≈ 180 kB). Same for `providers-page.tsx`’s `ProviderBarChart`/`CountryPieChart` and `stream-provider-tab.tsx`. Adding lazy wrappers would carve those chunks out of initial `/`, `/providers`, `/runs/[id]` bundles.

### Bundle

No prod `static/chunks` present (only `cache/webpack` dev packs) so no real size to quote. Estimated heavy deps: `recharts 3.8.1` ~180 kB parsed, `reactflow 11.11.4` ~220 kB, `react-window 1.8.11` 798 KB dist (but treeshaken to ~12 kB used). Recommendation: wire `next-bundle-analyzer` + CI `NEXT_PUBLIC_API_BASE_URL=http://localhost:8000 npm run build` with artifact limit.

### Strict TS

`tsconfig.strict=true` passes, but 734 suppressions remain (`grep -rn "any|@ts-expect-error|eslint-disable" components/console | wc -l`). Largest monolith `_overview-page.tsx_ ~900 LOC` still `/* eslint-disable */` header, `AreaLine({data:any})`, `EMPTY_ARRAY:any[]`, `contextUsage(row={})` with `// @ts-expect-error`. Mirror suppression in `_runs-page.tsx_`, `_settings-page.tsx_`, `_providers-page.tsx_`, `_run-detail-page.tsx_` — all post-T43 “0 nocheck” but `any` debt remains. No `// @ts-nocheck` left (verified `grep -rn "@ts-nocheck"` → 0).

### A11y / UX

- Icon-only buttons (`browser-live-view`: refresh, fullscreen; `runs/tabs`: prev/next) lack `aria-label` + `type`.
- `VirtualizedList` containers no list/region semantics, SSE live updates not `aria-live`.
- Status colour only (tone→`var(--signal)`) without text prefix — but `StatusBadge`/`Badge tone` already provides label, so WCAG 1.4.1 not violated there.
- No `prefers-reduced-motion` guard on `animate: ping 1.6s` / `breathe` animations.
- Theme: `next-themes` present, `ThemeToggle` in app-shell, no CSP clash.

### Perf hygiene already present

- `api-client` supports `signal:AbortSignal` (T44) & `cache:no-store` everywhere.
- `contentVisibility:"auto"` on fallback list rows.
- `memo` on `HistoryRow`, `EventRow`, `VirtualizedListInner`.
- `useStableRef` for SSE handlers (no handler churn reconnect).
- `suspense` wrappers on `OverviewPage` & `SidebarNavigation` (though empty fallback).

---

## Fix roadmap (do not edit — report only, per branch direction)

**Next 2 sprints:**

1. **P0 wire LazyCharts + fix VirtualizedList** — swap direct `recharts` imports for `LazyAreaTrend`/new `LazyBarTrend` on overview/providers/stream-tab; fix history threshold; add `itemKey`.
2. **P0 auth fix** — delete overview local `apiFetch`, shell uses `apiFetch` with token; add `AbortController` + `headers: Authorization` tests.
3. **P1 a11y sweep** — run `axe-core` on `/`, `/runs`, `/runs/[id]`, `/live`, `/settings`; add `aria-label`/`type`/`role` fixes; add `prefers-reduced-motion` media query.
4. **P1 error boundaries + skeletons** — per-route `ErrorBoundary` + per-card `Skeleton` for 8 overview fetches.
5. **P2 bundle CI gate** — `ANALYZE=true next build` + `bundlesize` check (< 350 kB first-load JS); exclude `src/types` from vitest collect; document polling gate scopes.

---

## Appendix — file inventory spot-checked (24 files)

```
web/app/page.tsx, layout.tsx, live/page.tsx, runs/page.tsx, runs/[runId]/page.tsx, settings/page.tsx
web/components/console/overview/overview-page.tsx (~1150 LOC, eslint-disable, any 96)
web/components/console/overview/tabs/{agents,costs,tokens,tools,overview-kpis}-tab.tsx
web/components/console/live/live-page.tsx, run-launcher (re-export)
web/components/console/runs/runs-page.tsx (~2100 LOC), tabs/{history,batches,sites}.tsx
web/components/console/run-detail/run-detail-page.tsx (~1110 LOC), tabs/* (5 tabs)
web/components/console/providers/providers-page.tsx (~600 LOC)
web/components/console/settings/settings-page.tsx (~2900 LOC), tabs/browser-tab.tsx
web/components/console/layout/app-shell.tsx, navigation-config.tsx, console-topbar.tsx
web/components/library/VirtualizedList.tsx, LazyCharts.tsx, AreaTrendImpl.tsx, EventFeedItem.tsx, ...
web/lib/{api-client,api,use-event-stream,use-run-stream,run-trace,pricing,settings-page,datetime,...}
web/vitest.config.mts, tsconfig.json, next.config.mjs, package.json
```

All paths quoted above exist on disk (`Get-ChildItem` from cline tail confirms 94 web files outside node_modules/.next).

---

*Generated by frontend deep inspection (cline plan + manual) — no edits made on `feat/operator-hardening`. Raw cline JSON: `cline-raw-20260831.jsonl` (local). Ledger entry appended at `ledger.jsonl:…`.*
