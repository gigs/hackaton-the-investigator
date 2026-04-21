import Anthropic from "@anthropic-ai/sdk";

export interface ClassifiedError {
  userMessage: string;
  logMessage: string;
  retryable: boolean;
}

export function classifyAnthropicError(err: unknown): ClassifiedError {
  if (err instanceof Anthropic.RateLimitError) {
    return {
      userMessage:
        "The investigation agent is busy. Please try again shortly.",
      logMessage: `Anthropic rate limited (429): ${messageOf(err)}`,
      retryable: true,
    };
  }

  if (err instanceof Anthropic.InternalServerError && err.status === 529) {
    return {
      userMessage: "The investigation agent is temporarily unavailable.",
      logMessage: `Anthropic overloaded (529): ${messageOf(err)}`,
      retryable: true,
    };
  }

  if (err instanceof Anthropic.InternalServerError) {
    return {
      userMessage: "The investigation agent is temporarily unavailable.",
      logMessage: `Anthropic server error (${err.status}): ${messageOf(err)}`,
      retryable: true,
    };
  }

  if (
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError
  ) {
    return {
      userMessage: "Configuration error — please contact the admin.",
      logMessage: `Anthropic auth/permission error (${err.status}): ${messageOf(err)}`,
      retryable: false,
    };
  }

  if (err instanceof Anthropic.APIConnectionError) {
    return {
      userMessage: "The investigation agent is temporarily unreachable.",
      logMessage: `Anthropic connection error: ${messageOf(err)}`,
      retryable: true,
    };
  }

  if (err instanceof Anthropic.APIError) {
    return {
      userMessage: "An unexpected error occurred.",
      logMessage: `Anthropic API error (${err.status}): ${messageOf(err)}`,
      retryable: false,
    };
  }

  return {
    userMessage: "An unexpected error occurred.",
    logMessage: `Unknown error: ${messageOf(err)}`,
    retryable: false,
  };
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
