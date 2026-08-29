# API Key Rotation Runbook

Operational checklist for rotating every external credential used by Open Web Catcher.
Keys live **only** in the local `.env` file (git-ignored; never committed — see
[Git history triage](#git-history-triage)). `configs/settings.yaml` holds non-secret
runtime defaults and must never contain keys.

After editing `.env`, running processes keep the old values: pydantic-settings reads
`.env` once at startup (`src/utils/config.py`, `SettingsConfigDict(env_file=".env")`).
**Restart note (applies to every provider below):**

```powershell
# Docker stack
docker compose up -d --force-recreate owc owc-web
# Local dev backend
# stop the uvicorn / `uv run` process, then start it again
```

Then verify: `curl.exe http://localhost:8000/health` and one small real run from the console.

---

## 1. Google AI Studio (Gemini)

Used for: all agent LLM calls (`GOOGLE_API_KEY`, provider `google`).

| Step | Action |
| --- | --- |
| 1 | Open <https://aistudio.google.com/apikey> |
| 2 | Create a new API key (or delete + recreate the existing one). Deleting the old key immediately invalidates it. |
| 3 | Update `.env`: `GOOGLE_API_KEY=<new-key>` |
| 4 | Restart per the note above. |

Check: launch any workflow from the console; classification must complete without auth errors in the run trace.

## 2. OpenRouter

Used for: alternate LLM provider (`OPENROUTER_API_KEY`) and local eval judge runs
(`OPENROUTER_MODEL=openai/gpt-4o-mini`); also pricing sync (`PROVIDER_PRICING_SYNC_ENABLED=true`
queries the OpenRouter models API).

| Step | Action |
| --- | --- |
| 1 | Open <https://openrouter.ai/keys> |
| 2 | Create a new key, then revoke the old one once the new key is confirmed working. |
| 3 | Update `.env`: `OPENROUTER_API_KEY=sk-or-...` (both the active line and the commented judge section if used) |
| 4 | Restart per the note above. |

Check: `GET` pricing sync log line appears on backend start, or set `LLM_PROVIDER=openrouter` temporarily and run one workflow.

## 3. NVIDIA NGC

Used for: NVIDIA-hosted model endpoints accessed through NGC credentials
(`NGC_API_KEY` / `NGC_API_BASE_URL` style env vars when an NGC-backed model is configured).

| Step | Action |
| --- | --- |
| 1 | Log in at <https://ngc.nvidia.com> → Setup → (Personal) API Keys. |
| 2 | Generate a new API key (keys are shown once — copy immediately), then revoke the old key. |
| 3 | Update `.env` with the new value in whichever `NGC_*` variable your deployment sets. |
| 4 | Restart per the note above. |

Check: one inference call against the NGC-backed model succeeds (run trace shows no 401/403).

## 4. Cloudinary

Used for: screenshot hosting of visual evidence (`CLOUDINARY_CLOUD_NAME`,
`CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, optional `CLOUDINARY_UPLOAD_PRESET`).

| Step | Action |
| --- | --- |
| 1 | Open <https://console.cloudinary.com/settings/access_keys> |
| 2 | Create a new API key/secret pair (multiple keys are allowed per cloud). |
| 3 | Update `.env`: `CLOUDINARY_API_KEY=<new>` and `CLOUDINARY_API_SECRET=<new>` (`CLOUDINARY_CLOUD_NAME` unchanged). |
| 4 | Revoke/delete the old key pair only after a successful upload with the new pair. |
| 5 | Restart per the note above. |

Check: run a workflow that captures screenshots; confirm uploads appear in the Cloudinary Media Library and evidence URLs render in run detail.

---

## Git history triage

**Date:** 2026-08-22 · **Scope:** all refs (`--all`, 156 commits) · **Method:** read-only, no rewrite performed.

Commands run:

```text
> git log --oneline --all -- .env
(no output)

> git log -p --all -- .env | findstr /i "API_KEY SECRET TOKEN"
(no output)
```

Findings:

- `.env` has **never been committed** on any branch/ref — zero commits touch it.
- Patch-level scan across full history found **no** `API_KEY` / `SECRET` / `TOKEN` material originating from `.env`.
- Repo hygiene state at triage time (Task 2 outcome): safe debris (`tmp/**` — 510 files,
  plus `data/tmp_schema_probe.py`) was untracked via `git rm --cached`; `open_web_catcher.egg-info/`
  was never tracked (already covered by `*.egg-info/`). Ignore rules were appended to `.gitignore`
  (`Report.zip`, `Report/`, `tmp/`, `data/settings.runtime.yaml`, root-scoped `/*.png`).
  Per owner mandate, `Report.zip`, everything under `Report/`, and `run-detail-email-output.png`
  **remain tracked** — thesis material gets ignore-rules only, so the rules protect against
  *future* re-adds while current blobs stay in history. Note: `git check-ignore` (git ≥2.x)
  does not report tracked paths even when a rule matches; rule validity was confirmed via
  untracked-path probes (`Report/some-new-file.tex` → `Report/`, `brandnew.png` → `/*.png`,
  `tmp/newfile.log` → `tmp/`). None of these paths contain credentials.

### Decision

**History clean — .env never committed; rotation sufficient.**
No `git filter-repo` / BFG rewrite required. Keys still present in the working `.env` should be rotated
on the normal schedule above (or immediately if any device/account compromise is suspected), but there is
no history-based exposure to mitigate. This decision closes plan item W1's history-triage condition;
revisit only if a future audit finds `.env` blobs reachable from any ref.
