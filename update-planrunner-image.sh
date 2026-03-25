#!/usr/bin/env bash
# Weekly scheduled rebuild: pulls base image updates; only restarts the runner if the
# built image ID actually changed (avoids unnecessary container churn).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

OLD_ID="$(docker image inspect planscrape-runner:latest -f '{{.Id}}' 2>/dev/null || true)"
docker build --pull -t planscrape-runner:latest "$SCRIPT_DIR"
NEW_ID="$(docker image inspect planscrape-runner:latest -f '{{.Id}}')"

if [[ "$OLD_ID" != "$NEW_ID" ]]; then
  docker compose up -d
fi
