#!/usr/bin/env bash
# Build the image (no Docker layer cache — full fresh build)
set -euo pipefail

IMAGE="${OWC_IMAGE:-open-web-catcher}"
TAG="${OWC_TAG:-latest}"

echo "Building ${IMAGE}:${TAG} (no cache)..."
docker build --no-cache -t "${IMAGE}:${TAG}" "$(dirname "$0")/.."
echo "Done: ${IMAGE}:${TAG}"
