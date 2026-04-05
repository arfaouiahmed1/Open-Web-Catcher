#!/usr/bin/env bash
# Stop the OWC container
set -euo pipefail

CONTAINER="${OWC_CONTAINER:-owc}"

if docker ps -q -f name="^${CONTAINER}$" | grep -q .; then
    echo "Stopping '${CONTAINER}'..."
    docker stop "${CONTAINER}"
    echo "Stopped."
else
    echo "Container '${CONTAINER}' is not running."
fi
