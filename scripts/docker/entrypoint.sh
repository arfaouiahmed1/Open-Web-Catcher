#!/usr/bin/env bash
set -euo pipefail

log() {
    printf '[entrypoint] %s\n' "$1"
}

prepare_runtime_dirs() {
    log "Preparing runtime directories."
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

        local extension_dir="${OWC_UBOL_EXTENSION_DIR:-/app/tools/puppeteer/extensions/ubol}"
        local ruleset_details_path="${OWC_UBOL_RULESET_DETAILS_PATH:-${extension_dir}/rulesets/ruleset-details.json}"
        if [[ ! -f "${ruleset_details_path}" ]]; then
                log "uBOL ruleset details missing at ${ruleset_details_path}; skipping policy generation."
                return
        fi

        mkdir -p /etc/opt/chrome/policies/managed /etc/chromium/policies/managed
        OWC_UBOL_RULESET_DETAILS_PATH="${ruleset_details_path}" node /app/scripts/docker/generate-ubol-policy.js
}

prepare_runtime_dirs
prepare_ubol_policy

log "Handing off to supervisord."
exec /usr/bin/supervisord -n -c /etc/supervisor/supervisord.conf
