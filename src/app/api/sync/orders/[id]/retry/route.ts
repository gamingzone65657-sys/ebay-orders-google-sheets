import { apiError, handle, ok } from "@/lib/api";
import { hasRunningJob } from "@/lib/jobs/queue";
import { getCurrentUser } from "@/lib/session";
import { retryOrder } from "@/lib/sync/sheet-sync";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/** Status for each reason a retry can be refused before it starts. */
const REFUSAL_STATUS: Record<string, number> = {
  ORDER_NOT_FOUND: 404,
  NOT_CONFIGURED: 409,
  CONFIRMATION_REQUIRED: 409,
  NO_ROW_PLANNED: 422,
};

/**
 * Retries one order without re-running the whole sync.
 *
 * Runs inline rather than through the job queue: this is one row, the caller
 * is waiting for the answer, and a queued job would have to be polled to say
 * something the user could have been told directly.
 */
export async function POST(_request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    const user = await getCurrentUser();

    // The sync engine holds a per-workspace mutex. Refusing here turns what
    // would be a lock timeout into an answer the user can act on.
    if (await hasRunningJob(user.id)) {
      return apiError({
        code: "SYNC_IN_PROGRESS",
        message:
          "A sync is already running. Wait for it to finish before retrying an order.",
        status: 409,
      });
    }

    const result = await retryOrder(user.id, id);

    if (!result.ok) {
      return apiError({
        code: result.code ?? "RETRY_FAILED",
        message: result.message,
        status: REFUSAL_STATUS[result.code ?? ""] ?? 502,
        detail: result.jobId ? `Run ${result.jobId}` : undefined,
      });
    }

    return ok({
      jobId: result.jobId,
      outcome: result.outcome,
      message: result.message,
    });
  });
}
