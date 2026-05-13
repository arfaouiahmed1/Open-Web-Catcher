# Frontend Console

This document describes the current operator console structure in `web/` and where new UI work should go.

## Route Map

- `/`: overview dashboard for KPIs, provider and model usage, reliability, and recent run health
- `/live`: workflow launch surface and live pipeline view
- `/runs`: persisted run explorer with filtering, comparison, cancellation, and deletion
- `/runs/[runId]`: run detail view for live traces, outputs, screenshots, costs, and telemetry tables
- `/datasets`: Postgres-backed dataset management and batch execution
- `/tools`: direct MCP tool workbench
- `/providers`: provider lookup and history
- `/database`: read-only database explorer
- `/prompts`: prompt catalog and prompt management
- `/settings`: runtime configuration, pricing, browser runtime, MCP tools, and notification preferences
- `/agents`: redirect to `/live`

## Module Layout

- `web/app/**/page.js`: thin route entrypoints only. They should compose and delegate, not own large local component trees.
- `web/components/console/layout`: shared shell concerns such as sidebar navigation, top bar, and route metadata
- `web/components/console/common`: reusable console-level building blocks such as page headers, confirmation flows, loading states, and panel shells
- `web/components/console/<feature>`: route-owned feature modules. Keep feature-specific sections, cards, and helpers here.
- `web/components/ui`: shadcn-style primitives and thin wrappers over Radix components. New generic controls belong here first.
- `web/lib`: API helpers, pricing logic, run-trace helpers, status helpers, and other non-visual utilities

## Shared UI Rules

- Prefer `web/components/ui/*` primitives over page-local raw controls.
- If a pattern is reused across routes, promote it to `web/components/console/common` or `web/components/console/layout`.
- Keep page-local custom visuals as compositions of shared primitives rather than introducing isolated control systems.
- Mobile overlays, confirmation flows, and navigation drawers should use shadcn-based primitives such as `sheet`, `dialog`, and `alert-dialog`.

## Maintenance Notes

- `owc-web` is production-built through `Dockerfile.web` with `npm ci` and `npm run build`. Any frontend change must keep that path green.
- `docker-compose.yml` serves the console on port `3001` through the `owc-web` service.
- Many console surfaces depend on backend data contracts from `/ui/*` and `/api/datasets/*`; preserve those response shapes unless backend and frontend are updated together.
- The dataset flow is Postgres-backed. Do not reintroduce CSV import UI or CSV fallback logic unless product direction changes.
