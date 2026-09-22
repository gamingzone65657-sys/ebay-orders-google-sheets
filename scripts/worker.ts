/**
 * Long-running background worker.
 *
 *   npm run worker
 *
 * Run this alongside `npm start` on a host that keeps processes alive. On a
 * serverless platform, hit POST /api/jobs/tick from a scheduler instead —
 * both call the same `tick()`, and both are safe to run at the same time.
 */

import { runWorkerLoop } from "../src/lib/jobs/worker";
import { prisma } from "../src/lib/db";

const intervalMs = Number(process.env.WORKER_INTERVAL_MS ?? 30_000);

const controller = new AbortController();

let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[worker] ${signal} received, finishing current tick…`);
  controller.abort();
  // The loop checks the signal between ticks; give it a moment, then exit.
  setTimeout(() => {
    void prisma.$disconnect().finally(() => process.exit(0));
  }, 2_000);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

runWorkerLoop({ intervalMs, signal: controller.signal })
  .catch((error) => {
    console.error("[worker] fatal", error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
