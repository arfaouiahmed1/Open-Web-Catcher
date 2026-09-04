# API Reference

The Open Web Catcher backend exposes a RESTful API built on FastAPI. Complete interactive documentation is accessible at `http://localhost:8000/docs` (Swagger UI) and `http://localhost:8000/redoc`.

---

## Core Endpoints

### Pipeline & Execution
- `POST /ui/workflows/run` — Launch a full autonomous pipeline run against a target URL.
- `POST /ui/agents/test` — Run a single agent in isolation against a URL.
- `POST /ui/runs/{run_id}/cancel` — Gracefully stop an in-flight pipeline run.
- `DELETE /ui/runs/{run_id}` — Delete a run record and its associated artifacts.

### Telemetry & Real-Time Streaming
- `GET /ui/runs/{run_id}` — Retrieve complete normalized run data, timeline, stream URLs, and diagnostics.
- `GET /ui/runs/{run_id}/stream` — Server-Sent Events (SSE) feed emitting real-time agent execution events.
- `GET /ui/overview` — Aggregated 7-day metrics, outcome breakdowns, model spend, and tool stats.

### Dataset Management
- `GET /api/datasets/sites` — List and filter cataloged streaming sites.
- `POST /api/datasets/sites` — Add or upsert a new target website.
- `POST /api/datasets/sites/health-check` — Probe site reachability and detect parked/anti-bot states.
- `POST /api/datasets/sites/bulk-update` — Update labels, languages, or operator notes across multiple sites.
- `POST /api/datasets/sites/bulk-delete` — Batch remove target sites from the dataset.
- `POST /api/datasets/batches` — Queue a batch execution across multiple cataloged sites.

### Settings & Model Configuration
- `GET /ui/config` — Get active provider, model routing, caching policies, and browser settings.
- `PUT /ui/config` — Update and persist runtime configurations into `settings.runtime.yaml`.
- `GET /ui/providers/models` — Query live provider model catalogs and pricing metadata.
