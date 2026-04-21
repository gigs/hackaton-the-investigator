# The Investigator — Implementation Plan

A Linear Agent that bridges Linear workspace events to a Claude Managed Agent. When users @mention or delegate issues to The Investigator in Linear, it proxies the request to an existing Claude Managed Agent, streams progress back as native Linear Agent Activities, and posts the final result.

## Architecture

```
Linear Workspace → HTTPS LB → VM:3000 (Hono) → Anthropic Managed Agent
                                    ↕                      ↕
                              Secret Manager          SSE stream
                           (OAuth tokens only)     (events mapped to
                                                    Linear activities)
```

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Compute | GCE VM + Docker | Long-lived process, simpler fire-and-forget than Cloud Run |
| Framework | Hono + @hono/node-server | Lightweight, good TS types, sufficient for 4 routes |
| Token storage | GCP Secret Manager | OAuth tokens are sensitive (workspace read/write); IAM-controlled, audit trail |
| Session mappings | In-memory Map | Recoverable on restart via Linear Activities API replay |
| Webhook dedup | In-memory Set (5min TTL) | Ephemeral, aligned to Linear retry window |
| Tenant model | Single workspace | Hackathon scope |
| Tool confirmation | Auto-confirm all | Managed agent environment constrains available tools |
| Issue transitions | None | Per team decision |
| HTTPS | GCP HTTPS Load Balancer + managed cert | Production-grade TLS termination for Linear webhooks + OAuth |

## Tech Stack

| Component | Package | Version |
|-----------|---------|---------|
| Runtime | Node.js | 22 |
| Language | TypeScript | latest |
| Framework | hono + @hono/node-server | latest |
| Linear SDK | @linear/sdk | 58.0.0 |
| Anthropic SDK | @anthropic-ai/sdk | pin after install |
| Secret Manager | @google-cloud/secret-manager | latest |
| Validation | zod | latest |
| Dev runner | tsx | latest |

## File Layout

```
hackaton-the-investigator/
├── src/
│   ├── index.ts                          # Hono app entry, route mounting, error boundary
│   ├── config.ts                         # Zod env var validation
│   ├── routes/
│   │   ├── health.ts                     # GET /health
│   │   ├── oauth.ts                      # GET /oauth/authorize, GET /oauth/callback
│   │   └── webhook.ts                    # POST /webhook
│   └── lib/
│       ├── linear/
│       │   ├── client.ts                 # LinearClient with token refresh
│       │   ├── activities.ts             # emitThought/Action/Response/Error helpers
│       │   ├── webhook-verify.ts         # HMAC-SHA256 signature verification
│       │   └── types.ts                  # Webhook payload TypeScript interfaces
│       ├── anthropic/
│       │   ├── session.ts                # Managed Agent session create/reuse + stream
│       │   └── event-mapper.ts           # Map Anthropic events → Linear activities
│       └── store/
│           ├── secrets.ts                # GCP Secret Manager wrapper (OAuth tokens)
│           └── memory.ts                 # In-memory maps (sessions, dedup, OAuth states)
├── package.json
├── tsconfig.json
├── Dockerfile
├── .env.example
├── .gitignore
├── PLAN.md
├── AGENTS.md
├── README.md
└── scripts/
    ├── create-project-and-vm.sh          # (modified: add Secret Manager + LB setup)
    ├── bootstrap-vm.sh
    ├── run-app-vm.sh
    ├── tunnel-app.sh
    └── vm-startup.sh
```

---

## Phase 1 — Scaffold & OAuth

### - [x] 1.1 — Project scaffold

Create the project skeleton with pinned dependencies.

**Files to create:** `package.json`, `tsconfig.json`, `.env.example`, `Dockerfile`
**Files to modify:** `.gitignore`

**Details:**
- `package.json`: set `packageManager: "pnpm@9.15.4"`, pin all deps, add scripts `dev` / `build` / `start`
- `tsconfig.json`: target ES2022, module NodeNext, strict, outDir dist
- `.env.example`: document all required env vars
- `Dockerfile`: node:22 + pnpm for VM Docker use
- `.gitignore`: add `node_modules/`, `dist/`
- Commit `pnpm-lock.yaml` for reproducible builds

