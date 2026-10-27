#!/usr/bin/env bash
#
# Start DAGENT (Linux / macOS).
#
#   bash scripts/start.sh                     # http://127.0.0.1:8420
#   bash scripts/start.sh --port 9000
#   bash scripts/start.sh --workspace ~/Projects/my-app
#   bash scripts/start.sh --host 0.0.0.0      # reachable from the local network
#
# Creator: frizovdanya - https://t.me/frizovdanya

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

if [ -x "$ROOT/.venv/bin/python" ]; then
  PY="$ROOT/.venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
  PY="python3"
else
  PY="python"
fi

if ! "$PY" -c "import fastapi, uvicorn" >/dev/null 2>&1; then
  echo "DAGENT dependencies are missing. Install them first:" >&2
  echo "  bash scripts/install.sh" >&2
  exit 1
fi

exec "$PY" "$ROOT/run.py" "$@"
