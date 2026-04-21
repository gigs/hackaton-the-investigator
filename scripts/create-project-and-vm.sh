#!/bin/bash
# Create the hackathon project under the grx folder and spin up a VM.
# Network setup: VM gets a public IP for egress. Inbound SSH is restricted to
# Google's IAP tunnel source range (35.235.240.0/20). IAP tunnel access +
# OS Login are granted to the whole gigs.com domain, so only gigs employees
# can reach the VM.
#
# Prereq: `gcloud auth login`.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-hackaton-the-investigator}"
FOLDER_ID="${FOLDER_ID:-359320839277}"
BILLING_ACCOUNT="${BILLING_ACCOUNT:-01D921-2F92E2-55AD5A}"
REGION="${REGION:-europe-west1}"
ZONE="${ZONE:-europe-west1-b}"
VM_NAME="${VM_NAME:-hackaton-the-investigator}"
MACHINE_TYPE="${MACHINE_TYPE:-e2-standard-4}"
DISK_SIZE_GB="${DISK_SIZE_GB:-50}"
IMAGE_FAMILY="${IMAGE_FAMILY:-debian-12}"
IMAGE_PROJECT="${IMAGE_PROJECT:-debian-cloud}"
GIGS_DOMAIN="${GIGS_DOMAIN:-gigs.com}"
NETWORK_TAG="${NETWORK_TAG:-hackaton-the-investigator}"
IAP_RANGE="35.235.240.0/20"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STARTUP_SCRIPT="${SCRIPT_DIR}/vm-startup.sh"

echo "==> Creating project ${PROJECT_ID} under folder ${FOLDER_ID}"
if ! gcloud projects describe "${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud projects create "${PROJECT_ID}" --folder="${FOLDER_ID}" --name="${PROJECT_ID}"
else
  echo "    project already exists, skipping create"
fi

echo "==> Linking billing account ${BILLING_ACCOUNT}"
gcloud beta billing projects link "${PROJECT_ID}" --billing-account="${BILLING_ACCOUNT}"

echo "==> Enabling APIs (compute, iap, oslogin)"
gcloud services enable compute.googleapis.com iap.googleapis.com oslogin.googleapis.com \
  --project="${PROJECT_ID}"

echo "==> Enabling project-wide OS Login"
gcloud compute project-info add-metadata \
  --project="${PROJECT_ID}" \
  --metadata=enable-oslogin=TRUE

echo "==> Granting IAP tunnel + OS Login roles to domain:${GIGS_DOMAIN}"
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="domain:${GIGS_DOMAIN}" \
  --role="roles/iap.tunnelResourceAccessor" \
  --condition=None >/dev/null
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="domain:${GIGS_DOMAIN}" \
  --role="roles/compute.osLogin" \
  --condition=None >/dev/null

echo "==> Removing default wide-open SSH/RDP firewall rules"
gcloud compute firewall-rules delete default-allow-ssh \
  --project="${PROJECT_ID}" --quiet 2>/dev/null || echo "    default-allow-ssh already gone"
gcloud compute firewall-rules delete default-allow-rdp \
  --project="${PROJECT_ID}" --quiet 2>/dev/null || echo "    default-allow-rdp already gone"

echo "==> Creating IAP-only SSH firewall rule (tag: ${NETWORK_TAG})"
if ! gcloud compute firewall-rules describe allow-ssh-iap --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud compute firewall-rules create allow-ssh-iap \
    --project="${PROJECT_ID}" \
    --network=default \
    --direction=INGRESS \
    --action=ALLOW \
    --rules=tcp:22 \
    --source-ranges="${IAP_RANGE}" \
    --target-tags="${NETWORK_TAG}"
else
  echo "    allow-ssh-iap already exists"
fi

echo "==> Creating IAP-only app firewall rule (tcp:3000)"
if ! gcloud compute firewall-rules describe allow-app-iap --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud compute firewall-rules create allow-app-iap \
    --project="${PROJECT_ID}" \
    --network=default \
    --direction=INGRESS \
    --action=ALLOW \
    --rules=tcp:3000 \
    --source-ranges="${IAP_RANGE}" \
    --target-tags="${NETWORK_TAG}"
else
  echo "    allow-app-iap already exists"
fi

echo "==> Creating VM ${VM_NAME} in ${ZONE} (public IP; inbound locked to IAP)"
if ! gcloud compute instances describe "${VM_NAME}" --zone="${ZONE}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud compute instances create "${VM_NAME}" \
    --project="${PROJECT_ID}" \
    --zone="${ZONE}" \
    --machine-type="${MACHINE_TYPE}" \
    --image-family="${IMAGE_FAMILY}" \
    --image-project="${IMAGE_PROJECT}" \
    --boot-disk-size="${DISK_SIZE_GB}GB" \
    --boot-disk-type=pd-balanced \
    --metadata=enable-oslogin=TRUE \
    --metadata-from-file=startup-script="${STARTUP_SCRIPT}" \
    --shielded-secure-boot \
    --shielded-vtpm \
    --shielded-integrity-monitoring \
    --tags="${NETWORK_TAG}"
else
  echo "    VM already exists, skipping create"
fi

echo
echo "==> Done."
echo "    SSH (IAP tunnel, works for any gigs.com user):"
echo "      gcloud compute ssh ${VM_NAME} --zone=${ZONE} --project=${PROJECT_ID} --tunnel-through-iap"
echo
echo "    Stop the VM to pause billing:"
echo "      gcloud compute instances stop ${VM_NAME} --zone=${ZONE} --project=${PROJECT_ID}"