**How to verify:**
```bash
pnpm install          # installs without errors
pnpm build            # tsc compiles (will fail until src/index.ts exists — expected)
```

---

### - [x] 1.2 — Config

Validate environment variables at startup.

**Files to create:** `src/config.ts`

**Details:**
- Zod schema for: `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `MANAGED_AGENT_ID`, `MANAGED_ENVIRONMENT_ID`, `GCP_PROJECT_ID`, `PORT`, `APP_URL`
- Export typed config object
- Fail fast on missing/invalid vars
- NEVER log values containing secrets

**How to verify:**
```bash
# With empty .env → should throw with descriptive Zod errors listing missing vars
pnpm dev
# With valid .env → should parse and export without errors
```

---

### - [x] 1.3 — Storage layer

Two modules: Secret Manager for sensitive tokens, in-memory for ephemeral state.

**Files to create:** `src/lib/store/secrets.ts`, `src/lib/store/memory.ts`

**Details for `secrets.ts`:**
- Secret pre-created by provisioning script as `investigator-oauth-token`
- App only calls `addSecretVersion()` — never `createSecret()`
- `getTokenData(): Promise<TokenData | null>` — access latest version, parse JSON
- `setTokenData(data: TokenData): Promise<void>` — add new version as JSON string
- Token shape: `{ access_token, refresh_token, expires_at, app_user_id }`

**Details for `memory.ts`:**
- `sessionMappings: Map<string, string>` — Linear session ID → Anthropic session ID
- `processedWebhooks: Set<string>` with 5min TTL auto-cleanup
- `oauthStates: Map<string, number>` — CSRF state → timestamp, 10min TTL
- `sessionLocks: Map<string, Promise<void>>` — per-session mutex to serialize concurrent webhooks

**How to verify:**
```bash
# Unit test: setTokenData() then getTokenData() returns same data
# Unit test: dedup Set auto-expires entries after 5min
# Unit test: sessionLocks serialize concurrent access
# Requires GCP_PROJECT_ID env var and ADC credentials for Secret Manager tests
```

---

### - [x] 1.3b — GCP setup for Secret Manager

One-time infrastructure provisioning.

**Files to modify:** `scripts/create-project-and-vm.sh`

**Details — add to provisioning script:**
1. Enable `secretmanager.googleapis.com` API
2. Create secret: `gcloud secrets create investigator-oauth-token --project=...`
3. Grant VM default service account:
   - `roles/secretmanager.secretAccessor` (read versions)
   - `roles/secretmanager.secretVersionManager` (add versions)
   - ⚠️ Verify exact role name against [GCP docs](https://cloud.google.com/secret-manager/docs/access-control) before scripting

**How to verify:**
```bash
# Run the script (idempotent)
./scripts/create-project-and-vm.sh
# Verify secret exists
gcloud secrets describe investigator-oauth-token --project=hackaton-the-investigator
# Verify IAM
gcloud secrets get-iam-policy investigator-oauth-token --project=hackaton-the-investigator
```

---

### - [x] 1.3c — HTTPS Load Balancer

Expose the app over HTTPS for Linear webhooks and OAuth redirects.

**Files to modify:** `scripts/create-project-and-vm.sh` (or separate script / documented manual steps)

**Details:**
1. Reserve static external IP
2. Create unmanaged instance group with the VM
3. Create backend service pointing to instance group, health check on `GET /health` port 3000
4. Create HTTPS LB with managed SSL certificate (requires a domain)
5. Add firewall rule: allow `35.191.0.0/16` and `130.211.0.0/22` (Google health check probes) to VM:3000
6. Configure DNS A record: `<domain>` → LB static IP
7. May need Certificate Manager API enabled
8. Set `APP_URL=https://<domain>` in `.env`

**How to verify:**
```bash
# After DNS propagation + cert provisioning:
curl -s https://<domain>/health
# Should return: {"status":"ok"}
```

---

### - [x] 1.4 — App entry

Hono application bootstrap with route mounting and error boundary.

**Files to create:** `src/index.ts`

