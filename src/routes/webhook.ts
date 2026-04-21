import { Hono } from "hono";
import { config } from "../config.js";
import { verifyWebhookSignature } from "../lib/linear/webhook-verify.js";
import { getLinearClient } from "../lib/linear/client.js";
import { emitThought, emitError } from "../lib/linear/activities.js";
import {
  sendAndStreamWithRecovery,
  InvestigatorError,
} from "../lib/anthropic/session.js";
import { classifyAnthropicError } from "../lib/anthropic/errors.js";
import { mapAndEmitEvents } from "../lib/anthropic/event-mapper.js";
import {
  hasProcessedWebhook,
  markWebhookProcessed,
  withSessionLock,
} from "../lib/store/memory.js";
import type {
  AgentSessionEventPayload,
  SessionContext,
} from "../lib/linear/types.js";

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

  console.log("Webhook received: type=%s action=%s", payload.type, (payload as any).action);

  if (payload.type !== "AgentSession" && payload.type !== "AgentSessionEvent") {
    console.log("Ignoring non-AgentSession webhook (type=%s)", payload.type);
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

async function resolveTriggerUserId(
  client: Awaited<ReturnType<typeof getLinearClient>>,
  payload: AgentSessionEventPayload,
  linearSessionId: string,
): Promise<string> {
  try {
    if (payload.action === "created") {
      if (payload.agentSession.creatorId) {
        console.log("Trigger user from payload creatorId: %s", payload.agentSession.creatorId);
        return payload.agentSession.creatorId;
      }
      const session = await client.agentSession(linearSessionId);
      const creator = await session.creator;
      if (creator?.id) {
        console.log("Trigger user from session creator: %s", creator.id);
        return creator.id;
      }
    } else if (payload.action === "prompted") {
      if (payload.agentSession.comment?.userId) {
        console.log("Trigger user from comment userId: %s", payload.agentSession.comment.userId);
        return payload.agentSession.comment.userId;
      }
      if (payload.agentSession.comment?.id) {
        try {
          const comment = await client.comment({ id: payload.agentSession.comment.id });
          const user = await comment.user;
          if (user?.id) {
            console.log("Trigger user from fetched comment user: %s", user.id);
            return user.id;
          }
        } catch (commentErr) {
          console.warn("Could not fetch comment user: %s", commentErr);
        }
      }
      const session = await client.agentSession(linearSessionId);
      const creator = await session.creator;
      if (creator?.id) {
        console.log("Trigger user fallback to session creator: %s", creator.id);
        return creator.id;
      }
    }
  } catch (err) {
    console.warn("Could not resolve trigger user for session=%s: %s", linearSessionId, err);
  }
  console.warn("Trigger user unresolved for session=%s, using empty string", linearSessionId);
  return "";
}

async function processWebhookAsync(
  payload: AgentSessionEventPayload,
  linearSessionId: string,
): Promise<void> {
  await withSessionLock(linearSessionId, async () => {
    const client = await getLinearClient();

    try {
      const issueIdentifier = payload.agentSession.issue.identifier;
      const issueId = payload.agentSession.issue.id;
      const triggerUserId = await resolveTriggerUserId(client, payload, linearSessionId);
      const sessionCtx: SessionContext = { issueId, triggerUserId };

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
          issueIdentifier,
        );

        const { stream, anthropicSessionId } = await sendAndStreamWithRecovery(
          client,
          linearSessionId,
          issueIdentifier,
          promptContext,
        );
        await mapAndEmitEvents(stream, client, linearSessionId, anthropicSessionId, sessionCtx);
      } else if (payload.action === "prompted") {
        const followUp = payload.agentActivity?.body ?? "";
        console.log(
          "Webhook prompted: session=%s followUp length=%d",
          linearSessionId,
          followUp.length,
        );

        const { stream, anthropicSessionId } = await sendAndStreamWithRecovery(
          client,
          linearSessionId,
          issueIdentifier,
          followUp,
        );
        await mapAndEmitEvents(stream, client, linearSessionId, anthropicSessionId, sessionCtx);
      }
    } catch (err) {
      let userMessage: string;
      if (err instanceof InvestigatorError) {
        console.error(
          "Webhook error (classified) session=%s: %s",
          linearSessionId,
          err.classified.logMessage,
        );
        userMessage = err.classified.userMessage;
      } else {
        const classified = classifyAnthropicError(err);
        console.error(
          "Webhook error session=%s: %s",
          linearSessionId,
          classified.logMessage,
        );
        userMessage = classified.userMessage;
      }

      try {
        await emitError(client, linearSessionId, userMessage);
      } catch (emitErr) {
        console.error("Failed to emit error activity:", emitErr);
      }
    }
  });
}

export { webhook };
