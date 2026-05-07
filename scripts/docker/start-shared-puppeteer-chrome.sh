#!/usr/bin/env bash
set -euo pipefail

chrome_bin="${PUPPETEER_EXECUTABLE_PATH:-/usr/local/bin/google-chrome-stable}"
port="${REMOTE_DEBUGGING_PORT:-9332}"
extension_dir="${OWC_UBOL_EXTENSION_DIR:-/app/tools/puppeteer/extensions/ubol}"
enable_ubol="${OWC_UBOL_ENABLED:-true}"
extension_args=()

if [[ ! -x "${chrome_bin}" ]]; then
    echo "[chrome-entrypoint] Chrome executable not found at ${chrome_bin}." >&2
    exit 1
fi

case "$(printf '%s' "${enable_ubol}" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on)
        if [[ -f "${extension_dir}/manifest.json" ]]; then
            extension_args+=("--disable-extensions-except=${extension_dir}")
            extension_args+=("--load-extension=${extension_dir}")
        else
            echo "[chrome-entrypoint] uBOL extension not found at ${extension_dir}; starting Chrome without extension." >&2
        fi
        ;;
    *)
        echo "[chrome-entrypoint] uBOL disabled for shared Puppeteer Chrome." >&2
        ;;
esac

exec "${chrome_bin}" \
    --headless=new \
    --no-sandbox \
    --disable-dev-shm-usage \
    --disable-gpu \
    --remote-debugging-port="${port}" \
    --remote-debugging-address=0.0.0.0 \
    --user-data-dir=/tmp/chrome-profile \
    "${extension_args[@]}" \
    about:blank
