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

## Settings UX And Theme Contract

The Settings page is a **Configure** surface: hierarchy, readable state, and safe edits take
priority over decorative panels. Its information architecture is grouped into:

- **AI Configuration:** Models and Provider Keys;
- **Runtime:** Browser and MCP Tools;
- **Preferences:** Display and Notifications;
- **Security:** Account.

Provider Keys is a searchable, grouped directory. It exposes configured/missing state, masked
credentials, endpoint overrides for custom gateways, Clear/Undo, and Test. Models uses searchable
provider and model selectors, per-agent assignments, and a manual model ID fallback. The full
provider behavior is documented in [Provider Directory](../operations/provider-directory.md).

Light mode is a first-class theme, not a recolored dark screenshot. Settings and shared controls
must use semantic classes (`text-foreground`, `text-muted-foreground`, `bg-muted/*`,
`border-border`) instead of dark-only `#f7f8f8`, `#8a8f98`, or white-alpha values. Accent text uses
the readable theme variables `--signal-text`, `--mint-text`, `--violet-text`, `--rose-text`, and
`--sky-text`; light-mode `--primary` and `--ring` resolve through `--signal-text`. Verify both
`.dark` and `.light` states when changing Settings or `web/components/ui/` primitives.

The shared `Select` primitive accepts `searchable` and `searchPlaceholder`, and filters by label,
description, and metadata without changing the value contract. This is required for the expanded
provider directory and must remain keyboard-dismissible with Escape.

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
