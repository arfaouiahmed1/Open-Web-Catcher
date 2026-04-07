#!/usr/bin/env bash
set -euo pipefail

log() {
    printf '[entrypoint] %s\n' "$1"
}

prepare_runtime_dirs() {
    log "Preparing runtime directories."
    mkdir -p /app/data/logs /app/data/raw /app/data/processed /app/data/reports
}

prepare_runtime_dirs

log "Handing off to supervisord."
exec /usr/bin/supervisord -n -c /etc/supervisor/supervisord.conf
