import type { Stream } from "@anthropic-ai/sdk/streaming";
import type {
  BetaManagedAgentsStreamSessionEvents,
  BetaManagedAgentsTextBlock,
} from "@anthropic-ai/sdk/resources/beta/sessions/events";
import type { LinearClient } from "@linear/sdk";
import {
  emitThought,
  emitAction,
  emitResponse,
  emitError,
  updatePlan,
  type PlanStep,
} from "../linear/activities.js";
import { getClient, InvestigatorError } from "./session.js";
import { classifyAnthropicError } from "./errors.js";
import type { SessionContext } from "../linear/types.js";
import {
  updateIssuePlan,
  addClarificationComment,
} from "../linear/actions.js";

const INITIAL_TIMEOUT_MS = 30_000;
const KEEPALIVE_CHECK_MS = 30_000;
const KEEPALIVE_INTERVAL_MS = 60_000;
const MAX_DURATION_MS = 5 * 60_000;

type AbortReason = "initial_timeout" | "max_duration";

function extractText(
  content?: Array<{ type: string; text?: string }>,
): string {
  if (!content) return "";
  return content
    .filter((b): b is BetaManagedAgentsTextBlock => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

function truncate(str: string, max = 2000): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + "…";
}

export async function mapAndEmitEvents(
  stream: Stream<BetaManagedAgentsStreamSessionEvents>,
  linearClient: LinearClient,
  linearSessionId: string,
  anthropicSessionId: string,
  sessionCtx: SessionContext,
): Promise<void> {
  const anthropic = getClient();
  const planSteps: PlanStep[] = [];
  const toolIdToStepIndex = new Map<string, number>();
  const pendingCustomTools = new Map<string, { name: string; input: Record<string, unknown>; stepIndex: number }>();

  let lastEventTime = Date.now();
  let receivedFirstEvent = false;
  let abortReason: AbortReason | null = null;

  const initialTimer = setTimeout(() => {
    if (!receivedFirstEvent) {
      abortReason = "initial_timeout";
      stream.controller.abort();
    }
  }, INITIAL_TIMEOUT_MS);

  const maxDurationTimer = setTimeout(() => {
    abortReason = "max_duration";
    stream.controller.abort();
  }, MAX_DURATION_MS);

  const keepaliveTimer = setInterval(() => {
    if (!receivedFirstEvent) return;
    if (Date.now() - lastEventTime >= KEEPALIVE_INTERVAL_MS) {
      emitThought(linearClient, linearSessionId, "Still working…").catch(() => {});
      lastEventTime = Date.now();
    }
  }, KEEPALIVE_CHECK_MS);

  function cleanup(): void {
    clearTimeout(initialTimer);
    clearTimeout(maxDurationTimer);
    clearInterval(keepaliveTimer);
  }

  async function cancelRemainingSteps(): Promise<void> {
    let changed = false;
    for (const step of planSteps) {
      if (step.status === "inProgress" || step.status === "pending") {
        step.status = "canceled";
        changed = true;
      }
    }
    if (changed && planSteps.length > 0) {
      await updatePlan(linearClient, linearSessionId, [...planSteps]);
    }
  }

  async function handleAbort(): Promise<void> {
    if (abortReason === "initial_timeout") {
      console.error(
        "Initial timeout (%dms) — no events received: session=%s",
        INITIAL_TIMEOUT_MS,
        anthropicSessionId,
      );
      await emitError(
        linearClient,
        linearSessionId,
        "The investigation agent did not respond within 30 seconds.",
      );
    } else if (abortReason === "max_duration") {
      console.error(
        "Max duration (%dms) exceeded: session=%s",
        MAX_DURATION_MS,
        anthropicSessionId,
      );
      await cancelRemainingSteps();
      await emitError(
        linearClient,
        linearSessionId,
        "The investigation agent exceeded the maximum session duration (5 minutes).",
      );
    }
  }

  async function pushPlan(): Promise<void> {
    await updatePlan(linearClient, linearSessionId, [...planSteps]);
  }

  try {
    for await (const event of stream) {
      if (!receivedFirstEvent) {
        receivedFirstEvent = true;
        clearTimeout(initialTimer);
      }
      lastEventTime = Date.now();

      console.log(
        "Anthropic event: type=%s session=%s",
        event.type,
        anthropicSessionId,
      );

      switch (event.type) {
      case "agent.thinking": {
        await emitThought(linearClient, linearSessionId, "Thinking…");
        break;
      }

      case "agent.tool_use": {
        const stepIndex = planSteps.length;
        planSteps.push({ content: event.name, status: "inProgress" });
        toolIdToStepIndex.set(event.id, stepIndex);
        await pushPlan();

        await emitAction(
          linearClient,
          linearSessionId,
          event.name,
          truncate(JSON.stringify(event.input)),
        );
        break;
      }

      case "agent.mcp_tool_use": {
        const label = `${event.mcp_server_name}/${event.name}`;
        const stepIndex = planSteps.length;
        planSteps.push({ content: label, status: "inProgress" });
        toolIdToStepIndex.set(event.id, stepIndex);
        await pushPlan();

        await emitAction(
          linearClient,
          linearSessionId,
          label,
          truncate(JSON.stringify(event.input)),
        );
        break;
      }

      case "agent.tool_result": {
        const idx = toolIdToStepIndex.get(event.tool_use_id);
        if (idx !== undefined) {
          planSteps[idx].status = event.is_error ? "canceled" : "completed";
          await pushPlan();
        }

        const resultText = extractText(event.content);
        await emitAction(
          linearClient,
          linearSessionId,
          "tool_result",
          event.tool_use_id,
          truncate(resultText || (event.is_error ? "Error" : "Done")),
        );
        break;
      }

      case "agent.mcp_tool_result": {
        const idx = toolIdToStepIndex.get(event.mcp_tool_use_id);
        if (idx !== undefined) {
          planSteps[idx].status = event.is_error ? "canceled" : "completed";
          await pushPlan();
        }

        const resultText = extractText(event.content);
        await emitAction(
          linearClient,
          linearSessionId,
          "mcp_tool_result",
          event.mcp_tool_use_id,
          truncate(resultText || (event.is_error ? "Error" : "Done")),
        );
        break;
      }

      case "agent.message": {
        const text = event.content
          .filter(
            (b): b is BetaManagedAgentsTextBlock => b.type === "text",
          )
          .map((b) => b.text)
          .join("\n");
        if (text) {
          await emitResponse(linearClient, linearSessionId, text);
        }
        break;
      }

      case "session.status_idle": {
        const { stop_reason } = event;

        if (stop_reason.type === "end_turn") {
          for (const step of planSteps) {
            if (step.status === "pending" || step.status === "inProgress") {
              step.status = "completed";
            }
          }
          if (planSteps.length > 0) await pushPlan();

          console.log(
            "Session turn complete: %s",
            anthropicSessionId,
          );
          return;
        }

        if (stop_reason.type === "requires_action") {
          const customToolIds: string[] = [];
          const confirmationIds: string[] = [];

          for (const eventId of stop_reason.event_ids) {
            if (pendingCustomTools.has(eventId)) {
              customToolIds.push(eventId);
            } else {
              confirmationIds.push(eventId);
            }
          }

          for (const toolId of customToolIds) {
            const tool = pendingCustomTools.get(toolId)!;
            pendingCustomTools.delete(toolId);

            let resultContent: string;
            let isError = false;

            if (tool.name === "plan_ready") {
              const raw = tool.input.plan ?? tool.input.content ?? tool.input.description;
              const content = typeof raw === "string" ? raw : JSON.stringify(raw ?? tool.input);
              const rawTitle = tool.input.title;
              const title = typeof rawTitle === "string" && rawTitle ? rawTitle : undefined;
              const result = await updateIssuePlan(linearClient, sessionCtx.issueId, content, title);
              if (result.ok) {
                resultContent = "Issue description updated successfully.";
                planSteps[tool.stepIndex].status = "completed";
              } else {
                resultContent = `Failed to update issue description: ${result.error}`;
                planSteps[tool.stepIndex].status = "canceled";
                isError = true;
              }
            } else if (tool.name === "requires_clarification") {
              const raw = tool.input.clarification ?? tool.input.message ?? tool.input.question;
              const message = typeof raw === "string" ? raw : JSON.stringify(raw ?? tool.input);
              const result = await addClarificationComment(linearClient, sessionCtx.issueId, sessionCtx.triggerUserId, message);
              if (result.ok) {
                resultContent = "Clarification comment posted on the issue.";
                planSteps[tool.stepIndex].status = "completed";
              } else {
                resultContent = `Failed to post clarification comment: ${result.error}`;
                planSteps[tool.stepIndex].status = "canceled";
                isError = true;
              }
            } else {
              resultContent = `Unknown custom tool: ${tool.name}`;
              planSteps[tool.stepIndex].status = "canceled";
              isError = true;
            }

            await pushPlan();

            await anthropic.beta.sessions.events.send(anthropicSessionId, {
              events: [
                {
                  type: "user.custom_tool_result",
                  custom_tool_use_id: toolId,
                  content: [{ type: "text", text: resultContent }],
                  is_error: isError,
                },
              ],
            });
            console.log(
              "Custom tool result sent: name=%s toolId=%s isError=%s session=%s",
              tool.name,
              toolId,
              isError,
              anthropicSessionId,
            );
          }

          for (const eventId of confirmationIds) {
            await anthropic.beta.sessions.events.send(anthropicSessionId, {
              events: [
                {
                  type: "user.tool_confirmation",
                  tool_use_id: eventId,
                  result: "deny",
                  deny_message:
                    "Tool confirmations are not permitted in this environment.",
                },
              ],
            });
          }
          if (confirmationIds.length > 0) {
            console.log(
              "Auto-denied %d tool(s): session=%s",
              confirmationIds.length,
              anthropicSessionId,
            );
          }
          break;
        }

        if (stop_reason.type === "retries_exhausted") {
          for (const step of planSteps) {
            if (step.status === "inProgress") step.status = "canceled";
          }
          if (planSteps.length > 0) await pushPlan();

          await emitError(
            linearClient,
            linearSessionId,
            "The investigation agent exhausted its retry budget.",
          );
          return;
        }

        break;
      }

      case "session.error": {
        const { retry_status } = event.error;

        if (retry_status.type === "retrying") {
          await emitThought(
            linearClient,
            linearSessionId,
            "Retrying…",
          );
        } else if (retry_status.type === "exhausted") {
          for (const step of planSteps) {
            if (step.status === "inProgress") step.status = "canceled";
          }
          if (planSteps.length > 0) await pushPlan();

          await emitError(
            linearClient,
            linearSessionId,
            "The investigation agent encountered an error and could not complete.",
          );
          return;
        } else if (retry_status.type === "terminal") {
          for (const step of planSteps) {
            if (step.status === "inProgress") step.status = "canceled";
          }
          if (planSteps.length > 0) await pushPlan();

          await emitError(
            linearClient,
            linearSessionId,
            "The investigation agent session has terminated.",
          );
          return;
        }
        break;
      }

      case "session.status_terminated": {
        for (const step of planSteps) {
          if (step.status === "inProgress") step.status = "canceled";
        }
        if (planSteps.length > 0) await pushPlan();

        console.log(
          "Session terminated: %s",
          anthropicSessionId,
        );
        return;
      }

      case "agent.custom_tool_use": {
        const customEvent = event as { id: string; name: string; input: Record<string, unknown>; type: string };
        const stepIndex = planSteps.length;
        const label = customEvent.name === "plan_ready"
          ? "Updating issue description"
          : customEvent.name === "requires_clarification"
            ? "Requesting clarification"
            : `Custom tool: ${customEvent.name}`;
        planSteps.push({ content: label, status: "inProgress" });
        pendingCustomTools.set(customEvent.id, {
          name: customEvent.name,
          input: customEvent.input,
          stepIndex,
        });
        await pushPlan();
        break;
      }

      case "session.status_running":
      case "session.status_rescheduled":
      case "session.deleted":
      case "span.model_request_start":
      case "span.model_request_end":
      case "agent.thread_context_compacted":
      case "user.message":
      case "user.interrupt":
      case "user.tool_confirmation":
      case "user.custom_tool_result":
        break;

      default:
        console.log(
          "Unhandled Anthropic event type: %s",
          (event as { type: string }).type,
        );
        break;
    }
    }

    if (abortReason) {
      await handleAbort();
    }
  } catch (err) {
    if (abortReason) {
      try {
        await handleAbort();
      } catch (abortErr) {
        console.error("Failed to emit abort error activity:", abortErr);
      }
      return;
    }

    await cancelRemainingSteps();

    if (err instanceof InvestigatorError) {
      console.error("Stream error (classified): %s", err.classified.logMessage);
      await emitError(linearClient, linearSessionId, err.classified.userMessage);
      return;
    }

    const classified = classifyAnthropicError(err);
    console.error("Stream error: %s", classified.logMessage);
    await emitError(linearClient, linearSessionId, classified.userMessage);
  } finally {
    cleanup();
  }
}
