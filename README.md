# The Investigator

A Linear Agent that bridges Linear workspace events to a Claude Managed Agent. When users @mention or assign issues to The Investigator in Linear, it forwards the request to an Anthropic Managed Agent, streams progress back as native Linear Agent Activities, and posts the final result.

## Architecture

```
Linear Workspace → HTTPS (LB / ngrok) → Hono :3000 → Anthropic Managed Agent
                                             ↕                      ↕
                                       Secret Manager          SSE stream
                                    (OAuth tokens only)     (events mapped to
                                                             Linear activities)
```

**Request flow:**

1. A user @mentions or assigns The Investigator on a Linear issue.
2. Linear sends a webhook (`POST /webhook`) with an `AgentSession` event.
3. The app verifies the HMAC-SHA256 signature, deduplicates the delivery, and responds `200` within ~5 s.
4. Asynchronously: the app creates (or reuses) an Anthropic Managed Agent session and sends the prompt context.
5. Anthropic events stream back (`agent.thinking`, `agent.tool_use`, `agent.message`, etc.) and are mapped to Linear Agent Activities in real-time, including plan step progress.
6. On follow-up messages (`prompted` action), the same Anthropic session is reused. If the session has expired, a new one is created with conversation history replayed from the Linear Activities API.

## Routes

| Method | Path               | Description                                              |
|--------|--------------------|----------------------------------------------------------|
| `GET`  | `/health`          | Health check for LB probes — `{"status":"ok"}`           |
| `GET`  | `/oauth/authorize` | Starts Linear OAuth flow (redirects to Linear consent)   |
| `GET`  | `/oauth/callback`  | Handles OAuth callback, stores tokens in Secret Manager  |
| `POST` | `/webhook`         | Receives Linear `AgentSession` webhook events            |

## Environment variables

Copy `.env.example` to `.env` and fill in all values.

| Variable                 | Secret? | Description                                                  |
|--------------------------|---------|--------------------------------------------------------------|
| `LINEAR_CLIENT_ID`       | No      | Linear OAuth app client ID                                   |
| `LINEAR_CLIENT_SECRET`   | Yes     | Linear OAuth app client secret                               |
| `LINEAR_WEBHOOK_SECRET`  | Yes     | Linear webhook signing secret (HMAC-SHA256)                  |
| `ANTHROPIC_API_KEY`      | Yes     | Anthropic API key with Managed Agents access                 |
| `MANAGED_AGENT_ID`       | No      | Anthropic Managed Agent ID (`agent_…`)                       |
| `MANAGED_ENVIRONMENT_ID` | No      | Anthropic Managed Agent environment ID (`env_…`)             |
| `GCP_PROJECT_ID`         | No      | GCP project for Secret Manager (e.g. `hackaton-the-investigator`) |
| `PORT`                   | No      | Server port (default: `3000`)                                |
| `APP_URL`                | No      | Public base URL — must be HTTPS for OAuth & webhooks         |

## GCP setup

### Secret Manager

The app stores Linear OAuth tokens in GCP Secret Manager (secret name: `investigator-oauth-token`). The provisioning script handles this automatically, but the manual steps are:

```bash
# Enable the API
gcloud services enable secretmanager.googleapis.com --project=hackaton-the-investigator

# Create the secret
gcloud secrets create investigator-oauth-token \
  --project=hackaton-the-investigator \
  --replication-policy=automatic

# Grant the VM service account read + write access
VM_SA="$(gcloud compute instances describe hackaton-the-investigator \
  --zone=europe-west1-b --project=hackaton-the-investigator \
  --format='value(serviceAccounts[0].email)')"

gcloud secrets add-iam-policy-binding investigator-oauth-token \
  --project=hackaton-the-investigator \
  --member="serviceAccount:${VM_SA}" \
  --role=roles/secretmanager.secretAccessor

gcloud secrets add-iam-policy-binding investigator-oauth-token \
  --project=hackaton-the-investigator \
  --member="serviceAccount:${VM_SA}" \
  --role=roles/secretmanager.secretVersionManager
```

