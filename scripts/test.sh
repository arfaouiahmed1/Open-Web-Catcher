#!/usr/bin/env bash
# Run pytest inside the running OWC container.
# Usage:
#   scripts/test.sh                   — run all tests
#   scripts/test.sh tests/test_agents.py  — run a specific file
#   scripts/test.sh -k "classification"  — pytest -k filter
set -euo pipefail

CONTAINER="${OWC_CONTAINER:-owc}"

if ! docker ps -q -f name="^${CONTAINER}$" | grep -q .; then
    echo "Container '${CONTAINER}' is not running. Start it first with scripts/start.sh"
    exit 1
fi

PYTEST_ARGS=("${@:-tests/}")

echo "Running tests in '${CONTAINER}': pytest ${PYTEST_ARGS[*]}"
docker exec -it "${CONTAINER}" \
    /app/.venv/bin/pytest "${PYTEST_ARGS[@]}" \
        --tb=short \
        -v \
        --asyncio-mode=auto
