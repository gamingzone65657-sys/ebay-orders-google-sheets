/**
 * When the next automatic sync should happen.
 *
 * Pure functions with an injectable `now`, because scheduling logic that
 * cannot be tested without waiting is scheduling logic that stays broken.
 */

import { MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES } from "@/lib/constants";

const MINUTE_MS = 60 * 1000;

export interface ScheduleSettings {
  enabled: boolean;
  intervalMinutes: number;
  timezone: string;
  /** Optional quiet hours, 0–23 inclusive. Null on either means "all day". */
  activeFromHour: number | null;
  activeToHour: number | null;
  lastSuccessAt: Date | null;
  lastRunAt: Date | null;
}

export function clampInterval(minutes: number): number {
  if (!Number.isFinite(minutes)) return 60;
  return Math.min(
    MAX_INTERVAL_MINUTES,
    Math.max(MIN_INTERVAL_MINUTES, Math.trunc(minutes)),
  );
}

/**
 * The hour (0–23) that `date` falls on in `timezone`.
 *
 * Uses Intl rather than manual offset arithmetic so daylight saving is
 * handled by the platform. An unknown timezone falls back to UTC rather
 * than throwing — a bad string in the database must not stop the scheduler.
 */
export function hourInTimezone(date: Date, timezone: string): number {
  try {
    const formatted = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      hour12: false,
    }).format(date);
    // "24" appears at midnight in some ICU versions.
    const hour = Number(formatted) % 24;
    return Number.isFinite(hour) ? hour : date.getUTCHours();
  } catch {
    return date.getUTCHours();
  }
}

/**
 * Is `date` inside the configured active window?
 *
 * A window that wraps midnight (from 22 to 6) is supported, and is why this
 * is not a simple `from <= hour <= to`.
 */
export function isWithinActiveHours(
  date: Date,
  settings: Pick<ScheduleSettings, "activeFromHour" | "activeToHour" | "timezone">,
): boolean {
  const { activeFromHour: from, activeToHour: to } = settings;
  if (from === null || to === null) return true;
  if (from === to) return true; // a zero-width window means "no restriction"

  const hour = hourInTimezone(date, settings.timezone);
  return from < to ? hour >= from && hour <= to : hour >= from || hour <= to;
}

/** Advances a time forward until it lands inside the active window. */
export function nextActiveTime(
  from: Date,
  settings: Pick<ScheduleSettings, "activeFromHour" | "activeToHour" | "timezone">,
): Date {
  if (isWithinActiveHours(from, settings)) return from;

  // Step forward hour by hour; 48 steps covers any window on any day.
  const candidate = new Date(from);
  for (let step = 0; step < 48; step += 1) {
    candidate.setTime(candidate.getTime() + 60 * MINUTE_MS);
    if (isWithinActiveHours(candidate, settings)) {
      // Land on the top of the hour so runs are predictable.
      candidate.setUTCMinutes(0, 0, 0);
      return candidate;
    }
  }
  return from;
}

/**
 * The next time a sync should run.
 *
 * Anchored on the last *attempt* rather than the last success: anchoring on
 * success would make a failing integration retry immediately and forever,
 * turning a broken connection into a hot loop.
 *
 * Returns null when automation is off.
 */
export function computeNextRun(
  settings: ScheduleSettings,
  now: Date = new Date(),
): Date | null {
  if (!settings.enabled) return null;

  const interval = clampInterval(settings.intervalMinutes) * MINUTE_MS;
  const anchor = settings.lastRunAt ?? settings.lastSuccessAt;

  // With no history, run on the next tick rather than a full interval away —
  // enabling a schedule should visibly do something.
  let next = anchor ? new Date(anchor.getTime() + interval) : new Date(now);

  // Never schedule into the past: if the app was down for a day, catch up
  // once rather than queuing a backlog of missed slots.
  if (next.getTime() < now.getTime()) next = new Date(now);

  return nextActiveTime(next, settings);
}

/** Is a sync due right now? */
export function isDue(
  settings: ScheduleSettings & { nextRunAt: Date | null },
  now: Date = new Date(),
): boolean {
  if (!settings.enabled) return false;
  if (!isWithinActiveHours(now, settings)) return false;
  if (!settings.nextRunAt) return true;
  return settings.nextRunAt.getTime() <= now.getTime();
}

/**
 * A stable key for one scheduled slot, so the same slot cannot be enqueued
 * twice by two overlapping ticks. Rounded to the minute because two ticks a
 * few seconds apart are the same slot.
 */
export function scheduleDedupeKey(userId: string, slot: Date): string {
  const minute = Math.floor(slot.getTime() / MINUTE_MS);
  return `sched:${userId}:${minute}`;
}

/**
 * Backoff before retrying a failed attempt.
 *
 * Exponential on the configured base, capped so a long-running outage does
 * not push the next attempt days away.
 */
export function retryDelayMs(
  attempt: number,
  baseSeconds: number,
  retryAfterSeconds?: number | null,
): number {
  if (retryAfterSeconds && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds * 1000, 60 * MINUTE_MS);
  }
  const base = Math.max(5, baseSeconds) * 1000;
  return Math.min(base * 2 ** Math.max(0, attempt - 1), 60 * MINUTE_MS);
}
