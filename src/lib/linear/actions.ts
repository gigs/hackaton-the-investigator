import type { LinearClient } from "@linear/sdk";

interface ActionResult {
  ok: boolean;
  error?: string;
}

export async function updateIssuePlan(
  client: LinearClient,
  issueId: string,
  markdown: string,
  title?: string,
): Promise<ActionResult> {
  try {
    const update: Record<string, string> = { description: markdown };
    if (title) update.title = title;
    await client.updateIssue(issueId, update);
    console.log("Issue updated: issueId=%s titleChanged=%s", issueId, !!title);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Failed to update issue: issueId=%s error=%s", issueId, msg);
    return { ok: false, error: msg };
  }
}

export async function addClarificationComment(
  client: LinearClient,
  issueId: string,
  triggerUserId: string,
  message: string,
): Promise<ActionResult> {
  try {
    let userTag = "";
    if (triggerUserId) {
      try {
        const user = await client.user(triggerUserId);
        console.log(
          "Resolved trigger user: id=%s displayName=%s name=%s",
          user.id,
          user.displayName,
          user.name,
        );
        const name = user.displayName || user.name;
        if (name) {
          userTag = `@${name} `;
        }
      } catch (err) {
        console.warn("Could not resolve user for userId=%s: %s", triggerUserId, err);
      }
    }

    const body = `${userTag}${message}`;
    await client.createComment({ issueId, body });
    console.log("Clarification comment added: issueId=%s", issueId);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Failed to add clarification comment: issueId=%s error=%s", issueId, msg);
    return { ok: false, error: msg };
  }
}
