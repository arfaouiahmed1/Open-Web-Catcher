# syntax=docker/dockerfile:1.7

# =============================================================================
#  Open Web Catcher - app container
#  Processes: Chrome (headless), MCP server (Node), FastAPI (uvicorn), Gradio
#  PostgreSQL runs as a sidecar in docker-compose for faster builds.
# =============================================================================

FROM python:3.11-slim-bookworm

WORKDIR /app

ENV DEBIAN_FRONTEND=noninteractive \
    PUPPETEER_CACHE_DIR=/opt/puppeteer \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1

# -- System packages -----------------------------------------------------------
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    bash \
    curl \
    ca-certificates \
    gnupg \
    supervisor \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libvulkan1 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    xdg-utils

# -- Node.js 20 ---------------------------------------------------------------
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# -- uv (Python package manager) ----------------------------------------------
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# -- Python dependencies -------------------------------------------------------
# Keep this layer keyed only on pyproject.toml so source edits do not force a
# dependency reinstall.
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

# -- Node.js dependencies + Chrome for Testing --------------------------------
# Cache both npm downloads and the Chrome binary download across builds.
COPY tools_js/package*.json tools_js/
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=cache,target=/opt/puppeteer \
    cd tools_js \
    && npm install --omit=dev --prefer-offline --no-audit --no-fund \
    && npx --yes @puppeteer/browsers install chrome@stable --path /opt/puppeteer \
    && CHROME_BIN="$(find /opt/puppeteer/chrome -type f -path '*/chrome-linux64/chrome' | head -n 1)" \
    && test -n "${CHROME_BIN}" \
    && ln -sf "${CHROME_BIN}" /usr/local/bin/google-chrome-stable \
    && ln -sf /usr/local/bin/google-chrome-stable /usr/local/bin/google-chrome

# -- Application source --------------------------------------------------------
COPY src/ src/
COPY tools_js/ tools_js/
COPY configs/ configs/
COPY tests/ tests/
COPY scripts/ scripts/

# -- Runtime directories + config ---------------------------------------------
RUN mkdir -p data/logs data/raw data/processed data/reports \
    && chmod +x scripts/docker/entrypoint.sh
COPY configs/supervisord.conf /etc/supervisor/conf.d/owc.conf

# -- Environment defaults ------------------------------------------------------
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PUPPETEER_EXECUTABLE_PATH=/usr/local/bin/google-chrome-stable \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    MCP_BROWSER_MODE=isolated \
    BROWSER_WS_ENDPOINT=ws://localhost:9222 \
    MCP_SERVER_URL=http://localhost:3000 \
    DATABASE_URL=postgresql+psycopg2://owc:owc@postgres:5432/owc \
    LANGSMITH_TRACING=false \
    LANGSMITH_PROJECT=open-web-catcher \
    LANGSMITH_ENDPOINT=http://langchain-frontend:1980 \
    LANGSMITH_UI_URL=http://localhost:1980 \
    LANGCHAIN_TRACING_V2=false \
    LANGCHAIN_PROJECT=open-web-catcher

EXPOSE 8000 7860 3000

ENTRYPOINT ["scripts/docker/entrypoint.sh"]
