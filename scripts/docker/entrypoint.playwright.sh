#!/usr/bin/env bash
set -euo pipefail

log() {
    printf '[playwright-entrypoint] %s\n' "$1"
}

prepare_runtime_dirs() {
    mkdir -p /app/data/logs /app/data/raw /app/data/processed /app/data/reports
}

prepare_ubol_policy() {
    local enabled="${OWC_UBOL_ENABLED:-true}"
    case "$(printf '%s' "${enabled}" | tr '[:upper:]' '[:lower:]')" in
        1|true|yes|on) ;;
        *)
            log "uBOL disabled; skipping managed policy generation."
            return
            ;;
    esac

    local extension_dir="${OWC_UBOL_EXTENSION_DIR:-/app/tools/playwright/extensions/ubol}"
    local ruleset_details_path="${OWC_UBOL_RULESET_DETAILS_PATH:-${extension_dir}/rulesets/ruleset-details.json}"
    if [[ ! -f "${ruleset_details_path}" ]]; then
        log "uBOL ruleset details missing at ${ruleset_details_path}; skipping policy generation."
        return
    fi

    mkdir -p /etc/opt/chrome/policies/managed /etc/chromium/policies/managed
    OWC_UBOL_RULESET_DETAILS_PATH="${ruleset_details_path}" node /app/scripts/docker/generate-ubol-policy.js
}

start_shared_chrome() {
    local chrome_bin="${PLAYWRIGHT_EXECUTABLE_PATH:-/usr/local/bin/google-chrome-stable}"
    local port="${REMOTE_DEBUGGING_PORT:-9223}"
    local extension_dir="${OWC_UBOL_EXTENSION_DIR:-/app/tools/playwright/extensions/ubol}"
    local enable_ubol="${OWC_UBOL_ENABLED:-true}"
    local extension_args=()

    if [[ ! -x "${chrome_bin}" ]]; then
        log "Chrome executable not found at ${chrome_bin}."
        return 1
    fi

    case "$(printf '%s' "${enable_ubol}" | tr '[:upper:]' '[:lower:]')" in
        1|true|yes|on)
            if [[ -f "${extension_dir}/manifest.json" ]]; then
                extension_args+=("--disable-extensions-except=${extension_dir}")
                extension_args+=("--load-extension=${extension_dir}")
            else
                log "uBOL extension not found at ${extension_dir}; starting Chrome without extension."
            fi
            ;;
        *)
            log "uBOL disabled for shared Playwright Chrome."
            ;;
    esac

    log "Starting shared Chrome on port ${port}."
    "${chrome_bin}" \
        --headless=new \
        --no-sandbox \
        --disable-dev-shm-usage \
        --disable-gpu \
        --remote-debugging-port="${port}" \
        --remote-debugging-address=0.0.0.0 \
        --user-data-dir=/tmp/chrome-profile-pw \
        "${extension_args[@]}" \
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
prepare_ubol_policy
start_shared_chrome
start_mcp_server

set +e
wait -n "${CHROME_PID}" "${MCP_PID}"
exit_code=$?
set -e

log "A managed process exited unexpectedly with code ${exit_code}."
shutdown "${exit_code}"
