#!/usr/bin/env bash
# Stop + remove the OWC container and its anonymous volumes.
# Prompts before removing data volume mount (it's on the host, not a Docker volume).
set -euo pipefail

CONTAINER="${OWC_CONTAINER:-owc}"
IMAGE="${OWC_IMAGE:-open-web-catcher}"
TAG="${OWC_TAG:-latest}"

# Stop
if docker ps -q -f name="^${CONTAINER}$" | grep -q .; then
    echo "Stopping '${CONTAINER}'..."
    docker stop "${CONTAINER}"
fi

# Remove container
if docker ps -aq -f name="^${CONTAINER}$" | grep -q .; then
    echo "Removing container '${CONTAINER}'..."
    docker rm -v "${CONTAINER}"
fi

# Optionally remove the image
read -r -p "Remove image ${IMAGE}:${TAG} as well? [y/N] " ans
if [[ "${ans}" =~ ^[Yy]$ ]]; then
    docker rmi "${IMAGE}:${TAG}" 2>/dev/null && echo "Image removed." || echo "Image not found."
fi

# Optionally prune dangling build cache
read -r -p "Prune Docker build cache? [y/N] " ans2
if [[ "${ans2}" =~ ^[Yy]$ ]]; then
    docker builder prune -f
fi

echo "Clean complete."
