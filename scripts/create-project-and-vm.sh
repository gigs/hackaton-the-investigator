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
gcloud billing projects link "${PROJECT_ID}" --billing-account="${BILLING_ACCOUNT}"

echo "==> Enabling APIs (compute, iap, oslogin, secretmanager, certificatemanager)"
NEEDED_APIS=(compute.googleapis.com iap.googleapis.com oslogin.googleapis.com secretmanager.googleapis.com certificatemanager.googleapis.com)
ENABLED_APIS="$(gcloud services list --enabled --project="${PROJECT_ID}" --format='value(config.name)' 2>/dev/null || true)"
APIS_TO_ENABLE=()
for api in "${NEEDED_APIS[@]}"; do
  if echo "${ENABLED_APIS}" | grep -qx "${api}"; then
    echo "    ${api} already enabled"
  else
    APIS_TO_ENABLE+=("${api}")
  fi
done
if [[ ${#APIS_TO_ENABLE[@]} -gt 0 ]]; then
  gcloud services enable "${APIS_TO_ENABLE[@]}" --project="${PROJECT_ID}"
else
  echo "    all APIs already enabled, skipping"
fi

echo "==> Enabling project-wide OS Login"
OSLOGIN_META="$(gcloud compute project-info describe --project="${PROJECT_ID}" \
  --format='value(commonInstanceMetadata.items.filter(key:enable-oslogin).extract(value).flatten())' 2>/dev/null || true)"
if echo "${OSLOGIN_META}" | grep -qi '^true$'; then
  echo "    OS Login already enabled, skipping"
else
  gcloud compute project-info add-metadata \
    --project="${PROJECT_ID}" \
    --metadata=enable-oslogin=TRUE
fi

echo "==> Granting IAP tunnel + OS Login roles to domain:${GIGS_DOMAIN}"
CURRENT_POLICY="$(gcloud projects get-iam-policy "${PROJECT_ID}" --format=json 2>/dev/null || true)"

MEMBER="domain:${GIGS_DOMAIN}"
if echo "${CURRENT_POLICY}" | grep -q "roles/iap.tunnelResourceAccessor" && \
   echo "${CURRENT_POLICY}" | grep -q "${MEMBER}"; then
  echo "    roles/iap.tunnelResourceAccessor already bound, skipping"
else
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="${MEMBER}" \
    --role="roles/iap.tunnelResourceAccessor" \
    --condition=None >/dev/null
fi

if echo "${CURRENT_POLICY}" | grep -q "roles/compute.osLogin" && \
   echo "${CURRENT_POLICY}" | grep -q "${MEMBER}"; then
  echo "    roles/compute.osLogin already bound, skipping"
else
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="${MEMBER}" \
    --role="roles/compute.osLogin" \
    --condition=None >/dev/null
fi

echo "==> Ensuring default VPC network exists"
if ! gcloud compute networks describe default --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud compute networks create default \
    --project="${PROJECT_ID}" \
    --subnet-mode=auto
else
  echo "    default network already exists, skipping"
fi

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

# ─── Secret Manager ───────────────────────────────────────────────────────────

SECRET_ID="investigator-oauth-token"
echo "==> Creating Secret Manager secret: ${SECRET_ID}"
if ! gcloud secrets describe "${SECRET_ID}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud secrets create "${SECRET_ID}" \
    --project="${PROJECT_ID}" \
    --replication-policy=automatic
else
  echo "    secret already exists, skipping"
fi

VM_SA="$(gcloud compute instances describe "${VM_NAME}" --zone="${ZONE}" --project="${PROJECT_ID}" \
  --format='value(serviceAccounts[0].email)' 2>/dev/null || true)"
if [[ -z "${VM_SA}" ]]; then
  VM_SA="$(gcloud iam service-accounts list --project="${PROJECT_ID}" \
    --filter='displayName:Compute Engine default service account' \
    --format='value(email)' 2>/dev/null || true)"
fi

if [[ -n "${VM_SA}" ]]; then
  echo "==> Granting Secret Manager roles to ${VM_SA}"
  for ROLE in roles/secretmanager.secretAccessor roles/secretmanager.secretVersionManager; do
    EXISTING="$(gcloud secrets get-iam-policy "${SECRET_ID}" --project="${PROJECT_ID}" --format=json 2>/dev/null || true)"
    if echo "${EXISTING}" | grep -q "${ROLE}" && echo "${EXISTING}" | grep -q "${VM_SA}"; then
      echo "    ${ROLE} already bound, skipping"
    else
      gcloud secrets add-iam-policy-binding "${SECRET_ID}" \
        --project="${PROJECT_ID}" \
        --member="serviceAccount:${VM_SA}" \
        --role="${ROLE}" >/dev/null
    fi
  done
else
  echo "    WARNING: could not determine VM service account — grant Secret Manager roles manually"
fi

# ─── HTTPS Load Balancer ──────────────────────────────────────────────────────

LB_IP_NAME="investigator-lb-ip"
INSTANCE_GROUP="investigator-ig"
HEALTH_CHECK="investigator-hc"
BACKEND_SERVICE="investigator-backend"
URL_MAP="investigator-url-map"
HTTPS_PROXY="investigator-https-proxy"
FORWARDING_RULE="investigator-https-fr"
LB_DOMAIN="${LB_DOMAIN:-}"       # set externally, e.g. investigator.example.com
CERT_NAME="investigator-cert"
FW_HEALTH_CHECK="allow-health-check"
HEALTH_CHECK_RANGES="35.191.0.0/16,130.211.0.0/22"

echo "==> Reserving global static IP: ${LB_IP_NAME}"
if ! gcloud compute addresses describe "${LB_IP_NAME}" --global --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud compute addresses create "${LB_IP_NAME}" \
    --project="${PROJECT_ID}" \
    --global \
    --ip-version=IPV4
fi
LB_IP="$(gcloud compute addresses describe "${LB_IP_NAME}" --global --project="${PROJECT_ID}" --format='value(address)')"
echo "    Static IP: ${LB_IP}"

echo "==> Creating unmanaged instance group: ${INSTANCE_GROUP}"
if ! gcloud compute instance-groups unmanaged describe "${INSTANCE_GROUP}" --zone="${ZONE}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud compute instance-groups unmanaged create "${INSTANCE_GROUP}" \
    --project="${PROJECT_ID}" \
    --zone="${ZONE}"
  gcloud compute instance-groups unmanaged add-instances "${INSTANCE_GROUP}" \
    --project="${PROJECT_ID}" \
    --zone="${ZONE}" \
    --instances="${VM_NAME}"
  gcloud compute instance-groups unmanaged set-named-ports "${INSTANCE_GROUP}" \
    --project="${PROJECT_ID}" \
    --zone="${ZONE}" \
    --named-ports=http:3000
else
  echo "    instance group already exists, skipping"
fi

echo "==> Creating health check: ${HEALTH_CHECK}"
if ! gcloud compute health-checks describe "${HEALTH_CHECK}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud compute health-checks create http "${HEALTH_CHECK}" \
    --project="${PROJECT_ID}" \
    --port=3000 \
    --request-path=/health \
    --check-interval=30s \
    --timeout=10s \
    --healthy-threshold=2 \
    --unhealthy-threshold=3
else
  echo "    health check already exists, skipping"
fi

echo "==> Creating backend service: ${BACKEND_SERVICE}"
if ! gcloud compute backend-services describe "${BACKEND_SERVICE}" --global --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud compute backend-services create "${BACKEND_SERVICE}" \
    --project="${PROJECT_ID}" \
    --global \
    --protocol=HTTP \
    --port-name=http \
    --health-checks="${HEALTH_CHECK}" \
    --timeout=600s
  gcloud compute backend-services add-backend "${BACKEND_SERVICE}" \
    --project="${PROJECT_ID}" \
    --global \
    --instance-group="${INSTANCE_GROUP}" \
    --instance-group-zone="${ZONE}" \
    --balancing-mode=UTILIZATION \
    --max-utilization=0.8
else
  echo "    backend service already exists, skipping"
fi

echo "==> Creating URL map: ${URL_MAP}"
if ! gcloud compute url-maps describe "${URL_MAP}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud compute url-maps create "${URL_MAP}" \
    --project="${PROJECT_ID}" \
    --default-service="${BACKEND_SERVICE}"
else
  echo "    url map already exists, skipping"
fi

if [[ -n "${LB_DOMAIN}" ]]; then
  echo "==> Creating managed SSL certificate for ${LB_DOMAIN}"
  if ! gcloud compute ssl-certificates describe "${CERT_NAME}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    gcloud compute ssl-certificates create "${CERT_NAME}" \
      --project="${PROJECT_ID}" \
      --domains="${LB_DOMAIN}" \
      --global
  else
    echo "    certificate already exists, skipping"
  fi

  echo "==> Creating HTTPS target proxy: ${HTTPS_PROXY}"
  if ! gcloud compute target-https-proxies describe "${HTTPS_PROXY}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    gcloud compute target-https-proxies create "${HTTPS_PROXY}" \
      --project="${PROJECT_ID}" \
      --url-map="${URL_MAP}" \
      --ssl-certificates="${CERT_NAME}"
  else
    echo "    HTTPS proxy already exists, skipping"
  fi

  echo "==> Creating forwarding rule: ${FORWARDING_RULE}"
  if ! gcloud compute forwarding-rules describe "${FORWARDING_RULE}" --global --project="${PROJECT_ID}" >/dev/null 2>&1; then
    gcloud compute forwarding-rules create "${FORWARDING_RULE}" \
      --project="${PROJECT_ID}" \
      --global \
      --address="${LB_IP_NAME}" \
      --target-https-proxy="${HTTPS_PROXY}" \
      --ports=443
  else
    echo "    forwarding rule already exists, skipping"
  fi
else
  echo "    LB_DOMAIN not set — skipping HTTPS proxy and forwarding rule."
  echo "    Set LB_DOMAIN=your.domain and re-run to complete HTTPS LB setup."
fi

echo "==> Creating health-check firewall rule: ${FW_HEALTH_CHECK}"
if ! gcloud compute firewall-rules describe "${FW_HEALTH_CHECK}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud compute firewall-rules create "${FW_HEALTH_CHECK}" \
    --project="${PROJECT_ID}" \
    --network=default \
    --direction=INGRESS \
    --action=ALLOW \
    --rules=tcp:3000 \
    --source-ranges="${HEALTH_CHECK_RANGES}" \
    --target-tags="${NETWORK_TAG}"
else
  echo "    ${FW_HEALTH_CHECK} already exists, skipping"
fi

# ─── Summary ──────────────────────────────────────────────────────────────────

echo
echo "==> Done."
echo "    SSH (IAP tunnel, works for any gigs.com user):"
echo "      gcloud compute ssh ${VM_NAME} --zone=${ZONE} --project=${PROJECT_ID} --tunnel-through-iap"
echo
echo "    Stop the VM to pause billing:"
echo "      gcloud compute instances stop ${VM_NAME} --zone=${ZONE} --project=${PROJECT_ID}"
echo
echo "    Load balancer static IP: ${LB_IP}"
if [[ -n "${LB_DOMAIN}" ]]; then
  echo "    DNS: point ${LB_DOMAIN} A → ${LB_IP}"
  echo "    Then set APP_URL=https://${LB_DOMAIN} in .env"
else
  echo "    Set LB_DOMAIN and re-run to create HTTPS proxy + forwarding rule."
fi
