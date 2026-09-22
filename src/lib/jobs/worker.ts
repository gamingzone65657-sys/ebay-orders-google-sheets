/**
 * The background worker.
 *
 * One `tick()` does three things, in order:
 *
 *   1. reclaim jobs abandoned by a crashed worker
 *   2. enqueue any schedule that has come due
 *   3. claim and run queued jobs
 *
 * It is written to be safe to call concurrently and repeatedly — from the
 * long-running worker process, from an external cron hitting
 * /api/jobs/tick, or from both at once. Every step is either idempotent or
 * guarded by a compare-and-swap in queue.ts.
 *
 * The run itself is `runSheetSync`, unchanged: a scheduled sync and a manual
 * one execute exactly the same code, so they cannot drift apart.
 */

import {
  MAX_CONSECUTIVE_FAILURES,
  SYNC_JOB_STATUS,
  SYNC_RANGES,
  SYNC_TRIGGERS,
} from "@/lib/constants";
import { logError } from "@/lib/log";
import { applyRetention } from "@/lib/retention";
import { prisma } from "@/lib/db";
import { runSheetSync } from "@/lib/sync/sheet-sync";

import {
  claimNextJob,
  enqueueJob,
  hasRunningJob,
  heartbeat,
  reclaimStaleJobs,
  releaseLockForJob,
  scheduleRetry,
} from "./queue";
import {
  clampInterval,
  computeNextRun,
  isDue,
  retryDelayMs,
  scheduleDedupeKey,
} from "./schedule";

/**
 * Failure categories worth retrying.
 *
 * Everything else — a revoked token, a missing scope, a deleted sheet, a
 * configuration blocker — will fail identically on the next attempt, so
 * retrying only delays the moment the user finds out, while burning API
 * quota in the meantime.
 *
 * `UNKNOWN` is deliberately absent. An unclassified *result* is far more
 * likely to be a permanent misconfiguration than a blip, and assuming
 * otherwise turns a broken setup into a retry loop. An unexpected
 * *exception* is different and is retried explicitly in `runClaimedJob`.
 */
const RETRYABLE_CODES = new Set([
  "RATE_LIMITED",
  "SERVER_ERROR",
  "NETWORK_ERROR",
  "WORKER_LOST",
]);

export function isRetryableFailure(code: string | null | undefined): boolean {
  if (!code) return false;
  return RETRYABLE_CODES.has(code);
}

export interface TickResult {
  reclaimed: number;
  enqueued: number;
  ran: number;
  succeeded: number;
  failed: number;
  retried: number;
  skipped: number;
}

/* -------------------------------------------------------------------------- */
/* Scheduling                                                                  */
/* -------------------------------------------------------------------------- */

/** Enqueues a job for every schedule that is due. */
export async function enqueueDueSchedules(
  now: Date = new Date(),
): Promise<number> {
  const schedules = await prisma.automationSetting.findMany({
    where: { enabled: true },
  });

  let enqueued = 0;

  for (const schedule of schedules) {
    // A schedule suspended by repeated failure stays suspended until the
    // user re-enables it; silently resuming would hide a real problem.
    if (schedule.disabledReason) continue;

    if (
      !isDue(
        {
          enabled: schedule.enabled,
          intervalMinutes: schedule.intervalMinutes,
          timezone: schedule.timezone,
          activeFromHour: schedule.activeFromHour,
          activeToHour: schedule.activeToHour,
          lastSuccessAt: schedule.lastSuccessAt,
          lastRunAt: schedule.lastRunAt,
          nextRunAt: schedule.nextRunAt,
        },
        now,
      )
    ) {
      continue;
    }

    // Do not stack a scheduled run on top of one already in flight.
    if (await hasRunningJob(schedule.userId)) continue;

    const sheetConfig = await prisma.googleSheetConfig.findFirst({
      where: { userId: schedule.userId, isActive: true },
      select: { id: true },
    });

    const slot = schedule.nextRunAt ?? now;
    const { created } = await enqueueJob({
      userId: schedule.userId,
      trigger: SYNC_TRIGGERS.SCHEDULED,
      sheetConfigId: sheetConfig?.id ?? null,
      scheduledFor: slot,
      maxAttempts: Math.max(1, schedule.retryLimit || 1),
      dedupeKey: scheduleDedupeKey(schedule.userId, slot),
    });

    if (created) enqueued += 1;

    // Move the cursor forward immediately, so a slow run cannot cause the
    // same slot to be considered due again on the next tick.
    await prisma.automationSetting.update({
      where: { userId: schedule.userId },
      data: {
        nextRunAt: computeNextRun(
          {
            enabled: true,
            intervalMinutes: clampInterval(schedule.intervalMinutes),
            timezone: schedule.timezone,
            activeFromHour: schedule.activeFromHour,
            activeToHour: schedule.activeToHour,
            lastSuccessAt: schedule.lastSuccessAt,
            lastRunAt: now,
          },
          now,
        ),
      },
    });
  }

  return enqueued;
}

/* -------------------------------------------------------------------------- */
/* Running                                                                     */
/* -------------------------------------------------------------------------- */

export interface RunJobOutcome {
  status: "SUCCESS" | "PARTIAL" | "FAILED" | "RETRYING";
  jobId: string;
  summary: string;
}

/**
 * Executes one already-claimed job and records the outcome.
 *
 * The success/failure bookkeeping is deliberately explicit: the incremental
 * cursor and `lastSuccessAt` are only ever advanced on a genuinely
 * successful run, so a failure can never look like a success or silently
 * skip a window of orders.
 */
