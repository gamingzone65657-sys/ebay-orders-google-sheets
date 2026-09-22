/**
 * eBay's view of the shared rate limiter in src/lib/http/rate-limit.ts.
 *
 * This file keeps the eBay call sites and their tests on the exact signatures
 * they were written against, while the implementation is shared with Google.
 * It supplies the eBay-specific pacing interval and namespaces keys so the
 * two providers never share a queue or a cooldown.
 */

import {
  acquireSlot as acquireSharedSlot,
  backoffDelayMs,
  clearCooldown as clearSharedCooldown,
  cooldownRemaining as sharedCooldownRemaining,
  resetRateLimitState,
  startCooldown as startSharedCooldown,
} from "@/lib/http/rate-limit";

function minIntervalMs(): number {
  const value = Number(process.env.EBAY_MIN_REQUEST_INTERVAL_MS ?? 120);
  return Number.isFinite(value) && value >= 0 ? value : 120;
}

const key = (connectionId: string) => `ebay:${connectionId}`;

export async function acquireSlot(connectionId: string): Promise<void> {
  return acquireSharedSlot(key(connectionId), minIntervalMs());
}

export function startCooldown(connectionId: string, seconds: number): Date {
  return startSharedCooldown(key(connectionId), seconds);
}

export function clearCooldown(connectionId: string): void {
  clearSharedCooldown(key(connectionId));
}

export function cooldownRemaining(connectionId: string): number {
  return sharedCooldownRemaining(key(connectionId));
}

export { backoffDelayMs, resetRateLimitState };
