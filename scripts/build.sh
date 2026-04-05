#!/usr/bin/env bash
# Build the image (uses Docker layer cache)
set -euo pipefail

IMAGE="${OWC_IMAGE:-open-web-catcher}"
TAG="${OWC_TAG:-latest}"

echo "Building ${IMAGE}:${TAG} (with cache)..."
docker build -t "${IMAGE}:${TAG}" "$(dirname "$0")/.."
echo "Done: ${IMAGE}:${TAG}"
