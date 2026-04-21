# Setup & Deployment Guide

Step-by-step instructions to go from zero to a running instance of The Investigator.

## Prerequisites

- **gcloud CLI** installed and authenticated (`gcloud auth login` with a `@gigs.com` account)
- **GitHub CLI** (`gh`) installed and authenticated on your laptop
- **pnpm** 9.15.4+ / **Node.js** 22+
- A domain you can point at a GCP load balancer (for HTTPS / Linear webhooks)

---

## 1. Provision GCP Infrastructure

The provisioning script is idempotent — safe to re-run at any time.

```bash
# First run — creates project, VM, Secret Manager, HTTPS LB
LB_DOMAIN=your.domain.com ./scripts/create-project-and-vm.sh
```

What this creates:
- GCP project `hackaton-the-investigator` under the grx folder
- VM `hackaton-the-investigator` in `europe-west1-b` (e2-standard-4, Debian 12)
- Firewall rules: IAP-only SSH (tcp:22), IAP-only app (tcp:3000), health-check probes (tcp:3000)
- IAM: `domain:gigs.com` gets IAP tunnel + OS Login access
- Secret Manager secret `investigator-oauth-token` with VM service account access
- HTTPS Load Balancer: static IP, instance group, backend service, managed SSL cert, forwarding rule

If you don't have a domain yet, omit `LB_DOMAIN` — the script will create everything except the HTTPS proxy and forwarding rule, and print the static IP. Re-run with `LB_DOMAIN` set once you have one.

### DNS setup

After the script prints the static IP:

```bash
# Point your domain at the LB IP
# Create an A record: your.domain.com → <static-ip>
```

Certificate provisioning takes a few minutes after DNS propagates.

---

## 2. Bootstrap the VM

Copy the bootstrap script to the VM and run it, piping your GitHub token via stdin (never touches disk or command history):

```bash
gcloud compute scp scripts/bootstrap-vm.sh hackaton-the-investigator:/tmp/bootstrap-vm.sh \
  --tunnel-through-iap --zone=europe-west1-b --project=hackaton-the-investigator

gh auth token | gcloud compute ssh hackaton-the-investigator \
  --tunnel-through-iap --zone=europe-west1-b --project=hackaton-the-investigator \
  --command='bash /tmp/bootstrap-vm.sh && rm /tmp/bootstrap-vm.sh'
```

This installs `gh`, authenticates git, and clones the repo to `/opt/hackaton-the-investigator/hackaton-the-investigator/`.

---

## 3. Configure Environment Variables

Create a `.env` file on the VM (or locally for dev). See `.env.example` for all variables:

| Variable | Description | Where to get it |
|----------|-------------|-----------------|
| `LINEAR_CLIENT_ID` | Linear OAuth app client ID | Linear Settings → API → Applications |
| `LINEAR_CLIENT_SECRET` | Linear OAuth app client secret | Same as above |
| `LINEAR_WEBHOOK_SECRET` | Webhook signing secret | Linear Settings → API → Webhooks |
| `ANTHROPIC_API_KEY` | Anthropic API key | Anthropic Console |
| `MANAGED_AGENT_ID` | Claude Managed Agent ID | Anthropic Console → Managed Agents |
| `MANAGED_ENVIRONMENT_ID` | Managed Agent environment ID | Same as above |
| `GCP_PROJECT_ID` | GCP project ID | `hackaton-the-investigator` |
| `PORT` | Server port (default `3000`) | — |
| `APP_URL` | Public HTTPS URL | `https://your.domain.com` |

On the VM, place the `.env` file at:
```
/opt/hackaton-the-investigator/hackaton-the-investigator/.env
```

---

## 4. Create the Linear OAuth App

1. Go to **Linear Settings → API → OAuth Applications → New**
2. Set:
   - **Redirect URI**: `https://your.domain.com/oauth/callback`
   - **Webhook URL**: `https://your.domain.com/webhook`
   - **Scopes**: `read`, `write`, `app:assignable`, `app:mentionable`
   - **Actor**: `Application`
3. Copy `CLIENT_ID` and `CLIENT_SECRET` into your `.env`
4. Copy the webhook signing secret into `LINEAR_WEBHOOK_SECRET`

---

## 5. Start the App

### On the VM (production)

```bash
gcloud compute ssh hackaton-the-investigator \
  --tunnel-through-iap --zone=europe-west1-b --project=hackaton-the-investigator

# On the VM:
/opt/hackaton-the-investigator/hackaton-the-investigator/scripts/run-app-vm.sh
```

This runs the app in a `node:22` Docker container with `--network=host`. First run is slower while `pnpm install` fetches dependencies (the pnpm store is persisted between runs).

### Locally (development)

```bash
pnpm install
pnpm dev
```

---

## 6. Complete the OAuth Flow

Once the app is running and HTTPS is live:

1. Open `https://your.domain.com/oauth/authorize` in your browser
2. Approve the Linear OAuth consent page
3. The callback stores tokens in Secret Manager automatically
4. The Investigator should now appear as assignable/mentionable in Linear

Verify tokens were stored:
```bash
gcloud secrets versions access latest \
  --secret=investigator-oauth-token \
  --project=hackaton-the-investigator | jq .
```

---

## App Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check for LB probes → `{"status":"ok"}` |
| `GET` | `/oauth/authorize` | Starts Linear OAuth flow (redirects to Linear consent) |
| `GET` | `/oauth/callback` | OAuth callback — exchanges code, stores tokens in Secret Manager |
| `POST` | `/webhook` | Receives Linear webhook events _(Phase 2)_ |

Tokens are auto-refreshed when within 5 minutes of expiry. Linear rotates refresh tokens on each use — both new access and refresh tokens are persisted.

---

## 7. Verify

```bash
# Health check via LB
curl -s https://your.domain.com/health
# → {"status":"ok"}

# Or via IAP tunnel (from laptop, no domain needed)
./scripts/tunnel-app.sh
curl -s http://localhost:3000/health
# → {"status":"ok"}
```

---

## Day-to-Day Operations

```bash
# SSH into the VM
gcloud compute ssh hackaton-the-investigator \
  --zone=europe-west1-b --project=hackaton-the-investigator \
  --tunnel-through-iap

# Tunnel to the app from your laptop
./scripts/tunnel-app.sh
# → http://localhost:3000

# Stop the VM (pause billing)
gcloud compute instances stop hackaton-the-investigator \
  --zone=europe-west1-b --project=hackaton-the-investigator

# Start it back up
gcloud compute instances start hackaton-the-investigator \
  --zone=europe-west1-b --project=hackaton-the-investigator

# Pull latest code on the VM
cd /opt/hackaton-the-investigator/hackaton-the-investigator && git pull

# Restart the app after pulling
# Ctrl+C the running container, then re-run:
/opt/hackaton-the-investigator/hackaton-the-investigator/scripts/run-app-vm.sh
```

---

## Gotchas

- **No default VPC**: Projects under the grx folder don't auto-create a default VPC (org policy). The provisioning script handles this, but if it fails, run manually: `gcloud compute networks create default --subnet-mode=auto --project=hackaton-the-investigator`
- **Docker group on first login**: Linux only applies group membership at login. If `docker` commands fail with permission denied, run `newgrp docker` or re-SSH.
- **IAP tunnel is slow**: First connect takes ~5-10s while IAP authorizes. Normal.
- **SSL cert provisioning**: Managed certificates can take 10-60 minutes after DNS is configured. Check status with: `gcloud compute ssl-certificates describe investigator-cert --project=hackaton-the-investigator`
