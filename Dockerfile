FROM python:3.11-slim

WORKDIR /app

# System deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js (needed for subprocess calls to JS tools)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Python deps
COPY pyproject.toml .
RUN pip install --no-cache-dir -e ".[dev]"

# JS tools
COPY tools_js/ tools_js/
RUN cd tools_js && npm ci --omit=dev

# App source
COPY src/ src/
COPY configs/ configs/

# Data dirs
RUN mkdir -p data/raw data/processed data/reports data/logs

EXPOSE 7860

CMD ["python", "-m", "src.api.gradio_app"]