For **local development**, either:
- Run `gcloud auth application-default login` so the SDK uses your user credentials, or
- Set `GOOGLE_APPLICATION_CREDENTIALS` to a service account key JSON file.

### HTTPS Load Balancer

For production, the app is exposed via a GCP HTTPS Load Balancer with a managed SSL certificate. The provisioning script (`scripts/create-project-and-vm.sh`) sets this up:

1. Reserves a global static IP (`investigator-lb-ip`)
2. Creates an unmanaged instance group with the VM
3. Creates a health check on `GET /health` port 3000
4. Creates a backend service, URL map, HTTPS proxy, and forwarding rule
5. Adds a firewall rule allowing Google health-check probes (`35.191.0.0/16`, `130.211.0.0/22`) to reach the VM on port 3000

You need to set `LB_DOMAIN` before running the script:

```bash
LB_DOMAIN=investigator.example.com ./scripts/create-project-and-vm.sh
```

After the script completes, point your DNS A record to the static IP it prints, then set `APP_URL=https://investigator.example.com` in `.env`.

## Linear OAuth app setup

1. Go to **Linear Settings → API → OAuth Applications** and create a new application.
2. Set the **Redirect URI** to `<APP_URL>/oauth/callback` (e.g. `https://investigator.example.com/oauth/callback`).
3. Set the **Webhook URL** to `<APP_URL>/webhook`.
4. Enable webhook events for **Agent Session** events.
5. Under scopes, request: `read`, `write`, `app:assignable`, `app:mentionable`.
6. Copy the **Client ID**, **Client Secret**, and **Webhook Signing Secret** into your `.env`.
7. Open `<APP_URL>/oauth/authorize` in a browser to complete the OAuth consent flow.
8. After approval, The Investigator appears as assignable/mentionable in your Linear workspace.

## Local development

### Quick start

```bash
cp .env.example .env       # fill in all values
pnpm install
pnpm dev                   # starts on http://localhost:3000
```

### Local development with ngrok

