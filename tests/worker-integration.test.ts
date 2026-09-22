/**
 * Integration tests for the background job system.
 *
 * These exercise the real queue primitives against an isolated database:
 * claiming, concurrency, crash recovery, retry classification, and the
 * success/failure bookkeeping that the incremental cursor depends on.
 */

import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import type { PrismaClient } from "@prisma/client";

import { JOB_HEARTBEAT_TIMEOUT_MS } from "@/lib/constants";

import { setupTestDatabase } from "./helpers/test-db";

let prisma: PrismaClient;
let queue: typeof import("@/lib/jobs/queue");
let enqueueDueSchedules: typeof import("@/lib/jobs/worker").enqueueDueSchedules;

let userId: string;

before(async () => {
  setupTestDatabase("worker");

  ({ prisma } = await import("@/lib/db"));
  queue = await import("@/lib/jobs/queue");
  ({ enqueueDueSchedules } = await import("@/lib/jobs/worker"));

  const user = await prisma.user.create({
    data: { email: "worker@test.local", name: "Worker Tester" },
  });
  userId = user.id;
});

beforeEach(async () => {
  await prisma.syncLog.deleteMany({});
  await prisma.syncLock.deleteMany({});
  await prisma.syncJob.deleteMany({ where: { userId } });
  await prisma.automationSetting.deleteMany({ where: { userId } });
});

const enqueue = (overrides: Record<string, unknown> = {}) =>
  queue.enqueueJob({
    userId,
    trigger: "SCHEDULED" as never,
    maxAttempts: 3,
    ...overrides,
  });

/* -------------------------------------------------------------------------- */

describe("enqueueJob", () => {
  it("creates a queued job", async () => {
    const { job, created } = await enqueue();
    assert.equal(created, true);

    const stored = await prisma.syncJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    assert.equal(stored.status, "QUEUED");
    assert.equal(stored.attempt, 1);
  });

  it("deduplicates the same slot", async () => {
    const first = await enqueue({ dedupeKey: "slot-1" });
    const second = await enqueue({ dedupeKey: "slot-1" });

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.job.id, second.job.id, "the same job is returned");

    const count = await prisma.syncJob.count({ where: { userId } });
    assert.equal(count, 1);
  });

  it("survives a concurrent race on the same dedupe key", async () => {
    const results = await Promise.all([
      enqueue({ dedupeKey: "race" }),
      enqueue({ dedupeKey: "race" }),
      enqueue({ dedupeKey: "race" }),
    ]);

    const ids = new Set(results.map((result) => result.job.id));
    assert.equal(ids.size, 1, "all callers converge on one job");
    assert.equal(
      results.filter((result) => result.created).length,
      1,
      "exactly one insert wins",
    );
  });
});

