import { fail, handle, ok } from "@/lib/api";
import { SYNC_PHASE_LABELS, type SyncPhase } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/** Progress + result for one sync run. Polled by the UI while it is live. */
export async function GET(_request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    const user = await getCurrentUser();

    const job = await prisma.syncJob.findFirst({
      where: { id, userId: user.id },
      include: {
        logs: { orderBy: { createdAt: "asc" }, take: 50 },
      },
    });

    if (!job) return fail("Sync job not found.", 404);

    const done = job.finishedAt !== null;

    return ok({
      jobId: job.id,
      kind: job.kind,
      status: job.status,
      phase: job.phase,
      phaseLabel:
        SYNC_PHASE_LABELS[job.phase as SyncPhase] ?? job.phase,
      done,
      progress: {
        current: job.progressCurrent,
        total: job.progressTotal,
        label: job.progressLabel,
      },
      results: {
        found: job.ordersFetched,
        inserted: job.rowsInserted,
        updated: job.rowsUpdated,
        skipped: job.rowsSkipped,
        failed: job.rowsFailed,
      },
      summary: job.summary,
      errorMessage: job.errorMessage,
      startedAt: job.startedAt.toISOString(),
      finishedAt: job.finishedAt?.toISOString() ?? null,
      durationMs: job.durationMs,
      logs: job.logs.map((entry) => ({
        level: entry.level,
        step: entry.step,
        message: entry.message,
      })),
    });
  });
}
