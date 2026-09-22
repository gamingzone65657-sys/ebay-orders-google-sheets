/**
 * Provider-agnostic client-side rate limiting.
 *
 * Originally written for eBay and extracted here unchanged in Phase 3 so the
 * Google client gets the same behaviour rather than a second implementation.
 * Keys are namespaced by the caller (`ebay:<id>`, `google:<id>`) so the two
 * providers never share a queue or a cooldown.
 *
 * Two mechanisms:
 *
 *  1. A per-key serial queue with a minimum gap between requests, so a
 *     paginated walk never fires a burst.
 *  2. A cooldown that a 429 sets, which short-circuits subsequent calls
 *     instead of hammering an API that is already refusing us.
 *
 * State is per process. That is correct for a single-node deployment; a
 * multi-node one would move `cooldowns` into the database or Redis, and both
 * connection tables already persist `rateLimitedUntil`.
 */

interface QueueState {
  /** Resolves when the previous request for this key has been paced. */
  tail: Promise<void>;
  lastStartedAt: number;
}

const queues = new Map<string, QueueState>();
const cooldowns = new Map<string, number>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits until it is this key's turn and the minimum gap has elapsed. Calls
 * for one key run strictly in order; different keys do not block each other.
 */
export async function acquireSlot(
  key: string,
  minIntervalMs: number,
): Promise<void> {
  const existing = queues.get(key);
  const state: QueueState = existing ?? {
    tail: Promise.resolve(),
    lastStartedAt: 0,
  };

  const wait = state.tail.then(async () => {
    const elapsed = Date.now() - state.lastStartedAt;
    if (elapsed < minIntervalMs) {
      await sleep(minIntervalMs - elapsed);
    }
    state.lastStartedAt = Date.now();
  });

  // Swallow rejections so one failed call cannot poison the queue.
  state.tail = wait.catch(() => undefined);
  queues.set(key, state);

  await wait;
}

/** Records a 429 so later calls fail fast instead of piling on. */
export function startCooldown(key: string, seconds: number): Date {
  const until = Date.now() + Math.max(1, seconds) * 1000;
  cooldowns.set(key, until);
  return new Date(until);
}

export function clearCooldown(key: string): void {
  cooldowns.delete(key);
}

/** Seconds remaining, or 0 when not cooling down. */
export function cooldownRemaining(key: string): number {
  const until = cooldowns.get(key);
  if (!until) return 0;
  const remaining = until - Date.now();
  if (remaining <= 0) {
    cooldowns.delete(key);
    return 0;
  }
  return Math.ceil(remaining / 1000);
}

/**
 * Backoff for attempt N (1-based), honouring a Retry-After when present.
 * Jitter avoids retry storms when several jobs collide.
 */
export function backoffDelayMs(
  attempt: number,
  retryAfterSeconds?: number,
): number {
  if (retryAfterSeconds && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds * 1000, 60_000);
  }
  const base = Math.min(2 ** (attempt - 1) * 500, 16_000);
  return base + Math.floor(Math.random() * 250);
}

/** Test seam. */
export function resetRateLimitState(): void {
  queues.clear();
  cooldowns.clear();
}
