import { Hono } from "hono";
import { config } from "../config.js";
import { verifyWebhookSignature } from "../lib/linear/webhook-verify.js";
import { getLinearClient } from "../lib/linear/client.js";
import { emitThought, emitError } from "../lib/linear/activities.js";
import {
  hasProcessedWebhook,
  markWebhookProcessed,
  withSessionLock,
} from "../lib/store/memory.js";
import type { AgentSessionEventPayload } from "../lib/linear/types.js";

let cachedOrgId: string | null = null;

async function resolveOrgId(): Promise<string> {
  if (cachedOrgId) return cachedOrgId;

  const client = await getLinearClient();
  const org = await client.organization;
  cachedOrgId = org.id;
  return cachedOrgId;
}

const webhook = new Hono();

webhook.post("/webhook", async (c) => {
  const rawBody = await c.req.text();

  const signature =
    c.req.header("linear-signature") ?? c.req.header("Linear-Signature");
  if (!verifyWebhookSignature(rawBody, signature, config.LINEAR_WEBHOOK_SECRET)) {
    return c.json({ error: "Invalid signature" }, 401);
  }

  let payload: AgentSessionEventPayload;
  try {
    payload = JSON.parse(rawBody) as AgentSessionEventPayload;
  } catch {
    console.error("Webhook body is not valid JSON (verified signature passed)");
    return c.json({ ok: true });
  }

  if (payload.type !== "AgentSession") {
    return c.json({ ok: true });
  }

  const orgId = await resolveOrgId();
  if (orgId !== payload.organizationId) {
    console.error(
      "Organization mismatch: expected=%s received=%s",
      orgId,
      payload.organizationId,
    );
    return c.json({ ok: true });
  }

  const deliveryId = payload.webhookId;
  if (hasProcessedWebhook(deliveryId)) {
    return c.json({ ok: true, deduplicated: true });
  }
  markWebhookProcessed(deliveryId);

  const linearSessionId = payload.agentSession.id;

  processWebhookAsync(payload, linearSessionId).catch((err) => {
    console.error("Webhook async processing failed:", err);
  });

  return c.json({ ok: true });
});

async function processWebhookAsync(
  payload: AgentSessionEventPayload,
  linearSessionId: string,
): Promise<void> {
  await withSessionLock(linearSessionId, async () => {
    const client = await getLinearClient();

    try {
      if (payload.action === "created") {
        await emitThought(
          client,
          linearSessionId,
          "Received the issue. Forwarding to the investigation agent...",
        );

        const promptContext = payload.promptContext ?? "";
        console.log(
          "Webhook created: session=%s issue=%s",
          linearSessionId,
          payload.agentSession.issue.identifier,
        );

        // Phase 3 will wire the Anthropic proxy here
        void promptContext;
      } else if (payload.action === "prompted") {
        const followUp = payload.agentActivity?.body ?? "";
        console.log(
          "Webhook prompted: session=%s followUp length=%d",
          linearSessionId,
          followUp.length,
        );

        // Phase 3 will wire the Anthropic proxy here
        void followUp;
      }
    } catch (err) {
      console.error(
        "Error processing webhook for session",
        linearSessionId,
        err,
      );
      try {
        await emitError(
          client,
          linearSessionId,
          "An unexpected error occurred while processing the request.",
        );
      } catch (emitErr) {
        console.error("Failed to emit error activity:", emitErr);
      }
    }
  });
}

export { webhook };
