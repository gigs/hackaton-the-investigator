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
import { getClient } from "./session.js";

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
): Promise<void> {
  const anthropic = getClient();
  const planSteps: PlanStep[] = [];
  const toolIdToStepIndex = new Map<string, number>();

  async function pushPlan(): Promise<void> {
    await updatePlan(linearClient, linearSessionId, [...planSteps]);
  }

  for await (const event of stream) {
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
          for (const eventId of stop_reason.event_ids) {
            await anthropic.beta.sessions.events.send(
              anthropicSessionId,
              {
                events: [
                  {
                    type: "user.tool_confirmation",
                    tool_use_id: eventId,
                    result: "deny",
                    deny_message:
                      "Tool confirmations are not permitted in this environment.",
                  },
                ],
              },
            );
          }
          console.log(
            "Auto-denied %d tool(s): session=%s",
            stop_reason.event_ids.length,
            anthropicSessionId,
          );
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

      case "session.status_running":
      case "session.status_rescheduled":
      case "session.deleted":
      case "span.model_request_start":
      case "span.model_request_end":
      case "agent.thread_context_compacted":
      case "agent.custom_tool_use": // TODO: handle custom tools
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
}
