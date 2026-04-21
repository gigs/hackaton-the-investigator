import Anthropic from "@anthropic-ai/sdk";
import type { Stream } from "@anthropic-ai/sdk/streaming";
import type { BetaManagedAgentsStreamSessionEvents } from "@anthropic-ai/sdk/resources/beta/sessions/events";
import type { LinearClient } from "@linear/sdk";
import { config } from "../../config.js";
import { sessionMappings } from "../store/memory.js";
import { classifyAnthropicError, type ClassifiedError } from "./errors.js";

export class InvestigatorError extends Error {
  constructor(
    public readonly classified: ClassifiedError,
    cause?: unknown,
  ) {
    super(classified.logMessage, { cause });
    this.name = "InvestigatorError";
  }
}

const MAX_HISTORY_ACTIVITIES = 20;

let client: Anthropic | null = null;

export function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  }
  return client;
}

export async function createOrGetSession(
  linearSessionId: string,
  issueIdentifier: string,
): Promise<string> {
  const existing = sessionMappings.get(linearSessionId);
  if (existing) {
    console.log(
      "Anthropic session cache hit: linear=%s anthropic=%s",
      linearSessionId,
      existing,
    );
    return existing;
  }

  return createNewSession(linearSessionId, issueIdentifier);
}

async function createNewSession(
  linearSessionId: string,
  issueIdentifier: string,
): Promise<string> {
  const anthropic = getClient();
  let session;
  try {
    session = await anthropic.beta.sessions.create({
      agent: config.MANAGED_AGENT_ID,
      environment_id: config.MANAGED_ENVIRONMENT_ID,
      title: `Linear ${issueIdentifier}`,
      ...(config.MANAGED_VAULT_ID && { vault_ids: [config.MANAGED_VAULT_ID] }),
    });
  } catch (err) {
    const classified = classifyAnthropicError(err);
    console.error(classified.logMessage);
    throw new InvestigatorError(classified, err);
  }

  sessionMappings.set(linearSessionId, session.id);
  console.log(
    "Anthropic session created: linear=%s anthropic=%s",
    linearSessionId,
    session.id,
  );
  return session.id;
}

export async function sendAndStream(
  anthropicSessionId: string,
  prompt: string,
): Promise<Stream<BetaManagedAgentsStreamSessionEvents>> {
  const anthropic = getClient();

  let stream: Stream<BetaManagedAgentsStreamSessionEvents>;
  try {
    // Open stream FIRST to avoid race condition — per Anthropic docs,
    // only events emitted after the stream opens are delivered.
    stream = await anthropic.beta.sessions.events.stream(
      anthropicSessionId,
    );
  } catch (err) {
    if (isSessionExpiredOrTerminated(err)) throw err;
    const classified = classifyAnthropicError(err);
    console.error(classified.logMessage);
    throw new InvestigatorError(classified, err);
  }

  try {
    await anthropic.beta.sessions.events.send(anthropicSessionId, {
      events: [
        {
          type: "user.message",
          content: [{ type: "text", text: prompt }],
        },
      ],
    });
  } catch (err) {
    if (isSessionExpiredOrTerminated(err)) throw err;
    const classified = classifyAnthropicError(err);
    console.error(classified.logMessage);
    throw new InvestigatorError(classified, err);
  }

  console.log(
    "Anthropic prompt sent and stream opened: session=%s promptLength=%d",
    anthropicSessionId,
    prompt.length,
  );

  return stream;
}

/**
 * Fetch conversation history from Linear Activities API and format it
 * as a context summary for replaying into a new Anthropic session.
 */
export async function fetchConversationHistory(
  linearClient: LinearClient,
  linearSessionId: string,
): Promise<string | null> {
  try {
    const session = await linearClient.agentSession(linearSessionId);
    const activitiesConnection = await session.activities({
      first: MAX_HISTORY_ACTIVITIES,
    });

    const entries: Array<{ role: "user" | "assistant"; body: string }> = [];

    for (const activity of activitiesConnection.nodes) {
      const content = activity.content;
      if (!content || typeof content.type !== "string") continue;

      if (content.type === "prompt" && "body" in content) {
        entries.push({ role: "user", body: (content as { body: string }).body });
      } else if (content.type === "response" && "body" in content) {
        entries.push({ role: "assistant", body: (content as { body: string }).body });
      }
    }

    if (entries.length === 0) return null;

    const lines = entries.map(
      (e) => `<${e.role}>\n${e.body}\n</${e.role}>`,
    );

    return [
      "<conversation_history>",
      "The following is the prior conversation history from this session.",
      "Continue from where you left off.",
      "",
      ...lines,
      "</conversation_history>",
    ].join("\n");
  } catch (err) {
    console.error(
      "Failed to fetch conversation history for session=%s: %s",
      linearSessionId,
      err,
    );
    return null;
  }
}

function isSessionExpiredOrTerminated(err: unknown): boolean {
  if (err instanceof Anthropic.APIError) {
    // 404 = session not found/expired, 409 = session terminated
    return err.status === 404 || err.status === 409;
  }
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return msg.includes("session") &&
      (msg.includes("expired") || msg.includes("terminated") || msg.includes("not found"));
  }
  return false;
}

/**
 * Send a prompt and open a stream, automatically recovering from
 * expired/terminated Anthropic sessions by creating a new session
 * and replaying conversation history from Linear.
 */
export async function sendAndStreamWithRecovery(
  linearClient: LinearClient,
  linearSessionId: string,
  issueIdentifier: string,
  prompt: string,
): Promise<{ stream: Stream<BetaManagedAgentsStreamSessionEvents>; anthropicSessionId: string }> {
  const anthropicSessionId = await createOrGetSession(linearSessionId, issueIdentifier);

  try {
    const stream = await sendAndStream(anthropicSessionId, prompt);
    return { stream, anthropicSessionId };
  } catch (err) {
    if (err instanceof InvestigatorError) throw err;
    if (!isSessionExpiredOrTerminated(err)) {
      const classified = classifyAnthropicError(err);
      console.error(classified.logMessage);
      throw new InvestigatorError(classified, err);
    }

    console.log(
      "Anthropic session expired/terminated, recovering: linear=%s anthropic=%s",
      linearSessionId,
      anthropicSessionId,
    );

    sessionMappings.delete(linearSessionId);

    const newSessionId = await createNewSession(linearSessionId, issueIdentifier);

    const history = await fetchConversationHistory(linearClient, linearSessionId);
    const replayPrompt = history
      ? `${history}\n\n${prompt}`
      : prompt;

    const stream = await sendAndStream(newSessionId, replayPrompt);
    return { stream, anthropicSessionId: newSessionId };
  }
}
