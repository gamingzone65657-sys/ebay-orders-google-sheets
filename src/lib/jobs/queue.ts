/**
 * A database-backed job queue.
 *
 * The whole design rests on one primitive: claiming is a *conditional*
 * update. `updateMany` with the expected status in the `where` clause either
 * affects exactly one row or none, and the database decides which caller
 * wins. That makes two workers — or two overlapping cron ticks — safe
 * without a separate lock table or an external broker.
 *
 * Crash recovery follows from the same idea: a worker writes a heartbeat
 * while it runs, and a RUNNING job whose heartbeat has gone stale is
 * returned to the queue by `reclaimStaleJobs`.
 */

import { randomUUID } from "node:crypto";

import {
  JOB_HEARTBEAT_TIMEOUT_MS,
  SYNC_JOB_STATUS,
  SYNC_PHASES,
  type SyncTrigger,
} from "@/lib/constants";
import { prisma } from "@/lib/db";

export interface EnqueueOptions {
  userId: string;
  trigger: SyncTrigger;
  sheetConfigId?: string | null;
  scheduledFor?: Date | null;
  maxAttempts?: number;
  /** Prevents the same logical slot being queued twice. */
  dedupeKey?: string | null;
}

/** A stable id for this process, so a job's owner is identifiable in logs. */
export const WORKER_ID = `${process.pid}-${randomUUID().slice(0, 8)}`;

/**
 * Adds a job, or returns the existing one when `dedupeKey` collides.
 *
 * The unique index on `dedupeKey` is what makes this race-free: two ticks
 * can both decide a slot is due, and exactly one insert survives.
 */
export async function enqueueJob(
  options: EnqueueOptions,
): Promise<{ job: { id: string }; created: boolean }> {
  if (options.dedupeKey) {
    const existing = await prisma.syncJob.findUnique({
      where: { dedupeKey: options.dedupeKey },
      select: { id: true },
    });
    if (existing) return { job: existing, created: false };
  }

  try {
    const job = await prisma.syncJob.create({
      data: {
        userId: options.userId,
        kind: "SHEET_SYNC",
        trigger: options.trigger,
        status: SYNC_JOB_STATUS.QUEUED,
        phase: SYNC_PHASES.QUEUED,
        sheetConfigId: options.sheetConfigId ?? null,
        scheduledFor: options.scheduledFor ?? null,
        maxAttempts: options.maxAttempts ?? 3,
        dedupeKey: options.dedupeKey ?? null,
      },
      select: { id: true },
    });
    return { job, created: true };
  } catch (error) {
    // Lost the insert race on dedupeKey — the winner's job is the right one.
    if (options.dedupeKey) {
      const existing = await prisma.syncJob.findUnique({
        where: { dedupeKey: options.dedupeKey },
        select: { id: true },
      });
      if (existing) return { job: existing, created: false };
    }
    throw error;
  }
}

/**
 * Is a sync already in flight for this user?
 *
 * Checked before claiming so two schedules, or a schedule and a manual run,
 * cannot write to the same sheet at once. A stale lock does not count as
 * in-flight; `reclaimStaleJobs` will return it to the queue.
 */
export async function hasRunningJob(
  userId: string,
  excludeJobId?: string,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - JOB_HEARTBEAT_TIMEOUT_MS);
  const running = await prisma.syncJob.findFirst({
    where: {
      userId,
      status: SYNC_JOB_STATUS.RUNNING,
      ...(excludeJobId ? { id: { not: excludeJobId } } : {}),
      OR: [{ heartbeatAt: { gt: cutoff } }, { heartbeatAt: null, startedAt: { gt: cutoff } }],
    },
    select: { id: true },
  });
  return running !== null;
}

/**
 * Atomically moves one due job from QUEUED to RUNNING.
 *
 * Returns null when nothing is due or another worker won the race, which is
 * a normal outcome rather than an error.
 */