export async function runClaimedJob(
  job: { id: string; userId: string; attempt: number },
): Promise<RunJobOutcome> {
  const beat = setInterval(() => void heartbeat(job.id), 30_000);

  try {
    const schedule = await prisma.automationSetting.findUnique({
      where: { userId: job.userId },
    });

    const result = await runSheetSync(job.userId, {
      // Incremental by default: never re-read the whole order history.
      range: SYNC_RANGES.SINCE_LAST,
      trigger: SYNC_TRIGGERS.SCHEDULED,
      // A schedule the user switched on is itself the confirmation.
      confirmed: true,
      jobId: job.id,
    });

    const now = new Date();
    const succeeded =
      result.status === SYNC_JOB_STATUS.SUCCESS ||
      result.status === SYNC_JOB_STATUS.PARTIAL;

    if (succeeded) {
      await prisma.automationSetting
        .update({
          where: { userId: job.userId },
          data: {
            lastRunAt: now,
            lastSuccessAt: now,
            lastSuccessJobId: job.id,
            consecutiveFailures: 0,
            lastFailureReason: null,
            lastFailureCode: null,
          },
        })
        .catch(() => undefined);

      return {
        status: result.status === SYNC_JOB_STATUS.PARTIAL ? "PARTIAL" : "SUCCESS",
        jobId: job.id,
        summary: result.summary,
      };
    }

    // --- Failure ----------------------------------------------------------
    const code = result.errorCode ?? "UNKNOWN";
    const message = result.errorMessage ?? result.summary;
    const maxAttempts = Math.max(1, schedule?.retryLimit || 1);

    const { willRetry } = isRetryableFailure(code)
      ? await scheduleRetry(job.id, {
          attempt: job.attempt,
          maxAttempts,
          delayMs: retryDelayMs(job.attempt, schedule?.retryBackoffSecs ?? 60),
          errorCode: code,
          errorMessage: message,
        })
      : { willRetry: false };

    if (!willRetry && !isRetryableFailure(code)) {
      // Permanent failure: the job row is already FAILED from runSheetSync.
      await prisma.syncJob
        .update({ where: { id: job.id }, data: { errorCode: code, lockedBy: null } })
        .catch(() => undefined);
    }

    const failures = (schedule?.consecutiveFailures ?? 0) + (willRetry ? 0 : 1);
    const exhausted = failures >= MAX_CONSECUTIVE_FAILURES;

    await prisma.automationSetting
      .update({
        where: { userId: job.userId },
        data: {
          lastRunAt: now,
          // lastSuccessAt is deliberately untouched.
          lastFailureAt: now,
          lastFailureJobId: job.id,
          lastFailureReason: message.slice(0, 500),
          lastFailureCode: code,
          consecutiveFailures: failures,
          ...(exhausted
            ? {
                enabled: false,
                nextRunAt: null,
                disabledReason: `Paused after ${failures} consecutive failures (${code}). Fix the problem, then re-enable.`,
              }
            : {}),
        },
      })
      .catch(() => undefined);

    return {
      status: willRetry ? "RETRYING" : "FAILED",
      jobId: job.id,
      summary: message,
    };
  } catch (error) {
    // An unexpected throw must still leave the job in a terminal or
    // retryable state rather than RUNNING forever.
    const message = error instanceof Error ? error.message : String(error);
    await scheduleRetry(job.id, {
      attempt: job.attempt,
      maxAttempts: 3,
      delayMs: retryDelayMs(job.attempt, 60),
      errorCode: "UNKNOWN",
      errorMessage: message,
    });
    return { status: "RETRYING", jobId: job.id, summary: message };
  } finally {
    clearInterval(beat);
    // Whatever happened, the workspace must not stay locked.
    await releaseLockForJob(job.id);
  }
}

/* -------------------------------------------------------------------------- */
/* Tick                                                                        */
/* -------------------------------------------------------------------------- */

export async function tick(
  options: { maxJobs?: number; now?: Date } = {},
): Promise<TickResult> {
  const now = options.now ?? new Date();
  const maxJobs = Math.max(1, options.maxJobs ?? 3);

  const result: TickResult = {
    reclaimed: 0,
    enqueued: 0,
    ran: 0,
    succeeded: 0,
    failed: 0,
    retried: 0,
    skipped: 0,
  };

  result.reclaimed = await reclaimStaleJobs(now);
  result.enqueued = await enqueueDueSchedules(now);

  // Retention runs on the tick rather than on a timer of its own, so a
  // deployment that runs the worker gets it for free and one that does not is
  // simply keeping its data — never a half-applied policy.
  await applyRetention(now).catch((error) => logError("retention", error));

  for (let index = 0; index < maxJobs; index += 1) {
    const job = await claimNextJob(new Date());
    if (!job) {
      result.skipped += 1;
      break;
    }

    result.ran += 1;
    const outcome = await runClaimedJob(job);
    if (outcome.status === "SUCCESS" || outcome.status === "PARTIAL") {
      result.succeeded += 1;
    } else if (outcome.status === "RETRYING") {
      result.retried += 1;
    } else {
      result.failed += 1;
    }
  }

  return result;
}

/** The long-running loop used by `npm run worker`. */
export async function runWorkerLoop(
  options: { intervalMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const intervalMs = Math.max(5_000, options.intervalMs ?? 30_000);

  console.log(
    `[worker] started, polling every ${Math.round(intervalMs / 1000)}s`,
  );

  while (!options.signal?.aborted) {
    try {
      const result = await tick();
      if (result.reclaimed || result.enqueued || result.ran) {
        console.log(
          `[worker] reclaimed=${result.reclaimed} enqueued=${result.enqueued} ran=${result.ran} ok=${result.succeeded} retry=${result.retried} failed=${result.failed}`,
        );
      }
    } catch (error) {
      // A failing tick must not kill the loop.
      logError("worker", error);
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  console.log("[worker] stopped");
}
