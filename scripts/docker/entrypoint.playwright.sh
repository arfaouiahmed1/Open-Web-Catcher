#!/usr/bin/env bash
set -euo pipefail

log() {
    printf '[playwright-entrypoint] %s\n' "$1"
}

prepare_runtime_dirs() {
    mkdir -p /app/data/logs /app/data/raw /app/data/processed /app/data/reports
}

start_shared_chrome() {
    local chrome_bin="${PLAYWRIGHT_EXECUTABLE_PATH:-/usr/local/bin/google-chrome-stable}"
    local port="${REMOTE_DEBUGGING_PORT:-9223}"

    if [[ ! -x "${chrome_bin}" ]]; then
        log "Chrome executable not found at ${chrome_bin}."
        return 1
    fi

    log "Starting shared Chrome on port ${port}."
    "${chrome_bin}" \
        --headless=new \
        --no-sandbox \
        --disable-dev-shm-usage \
        --disable-gpu \
        --disable-extensions \
        --remote-debugging-port="${port}" \
        --remote-debugging-address=0.0.0.0 \
        --user-data-dir=/tmp/chrome-profile-pw \
        about:blank &
    CHROME_PID=$!
}

start_mcp_server() {
    log "Starting Playwright MCP server on port ${PORT:-3001}."
    node /app/tools/playwright/mcp-server.js &
    MCP_PID=$!
}

shutdown() {
    local exit_code="${1:-0}"

    if [[ -n "${MCP_PID:-}" ]] && kill -0 "${MCP_PID}" 2>/dev/null; then
        kill "${MCP_PID}" 2>/dev/null || true
        wait "${MCP_PID}" 2>/dev/null || true
    fi

    if [[ -n "${CHROME_PID:-}" ]] && kill -0 "${CHROME_PID}" 2>/dev/null; then
        kill "${CHROME_PID}" 2>/dev/null || true
        wait "${CHROME_PID}" 2>/dev/null || true
    fi

    exit "${exit_code}"
}

trap 'shutdown 0' SIGTERM SIGINT

prepare_runtime_dirs
start_shared_chrome
start_mcp_server

set +e
wait -n "${CHROME_PID}" "${MCP_PID}"
exit_code=$?
set -e

log "A managed process exited unexpectedly with code ${exit_code}."
shutdown "${exit_code}"
