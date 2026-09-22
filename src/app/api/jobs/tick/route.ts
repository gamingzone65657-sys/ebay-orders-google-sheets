import { timingSafeEqual } from "node:crypto";

import { fail, handle, ok } from "@/lib/api";
import { tick } from "@/lib/jobs/worker";
import { queueDepth } from "@/lib/jobs/queue";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Runs one worker tick.
 *
 * This is the serverless-friendly half of the background system: point a
 * platform cron (Vercel Cron, GitHub Actions, systemd timer, `curl` in
 * crontab) at it every minute or so. It calls exactly the same `tick()` as
 * the long-running worker, and the two are safe to run simultaneously —
 * claiming is a compare-and-swap, so at most one of them gets each job.
 *
 * Protected by CRON_SECRET. Without that variable set the endpoint refuses
 * to run rather than defaulting to open, because an unauthenticated trigger
 * would let anyone burn a seller's eBay and Google quota.
 */
function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;

  const header =
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    request.headers.get("x-cron-secret") ??
    new URL(request.url).searchParams.get("secret") ??
    "";

  const a = Buffer.from(header, "utf8");
  const b = Buffer.from(secret, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  return handle(async () => {
    if (!process.env.CRON_SECRET?.trim()) {
      return fail(
        "CRON_SECRET is not configured, so the tick endpoint is disabled. Set it, or run `npm run worker` instead.",
        503,
      );
    }
    if (!isAuthorized(request)) return fail("Unauthorized.", 401);

    const url = new URL(request.url);
    const maxJobs = Number(url.searchParams.get("maxJobs") ?? 3);

    const result = await tick({
      maxJobs: Number.isFinite(maxJobs) ? maxJobs : 3,
    });

    return ok({ ...result, queueDepth: await queueDepth() });
  });
}

/** GET is accepted too, since some cron services only issue GETs. */
export async function GET(request: Request) {
  return POST(request);
}
