# Operator Console

The operator console is built with **Next.js 15 (App Router)**, **React 19**, and **Tailwind CSS**. It provides comprehensive command-and-control capabilities for managing multi-agent runs, investigating streaming piracy sites, and tuning model parameters.

---

## Key Workspaces

### 1. Overview Dashboard (`/`)
- Real-time aggregate KPIs: Total runs, success rate, average latency, total tokens, tool success rate.
- 5 Recharts visualizations: 7-day cost/token area trend, outcome donut distribution, latency benchmark bars, provider/model distribution, and top tools reliability.

### 2. Live Pipeline Launcher (`/live?mode=workflow`)
- Interactive 4-stage pipeline canvas with stage inspection.
- Quick presets for known streaming architectures (`freeshot.live`, `streamed.pk`).
- Live runtime preflight checks (browser CDP status, MCP health, tool profile readiness).

### 3. Website Dataset (`/runs?tab=sites`)
- Unified dataset management for target sites.
- Bulk operations: health checks (`POST /api/datasets/sites/health-check`), batch launches, bulk tag/label edits, and dead-site pruning.
- Slide-over `SiteDetailSheet` displaying historical stream yields, latency, and operator notes.

### 4. Run Detail Cockpit (`/runs/[runId]`)
- Compact command bar and 6-tile KPI ribbon.
- Interactive **Agent Execution Graph**: Visual topology of the orchestrator and subagents.
- **Rich Agent Inspector**: Clicking any agent node opens a comprehensive slide-over detailing tool executions (with arguments and results), thought traces, discovered artifacts, and diagnostics.
- Native HTML5 video player for instant stream preview.

### 5. Settings Workspace (`/settings`)
- **Models**: Global model configuration and per-agent routing overrides with live catalog pricing.
- **Browser**: Playwright runtime policies, concurrency limits, uBOL adblocker toggles, and CORS patches.
- **Display**: Granular UI density, polling rate, and panel visibility preferences stored in `localStorage`.
