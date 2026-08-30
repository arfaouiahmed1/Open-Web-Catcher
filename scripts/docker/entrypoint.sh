#!/usr/bin/env bash
set -euo pipefail

log() {
    printf '[entrypoint] %s\n' "$1"
}

prepare_runtime_dirs() {
    log "Preparing runtime directories."
    mkdir -p /app/data/logs /app/data/raw /app/data/processed /app/data/reports
}

# uBOL managed-policy generation moved to the owc-tools-playwright image,
# which owns the extension assets and ships Node. This API image is
# node-free by design (playwright-only consolidation, plan T22/ADR-003),
# so we only keep the runtime-dir preparation here.
prepare_runtime_dirs

log "Handing off to supervisord."
exec /usr/bin/supervisord -n -c /etc/supervisor/supervisord.conf
