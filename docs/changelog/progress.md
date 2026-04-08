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
