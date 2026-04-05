#!/usr/bin/env bash
# Restart the OWC container
set -euo pipefail

CONTAINER="${OWC_CONTAINER:-owc}"

if docker ps -aq -f name="^${CONTAINER}$" | grep -q .; then
    echo "Restarting '${CONTAINER}'..."
    docker restart "${CONTAINER}"
    echo "Restarted."
else
    echo "Container '${CONTAINER}' not found — run scripts/start.sh first."
    exit 1
fi
