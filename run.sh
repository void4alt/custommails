#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if command -v node >/dev/null 2>&1; then
  exec node server.js "$@"
else
  exec python3 web.py "$@"
fi
