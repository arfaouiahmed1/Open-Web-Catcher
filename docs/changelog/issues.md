# Issues & Resolutions

> Log of bugs, architectural mistakes, and non-obvious problems encountered during the build.
> Each entry: what happened, why it happened, how it was fixed.
> **[← Docs Home](../README.md)** · [Progress Log](progress.md)

---

## Issue 001 — Git Push Non-Fast-Forward

**When:** Phase 1, first push after scaffold generation.

**Symptom:**
```
! [rejected] main -> main (non-fast-forward)
error: failed to push some refs to 'https://github.com/...'
hint: Updates were rejected because the remote contains work that you do
hint: not have locally.
```

**Root cause:** GitHub had auto-generated a README.md commit when the repository was created.
The local commit history didn't include it, making the remote ahead of local.

**Fix:**
```bash
git pull --rebase origin main

# Conflict in README.md — keep our version
git checkout --ours README.md
git add README.md

# Continue the rebase without opening an editor
GIT_EDITOR=true git rebase --continue

git push origin main
```

**Lesson:** Always create GitHub repos empty (no README/LICENSE auto-generation) when
the project already has its own README.

---

## Issue 002 — Pylance: Unused Import `tool`

**When:** Phase 4, after adding `run_agent_loop` to orchestrator.

**Symptom:** Pylance warning in `src/agents/orchestrator.py`:
```
"tool" is imported but unused (reportUnusedImport)
```

**Root cause:** Copy-paste from another module left `tool` in the import:
```python
from langchain_core.tools import BaseTool, tool  # 'tool' not needed
```

**Fix:** Remove `tool` from the import:
```python
from langchain_core.tools import BaseTool
```

---

## Issue 003 — Pylance: `*a, **kw` Signature Warnings in `_arun`

**When:** Phase 4, first version of orchestrator sub-agent tool wrappers.

**Symptom:** Pylance complained about `_arun` signature not matching `BaseTool`:
```python
async def _arun(self, *a, **kw) -> Any:
    raise NotImplementedError
# → Pylance: Parameter name should be '*args' not '*a'
```

**Attempts:**
1. `*_args, **_kwargs` — still warned about naming
2. `*_, **__` — Pylance accepted but considered bad style
3. `async def _arun(self)` (no params) — accepted but then broken once we needed it to actually work

**Final fix (Phase 6):** Made `_arun` actually work with the correct signature:
```python
async def _arun(self, url: str) -> str:
    result = await HostingPageAgent(self.settings).run(url=url)
    return result.model_dump_json()
```
The warning disappeared because the method now has a real, valid signature.

---

## Issue 004 — Unused Variable `pipeline_data`

**When:** Phase 4, `_build_pipeline_result` refactor.

**Symptom:** Pylance warning:
```python
pipeline_data = _parse_pipeline_data(messages)
# Assigned but never used
```

**Root cause:** During refactoring, the variable assignment was left in after the logic
was inlined into `_build_pipeline_result`.

**Fix:** Removed the intermediate variable, inlined the logic directly.

---

## Issue 005 — Unused `data` Parameter in `_parse_pipeline_data`

**When:** Phase 4, same refactor as Issue 004.

**Symptom:** `data` parameter was declared but the function body didn't use it.

**Fix:** Removed the parameter, updated the call site to not pass it.

---

## Issue 006 — SQLite `check_same_thread` Incompatible with PostgreSQL

**When:** Phase 7, switching from SQLite to PostgreSQL in the single container.

**Symptom:** SQLAlchemy error when using PostgreSQL:
```
TypeError: argument 'check_same_thread' is not available for PostgreSQL dialect
```

**Root cause:** `database.py` had:
```python
engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
```
`check_same_thread=False` is a SQLite-specific arg. PostgreSQL doesn't recognise it.

**Fix:** Made `connect_args` conditional on dialect:
```python
_is_sqlite = DATABASE_URL.startswith("sqlite")
_connect_args = {"check_same_thread": False} if _is_sqlite else {}
engine = create_engine(DATABASE_URL, connect_args=_connect_args)
```

---

## Issue 007 — Gradio Handlers Not Working with Async Agents

**When:** Phase 7, after converting all agents to async.

**Symptom:** Gradio button clicks in `gradio_app.py` hung indefinitely because
the handlers called `agent.run()` which was now `async` but the handlers were sync.

**Root cause:** Gradio handlers are synchronous functions. Before Phase 6, `agent.run()` 
was sync. After the async conversion, calling `agent.run()` in a sync context returned
a coroutine object instead of executing it.

**Fix:** Wrapped all agent calls with `asyncio.run()`:
```python
def _run_hosting(url: str) -> str:
    result = asyncio.run(HostingPageAgent(settings).run(url=url.strip()))
    return result.model_dump_json(indent=2)
```

This is safe in Gradio because each button click runs in a separate thread — there's
no outer event loop in the thread to conflict with `asyncio.run()`.

---

## Issue 008 — Shell Scripts CRLF Line Endings on Windows

**When:** Phase 7, after creating `scripts/*.sh`.

**Symptom:** Git showed CRLF warnings for `.sh` files:
```
warning: in the working copy of 'scripts/docker/entrypoint.sh', LF will be replaced by CRLF
```

