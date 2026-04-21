# hackaton-the-investigator

## GCP setup

Scripts + notes for the hackathon dev VM under the GRX folder.

### What's live

- **GCP project**: `hackaton-the-investigator` under folder `359320839277` (grx)
- **VM**: `hackaton-the-investigator` in `europe-west1-b` — `e2-standard-4`, Debian 12, 50 GB, public IP, Shielded VM
- **Network**: `default` auto-mode VPC. Inbound is IAP-only:
  - `allow-ssh-iap` → `tcp:22` from `35.235.240.0/20` to tag `hackaton-the-investigator`
  - `allow-app-iap` → `tcp:3000` from `35.235.240.0/20` to tag `hackaton-the-investigator`
- **IAM**: `domain:gigs.com` has `roles/iap.tunnelResourceAccessor` + `roles/compute.osLogin` on the project — any gigster can SSH / tunnel in

## Scripts

### `scripts/vm-startup.sh`
Runs on first boot of the VM as root (wired via `--metadata-from-file=startup-script=…`). Installs:
- Docker CE (engine + CLI + buildx + compose plugin) from the official Docker apt repo
- `git`

Also drops a profile snippet that adds the interactive OS Login user to the `docker` group on first shell session. Writes `/var/log/vm-startup-done` when finished — useful for polling from your laptop.

Not intended to be run by hand; it's only invoked by GCE on VM boot.

### `scripts/create-project-and-vm.sh`
Idempotent. End-to-end GCP project + VM provisioning:
1. Creates the project under the grx folder
2. Links the Gigs billing account
3. Enables `compute`, `iap`, `oslogin` APIs
4. Enables project-wide OS Login
5. Grants `domain:gigs.com` the IAP tunnel + OS Login roles
6. Removes the wide-open `default-allow-ssh` / `default-allow-rdp` rules (if present)
7. Creates `allow-ssh-iap` (tcp:22) and `allow-app-iap` (tcp:3000), both IAP-range only
8. Creates the `hackaton-the-investigator` VM

All inputs are overrideable env vars (`PROJECT_ID`, `FOLDER_ID`, `BILLING_ACCOUNT`, `REGION`, `ZONE`, `VM_NAME`, `MACHINE_TYPE`, `DISK_SIZE_GB`, `IMAGE_FAMILY`, `IMAGE_PROJECT`, `GIGS_DOMAIN`, `NETWORK_TAG`). Defaults produce the live setup above.

**Not handled by this script**: creating the `default` VPC. Org policy skips default VPC creation on new projects, so you need to run this once before first VM create:
```bash
gcloud compute networks create default --subnet-mode=auto --project=hackaton-the-investigator
```

Run:
```bash
gcloud auth login                                # once per laptop
./scripts/create-project-and-vm.sh               # provisions everything
```

### `scripts/bootstrap-vm.sh`
Server-side script. Creates the shared workspace `/opt/hackaton-the-investigator/` (setgid, group `docker`), installs `gh` CLI if missing, authenticates git + gh using a GitHub token **read from stdin** (so it never lands on a command line or in history), then clones `gigs/hackaton-the-investigator`.

Idempotent — safe to re-run. Run it from your laptop:
```bash
gcloud compute scp scripts/bootstrap-vm.sh hackaton-the-investigator:/tmp/bootstrap-vm.sh \
  --tunnel-through-iap --zone=europe-west1-b --project=hackaton-the-investigator

gh auth token | gcloud compute ssh hackaton-the-investigator \
  --tunnel-through-iap --zone=europe-west1-b --project=hackaton-the-investigator \
  --command='bash /tmp/bootstrap-vm.sh && rm /tmp/bootstrap-vm.sh'
```

### `scripts/run-app-vm.sh`
Runs on the VM. Starts the app in a disposable `node:22` container with `--network=host`, mounting `/opt/hackaton-the-investigator/hackaton-the-investigator` into `/app`. Uses the host network so publishing on `:3000` goes straight to the VM interface (which IAP is already set up for).

Run it on the VM:
```bash
/opt/hackaton-the-investigator/hackaton-the-investigator/scripts/run-app-vm.sh
```
First run: `pnpm i` fetches all dependencies (slow; pnpm store is persisted at `/opt/hackaton-the-investigator/pnpm-store` for subsequent runs).

### `scripts/tunnel-app.sh`
Laptop-side. Opens an IAP TCP tunnel so you can reach the app running on the VM at `http://localhost:3000`.

```bash
./scripts/tunnel-app.sh
# then open http://localhost:3000
```

Overrideable env vars: `PROJECT_ID`, `ZONE`, `VM_NAME`, `REMOTE_PORT`, `LOCAL_PORT`. Any gigster with gcloud auth can run this.

## Application

### Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check for LB probes → `{"status":"ok"}` |
| `GET` | `/oauth/authorize` | Starts Linear OAuth flow (redirects to Linear consent page) |
| `GET` | `/oauth/callback` | Handles OAuth callback, exchanges code for tokens, stores in Secret Manager |
| `POST` | `/webhook` | Receives Linear webhook events _(Phase 2 — not yet implemented)_ |

### OAuth setup

After deploying and configuring your Linear app (client ID, client secret, webhook secret):

1. Open `https://<your-domain>/oauth/authorize` in a browser
2. Approve the OAuth consent on Linear
3. The callback exchanges the code for tokens, queries `viewer { id }`, and stores everything in Secret Manager
4. The Investigator should now appear as assignable/mentionable in your Linear workspace

Tokens are auto-refreshed when they're within 5 minutes of expiry.

### Local development

```bash
cp .env.example .env       # fill in all values
pnpm install
pnpm dev                   # starts on http://localhost:3000
```

## Day-to-day

```bash
# SSH (IAP tunnel; works for any @gigs.com user)
gcloud compute ssh hackaton-the-investigator \
  --zone=europe-west1-b --project=hackaton-the-investigator \
  --tunnel-through-iap

# Reach the app from your laptop
./scripts/tunnel-app.sh            # then open http://localhost:3000

# Stop the VM to pause billing at end of a hack session
gcloud compute instances stop hackaton-the-investigator \
  --zone=europe-west1-b --project=hackaton-the-investigator

# Start it back up
gcloud compute instances start hackaton-the-investigator \
  --zone=europe-west1-b --project=hackaton-the-investigator
```

## VM runtime layout

Done by `scripts/bootstrap-vm.sh`:
- `/opt/hackaton-the-investigator/` — shared workspace (setgid, group `docker`)
- `/opt/hackaton-the-investigator/hackaton-the-investigator/` — cloned from GitHub

Bring-up order each session:
1. Start the app: `/opt/hackaton-the-investigator/hackaton-the-investigator/scripts/run-app-vm.sh`
2. From your laptop: `./scripts/tunnel-app.sh` → open http://localhost:3000

Nothing auto-starts. Stop the VM when done to pause billing.

## Gotchas

- Projects under the grx folder don't auto-create a default VPC (org policy). You must create one before the first VM — see note under `create-project-and-vm.sh` above.
- **First login to the VM** puts you in the `docker` group, but Linux only applies group membership at login. If your first `docker` command fails with `permission denied … docker.sock`, run `newgrp docker` (or `exit` + re-ssh) and retry.
- `--tunnel-through-iap` on `gcloud compute ssh` is slow on first connect (~5-10 s) while IAP authorizes. Normal.
