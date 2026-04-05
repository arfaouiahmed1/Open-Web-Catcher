#!/usr/bin/env bash
set -euo pipefail

PG_VERSION="${PG_VERSION:-15}"
PG_CLUSTER="${PG_CLUSTER:-main}"
PG_DATA="/var/lib/postgresql/${PG_VERSION}/${PG_CLUSTER}"
PG_USER="${POSTGRES_USER:-owc}"
PG_PASS="${POSTGRES_PASSWORD:-owc}"
PG_DB="${POSTGRES_DB:-owc}"
PG_READY_TIMEOUT="${PG_READY_TIMEOUT:-30}"

log() {
    printf '[entrypoint] %s\n' "$1"
}

start_postgres() {
    log "Preparing PostgreSQL ${PG_VERSION}/${PG_CLUSTER}."

    if [ ! -f "${PG_DATA}/PG_VERSION" ]; then
        log "Creating PostgreSQL cluster ${PG_VERSION}/${PG_CLUSTER}."
        pg_createcluster "${PG_VERSION}" "${PG_CLUSTER}" --start
        return
    fi

    log "Starting existing PostgreSQL cluster ${PG_VERSION}/${PG_CLUSTER}."
    pg_ctlcluster "${PG_VERSION}" "${PG_CLUSTER}" start || true
}

wait_for_postgres() {
    local attempt=1

    while [ "${attempt}" -le "${PG_READY_TIMEOUT}" ]; do
        if su -c "pg_isready -q" postgres 2>/dev/null; then
            log "PostgreSQL is ready (attempt ${attempt}/${PG_READY_TIMEOUT})."
            return 0
        fi

        log "Waiting for PostgreSQL... (${attempt}/${PG_READY_TIMEOUT})"
        sleep 1
        attempt=$((attempt + 1))
    done

    log "PostgreSQL did not become ready in ${PG_READY_TIMEOUT} seconds."
    return 1
}

ensure_role() {
    if su -c "psql -v ON_ERROR_STOP=1 -tAc \"SELECT 1 FROM pg_roles WHERE rolname='${PG_USER}'\"" postgres | grep -q 1; then
        log "PostgreSQL role '${PG_USER}' already exists."
        return
    fi

    log "Creating PostgreSQL role '${PG_USER}'."
    su -c "psql -v ON_ERROR_STOP=1 -c \"CREATE ROLE ${PG_USER} WITH LOGIN PASSWORD '${PG_PASS}'\"" postgres
}

ensure_database() {
    if su -c "psql -v ON_ERROR_STOP=1 -tAc \"SELECT 1 FROM pg_database WHERE datname='${PG_DB}'\"" postgres | grep -q 1; then
        log "PostgreSQL database '${PG_DB}' already exists."
        return
    fi

    log "Creating PostgreSQL database '${PG_DB}'."
    su -c "psql -v ON_ERROR_STOP=1 -c \"CREATE DATABASE ${PG_DB} OWNER ${PG_USER}\"" postgres
}

prepare_runtime_dirs() {
    log "Preparing runtime directories."
    mkdir -p /app/data/logs /app/data/raw /app/data/processed /app/data/reports
}

start_postgres
wait_for_postgres
ensure_role
ensure_database
prepare_runtime_dirs

log "PostgreSQL is ready. Database '${PG_DB}' is owned by '${PG_USER}'."
log "Handing off to supervisord."
exec /usr/bin/supervisord -n -c /etc/supervisor/supervisord.conf
