# Frontend Console

The operator console is a Next.js 15 application under [`web/`](../../web/). It is the browser-facing surface for run launch, live SSE telemetry, provider lookup, run history, and settings.

## Source invariant

All application source is TypeScript:

- Runtime code in `web/app/`, `web/components/`, and `web/lib/` uses `.ts` or `.tsx` only.
- `web/tailwind.config.ts` is typed and scans the TypeScript source tree.
- `web/postcss.config.mjs` is ESM because PostCSS loads configuration modules rather than TypeScript source files.
- `web/components.json` has `tsx: true`, preventing shadcn/ui from generating JavaScript primitives in future.
- `web/tests/no-js-frontend.test.ts` is the regression gate. It rejects `.js` and `.jsx` application files and the two retired configuration filenames.

Some preserved legacy page modules retain `// @ts-nocheck` while their behavior is decomposed into the typed library and tab components. This is explicit migration debt rather than hidden JavaScript: the modules are `.tsx`, compile under the strict project configuration, and remain covered by the production build and frontend test suite. Do not add new unchecked modules.

## Module map

| Concern | Primary modules |
| --- | --- |
| Routes and shell | `web/app/**/*.tsx`, `web/components/console/layout/` |
| API transport | `web/lib/api-client.ts`, with `web/lib/api.ts` as the legacy import-compatible façade |
| Live updates | `web/lib/use-run-stream.ts`, `web/lib/use-event-stream.ts` (SSE only; no polling timers) |
| Design library | `web/components/library/` and `web/components/ui/` |
| Console screens | `web/components/console/{overview,runs,settings,providers,run-detail}/` |
| Large-data rendering | `web/components/library/VirtualizedList.tsx` |
| Deferred visualization code | `web/components/charts/LazyCharts.tsx` |

## API-origin contract

There is no localhost fallback:

- Browser requests require `NEXT_PUBLIC_API_BASE_URL`.
- Server-side rendering and tests may use `API_BASE_URL`, which takes precedence over `NEXT_PUBLIC_API_BASE_URL` without exposing that internal origin to browser code.
- `web/next.config.mjs` rejects a build without a valid public API origin.

## Required validation

Run from `web/` with an explicit non-production origin:

```bash
npx tsc --noEmit
npx vitest run
NEXT_PUBLIC_API_BASE_URL=https://api.test.invalid npm run lint
NEXT_PUBLIC_API_BASE_URL=https://api.test.invalid npm run build
node ../scripts/check-no-polling.mjs
```

The build output is also the baseline for T44 bundle work. Preserve lazy chart and workflow-canvas boundaries, virtualize high-cardinality lists, and prefer `AbortSignal` through `apiFetch` for request cleanup.