If committed with CRLF endings, shell scripts fail inside the Linux container:
```bash
/bin/bash: bad interpreter: No such file or directory
# (because the shebang line has \r at the end)
```

**Fix:** Added `.gitattributes` to force LF for shell scripts:
```
*.sh text eol=lf
scripts/docker/*.sh text eol=lf
```

Also ran `git update-index --chmod=+x scripts/*.sh` to mark scripts as executable
in the git index (important for Linux containers where the execute bit matters).

---

## Issue 009 — Dockerfile.tools `CMD` Was `node --version`

**When:** Phase 7, reviewing `Dockerfile.tools` for the single-container migration.

**Symptom:** The old `Dockerfile.tools` had `CMD ["node", "--version"]` — a diagnostic
command, not a server. When Docker ran it as a container process, it would print the
Node.js version and immediately exit.

**Root cause:** `Dockerfile.tools` was originally designed for a separate container
where the tools were called via subprocess (not as a persistent server). The CMD
was a placeholder.

**Fix:** Updated CMD to start the MCP server and added EXPOSE:
```dockerfile
EXPOSE 3000
CMD ["node", "mcp-server.js"]
```

---

## Issue 010 — `docker-compose.yml` Missing `MCP_SERVER_URL` for App Service

**When:** Phase 6, wiring up the Python app to use the MCP server.

**Symptom:** Python agents were connecting to `http://localhost:3000` (the default)
which works inside the single container, but the old multi-container compose file
had the `tools` service on a different Docker network host.

**Root cause:** The `app` service in `docker-compose.yml` didn't have `MCP_SERVER_URL`
set to the `tools` service name. Inside Docker networks, services are reachable by
their service name, not `localhost`.

**Fix (multi-container, now obsolete):** Added `MCP_SERVER_URL=http://tools:3000`.
**Fix (single-container, current):** All services are on `localhost` inside the container.
`MCP_SERVER_URL=http://localhost:3000` is the correct default.

---

## Issue 011 — Chrome `--disable-dev-shm-usage` Required in Container

**When:** Phase 7, first attempts to run Chrome inside Docker.

**Symptom:** Chrome crashed silently or failed to start:
```
[ERROR:zygote_main_linux.cc] Failed to fork child process
```
or pages loaded blank with no content.

**Root cause:** Docker containers have a default `/dev/shm` (shared memory) size of 64MB.
Chrome requires significantly more shared memory for its renderer processes.

**Fixes applied:**
1. `--disable-dev-shm-usage` flag in the supervisord Chrome command — makes Chrome use
   `/tmp` instead of `/dev/shm`
2. `--shm-size=2g` in `docker run` / `docker-compose.yml` — increases the container's
   shared memory to 2GB

Both are needed: the flag prevents crashes during normal operation; the shm-size
prevents crashes during heavy rendering (multiple iframes, video players).

---

## Issue 012 — PostgreSQL Startup Race Condition in supervisord

**When:** Phase 7, integrating PostgreSQL into the container.

**Symptom:** API and Gradio started before PostgreSQL was ready, causing:
```
sqlalchemy.exc.OperationalError: could not connect to server: Connection refused
```

**Root cause:** supervisord starts processes by priority but doesn't wait for a process
to be "ready" — only for its process to be alive. PostgreSQL takes 2-3 seconds to
initialise before it accepts connections.

**Fix:** PostgreSQL is started in `scripts/docker/entrypoint.sh` **before** supervisord:
```bash
pg_ctlcluster 15 main start
# wait for pg_isready (up to 20 attempts)
for i in $(seq 1 20); do
    su -c "pg_isready -q" postgres && break
    sleep 1
done
# then exec supervisord
exec supervisord -n -c /etc/supervisor/supervisord.conf
```

This guarantees PostgreSQL is accepting connections before any Python service starts.

---

## Issue 013 — `psycopg2-binary` Not in Original Dependencies

**When:** Phase 7, first run of FastAPI with PostgreSQL.

**Symptom:**
```
ModuleNotFoundError: No module named 'psycopg2'
```

**Root cause:** The original `pyproject.toml` had `sqlalchemy` but no PostgreSQL driver.
SQLite works without a driver (built into Python), so this wasn't caught earlier.

**Fix:** Added to `pyproject.toml`:
```toml
"psycopg2-binary>=2.9",
```
Using the binary wheel (`psycopg2-binary`) avoids needing `libpq-dev` and a C compiler
at build time.

---

## Issue 014 — ESM Modules Required for MCP SDK

**When:** Phase 3, first implementation of the MCP server.

**Symptom:** `@modelcontextprotocol/sdk` import failed in CommonJS context:
```
Error [ERR_REQUIRE_ESM]: require() of ES Module .../node_modules/@modelcontextprotocol/sdk/...
```

**Root cause:** `@modelcontextprotocol/sdk` is an ES Module. CommonJS `require()` cannot
import ES Modules directly.

**Fix:** Converted all `tools_js/` files to ES Modules:
```json
// package.json
{
  "type": "module"
}
```
All `require()` calls changed to `import` statements, all `module.exports` to `export`.

**Impact:** All shared utilities in `tools_js/shared/` also had to be converted.
`@ghostery/adblocker-puppeteer` was already ESM-compatible.

---

*See [Progress Log](progress.md) for the full build history.*
