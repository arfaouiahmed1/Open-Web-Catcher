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

        OWC_UBOL_RULESET_DETAILS_PATH="${ruleset_details_path}" node <<'NODE'
const fs = require('node:fs');

const extensionId = 'ddkjiahejlhfcafbddmgiahcphecmpfh';
const rulesetDetailsPath = process.env.OWC_UBOL_RULESET_DETAILS_PATH;
const defaultFilteringRaw = String(process.env.OWC_UBOL_DEFAULT_FILTERING || 'complete').trim().toLowerCase();
const validModes = new Set(['none', 'basic', 'optimal', 'complete']);
const defaultFiltering = validModes.has(defaultFilteringRaw) ? defaultFilteringRaw : 'complete';

const parsed = JSON.parse(fs.readFileSync(rulesetDetailsPath, 'utf8'));
const ruleIds = Array.from(new Set(
    (Array.isArray(parsed) ? parsed : [])
        .map((entry) => (entry && typeof entry.id === 'string' ? entry.id.trim() : ''))
        .filter(Boolean),
));

const allowlistHosts = String(process.env.OWC_ADBLOCK_ALLOWLIST_HOSTS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

const policy = {
    '3rdparty': {
        extensions: {
            [extensionId]: {
                defaultFiltering,
                disableFirstRunPage: true,
                strictBlockMode: true,
                showBlockedCount: true,
                rulesets: ['-*', '+default', ...ruleIds.map((id) => `+${id}`)],
                ...(allowlistHosts.length ? { noFiltering: allowlistHosts } : {}),
            },
        },
    },
};

const payload = `${JSON.stringify(policy, null, 2)}\n`;
for (const destination of [
    '/etc/opt/chrome/policies/managed/ubol.json',
    '/etc/chromium/policies/managed/ubol.json',
]) {
    fs.writeFileSync(destination, payload, 'utf8');
}

console.log(`[entrypoint] Generated uBOL managed policy with ${ruleIds.length} rulesets (mode=${defaultFiltering}).`);
NODE
}

prepare_runtime_dirs
prepare_ubol_policy

log "Handing off to supervisord."
exec /usr/bin/supervisord -n -c /etc/supervisor/supervisord.conf
