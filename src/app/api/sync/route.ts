import { z } from "zod";

import { fail, handle, ok, parseBody } from "@/lib/api";
import {
  ROW_MODES,
  SYNC_JOB_STATUS,
  SYNC_MODES,
  SYNC_PHASES,
  SYNC_RANGES,
  SYNC_TRIGGERS,
} from "@/lib/constants";
import { prisma } from "@/lib/db";
import {
  claimExclusively,
  enqueueJob,
  hasRunningJob,
  heartbeat,
  releaseLockForJob,
} from "@/lib/jobs/queue";
import { runSheetSync } from "@/lib/sync/sheet-sync";
import { logError } from "@/lib/log";
import { getCurrentUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const schema = z.object({
  range: z
    .enum([
      SYNC_RANGES.SINCE_LAST,
      SYNC_RANGES.LAST_24H,
      SYNC_RANGES.LAST_7D,
      SYNC_RANGES.LAST_30D,
      SYNC_RANGES.LAST_90D,
      SYNC_RANGES.CUSTOM,
    ])
    .default(SYNC_RANGES.SINCE_LAST),
  customFrom: z.string().datetime().optional(),
  customTo: z.string().datetime().optional(),
  rowMode: z.enum([ROW_MODES.ORDER, ROW_MODES.LINE_ITEM]).optional(),
  syncMode: z
    .enum([SYNC_MODES.APPEND, SYNC_MODES.UPDATE, SYNC_MODES.APPEND_UPDATE])
    .optional(),
  skipImport: z.boolean().default(false),
  confirmed: z.boolean().default(false),
  /** Wait for the run instead of polling. Used by tests and scripts. */
  wait: z.boolean().default(false),
});

/**
 * Starts a sync.
 *
 * By default this returns a job id immediately and runs the work in the
 * background, so the UI can poll `/api/sync/jobs/[id]` and show real progress
 * through fetching → processing → writing. Pass `wait: true` to block until
 * the run finishes and get the full result in one response.
 *
 * Running detached is fine for a single long-lived Node process. A
 * multi-instance deployment should move this onto a job queue; the SyncJob
 * row is already the unit of work that would be enqueued.
 */
export async function POST(request: Request) {
  return handle(async () => {
    const { data, error } = await parseBody(request, schema);
    if (error) return error;

    if (data.range === SYNC_RANGES.CUSTOM) {
      if (!data.customFrom || !data.customTo) {
        return fail("A custom range needs both a start and an end date.", 422);
      }
      if (new Date(data.customFrom) >= new Date(data.customTo)) {
        return fail("The custom range start must be before its end.", 422);
      }
    }

    const user = await getCurrentUser();

    const sheetConfig = await prisma.googleSheetConfig.findFirst({
      where: { userId: user.id, isActive: true },
      select: { id: true },
    });
    if (!sheetConfig) {
      return fail(
        "Select a destination spreadsheet before syncing.",
        409,
      );
    }

    const options = {
      range: data.range,
      customFrom: data.customFrom ? new Date(data.customFrom) : undefined,
      customTo: data.customTo ? new Date(data.customTo) : undefined,
      rowMode: data.rowMode,
      syncMode: data.syncMode,
      skipImport: data.skipImport,
      confirmed: data.confirmed,
      trigger: SYNC_TRIGGERS.MANUAL,
    };

    // Manual and scheduled syncs share one lock, so pressing Sync Now while
    // the worker is mid-run cannot produce two writers on the same sheet.
    if (await hasRunningJob(user.id)) {
      const running = await prisma.syncJob.findFirst({
        where: { userId: user.id, status: SYNC_JOB_STATUS.RUNNING },
        orderBy: { startedAt: "desc" },
        select: { id: true, trigger: true },
      });
      return fail(
        running?.trigger === SYNC_TRIGGERS.SCHEDULED
          ? "A scheduled sync is running right now. Wait for it to finish, then try again."
          : "A sync is already running.",
        409,
        { jobId: running?.id ?? null },
      );
    }

    // Manual runs go through the same queue as scheduled ones, then execute
    // inline — so a manual sync still works with no worker process running,
    // which is the whole point of the button.
    const { job } = await enqueueJob({
      userId: user.id,
      trigger: SYNC_TRIGGERS.MANUAL,
      sheetConfigId: sheetConfig.id,
      maxAttempts: 1,
    });

    // claimExclusively, not claimJob: two requests arriving together would
    // each create and claim their own row, so the mutual exclusion has to
    // be resolved after the claim, not before it.
    if ((await claimExclusively(job.id, user.id)) === "busy") {
      return fail("A sync is already running for this workspace.", 409, {
        jobId: job.id,
      });
    }

    const execute = async () => {
      const beat = setInterval(() => void heartbeat(job.id), 30_000);
      try {
        return await runSheetSync(user.id, { ...options, jobId: job.id });
      } finally {
        clearInterval(beat);
        await releaseLockForJob(job.id);
      }
    };

    if (data.wait) {
      return ok(await execute());
    }

    // Detached on purpose; progress is observable through the job row, and
    // a crash mid-run is recovered by the worker's stale-job reclaim.
    void execute().catch(async (caught) => {
      logError("sync", caught);
      await prisma.syncJob
        .update({
          where: { id: job.id },
          data: {
            status: SYNC_JOB_STATUS.FAILED,
            phase: SYNC_PHASES.FAILED,
            finishedAt: new Date(),
            summary: "The sync crashed unexpectedly.",
            errorMessage:
              caught instanceof Error ? caught.message : String(caught),
            lockedBy: null,
          },
        })
        .catch(() => undefined);
    });

    return ok({ jobId: job.id, started: true });
  });
}
