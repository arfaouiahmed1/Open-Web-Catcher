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
    local headless="${OWC_BROWSER_HEADLESS:-true}"
    local extension_args=()
    local chrome_cmd=()

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

    case "$(printf '%s' "${headless}" | tr '[:upper:]' '[:lower:]')" in
        1|true|yes|on)
            chrome_cmd=("${chrome_bin}" "--headless=new")
            ;;
        *)
            log "Headed Chrome requested; launching under Xvfb."
            chrome_cmd=(xvfb-run -a --server-args="-screen 0 ${OWC_XVFB_SCREEN:-1280x800x24}" "${chrome_bin}")
            ;;
    esac

    log "Starting shared Chrome on port ${port}."
    "${chrome_cmd[@]}" \
        --no-sandbox \
        --disable-dev-shm-usage \
        --disable-gpu \
        --remote-debugging-port="${port}" \
        --remote-debugging-address="${REMOTE_DEBUGGING_ADDRESS:-127.0.0.1}" \
        --user-data-dir=/tmp/chrome-profile-pw \
        "${extension_args[@]}" \
        about:blank &
    CHROME_PID=$!
}

start_cdp_proxy() {
    local source_port="${REMOTE_DEBUGGING_PORT:-9223}"
    local proxy_port="${REMOTE_DEBUGGING_PROXY_PORT:-9224}"
    # Chromium in this image keeps CDP on loopback even with
    # --remote-debugging-address=0.0.0.0. Export a separate container-network
    # port instead of weakening the Chrome listener itself.
    log "Proxying shared Chrome CDP ${source_port} -> ${proxy_port}."
    socat "TCP-LISTEN:${proxy_port},fork,reuseaddr,bind=0.0.0.0" "TCP:127.0.0.1:${source_port}" &
    CDP_PROXY_PID=$!
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

    if [[ -n "${CDP_PROXY_PID:-}" ]] && kill -0 "${CDP_PROXY_PID}" 2>/dev/null; then
        kill "${CDP_PROXY_PID}" 2>/dev/null || true
        wait "${CDP_PROXY_PID}" 2>/dev/null || true
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
start_cdp_proxy
start_mcp_server

set +e
wait -n "${CHROME_PID}" "${CDP_PROXY_PID}" "${MCP_PID}"
exit_code=$?
set -e

log "A managed process exited unexpectedly with code ${exit_code}."
shutdown "${exit_code}"
