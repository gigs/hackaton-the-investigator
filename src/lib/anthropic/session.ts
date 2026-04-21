import Anthropic from "@anthropic-ai/sdk";
import type { Stream } from "@anthropic-ai/sdk/streaming";
import type { BetaManagedAgentsStreamSessionEvents } from "@anthropic-ai/sdk/resources/beta/sessions/events";
import { config } from "../../config.js";
import { sessionMappings } from "../store/memory.js";

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

  const anthropic = getClient();
  const session = await anthropic.beta.sessions.create({
    agent: config.MANAGED_AGENT_ID,
    environment_id: config.MANAGED_ENVIRONMENT_ID,
    title: `Linear ${issueIdentifier}`,
  });

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

  // Open stream FIRST to avoid race condition — per Anthropic docs,
  // only events emitted after the stream opens are delivered.
  const stream = await anthropic.beta.sessions.events.stream(
    anthropicSessionId,
  );

  await anthropic.beta.sessions.events.send(anthropicSessionId, {
    events: [
      {
        type: "user.message",
        content: [{ type: "text", text: prompt }],
      },
    ],
  });

  console.log(
    "Anthropic prompt sent and stream opened: session=%s promptLength=%d",
    anthropicSessionId,
    prompt.length,
  );

  return stream;
}
