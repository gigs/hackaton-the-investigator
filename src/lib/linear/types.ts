export interface SessionContext {
  issueId: string;
  triggerUserId: string;
}

export interface AgentSessionPayload {
  id: string;
  status: string;
  creatorId?: string;
  issue: {
    id: string;
    identifier: string;
    title: string;
    teamId: string;
  };
  comment?: {
    id: string;
    body: string;
    userId?: string;
  };
}

export interface AgentActivityPayload {
  id: string;
  body?: string;
  content?: Record<string, unknown>;
}

export interface AgentSessionEventPayload {
  action: "created" | "prompted";
  type: "AgentSession" | "AgentSessionEvent";
  agentSession: AgentSessionPayload;
  agentActivity?: AgentActivityPayload;
  promptContext?: string;
  guidance?: string;
  organizationId: string;
  appUserId: string;
  webhookId: string;
}