describe("claiming", () => {
  it("moves a job to RUNNING exactly once", async () => {
    const { job } = await enqueue();

    const first = await queue.claimJob(job.id);
    const second = await queue.claimJob(job.id);

    assert.equal(first, true);
    assert.equal(second, false, "a claimed job cannot be claimed again");

    const stored = await prisma.syncJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    assert.equal(stored.status, "RUNNING");
    assert.ok(stored.lockedBy);
    assert.ok(stored.heartbeatAt);
  });

  it("gives a job to only one of several concurrent claimers", async () => {
    const { job } = await enqueue();
    const results = await Promise.all([
      queue.claimJob(job.id),
      queue.claimJob(job.id),
      queue.claimJob(job.id),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
  });

  it("claimNextJob picks up a queued job", async () => {
    await enqueue();
    const claimed = await queue.claimNextJob();
    assert.ok(claimed);
    assert.equal(claimed!.userId, userId);
  });

  it("will not run two jobs for one user at the same time", async () => {
    await enqueue({ dedupeKey: "a" });
    await enqueue({ dedupeKey: "b" });

    const first = await queue.claimNextJob();
    const second = await queue.claimNextJob();

    assert.ok(first, "the first job is claimed");
    assert.equal(second, null, "the second waits for the first to finish");
  });

  it("skips a job whose retry time has not arrived", async () => {
    const { job } = await enqueue();
    await prisma.syncJob.update({
      where: { id: job.id },
      data: { nextAttemptAt: new Date(Date.now() + 60_000) },
    });

    assert.equal(await queue.claimNextJob(), null);
  });

  it("picks up a retry once its time has passed", async () => {
    const { job } = await enqueue();
    await prisma.syncJob.update({
      where: { id: job.id },
      data: { nextAttemptAt: new Date(Date.now() - 1_000) },
    });

    const claimed = await queue.claimNextJob();
    assert.equal(claimed?.id, job.id);
  });
});

describe("claimExclusively", () => {
  it("lets exactly one of two separate jobs win", async () => {
    // The race that a pre-flight "is anything running?" check cannot catch:
    // two requests each create their own row, so each succeeds at its own
    // compare-and-swap.
    const a = await enqueue({ dedupeKey: "exclusive-a" });
    const b = await enqueue({ dedupeKey: "exclusive-b" });

    const [first, second] = await Promise.all([
      queue.claimExclusively(a.job.id, userId),
      queue.claimExclusively(b.job.id, userId),
    ]);

    const outcomes = [first, second];
    assert.equal(
      outcomes.filter((outcome) => outcome === "claimed").length,
      1,
      "exactly one claim survives",
    );
    assert.equal(outcomes.filter((outcome) => outcome === "busy").length, 1);

    const running = await prisma.syncJob.count({
      where: { userId, status: "RUNNING" },
    });
    assert.equal(running, 1, "only one job is left running");
  });

  it("cancels the loser by default", async () => {
    const a = await enqueue({ dedupeKey: "cancel-a" });
    const b = await enqueue({ dedupeKey: "cancel-b" });

    await Promise.all([
      queue.claimExclusively(a.job.id, userId),
      queue.claimExclusively(b.job.id, userId),
    ]);

    const cancelled = await prisma.syncJob.count({
      where: { userId, status: "CANCELLED" },
    });
    assert.equal(cancelled, 1);
  });

  it("requeues the loser when asked, so a schedule is not lost", async () => {
    const a = await enqueue({ dedupeKey: "requeue-a" });
    const b = await enqueue({ dedupeKey: "requeue-b" });

    await Promise.all([
      queue.claimExclusively(a.job.id, userId, new Date(), "requeue"),
      queue.claimExclusively(b.job.id, userId, new Date(), "requeue"),
    ]);

    const queued = await prisma.syncJob.count({
      where: { userId, status: "QUEUED" },
    });
    assert.equal(queued, 1, "the loser waits for the next tick");
  });

  it("is a no-op for an already-claimed job", async () => {
    const { job } = await enqueue();
    await queue.claimJob(job.id);
    assert.equal(await queue.claimExclusively(job.id, userId), "busy");
  });

  it("holds the workspace mutex while running", async () => {
    const a = await enqueue({ dedupeKey: "mutex-a" });
    assert.equal(await queue.claimExclusively(a.job.id, userId), "claimed");

    const lock = await prisma.syncLock.findUnique({ where: { userId } });
    assert.ok(lock, "the mutex is held");
    assert.equal(lock!.jobId, a.job.id);

    const b = await enqueue({ dedupeKey: "mutex-b" });
    assert.equal(
      await queue.claimExclusively(b.job.id, userId),
      "busy",
      "a second job cannot start while the mutex is held",
    );
  });

  it("releases the mutex so the next run can start", async () => {
    const a = await enqueue({ dedupeKey: "release-a" });
    await queue.claimExclusively(a.job.id, userId);
    await queue.releaseLockForJob(a.job.id);

    const b = await enqueue({ dedupeKey: "release-b" });
    assert.equal(await queue.claimExclusively(b.job.id, userId), "claimed");
  });

  it("takes over a mutex abandoned by a crashed worker", async () => {
    const a = await enqueue({ dedupeKey: "stale-lock-a" });
    await queue.claimExclusively(a.job.id, userId);

    // Simulate the holder dying without releasing.
    await prisma.syncLock.update({
      where: { userId },
      data: {
        heartbeatAt: new Date(Date.now() - JOB_HEARTBEAT_TIMEOUT_MS - 60_000),
      },
    });

    const b = await enqueue({ dedupeKey: "stale-lock-b" });
    assert.equal(
      await queue.claimExclusively(b.job.id, userId),
      "claimed",
      "a stale mutex must not wedge the workspace forever",
    );
  });
});

describe("hasRunningJob", () => {
  it("is false with nothing running", async () => {
    assert.equal(await queue.hasRunningJob(userId), false);
  });

  it("is true while a claimed job is alive", async () => {
    const { job } = await enqueue();
    await queue.claimJob(job.id);
    assert.equal(await queue.hasRunningJob(userId), true);
  });

  it("ignores a job whose worker has gone quiet", async () => {
    const { job } = await enqueue();
    await queue.claimJob(job.id);
    await prisma.syncJob.update({
      where: { id: job.id },
      data: {
        heartbeatAt: new Date(Date.now() - JOB_HEARTBEAT_TIMEOUT_MS - 1000),
        startedAt: new Date(Date.now() - JOB_HEARTBEAT_TIMEOUT_MS - 1000),
      },
    });
    assert.equal(
      await queue.hasRunningJob(userId),
      false,
      "a stale lock must not block the schedule forever",
    );
  });
});

describe("crash recovery", () => {
  async function makeStaleJob(attempt = 1, maxAttempts = 3) {
    const { job } = await enqueue({ maxAttempts });
    await queue.claimJob(job.id);
    const stale = new Date(Date.now() - JOB_HEARTBEAT_TIMEOUT_MS - 60_000);
    await prisma.syncJob.update({
      where: { id: job.id },
      data: { heartbeatAt: stale, startedAt: stale, attempt },
    });
    return job.id;
  }

  it("requeues a job abandoned mid-run", async () => {
    const jobId = await makeStaleJob();

    const reclaimed = await queue.reclaimStaleJobs();
    assert.equal(reclaimed, 1);

    const stored = await prisma.syncJob.findUniqueOrThrow({
      where: { id: jobId },
    });
    assert.equal(stored.status, "QUEUED");
    assert.equal(stored.attempt, 2);
    assert.equal(stored.lockedBy, null);
    assert.equal(stored.errorCode, "WORKER_LOST");
  });

  it("fails an abandoned job once attempts run out", async () => {
    const jobId = await makeStaleJob(3, 3);

    await queue.reclaimStaleJobs();

    const stored = await prisma.syncJob.findUniqueOrThrow({
      where: { id: jobId },
    });
    assert.equal(stored.status, "FAILED");
    assert.ok(stored.finishedAt, "a failed job is finished, not left hanging");
  });

  it("leaves a healthy job alone", async () => {
    const { job } = await enqueue();
    await queue.claimJob(job.id);

    assert.equal(await queue.reclaimStaleJobs(), 0);
    const stored = await prisma.syncJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    assert.equal(stored.status, "RUNNING");
  });

  it("logs why a job was requeued", async () => {
    const jobId = await makeStaleJob();
    await queue.reclaimStaleJobs();

    const logs = await prisma.syncLog.findMany({ where: { syncJobId: jobId } });
    assert.ok(logs.some((entry) => /Worker lost/i.test(entry.message)));
  });
});

describe("scheduleRetry", () => {
  it("requeues with backoff while attempts remain", async () => {
    const { job } = await enqueue({ maxAttempts: 3 });
    await queue.claimJob(job.id);

    const { willRetry } = await queue.scheduleRetry(job.id, {
      attempt: 1,
      maxAttempts: 3,
      delayMs: 60_000,
      errorCode: "RATE_LIMITED",
      errorMessage: "slow down",
    });

    assert.equal(willRetry, true);
    const stored = await prisma.syncJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    assert.equal(stored.status, "QUEUED");
    assert.equal(stored.attempt, 2);
    assert.equal(stored.retryable, true);
    assert.ok(stored.nextAttemptAt!.getTime() > Date.now());
    assert.equal(stored.lockedBy, null);
  });

  it("fails for good on the last attempt", async () => {
    const { job } = await enqueue({ maxAttempts: 2 });
    await queue.claimJob(job.id);

    const { willRetry } = await queue.scheduleRetry(job.id, {
      attempt: 2,
      maxAttempts: 2,
      delayMs: 1000,
      errorCode: "SERVER_ERROR",
      errorMessage: "still broken",
    });

    assert.equal(willRetry, false);
    const stored = await prisma.syncJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    assert.equal(stored.status, "FAILED");
    assert.equal(stored.retryable, false);
    assert.ok(stored.finishedAt);
    assert.equal(
      stored.summary,
      null,
      "a failed job is never given a success summary",
    );
  });
});

describe("enqueueDueSchedules", () => {
  async function setSchedule(data: Record<string, unknown>) {
    return prisma.automationSetting.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
  }

  it("enqueues nothing when automation is off", async () => {
    await setSchedule({ enabled: false, nextRunAt: new Date(0) });
    assert.equal(await enqueueDueSchedules(), 0);
  });

  it("enqueues a due schedule", async () => {
    await setSchedule({
      enabled: true,
      intervalMinutes: 60,
      nextRunAt: new Date(Date.now() - 60_000),
    });

    assert.equal(await enqueueDueSchedules(), 1);
    const job = await prisma.syncJob.findFirstOrThrow({ where: { userId } });
    assert.equal(job.trigger, "SCHEDULED");
    assert.equal(job.status, "QUEUED");
  });

  it("advances the cursor so the same slot is not queued twice", async () => {
    await setSchedule({
      enabled: true,
      intervalMinutes: 60,
      nextRunAt: new Date(Date.now() - 60_000),
    });

    const first = await enqueueDueSchedules();
    const second = await enqueueDueSchedules();

    assert.equal(first, 1);
    assert.equal(second, 0, "the cursor moved forward");
    assert.equal(await prisma.syncJob.count({ where: { userId } }), 1);
  });

  it("does not stack a run on top of one already in flight", async () => {
    await setSchedule({
      enabled: true,
      intervalMinutes: 15,
      nextRunAt: new Date(Date.now() - 60_000),
    });
    const { job } = await enqueue({ dedupeKey: "in-flight" });
    await queue.claimJob(job.id);

    assert.equal(await enqueueDueSchedules(), 0);
  });

  it("skips a schedule suspended after repeated failures", async () => {
    await setSchedule({
      enabled: true,
      intervalMinutes: 15,
      nextRunAt: new Date(Date.now() - 60_000),
      disabledReason: "Paused after 5 consecutive failures.",
    });

    assert.equal(
      await enqueueDueSchedules(),
      0,
      "a suspended schedule stays suspended until the user acts",
    );
  });

  it("respects quiet hours", async () => {
    // A window that certainly excludes the current hour.
    const hour = new Date().getUTCHours();
    const from = (hour + 2) % 24;
    const to = (hour + 4) % 24;

    await setSchedule({
      enabled: true,
      intervalMinutes: 15,
      timezone: "UTC",
      activeFromHour: from,
      activeToHour: to,
      nextRunAt: new Date(Date.now() - 60_000),
    });

    assert.equal(await enqueueDueSchedules(), 0);
  });
});
