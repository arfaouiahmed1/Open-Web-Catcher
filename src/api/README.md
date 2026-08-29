# src/api

Owns the FastAPI surface: `app.py` (UI and workflow routes, background jobs, SSE streams), `datasets.py` (dataset sites and batches), `provider_config.py` (model and pricing settings), and `auth/` (JWT login, current user, bootstrap-admin).

Status note: auth implementation is in progress under `.omo/plans/full-audit.md` task 3 and not yet verified; `auth/` contains router, security, and dependency files for JWT login, current user, and bootstrap-admin. See [ADR-005](../../docs/adr/ADR-005-auth-model.md) for the accepted design.

Update this file when adding or changing routes, auth rules, response payloads, or background job handling.
