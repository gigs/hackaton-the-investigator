#!/bin/bash
# Open an IAP tunnel from your laptop to the app running on the hack VM.
# Keeps running in the foreground; Ctrl+C to close.
#
# Once this is up, open http://localhost:3000 in your browser.
#
# Requires:
#   - gcloud CLI installed and `gcloud auth login` done with your @gigs.com account
#   - Project-level `roles/iap.tunnelResourceAccessor` (granted to domain:gigs.com)
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-hackaton-the-investigator}"
ZONE="${ZONE:-europe-west1-b}"
VM_NAME="${VM_NAME:-hackaton-the-investigator}"
REMOTE_PORT="${REMOTE_PORT:-3000}"
LOCAL_PORT="${LOCAL_PORT:-3000}"

echo "==> Tunneling ${VM_NAME}:${REMOTE_PORT} -> localhost:${LOCAL_PORT} via IAP"
echo "    Browser: http://localhost:${LOCAL_PORT}"
echo "    Ctrl+C to close."

exec gcloud compute start-iap-tunnel "${VM_NAME}" "${REMOTE_PORT}" \
  --local-host-port="localhost:${LOCAL_PORT}" \
  --zone="${ZONE}" \
  --project="${PROJECT_ID}"
