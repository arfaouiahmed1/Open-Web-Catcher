# syntax=docker/dockerfile:1.7

# =============================================================================
#  Open Web Catcher - application container
#  Processes: FastAPI (uvicorn)
#  Puppeteer/Chrome MCP tooling runs in a dedicated sidecar container.
# =============================================================================

FROM python:3.11-slim-bookworm

WORKDIR /app

ENV DEBIAN_FRONTEND=noninteractive \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    bash \
    curl \
    ca-certificates \
    supervisor \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

COPY pyproject.toml ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv venv .venv --python 3.11 && \
    python - <<'PY' > /tmp/requirements-dev.txt
import tomllib
from pathlib import Path

data = tomllib.loads(Path("pyproject.toml").read_text(encoding="utf-8"))
requirements = list(data["project"].get("dependencies", []))
requirements.extend(data["project"].get("optional-dependencies", {}).get("dev", []))
print("\n".join(requirements))
PY
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --python /app/.venv/bin/python -r /tmp/requirements-dev.txt

COPY src/ src/
COPY tools/puppeteer/ tools/puppeteer/
COPY configs/ configs/
COPY tests/ tests/
COPY notebooks/ notebooks/
COPY scripts/ scripts/
COPY alembic/ alembic/
COPY alembic.ini ./

RUN mkdir -p data/logs data/raw data/processed data/reports \
    && chmod +x scripts/docker/entrypoint.sh
COPY configs/supervisord.conf /etc/supervisor/conf.d/owc.conf

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    MCP_SERVER_URL=http://localhost:3000 \
    DATABASE_URL=postgresql+psycopg2://owc:owc@postgres:5432/owc \
    OBSERVABILITY_ENABLED=true \
    OBSERVABILITY_PROJECT_NAME=open-web-catcher

EXPOSE 8000

ENTRYPOINT ["scripts/docker/entrypoint.sh"]
