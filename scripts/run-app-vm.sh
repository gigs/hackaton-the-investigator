#!/bin/bash
# Run the app in a disposable node:22 container, sharing the VM's network
# namespace so it publishes on localhost:3000 (exposed via the allow-app-iap
# firewall rule for tunneling).
#
# Run this on the VM, after:
#   - /opt/hackaton-the-investigator/hackaton-the-investigator is cloned
#   - the repo has a package.json with a "dev" script
#
# Ctrl+C to stop. The container is --rm so state doesn't persist between runs;
# pnpm's content-addressable store is mounted to avoid re-downloading packages.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/hackaton-the-investigator/hackaton-the-investigator}"
CONTAINER_NAME="${CONTAINER_NAME:-hackaton-the-investigator}"
NODE_IMAGE="${NODE_IMAGE:-node:22}"
PNPM_STORE="${PNPM_STORE:-/opt/hackaton-the-investigator/pnpm-store}"
mkdir -p "${PNPM_STORE}"

echo "==> Starting ${CONTAINER_NAME} (network=host; port 3000 -> VM:3000)"
exec docker run --rm -it \
  --name "${CONTAINER_NAME}" \
  --network=host \
  -v "${APP_DIR}:/app" \
  -v "${PNPM_STORE}:/root/.local/share/pnpm/store" \
  -w /app \
  "${NODE_IMAGE}" \
  bash -c "corepack enable && pnpm i && pnpm dev"