export async function claimNextJob(
  now: Date = new Date(),
): Promise<{ id: string; userId: string; trigger: string; attempt: number } | null> {
  const candidates = await prisma.syncJob.findMany({
    where: {
      status: SYNC_JOB_STATUS.QUEUED,
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    orderBy: [{ scheduledFor: "asc" }, { createdAt: "asc" }],
    take: 10,
    select: { id: true, userId: true, trigger: true, attempt: true },
  });

  for (const candidate of candidates) {
    // One sync per user at a time; leave the job queued for the next tick.
    // The cheap pre-check avoids most contention; claimExclusively is what
    // actually guarantees it.
    if (await hasRunningJob(candidate.userId)) continue;

    const outcome = await claimExclusively(
      candidate.id,
      candidate.userId,
      now,
      "requeue",
    );
    if (outcome === "claimed") return candidate;
  }

  return null;
}

/** Claims one specific job, for a manual run that wants to execute inline. */
export async function claimJob(
  jobId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const claimed = await prisma.syncJob.updateMany({
    where: { id: jobId, status: SYNC_JOB_STATUS.QUEUED },
    data: {
      status: SYNC_JOB_STATUS.RUNNING,
      lockedBy: WORKER_ID,
      lockedAt: now,
      heartbeatAt: now,
      startedAt: now,
    },
  });
  return claimed.count === 1;
}

/**
 * Takes the per-workspace mutex, or reports that someone else holds it.
 *
 * The SyncLock primary key does the work: `create` succeeds for exactly one
 * caller and throws for the rest. A holder whose heartbeat has gone stale
 * is evicted with a conditional update, which is itself atomic — so a
 * crashed worker cannot wedge a workspace permanently.
 */
export async function acquireUserLock(
  userId: string,
  jobId: string,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    await prisma.syncLock.create({
      data: { userId, jobId, workerId: WORKER_ID, acquiredAt: now, heartbeatAt: now },
    });
    return true;
  } catch {
    // Held by someone. Take it over only if that holder has gone quiet.
    const cutoff = new Date(now.getTime() - JOB_HEARTBEAT_TIMEOUT_MS);
    const stolen = await prisma.syncLock.updateMany({
      where: { userId, heartbeatAt: { lt: cutoff } },
      data: { jobId, workerId: WORKER_ID, acquiredAt: now, heartbeatAt: now },
    });
    return stolen.count === 1;
  }
}

export async function releaseUserLock(
  userId: string,
  jobId: string,
): Promise<void> {
  await prisma.syncLock
    .deleteMany({ where: { userId, jobId } })
    .catch(() => undefined);
}

/**
 * Claims a job *and* the workspace mutex, so it is genuinely the only run.
 *
 * Checking "is anything running?" before claiming is not enough: two
 * requests can both see an idle workspace, both create their own job row,
 * and both succeed at a compare-and-swap — because the CAS protects a
 * single row, and they are claiming different ones. Deciding the winner
 * afterwards by comparing timestamps does not work either, because a caller
 * whose rival has not yet committed sees no rival at all and claims
 * unconditionally.
 *
 * Taking the mutex *before* touching the job removes the ambiguity: the
 * database picks one winner, and the loser never claims anything.
 */
export async function claimExclusively(
  jobId: string,
  userId: string,
  now: Date = new Date(),
  /**
   * What to do with this job if it loses. A manual request is cancelled —
   * the caller reports "already running" and the user can press again. A
   * scheduled job goes back to the queue so the next tick picks it up.
   */
  onLose: "cancel" | "requeue" = "cancel",
): Promise<"claimed" | "busy"> {
  if (!(await acquireUserLock(userId, jobId, now))) {
    await markLost(jobId, onLose, now);
    return "busy";
  }

  if (!(await claimJob(jobId, now))) {
    // Already claimed elsewhere (or no longer queued); give the mutex back.
    await releaseUserLock(userId, jobId);
    return "busy";
  }

  return "claimed";
}

async function markLost(
  jobId: string,
  onLose: "cancel" | "requeue",
  now: Date,
): Promise<void> {
  await prisma.syncJob
    .updateMany({
      where: { id: jobId, status: SYNC_JOB_STATUS.QUEUED },
      data:
        onLose === "requeue"
          ? { status: SYNC_JOB_STATUS.QUEUED, phase: SYNC_PHASES.QUEUED }
          : {
              status: SYNC_JOB_STATUS.CANCELLED,
              phase: SYNC_PHASES.FAILED,
              finishedAt: now,
              summary:
                "Cancelled: another sync for this workspace was already running.",
            },
    })
    .catch(() => undefined);
}

/**
 * Keeps both the job claim and the workspace mutex alive.
 *
 * Failures are ignored: a missed heartbeat is recoverable (the job is
 * reclaimed), whereas throwing here would abort a sync that is working.
 */
export async function heartbeat(jobId: string): Promise<void> {
  const now = new Date();
  await prisma.syncJob
    .update({ where: { id: jobId }, data: { heartbeatAt: now } })
    .catch(() => undefined);
  await prisma.syncLock
    .updateMany({ where: { jobId }, data: { heartbeatAt: now } })
    .catch(() => undefined);
}

