const DEDUP_TTL_MS = 5 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** Linear session ID → Anthropic session ID */
export const sessionMappings = new Map<string, string>();

/** Webhook delivery IDs already processed (auto-expires after 5 min) */
const processedWebhooks = new Map<string, number>();

/** CSRF state → creation timestamp (auto-expires after 10 min) */
const oauthStates = new Map<string, number>();

/** Per-session mutex: serialize concurrent webhooks for the same session */
const sessionLocks = new Map<string, Promise<void>>();

// --- Dedup helpers ---

export function hasProcessedWebhook(deliveryId: string): boolean {
  pruneMap(processedWebhooks, DEDUP_TTL_MS);
  return processedWebhooks.has(deliveryId);
}

export function markWebhookProcessed(deliveryId: string): void {
  processedWebhooks.set(deliveryId, Date.now());
}

// --- OAuth state helpers ---

export function createOAuthState(state: string): void {
  pruneMap(oauthStates, OAUTH_STATE_TTL_MS);
  oauthStates.set(state, Date.now());
}

export function consumeOAuthState(state: string): boolean {
  pruneMap(oauthStates, OAUTH_STATE_TTL_MS);
  if (!oauthStates.has(state)) return false;
  oauthStates.delete(state);
  return true;
}

// --- Session lock helpers ---

export async function withSessionLock<T>(
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  while (sessionLocks.has(sessionId)) {
    await sessionLocks.get(sessionId);
  }

  let resolve!: () => void;
  const lock = new Promise<void>((r) => {
    resolve = r;
  });
  sessionLocks.set(sessionId, lock);

  try {
    return await fn();
  } finally {
    sessionLocks.delete(sessionId);
    resolve();
  }
}

// --- Internal ---

function pruneMap(map: Map<string, number>, ttl: number): void {
  const cutoff = Date.now() - ttl;
  for (const [key, ts] of map) {
    if (ts < cutoff) map.delete(key);
  }
}
