#!/usr/bin/env bash
# =============================================================================
#  Container entrypoint — runs once at startup
#  1. Initialises PostgreSQL cluster (first boot only)
#  2. Creates the owc role + database
#  3. Creates runtime data directories
#  4. Hands off to supervisord (which starts Chrome, MCP, API, Gradio)
# =============================================================================
set -euo pipefail

PG_VERSION=15
PG_CLUSTER=main
PG_DATA="/var/lib/postgresql/${PG_VERSION}/${PG_CLUSTER}"
PG_USER=owc
PG_PASS=owc
PG_DB=owc

echo "[entrypoint] ── PostgreSQL ──────────────────────────────────────"

# Debian's postgresql package pre-creates the cluster; just make sure it exists
if [ ! -f "${PG_DATA}/PG_VERSION" ]; then
    echo "[entrypoint] Creating PostgreSQL cluster ${PG_VERSION}/${PG_CLUSTER}..."
    pg_createcluster "${PG_VERSION}" "${PG_CLUSTER}" --start
else
    echo "[entrypoint] Starting existing cluster ${PG_VERSION}/${PG_CLUSTER}..."
    pg_ctlcluster "${PG_VERSION}" "${PG_CLUSTER}" start || true
fi

# Wait for PostgreSQL to accept connections
for i in $(seq 1 20); do
    if su -c "pg_isready -q" postgres 2>/dev/null; then
        echo "[entrypoint] PostgreSQL is ready (attempt ${i})."
        break
    fi
    echo "[entrypoint] Waiting for PostgreSQL... (${i}/20)"
    sleep 1
done

# Idempotent: create role and database if they don't exist
su -c "psql -tc \"SELECT 1 FROM pg_roles WHERE rolname='${PG_USER}'\" \
       | grep -q 1 \
       || psql -c \"CREATE ROLE ${PG_USER} WITH LOGIN PASSWORD '${PG_PASS}'\"" postgres

su -c "psql -tc \"SELECT 1 FROM pg_database WHERE datname='${PG_DB}'\" \
       | grep -q 1 \
       || psql -c \"CREATE DATABASE ${PG_DB} OWNER ${PG_USER}\"" postgres

echo "[entrypoint] PostgreSQL ready — database '${PG_DB}' owned by '${PG_USER}'."

echo "[entrypoint] ── Runtime directories ──────────────────────────────"
mkdir -p /app/data/{logs,raw,processed,reports}

echo "[entrypoint] ── Handing off to supervisord ───────────────────────"
exec /usr/bin/supervisord -n -c /etc/supervisor/supervisord.conf