Linear webhooks and OAuth require a publicly reachable HTTPS URL. For local development, use [ngrok](https://ngrok.com/) to tunnel traffic to your machine.

**1. Install ngrok**

```bash
# macOS
brew install ngrok

# or download from https://ngrok.com/download
```

**2. Authenticate (one-time)**

Sign up at [ngrok.com](https://ngrok.com/) and add your auth token:

```bash
ngrok config add-authtoken <your-token>
```

**3. Start the tunnel**

```bash
ngrok http 3000
```

ngrok prints a forwarding URL like:

```
Forwarding  https://abcd-1234.ngrok-free.app -> http://localhost:3000
```

**4. Configure your `.env`**

Set `APP_URL` to the ngrok HTTPS URL:

```
APP_URL=https://abcd-1234.ngrok-free.app
```

**5. Update your Linear OAuth app**

In **Linear Settings → API → OAuth Applications**, update:
- **Redirect URI** → `https://abcd-1234.ngrok-free.app/oauth/callback`
- **Webhook URL** → `https://abcd-1234.ngrok-free.app/webhook`

**6. Start the app and authorize**

```bash
pnpm dev
```

Then open `https://abcd-1234.ngrok-free.app/oauth/authorize` in your browser to complete the OAuth flow.

**7. Test it**

Go to a Linear issue, @mention The Investigator (or assign it), and watch the webhook arrive in your terminal and the agent activities stream into Linear.

> **Tip:** ngrok's free tier assigns a new URL every time you restart the tunnel.
> You'll need to update `APP_URL` in `.env` and the Linear app's redirect/webhook
> URLs each time. Use a paid plan or `ngrok http 3000 --url=your-static.ngrok.io`
> for a stable URL.

> **Tip:** Keep the ngrok web inspector at http://localhost:4040 open — it shows
> every request/response flowing through the tunnel, which is invaluable for
> debugging webhook payloads and OAuth redirects.

## VM deployment

### First-time setup

```bash
# 1. Provision GCP resources (from your laptop)
gcloud auth login
./scripts/create-project-and-vm.sh

# 2. Bootstrap the VM (copies script, clones repo)
gcloud compute scp scripts/bootstrap-vm.sh hackaton-the-investigator:/tmp/bootstrap-vm.sh \
  --tunnel-through-iap --zone=europe-west1-b --project=hackaton-the-investigator

gh auth token | gcloud compute ssh hackaton-the-investigator \
  --tunnel-through-iap --zone=europe-west1-b --project=hackaton-the-investigator \
  --command='bash /tmp/bootstrap-vm.sh && rm /tmp/bootstrap-vm.sh'
```

### Running the app on the VM

```bash
# SSH into the VM
gcloud compute ssh hackaton-the-investigator \
  --zone=europe-west1-b --project=hackaton-the-investigator \
  --tunnel-through-iap

# Start the app (runs in a node:22 Docker container with host networking)
/opt/hackaton-the-investigator/hackaton-the-investigator/scripts/run-app-vm.sh

# From your laptop, open an IAP tunnel to reach the app:
./scripts/tunnel-app.sh    # then open http://localhost:3000
```

### Day-to-day

```bash
# Stop the VM to pause billing
gcloud compute instances stop hackaton-the-investigator \
  --zone=europe-west1-b --project=hackaton-the-investigator

# Start it back up
gcloud compute instances start hackaton-the-investigator \
  --zone=europe-west1-b --project=hackaton-the-investigator
```

## Scripts

| Script | Where | Description |
|--------|-------|-------------|
| `scripts/create-project-and-vm.sh` | Laptop | Idempotent GCP provisioning (project, VM, networking, Secret Manager, LB) |
| `scripts/vm-startup.sh` | VM (auto) | Runs on first boot — installs Docker + git |
| `scripts/bootstrap-vm.sh` | VM | Creates shared workspace, clones repo |
| `scripts/run-app-vm.sh` | VM | Starts the app in a `node:22` Docker container |
| `scripts/tunnel-app.sh` | Laptop | Opens an IAP TCP tunnel to reach the app at `localhost:3000` |

## File layout

```
src/
├── index.ts                          # Hono app entry, route mounting, error boundary
├── config.ts                         # Zod env var validation
├── routes/
│   ├── health.ts                     # GET /health
│   ├── oauth.ts                      # GET /oauth/authorize, GET /oauth/callback
│   └── webhook.ts                    # POST /webhook
└── lib/
    ├── linear/
    │   ├── client.ts                 # LinearClient with token refresh
    │   ├── activities.ts             # emitThought/Action/Response/Error + plan updates
    │   ├── webhook-verify.ts         # HMAC-SHA256 signature verification
    │   └── types.ts                  # Webhook payload TypeScript interfaces
    ├── anthropic/
    │   ├── session.ts                # Managed Agent session lifecycle + recovery
    │   ├── event-mapper.ts           # Map Anthropic events → Linear activities
    │   └── errors.ts                 # Classify Anthropic errors → user-friendly messages
    └── store/
        ├── secrets.ts                # GCP Secret Manager wrapper (OAuth tokens)
        └── memory.ts                 # In-memory maps (sessions, dedup, OAuth states)
```

## Hackathon compliance

Per the [Gigs hackathon security guidelines](AGENTS.md):

- **No production data** — uses a staging Linear workspace with test data only.
- **No production systems** — all resources are isolated under the hackathon GCP project.
- **Naming convention** — GCP project: `hackaton-the-investigator`, GitHub repo: `hackaton-the-investigator`.
- **GCP location** — project is under `gigs.com → sandbox → gigs-republic → grx` folder.
- **Cleanup deadline** — all resources, API keys, and GCP projects must be deleted or graduated by **2026-05-21** (30 days post-hackathon).
