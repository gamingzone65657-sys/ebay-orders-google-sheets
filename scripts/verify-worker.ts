/**
 * One-shot end-to-end check of the background worker.
 *
 *   npx tsx scripts/verify-worker.ts
 *
 * Makes a schedule due, runs a single tick, and reports what the worker did
 * with it. Reads and writes the real development database.
 */

import { prisma } from "../src/lib/db";
import { tick } from "../src/lib/jobs/worker";

async function main() {
  const user = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
  if (!user) throw new Error("No workspace found. Run `npm run db:seed` first.");

  await prisma.automationSetting.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      enabled: true,
      intervalMinutes: 60,
      nextRunAt: new Date(Date.now() - 60_000),
    },
    update: {
      enabled: true,
      disabledReason: null,
      consecutiveFailures: 0,
      nextRunAt: new Date(Date.now() - 60_000),
    },
  });

  console.log("schedule made due; running one tick…");
  const result = await tick({ maxJobs: 1 });
  console.log("tick:", result);

  const job = await prisma.syncJob.findFirst({
    where: { userId: user.id, trigger: "SCHEDULED", kind: "SHEET_SYNC" },
    orderBy: { createdAt: "desc" },
    include: { logs: { orderBy: { createdAt: "asc" }, take: 6 } },
  });

  if (!job) {
    console.log("RESULT: no scheduled job was created");
    return;
  }

  console.log(
    `job ${job.id}: status=${job.status} phase=${job.phase} attempt=${job.attempt}`,
  );
  console.log(`  summary: ${job.summary ?? "(none)"}`);
  console.log(`  errorCode: ${job.errorCode ?? "(none)"}`);
  for (const log of job.logs) {
    console.log(`  [${log.level}] ${log.step}: ${log.message.slice(0, 110)}`);
  }

  const automation = await prisma.automationSetting.findUniqueOrThrow({
    where: { userId: user.id },
  });
  console.log("automation after the run:");
  console.log(`  lastSuccessAt: ${automation.lastSuccessAt?.toISOString() ?? "null"}`);
  console.log(`  lastFailureAt: ${automation.lastFailureAt?.toISOString() ?? "null"}`);
  console.log(`  lastFailureCode: ${automation.lastFailureCode ?? "null"}`);
  console.log(`  consecutiveFailures: ${automation.consecutiveFailures}`);
  console.log(`  nextRunAt: ${automation.nextRunAt?.toISOString() ?? "null"}`);

  const locks = await prisma.syncLock.count();
  console.log(`  locks still held: ${locks}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
