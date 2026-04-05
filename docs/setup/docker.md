# Docker & Container Setup

> **See also:** [Quickstart](quickstart.md) · [Configuration](configuration.md) · [← Docs Home](../README.md)

---

## Single-Container Architecture

Everything runs in one Docker container managed by `supervisord`:

```
docker run open-web-catcher
│
├─ entrypoint.sh
│   ├─ pg_ctlcluster 15 main start    (PostgreSQL)
│   ├─ create owc role + owc database
│   └─ exec supervisord
│
└─ supervisord
    ├─ [chrome]   google-chrome-stable --headless=new --remote-debugging-port=9222
    ├─ [mcp]      node /app/tools_js/mcp-server.js                      :3000
    ├─ [api]      uvicorn src.api.app:app --port 8000                   :8000
    └─ [gradio]   python -m src.api.gradio_app                          :7860
```

### Startup Order

Supervisord assigns priorities so services start in dependency order:

| Priority | Service | Waits for | `startsecs` |
|----------|---------|-----------|-------------|
| 10 | chrome | — | 2s |
| 20 | mcp | chrome (implicit via retry) | 3s |
| 30 | api | mcp (implicit) | 5s |
| 30 | gradio | mcp (implicit) | 5s |

If Chrome or MCP crashes, supervisord automatically restarts them.

---

## `scripts/docker/` Reference

All scripts accept environment variable overrides:

```bash
OWC_IMAGE=my-registry/owc OWC_TAG=v1.2 OWC_CONTAINER=owc-prod bash scripts/docker/start.sh
```

| Script | Command | Description |
|--------|---------|-------------|
| `build.sh` | `docker build -t open-web-catcher:latest .` | Build with layer cache |
| `build.sh --no-cache` | `docker build --no-cache ...` | Full fresh build |
| `start.sh` | `docker run -d --name owc ...` | Start with volumes + env file |
| `stop.sh` | `docker stop owc` | Graceful stop |
| `restart.sh` | `docker restart owc` | Restart without rebuilding |
| `clean.sh` | Stop + remove + optionally remove image + prune cache | Full cleanup |
| `test.sh` | `docker exec owc pytest tests/` | Run test suite in running container |

### `start.sh` Details

```bash
docker run -d \
    --name owc \
    --env-file .env \
    -p 8000:8000 \
    -p 7860:7860 \
    -v ./data:/app/data \
    -v ./configs:/app/configs:ro \
    --shm-size=2g \
    --restart unless-stopped \
    open-web-catcher:latest
```

Key flags:
- `--shm-size=2g` — Chrome requires shared memory; the default 64MB causes crashes
- `-v ./data:/app/data` — PostgreSQL data, logs, and raw outputs survive container restarts
- `-v ./configs:/app/configs:ro` — Swap prompts and settings without rebuilding

### `test.sh` Details

```bash
# Run all tests
bash scripts/docker/test.sh

# Run specific file
bash scripts/docker/test.sh tests/test_agents.py

# Filter by name
bash scripts/docker/test.sh -k "classification"

# With coverage
bash scripts/docker/test.sh --cov=src --cov-report=term-missing
```

Tests run inside the running container against the real PostgreSQL database
(using `sqlite:///:memory:` override in conftest.py fixtures).

---

## Dockerfile Walkthrough

```dockerfile
FROM python:3.11-bookworm
```
Debian bookworm base — matches the PostgreSQL 15 apt repo and Chrome's glibc requirements.

```dockerfile
RUN apt-get install -y supervisor postgresql-15 [chrome deps...]
```
- `supervisor` — manages all 4 processes
- `postgresql-15` — Debian package, pre-initialises the `main` cluster
- Chrome native libs — libatk, libgbm, libnss3, etc. required by Chrome headless

```dockerfile
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
RUN apt-get install -y nodejs
```
Node.js 20 LTS via NodeSource — needed for the MCP server.