/** Drops the mutex a job holds, whatever its outcome was. */
export async function releaseLockForJob(jobId: string): Promise<void> {
  await prisma.syncLock
    .deleteMany({ where: { jobId } })
    .catch(() => undefined);
}

/**
 * Returns jobs abandoned by a crashed worker to the queue.
 *
 * Without this, a process killed mid-sync would leave a job RUNNING forever
 * and — because of the one-sync-per-user guard — block that user's schedule
 * permanently.
 */
export async function reclaimStaleJobs(
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - JOB_HEARTBEAT_TIMEOUT_MS);

  const stale = await prisma.syncJob.findMany({
    where: {
      status: SYNC_JOB_STATUS.RUNNING,
      OR: [
        { heartbeatAt: { lt: cutoff } },
        { heartbeatAt: null, startedAt: { lt: cutoff } },
      ],
    },
    select: { id: true, attempt: true, maxAttempts: true },
  });

  let reclaimed = 0;
  for (const job of stale) {
    const exhausted = job.attempt >= job.maxAttempts;

    const updated = await prisma.syncJob.updateMany({
      where: { id: job.id, status: SYNC_JOB_STATUS.RUNNING },
      data: exhausted
        ? {
            status: SYNC_JOB_STATUS.FAILED,
            phase: SYNC_PHASES.FAILED,
            finishedAt: now,
            errorCode: "WORKER_LOST",
            errorMessage:
              "The worker stopped responding and the attempt limit was reached.",
            summary: "Failed: the worker stopped responding.",
            lockedBy: null,
          }
        : {
            status: SYNC_JOB_STATUS.QUEUED,
            phase: SYNC_PHASES.QUEUED,
            attempt: job.attempt + 1,
            // A crashed run is worth retrying promptly.
            nextAttemptAt: new Date(now.getTime() + 30_000),
            lockedBy: null,
            lockedAt: null,
            heartbeatAt: null,
            errorCode: "WORKER_LOST",
            errorMessage: "The worker stopped responding; the job was requeued.",
          },
    });

    if (updated.count === 1) {
      reclaimed += 1;
      // Free the workspace too, or the reclaimed job could never be re-run.
      await releaseLockForJob(job.id);
      await prisma.syncLog
        .create({
          data: {
            syncJobId: job.id,
            level: "WARN",
            step: "worker",
            message: exhausted
              ? "Worker lost and attempts exhausted; marked failed."
              : `Worker lost; requeued as attempt ${job.attempt + 1}.`,
          },
        })
        .catch(() => undefined);
    }
  }

  return reclaimed;
}

/** Requeues a transient failure, or marks it failed once attempts run out. */
export async function scheduleRetry(
  jobId: string,
  options: {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    errorCode: string;
    errorMessage: string;
  },
): Promise<{ willRetry: boolean }> {
  const willRetry = options.attempt < options.maxAttempts;
  const now = new Date();

  await prisma.syncJob.update({
    where: { id: jobId },
    data: willRetry
      ? {
          status: SYNC_JOB_STATUS.QUEUED,
          phase: SYNC_PHASES.QUEUED,
          attempt: options.attempt + 1,
          nextAttemptAt: new Date(now.getTime() + options.delayMs),
          retryable: true,
          errorCode: options.errorCode,
          errorMessage: options.errorMessage.slice(0, 500),
          lockedBy: null,
          lockedAt: null,
          heartbeatAt: null,
          finishedAt: null,
        }
      : {
          status: SYNC_JOB_STATUS.FAILED,
          phase: SYNC_PHASES.FAILED,
          finishedAt: now,
          retryable: false,
          errorCode: options.errorCode,
          errorMessage: options.errorMessage.slice(0, 500),
          lockedBy: null,
        },
  });

  await prisma.syncLog
    .create({
      data: {
        syncJobId: jobId,
        level: willRetry ? "WARN" : "ERROR",
        step: "retry",
        message: willRetry
          ? `Attempt ${options.attempt} failed (${options.errorCode}); retrying in ${Math.round(
              options.delayMs / 1000,
            )}s.`
          : `Attempt ${options.attempt} failed (${options.errorCode}); no attempts left.`,
      },
    })
    .catch(() => undefined);

  return { willRetry };
}

/** Releases a claim without changing the outcome. */
export async function releaseJob(jobId: string): Promise<void> {
  await prisma.syncJob
    .update({
      where: { id: jobId },
      data: { lockedBy: null, lockedAt: null, heartbeatAt: null },
    })
    .catch(() => undefined);
}

export async function queueDepth(): Promise<number> {
  return prisma.syncJob.count({ where: { status: SYNC_JOB_STATUS.QUEUED } });
}
