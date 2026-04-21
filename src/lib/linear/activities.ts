import type { LinearClient } from "@linear/sdk";

export async function emitThought(
  client: LinearClient,
  sessionId: string,
  body: string,
): Promise<void> {
  await client.createAgentActivity({
    agentSessionId: sessionId,
    content: { type: "thought", body },
  });
  console.log("Activity emitted: thought for session", sessionId);
}

export async function emitAction(
  client: LinearClient,
  sessionId: string,
  action: string,
  parameter: string,
  result?: string,
): Promise<void> {
  const content: Record<string, string> = { type: "action", action, parameter };
  if (result !== undefined) content.result = result;

  await client.createAgentActivity({
    agentSessionId: sessionId,
    content,
  });
  console.log("Activity emitted: action for session", sessionId);
}

export async function emitResponse(
  client: LinearClient,
  sessionId: string,
  body: string,
): Promise<void> {
  await client.createAgentActivity({
    agentSessionId: sessionId,
    content: { type: "response", body },
  });
  console.log("Activity emitted: response for session", sessionId);
}

export async function emitError(
  client: LinearClient,
  sessionId: string,
  body: string,
): Promise<void> {
  await client.createAgentActivity({
    agentSessionId: sessionId,
    content: { type: "error", body },
  });
  console.log("Activity emitted: error for session", sessionId);
}
