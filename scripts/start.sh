#!/usr/bin/env bash
# Start (or re-create) the OWC container from a .env file
set -euo pipefail

CONTAINER="${OWC_CONTAINER:-owc}"
IMAGE="${OWC_IMAGE:-open-web-catcher}"
TAG="${OWC_TAG:-latest}"
ENV_FILE="$(dirname "$0")/../.env"
DATA_DIR="$(dirname "$0")/../data"
CONFIGS_DIR="$(dirname "$0")/../configs"

# Stop existing container if running
if docker ps -q -f name="^${CONTAINER}$" | grep -q .; then
    echo "Stopping existing container '${CONTAINER}'..."
    docker stop "${CONTAINER}"
fi

# Remove stopped container with the same name
if docker ps -aq -f name="^${CONTAINER}$" | grep -q .; then
    docker rm "${CONTAINER}"
fi

mkdir -p "${DATA_DIR}"

ENV_ARGS=()
if [ -f "${ENV_FILE}" ]; then
    ENV_ARGS=(--env-file "${ENV_FILE}")
fi

echo "Starting container '${CONTAINER}' from ${IMAGE}:${TAG}..."
docker run -d \
    --name "${CONTAINER}" \
    "${ENV_ARGS[@]}" \
    -p 8000:8000 \
    -p 7860:7860 \
    -v "${DATA_DIR}:/app/data" \
    -v "${CONFIGS_DIR}:/app/configs:ro" \
    --shm-size=2g \
    --restart unless-stopped \
    "${IMAGE}:${TAG}"

echo "Container '${CONTAINER}' started."
echo "  FastAPI  → http://localhost:8000"
echo "  Gradio   → http://localhost:7860"
echo "  API docs → http://localhost:8000/docs"