**Details:**
- Create Hono app instance
- Mount routes: `GET /health`, `GET /oauth/authorize`, `GET /oauth/callback`, `POST /webhook`
- Serve via `@hono/node-server` on `config.PORT`
- Structured JSON logging (never log tokens/keys/raw promptContext)
- `process.on('unhandledRejection', ...)` — log but don't crash

**How to verify:**
```bash
pnpm dev
curl http://localhost:3000/health   # → {"status":"ok"}
# Other routes return 404 or placeholder until implemented
```

---

### - [x] 1.5 — Health route

Simple health check endpoint for LB probes.

**Files to create:** `src/routes/health.ts`

**Details:**
- `GET /health` → `200 { "status": "ok" }`

**How to verify:**
```bash
curl -s http://localhost:3000/health | jq .
# → { "status": "ok" }
```

---

### - [x] 1.6 — Linear client wrapper

LinearClient factory with automatic token refresh and rotation.

**Files to create:** `src/lib/linear/client.ts`

**Details:**
- `getLinearClient(): Promise<LinearClient>`
- Load token from Secret Manager via `getTokenData()`
- Check `expires_at` with 5-minute buffer
- If expired: POST `https://api.linear.app/oauth/token` with `grant_type=refresh_token`
- Persist BOTH new `access_token` AND new `refresh_token` (Linear rotates refresh tokens)
- Handle network errors gracefully (log + throw)
- Return configured `LinearClient` instance

**How to verify:**
```bash
# After OAuth is complete (Phase 1.8):
# Call getLinearClient() → should return a working client
# Manually expire the token → should auto-refresh and persist new tokens
```

---

### - [x] 1.7 — Linear types

TypeScript interfaces for webhook payloads.

**Files to create:** `src/lib/linear/types.ts`

**Details:**
- `AgentSessionEventPayload`: `action` ('created' | 'prompted'), `agentSession`, `agentActivity`, `promptContext`, `guidance`, `organizationId`, `appUserId`, `webhookId`/delivery ID
- `AgentSessionPayload`: `id`, `status`, `issue` (with `id`, `identifier`, `title`, `teamId`), `comment`
- `AgentActivityPayload`: `id`, `body`, `content`
- `TokenData`: `access_token`, `refresh_token`, `expires_at`, `app_user_id`
- Include `organizationId` field for single-tenant validation

**How to verify:**
```bash
pnpm tsc --noEmit   # types compile without errors
```

---

### - [x] 1.8 — OAuth routes

OAuth 2.0 flow for Linear app installation.

**Files to create:** `src/routes/oauth.ts`

**Details for `GET /oauth/authorize`:**
- Generate random `state` string (crypto.randomUUID)
- Store in `oauthStates` map with timestamp (10min TTL)
- Redirect to `https://linear.app/oauth/authorize` with:
  - `client_id`, `redirect_uri=${APP_URL}/oauth/callback`, `response_type=code`
  - `scope=read,write,app:assignable,app:mentionable`
  - `actor=app`, `state=<generated>`

**Details for `GET /oauth/callback`:**
- Validate `state` param exists in `oauthStates` map and is not expired
- Exchange `code` for token: POST `https://api.linear.app/oauth/token` with `grant_type=authorization_code`
- Query `viewer { id }` with the new access token to get `app_user_id`
- Store via `setTokenData({ access_token, refresh_token, expires_at, app_user_id })`
- Return success page

**How to verify:**
```bash
# 1. Open https://<domain>/oauth/authorize in browser
# 2. Should redirect to Linear OAuth consent page
# 3. After approval, redirects to callback
# 4. Callback exchanges token and stores in Secret Manager
# 5. Verify: gcloud secrets versions access latest --secret=investigator-oauth-token | jq .
# 6. The Investigator should appear as assignable/mentionable in Linear
```

---

## Phase 2 — Webhook Handling & Activities

### - [ ] 2.1 — Webhook signature verification

Verify that incoming webhooks are genuinely from Linear.

**Files to create:** `src/lib/linear/webhook-verify.ts`

**Details:**
- CRITICAL: verify HMAC-SHA256 over **raw body bytes** before any JSON parsing
- In Hono: read body as `text()` first, verify signature, then `JSON.parse()`
- Compare computed HMAC against `Linear-Signature` header (or `linear-signature`)
- Use Node `crypto.createHmac('sha256', secret).update(rawBody).digest('hex')`
- Return 401 on invalid signature
- Use timing-safe comparison (`crypto.timingSafeEqual`)

