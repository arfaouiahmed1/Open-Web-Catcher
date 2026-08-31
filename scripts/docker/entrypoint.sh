#!/usr/bin/env bash
set -euo pipefail

log() {
    printf '[entrypoint] %s\n' "$1"
}

prepare_runtime_dirs() {
    log "Preparing runtime directories."
    mkdir -p /app/data/logs /app/data/raw /app/data/processed /app/data/reports
    # Windows host bind-mount (./data:/app/data) is NTFS — image's chown is lost at mount.
    # When running as root (compose user: "0:0" on Windows), heal perms for app:10001;
    # when running as app on Linux, this is a no-op (chown fails silently).
    if [ "$(id -u)" = "0" ]; then
        chown -R app:app /app/data 2>/dev/null || true
        chown app:app /var/run/supervisord.pid 2>/dev/null || true
        chmod -R 775 /app/data/logs 2>/dev/null || true
    fi
}

# uBOL managed-policy generation moved to the owc-tools-playwright image,
# which owns the extension assets and ships Node. This API image is
# node-free by design (playwright-only consolidation, plan T22/ADR-003),
# so we only keep the runtime-dir preparation here.
prepare_runtime_dirs

log "Handing off to supervisord."
exec /usr/bin/supervisord -n -c /etc/supervisor/supervisord.conf
