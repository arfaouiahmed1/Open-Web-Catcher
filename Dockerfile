# =============================================================================
#  Open Web Catcher — single-container build
#  Processes: PostgreSQL 15 · Chrome (headless) · MCP server (Node) ·
#             FastAPI (uvicorn) · Gradio dashboard
#  Python managed by uv  |  JS managed by npm
# =============================================================================

FROM python:3.11-bookworm

# ── System packages ───────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    # utilities
    curl wget ca-certificates gnupg lsb-release procps \
    # process supervisor
    supervisor \
    # PostgreSQL 15
    postgresql-15 postgresql-client-15 \
    # Chrome / Puppeteer native deps
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
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# ── Node.js 20 ────────────────────────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# ── Google Chrome stable ──────────────────────────────────────────────────────
# ── uv (Python package manager) ───────────────────────────────────────────────
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app

ENV PUPPETEER_CACHE_DIR=/opt/puppeteer

# ── Python deps (cached layer — only re-runs when pyproject.toml changes) ────
COPY pyproject.toml .
COPY src/        src/
RUN uv venv .venv --python 3.11 && \
    uv pip install --python .venv/bin/python -e ".[dev]"

# ── Node.js deps ──────────────────────────────────────────────────────────────
COPY tools_js/package*.json tools_js/
RUN cd tools_js && npm install --omit=dev \
    && npx --yes @puppeteer/browsers@latest install chrome@stable --path "${PUPPETEER_CACHE_DIR}" \
    && CHROME_BIN="$(find "${PUPPETEER_CACHE_DIR}/chrome" -type f -path '*/chrome-linux64/chrome' | head -n 1)" \
    && test -n "${CHROME_BIN}" \
    && ln -sf "${CHROME_BIN}" /usr/local/bin/google-chrome-stable \
    && ln -sf /usr/local/bin/google-chrome-stable /usr/local/bin/google-chrome

# ── Application source ────────────────────────────────────────────────────────
COPY tools_js/   tools_js/
COPY configs/    configs/
COPY tests/      tests/
COPY scripts/    scripts/

# ── Runtime directories ───────────────────────────────────────────────────────
RUN mkdir -p data/logs data/raw data/processed data/reports \
    && chmod +x scripts/docker/entrypoint.sh

# ── Supervisord config ────────────────────────────────────────────────────────
COPY configs/supervisord.conf /etc/supervisor/conf.d/owc.conf

# ── Environment defaults (all can be overridden at runtime) ──────────────────
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    # Chrome path for Puppeteer
    PUPPETEER_EXECUTABLE_PATH=/usr/local/bin/google-chrome-stable \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    MCP_BROWSER_MODE=isolated \
    # Internal service URLs (Chrome + MCP run in same container)
    BROWSER_WS_ENDPOINT=ws://localhost:9222 \
    MCP_SERVER_URL=http://localhost:3000 \
    # PostgreSQL (local, managed by supervisord)
    DATABASE_URL=postgresql+psycopg2://owc:owc@localhost:5432/owc \
    # LangSmith tracing enabled by default — set LANGSMITH_API_KEY to activate
    LANGSMITH_TRACING=true \
    LANGSMITH_PROJECT=open-web-catcher \
    LANGSMITH_ENDPOINT=https://api.smith.langchain.com \
    LANGCHAIN_TRACING_V2=true \
    LANGCHAIN_PROJECT=open-web-catcher

# ── Ports ─────────────────────────────────────────────────────────────────────
EXPOSE 8000 7860 3000

ENTRYPOINT ["scripts/docker/entrypoint.sh"]