**How to verify:**
```bash
# Send a request with invalid/missing signature → 401
curl -X POST http://localhost:3000/webhook -d '{}' -H 'Content-Type: application/json'
# → 401

# Send with valid HMAC → 200 (even if payload is nonsense, signature passes)
# Can unit test with a known secret + body + expected HMAC
```

---

### - [ ] 2.2 — Activity helpers

Helper functions for emitting Linear Agent Activities.

**Files to create:** `src/lib/linear/activities.ts`

**Details:**
- `emitThought(client, sessionId, body, ephemeral?)` → `{ type: "thought", body }`
- `emitAction(client, sessionId, action, parameter, result?, ephemeral?)` → `{ type: "action", action, parameter, result? }`
- `emitResponse(client, sessionId, body)` → `{ type: "response", body }`
- `emitError(client, sessionId, body)` → `{ type: "error", body }`
- Each calls `linearClient.createAgentActivity({ agentSessionId, content, ephemeral? })`
- Log: activity type + linearSessionId (not body content — may contain sensitive data)

**How to verify:**
```bash
# After OAuth (Phase 1.8), with a known agentSessionId:
# Call emitThought() → should create visible activity in Linear UI
# Call emitError() → should show error in Linear
# Unit test: verify correct content shape passed to createAgentActivity
```

---

### - [ ] 2.3 — Webhook route

Receive Linear webhook events and process them asynchronously.

**Files to create:** `src/routes/webhook.ts`

**Details — SYNC path (must complete within ~5s):**
1. Read raw body as text
2. Verify HMAC signature → 401 on failure
3. `JSON.parse()` the verified body
4. Validate `organizationId` matches stored token's org → 403 on mismatch
5. Check in-memory dedup Set → skip if already seen
6. Add delivery ID to dedup Set
7. Return `200`

