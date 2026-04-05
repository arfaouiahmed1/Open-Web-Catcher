#!/usr/bin/env bash
# Run pytest inside the running OWC container.
# Usage:
#   scripts/docker/test.sh                   - run all tests
#   scripts/docker/test.sh tests/test_agents.py  - run a specific file
#   scripts/docker/test.sh -k "classification"  - pytest -k filter
set -euo pipefail

CONTAINER="${OWC_CONTAINER:-owc}"

if ! docker ps -q -f name="^${CONTAINER}$" | grep -q .; then
    echo "Container '${CONTAINER}' is not running. Start it first with scripts/docker/start.sh"
    exit 1
fi

PYTEST_ARGS=("${@:-tests/}")

DOCKER_EXEC_ARGS=(-i)
if [ -t 0 ] && [ -t 1 ]; then
    DOCKER_EXEC_ARGS=(-it)
fi

echo "Running tests in '${CONTAINER}': pytest ${PYTEST_ARGS[*]}"
docker exec "${DOCKER_EXEC_ARGS[@]}" "${CONTAINER}" \
    /app/.venv/bin/pytest "${PYTEST_ARGS[@]}" \
        --tb=short \
        -v \
        --asyncio-mode=auto
