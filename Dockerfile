# syntax=docker/dockerfile:1.7

# =============================================================================
#  Open Web Catcher - application container
#  Processes: FastAPI (uvicorn)
#  Puppeteer/Chrome MCP tooling runs in a dedicated sidecar container.
# =============================================================================

# Base pinned to the python 3.11 minor on slim-bookworm.
# Digest pin placeholder (resolve with: docker buildx imagetools inspect python:3.11-slim-bookworm
# then append @sha256:<digest> to the FROM line below):
#   python:3.11-slim-bookworm@sha256:<TO_FILL_AFTER_VERIFYING>
FROM python:3.14-slim-bookworm

ARG BUILDKIT_INLINE_CACHE=1

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

# CVE hygiene (plan T47): full OS upgrade so the published image ships the
# current Debian bookworm security point-release (2C/8H were base-inherited).
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

# Non-root runtime user. Created after the root-requiring installs above;
# everything below that still needs root runs before `USER app`.
RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --home-dir /home/app --create-home --shell /bin/bash app

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

COPY pyproject.toml uv.lock ./
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
COPY tools/playwright/ tools/playwright/
COPY tools/shared/ tools/shared/
COPY configs/ configs/
COPY datasets/ datasets/
COPY scripts/ scripts/
COPY alembic/ alembic/
COPY alembic.ini ./

# Runtime-writable paths owned by app: data tree (logs/raw/processed/reports,
# runtime settings, screenshots, datasets output), supervisord pidfile
# (configs/supervisord.conf writes /var/run/supervisord.pid), and the Chrome
# managed-policy dirs the entrypoint may populate via prepare_ubol_policy().
RUN mkdir -p data/logs data/raw data/processed data/reports \
    && chmod +x scripts/docker/entrypoint.sh \
    && touch /var/run/supervisord.pid \
    && chown app:app /var/run/supervisord.pid \
    && mkdir -p /etc/opt/chrome/policies/managed /etc/chromium/policies/managed \
    && chown -R app:app /etc/opt/chrome /etc/chromium \
    && chown -R app:app /app/data
COPY configs/supervisord.conf /etc/supervisor/conf.d/owc.conf

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    MCP_SERVER_URL=http://localhost:3000 \
    OBSERVABILITY_ENABLED=true \
    OBSERVABILITY_PROJECT_NAME=open-web-catcher

EXPOSE 8000

USER app

ENTRYPOINT ["scripts/docker/entrypoint.sh"]
