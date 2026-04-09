# Migration Notes

This repository now uses:

- Next.js for the operator console
- internal observability instead of external tracing
- Postgres-backed pricing and evaluation storage

## Delivered

- Removed the old interactive dashboard implementation
- Removed the previous external tracing integration
- Added SSE-backed live run streaming
- Added KPI, runs, pricing, evaluations, and DB explorer screens
- Added persisted evaluation suites and scoring
- Added first-party token and cost reporting
- Updated Docker topology to run the web console separately

## 2026-04-08 Debugging Report

- Added full incident report for agent/runtime debugging, MCP fixes, schema compatibility, and quota handling:
	- [Agent Debugging and Fixes](./2026-04-08-agent-debugging-and-fixes.md)

## 2026-04-09 Architecture and Follow-up Report

- Added full architecture deep dive with diagrams for orchestrator routing, handoff context, extraction normalization, provider/email stages, and Gemini cache lifecycle:
	- [Implementation Deep Dive (2026-04-09)](../architecture/implementation-deep-dive-2026-04-09.md)
- Added issue-by-issue postmortem and future roadmap:
	- [Issues, Fixes, and Future Improvements (2026-04-09)](./2026-04-09-issues-fixes-future-improvements.md)