**Details — ASYNC path (fire-and-forget, wrapped in try/catch → error activity):**
1. Acquire per-session mutex (serialize concurrent webhooks for same session)
2. Get `LinearClient` via `getLinearClient()`
3. If `action === 'created'`:
   - Emit thought within 10s: "Received the issue. Forwarding to the investigation agent..."
   - Extract `promptContext` (pass as-is — it's already LLM-formatted XML)
   - Forward to Anthropic proxy (Phase 3)
4. If `action === 'prompted'`:
   - Extract follow-up message from `agentActivity.body`
   - Forward to Anthropic proxy (Phase 3)
5. On any error: emit error activity to Linear, log structured error

**How to verify:**
```bash
# 1. With valid signature + created event → 200 + thought activity appears in Linear within 10s
# 2. Same webhook resent → 200 but no duplicate processing (dedup)
# 3. Invalid signature → 401
# 4. Wrong org → 403
# 5. Simulated async error → error activity emitted to Linear
```

---

## Phase 3 — Anthropic Managed Agent Proxy

### - [ ] 3.1 — Anthropic session manager

Create and reuse Managed Agent sessions, with stream-first pattern.

**Files to create:** `src/lib/anthropic/session.ts`

**Details:**
- Initialize `Anthropic` client (SDK auto-includes `managed-agents-2026-04-01` beta header)
- `createOrGetSession(linearSessionId, issueIdentifier): Promise<string>`
  - Check in-memory `sessionMappings` map
  - If not found: `anthropic.beta.sessions.create({ agent: MANAGED_AGENT_ID, environment_id: MANAGED_ENVIRONMENT_ID, title: "Linear <issueIdentifier>" })`
  - Store mapping in memory
  - Return Anthropic session ID
- `sendAndStream(anthropicSessionId, prompt): AsyncIterable<Event>`
  - Open stream FIRST: `client.beta.sessions.events.stream(sessionId)`
  - THEN send: `client.beta.sessions.events.send(sessionId, { events: [{ type: "user.message", content: [{ type: "text", text: prompt }] }] })`
  - Return the stream async iterable

**How to verify:**
```bash
# With valid ANTHROPIC_API_KEY + MANAGED_AGENT_ID + MANAGED_ENVIRONMENT_ID:
# 1. createOrGetSession() → returns a session ID (string)
# 2. Same linearSessionId → returns same Anthropic session ID (cache hit)
# 3. sendAndStream() → returns iterable that yields events
# 4. Events include at minimum: agent.message or session.status_idle
```

---

### - [ ] 3.2 — Event mapper

Map Anthropic Managed Agent events to Linear Agent Activities in real-time.

**Files to create:** `src/lib/anthropic/event-mapper.ts`

**Details — `mapAndEmitEvents(stream, linearClient, linearSessionId)`:**

| Anthropic Event | Linear Activity | Notes |
|----------------|----------------|-------|
| `agent.thinking` | ephemeral `thought` | Shows agent reasoning |
| `agent.tool_use` | ephemeral `action` (name, JSON input) | Shows tool invocation |
| `agent.tool_result` | `action` with `result` | Updates previous action |
| `agent.message` | `response` | Agent's text output |
| `session.status_idle` + `end_turn` | (done, stop iterating) | Session complete |
| `session.status_idle` + `requires_action` | auto-confirm | Send `user.tool_confirmation` with `allow: true`, continue streaming |
| `session.error` + `retrying` | ephemeral `thought` ("Retrying...") | Transient, agent will retry |
| `session.error` + `exhausted` | `error` activity | Turn failed, session idle |
| `session.error` + `terminal` | `error` activity + stop | Session dead |

**How to verify:**
```bash
# Integration test with a real Managed Agent session:
# 1. Send a simple prompt → should see thought/action/response activities in Linear
# 2. Send a prompt that triggers tool use → should see action activities
# 3. Simulate error → should see error activity in Linear
```

---

### - [ ] 3.3 — Wire proxy to webhook

Connect the Anthropic session manager + event mapper to the webhook handler.

**Files to modify:** `src/routes/webhook.ts`

**Details:**
- In the ASYNC path of the webhook handler:
- For `created`: call `createOrGetSession(linearSessionId, issueIdentifier)`, then `sendAndStream(sessionId, promptContext)`, then `mapAndEmitEvents(stream, linearClient, linearSessionId)`
- For `prompted`: call `createOrGetSession(linearSessionId, issueIdentifier)`, then `sendAndStream(sessionId, agentActivity.body)`, then `mapAndEmitEvents(...)`

**How to verify:**
```bash
# End-to-end test:
# 1. @mention The Investigator on a Linear issue
# 2. Webhook received → thought activity ("Received the issue...")
# 3. Managed Agent processes → tool_use/thinking activities stream in
# 4. Final response activity appears in Linear
# 5. Reply in-thread → prompted webhook → follow-up response
```

---

## Phase 4 — Session Continuity

### - [ ] 4.1 — Session recovery and history replay

Handle expired or errored Anthropic sessions gracefully.

**Files to modify:** `src/lib/anthropic/session.ts`

**Details:**
- Wrap `sendAndStream()` in try/catch
- On Anthropic session error (expired, terminated):
  1. Remove old mapping from `sessionMappings`
  2. Create a new Anthropic session
  3. Replay conversation history from Linear Activities API:
     - Call `linearClient.agentSession(linearSessionId)` → `.activities()` with pagination
     - Filter to `Prompt` + `Response` activity types only
     - Order chronologically
     - Cap at last N activities (e.g. 20) to avoid context overflow
     - Map to `user.message` / `assistant.message` format
  4. Send replay messages, then send the new prompt
  5. Resume streaming

**How to verify:**
```bash
# 1. Complete a session successfully (baseline)
# 2. Wait for Anthropic session to expire (or manually invalidate)
# 3. Send a follow-up in Linear → should create new session with history
# 4. Agent response should show awareness of prior conversation context
```

---

## Phase 5 — Polish

### - [ ] 5.1 — Agent plans

Show execution progress in the Linear UI via agent session plans.

**Files to create/modify:** helper in `src/lib/linear/activities.ts`, updates to `src/lib/anthropic/event-mapper.ts`

**Details:**
- `updatePlan(linearClient, sessionId, steps: PlanStep[])` helper
- `PlanStep: { content: string, status: 'pending' | 'inProgress' | 'completed' | 'canceled' }`
- Plans are agent-session artifacts only — NO issue field/label/status mutations
- In event mapper: maintain a running list of plan steps
  - Each `agent.tool_use` → add step as `inProgress`
  - Each `agent.tool_result` → mark step `completed`
  - On `session.status_idle` + `end_turn` → mark all remaining `completed`
- Call `linearClient.agentSessionUpdate(sessionId, { plan: steps })` on each transition

**How to verify:**
```bash
# 1. Trigger a multi-step agent task
# 2. Plan steps should appear in Linear UI, updating in real-time
# 3. Completed steps show checkmarks, current step shows progress
```

---

### - [ ] 5.2 — Timeouts and keepalive

Prevent stale sessions and runaway agents.

**Files to modify:** `src/lib/anthropic/event-mapper.ts`, `src/lib/anthropic/session.ts`

**Details:**
- 30s initial timeout: if no Anthropic event received within 30s of sending, emit error activity and abort
  - Use `AbortController` + `setTimeout`
- 60s keepalive: for long-running sessions, emit ephemeral thought ("Still working...") every 60s to prevent Linear marking the session stale
- Configurable max duration: default 5 minutes, kill stream and emit error after
- All timeouts should clean up resources (abort stream, release session lock)

**How to verify:**
```bash
# 1. With a slow/unresponsive Managed Agent → error activity after 30s
# 2. With a long-running task (>60s) → periodic "Still working..." thoughts
# 3. After 5 minutes → timeout error activity, stream closed
```

---

### - [ ] 5.3 — Error handling

Structured error mapping from Anthropic to Linear.

**Files to modify:** `src/lib/anthropic/session.ts`, `src/lib/anthropic/event-mapper.ts`, `src/routes/webhook.ts`

**Details:**
- Wrap all Anthropic API calls in try/catch
- Error mapping:

| Anthropic Error | Linear Error Message |
|----------------|---------------------|
| Rate limited (429) | "The investigation agent is busy. Please try again shortly." |
| Model overloaded (529) | "The investigation agent is temporarily unavailable." |
| Billing/auth error | "Configuration error — please contact the admin." |
| Stream `session.error` + `retrying` | Ephemeral thought: "Retrying..." |
| Stream `session.error` + `exhausted` | Error: "The investigation agent encountered an error and could not complete." |
| Stream `session.error` + `terminal` | Error: "The investigation agent session has terminated." |
| Unknown error | "An unexpected error occurred." |

- Log full error details (excluding tokens/keys)
- All errors emit Linear `error` activities

**How to verify:**
```bash
# 1. Invalid ANTHROPIC_API_KEY → error activity with "Configuration error"
# 2. Rate limit simulation → error activity with "busy" message
# 3. All errors visible in Linear UI and in structured server logs
```

---

### - [ ] 5.4 — README

Complete project documentation.

**Files to modify:** `README.md`

**Details — add sections for:**
- Architecture overview (diagram from this plan)
- Environment variables (table with descriptions, which are secret)
- GCP setup: Secret Manager (API, secret creation, IAM roles)
- GCP setup: HTTPS Load Balancer (IP, instance group, LB, cert, DNS, firewall)
- Linear OAuth app setup (create app, set webhook URL, redirect URI, scopes)
- Local development (`pnpm dev` with `.env`)
- VM deployment (existing `run-app-vm.sh` workflow)
- AGENTS.md compliance notes:
  - Staging Linear workspace only, non-production data
  - Resource labels follow `hackathon-<name>` convention
  - GCP project under grx folder
  - Cleanup deadline: 2026-05-21

**How to verify:**
```bash
# A new team member can follow the README to:
# 1. Set up GCP resources
# 2. Deploy to the VM
# 3. Complete OAuth
# 4. See The Investigator working in Linear
```

---

### - [ ] Validation — Type-check

Final compilation verification.

**How to verify:**
```bash
pnpm install            # clean install from lockfile
pnpm tsc --noEmit       # TypeScript compiles without errors
```

No ESLint for hackathon scope — TypeScript compiler is the validator.
