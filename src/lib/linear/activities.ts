import type { LinearClient } from "@linear/sdk";

export interface PlanStep {
  content: string;
  status: "pending" | "inProgress" | "completed" | "canceled";
}

const AGENT_SESSION_UPDATE_MUTATION = `
  mutation AgentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) {
    agentSessionUpdate(id: $id, input: $input) {
      success
    }
  }
`;

export async function updatePlan(
  client: LinearClient,
  sessionId: string,
  steps: PlanStep[],
): Promise<void> {
  try {
    await client.client.rawRequest(AGENT_SESSION_UPDATE_MUTATION, {
      id: sessionId,
      input: { plan: steps },
    });
    console.log(
      "Plan updated: session=%s steps=%d",
      sessionId,
      steps.length,
    );
  } catch (err) {
    console.error("Failed to update plan for session=%s: %s", sessionId, err);
  }
}

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