```dockerfile
RUN wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
RUN apt-get install -y ./google-chrome-stable_current_amd64.deb
```
Google Chrome stable (not Chromium) — full browser, same as user-facing Chrome.
Puppeteer-core connects to it via CDP WebSocket at `ws://localhost:9222`.

```dockerfile
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
```
uv binary copied from its official image — no pip, no virtualenv overhead.

```dockerfile
RUN uv venv .venv --python 3.11 && \
    uv pip install --python .venv/bin/python -e ".[dev]"
```
Creates `/app/.venv` with all Python deps. Installing in editable mode (`-e`) means
source code changes don't require reinstalling.

```dockerfile
COPY tools_js/package*.json tools_js/
RUN cd tools_js && npm ci --omit=dev
```
`npm ci` (not `npm install`) for reproducible installs from `package-lock.json`.
`--omit=dev` skips dev dependencies in production.

```dockerfile
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
```
Tells puppeteer-core where Chrome is. `SKIP_CHROMIUM_DOWNLOAD=true` prevents
puppeteer from trying to download its own Chromium (which would fail without internet).

```dockerfile
COPY configs/supervisord.conf /etc/supervisor/conf.d/owc.conf
```
Debian's supervisord reads `/etc/supervisor/conf.d/*.conf` by default.

---

## `configs/supervisord.conf`

Key settings for each program:

```ini
[program:chrome]
command=google-chrome-stable --headless=new --no-sandbox --disable-dev-shm-usage
        --disable-gpu --remote-debugging-port=9222 --remote-debugging-address=0.0.0.0
        about:blank
priority=10
autorestart=true
```

`--no-sandbox` is required when running as root inside Docker.
`--disable-dev-shm-usage` prevents crashes on containers with limited `/dev/shm`.
`about:blank` keeps Chrome alive without loading a page.

```ini
[program:mcp]
command=node /app/tools_js/mcp-server.js
priority=20
startsecs=3      # give Chrome 3s to start before MCP tries to connect
startretries=5
```

```ini
[program:api]
command=/app/.venv/bin/uvicorn src.api.app:app --host 0.0.0.0 --port 8000
priority=30
startsecs=5
```

---

## Volumes

| Host path | Container path | Description |
|-----------|---------------|-------------|
| `./data` | `/app/data` | PostgreSQL data, logs, raw outputs |
| `./configs` | `/app/configs` | Agent prompts + settings.yaml (read-only) |

Data persists across container restarts because `./data` is on the host.
The PostgreSQL cluster lives at `/var/lib/postgresql/15/main` **inside** the container — 
if you want Postgres data to survive `docker rm`, add a volume for it:

```bash
docker run ... -v ./pgdata:/var/lib/postgresql/15/main ...
```

---

## docker-compose.yml

```yaml
services:
  owc:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: owc
    shm_size: "2gb"
    ports:
      - "8000:8000"
      - "7860:7860"
    env_file: .env
    environment:
      BROWSER_WS_ENDPOINT: ws://localhost:9222
      MCP_SERVER_URL: http://localhost:3000
      DATABASE_URL: postgresql+psycopg2://owc:owc@localhost:5432/owc
      LANGCHAIN_TRACING_V2: "true"
    volumes:
      - ./data:/app/data
      - ./configs:/app/configs:ro
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
      start_period: 30s
```

```bash
# Build + start via compose
docker compose up --build

# Or use the scripts (which don't require compose)
bash scripts/docker/build.sh && bash scripts/docker/start.sh
```

---

## Debugging Inside the Container

```bash
# Live logs from all processes
docker exec owc supervisorctl tail -f mcp
docker exec owc supervisorctl tail -f api
docker exec owc tail -f data/logs/chrome.log

# Check process status
docker exec owc supervisorctl status

# Interactive shell
docker exec -it owc bash

# Restart a single process without restarting the container
docker exec owc supervisorctl restart mcp

# Check PostgreSQL
docker exec owc psql -U owc -d owc -c "SELECT count(*) FROM runs;"
```

---

*Next: [Quickstart](quickstart.md) | [Configuration](configuration.md)*
