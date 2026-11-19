#!/usr/bin/env bash
# Run the API on this laptop against production: starts the Cloud SQL proxy (127.0.0.1:5433) if it isn't running.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! lsof -nP -iTCP:5433 -sTCP:LISTEN >/dev/null 2>&1; then
  cloud-sql-proxy yieldpilot-csulb:us-central1:yieldpilot-db --port 5433 >/tmp/yp-cloud-sql-proxy.log 2>&1 &
  for _ in $(seq 1 40); do
    lsof -nP -iTCP:5433 -sTCP:LISTEN >/dev/null 2>&1 && break
    sleep 0.25
  done
  lsof -nP -iTCP:5433 -sTCP:LISTEN >/dev/null 2>&1 || { echo "The Cloud SQL proxy didn't start:"; cat /tmp/yp-cloud-sql-proxy.log; exit 1; }
  echo "Cloud SQL proxy running on 127.0.0.1:5433 (log: /tmp/yp-cloud-sql-proxy.log)"
fi
exec .venv/bin/uvicorn app.main:app --port 8000 "$@"
