#!/usr/bin/env bash
# Build the image.
# Usage:
#   scripts/docker/build.sh            # build with cache
#   scripts/docker/build.sh --no-cache # full fresh build
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

IMAGE="${OWC_IMAGE:-open-web-catcher}"
TAG="${OWC_TAG:-latest}"

NO_CACHE=false
if [[ "${1:-}" == "--no-cache" ]]; then
	NO_CACHE=true
	shift
fi

if [[ $# -gt 0 ]]; then
	echo "Usage: scripts/docker/build.sh [--no-cache]"
	exit 1
fi

BUILD_ARGS=()
MODE="with cache"
if [[ "${NO_CACHE}" == "true" ]]; then
	BUILD_ARGS=(--no-cache)
	MODE="no cache"
fi

echo "Building ${IMAGE}:${TAG} (${MODE})..."
docker build "${BUILD_ARGS[@]}" -t "${IMAGE}:${TAG}" "${ROOT_DIR}"
echo "Done: ${IMAGE}:${TAG}"
