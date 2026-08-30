#!/usr/bin/env bash
set -euo pipefail
export NEXT_PUBLIC_API_BASE_URL="${NEXT_PUBLIC_API_BASE_URL:-https://api.test.invalid}"
export ANALYZE=1
npx next build
