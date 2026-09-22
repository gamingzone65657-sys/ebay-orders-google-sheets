import { prisma } from "@/lib/db";
import {
  JOB_HEARTBEAT_TIMEOUT_MS,
  ORDER_SYNC_STATE,
  SYNC_JOB_STATUS,
} from "@/lib/constants";

/** Everything the dashboard renders, in one round trip. */
export async function getDashboardData(userId: string) {
  const [
    ebayConnection,
    googleConnection,
    sheetConfig,
    automation,
    lastJob,
    mappingCount,
    enabledMappingCount,
    totals,
  ] = await Promise.all([
    prisma.ebayConnection.findFirst({ where: { userId, isActive: true } }),
    prisma.googleConnection.findFirst({ where: { userId, isActive: true } }),
    prisma.googleSheetConfig.findFirst({
      where: { userId, isActive: true },
      include: { _count: { select: { columns: true } } },
    }),
    prisma.automationSetting.findUnique({ where: { userId } }),
    prisma.syncJob.findFirst({
      where: { userId },
      orderBy: { startedAt: "desc" },
    }),
    prisma.fieldMapping.count({
      where: { sheetConfig: { userId, isActive: true }, savedConfigId: null },
    }),
    prisma.fieldMapping.count({
      where: {
        sheetConfig: { userId, isActive: true },
        savedConfigId: null,
        enabled: true,
      },
    }),
    prisma.syncJob.aggregate({
      where: { userId },
      _sum: {
        ordersImported: true,
        ordersUpdated: true,
        ordersSkipped: true,
        errorCount: true,
      },
      _count: { _all: true },
    }),
  ]);

  const [orderCount, pendingCount, failedCount] = await Promise.all([
    prisma.importedOrder.count({ where: { userId } }),
    prisma.importedOrder.count({
      where: { userId, syncState: ORDER_SYNC_STATE.PENDING },
    }),
    prisma.importedOrder.count({
      where: { userId, syncState: ORDER_SYNC_STATE.FAILED },
    }),
  ]);

  const recentJobs = await prisma.syncJob.findMany({
    where: { userId },
    orderBy: { startedAt: "desc" },
    take: 5,
  });

  // A RUNNING job only counts as "in progress" while its worker is still
  // checking in; a stale one is a crash waiting to be reclaimed.
  const heartbeatCutoff = new Date(Date.now() - JOB_HEARTBEAT_TIMEOUT_MS);
  const [runningJob, queuedCount, lastSuccessJob] = await Promise.all([
    prisma.syncJob.findFirst({
      where: {
        userId,
        status: SYNC_JOB_STATUS.RUNNING,
        OR: [
          { heartbeatAt: { gt: heartbeatCutoff } },
          { heartbeatAt: null, startedAt: { gt: heartbeatCutoff } },
        ],
      },
      orderBy: { startedAt: "desc" },
    }),
    prisma.syncJob.count({
      where: { userId, status: SYNC_JOB_STATUS.QUEUED },
    }),
    automation?.lastSuccessJobId
      ? prisma.syncJob.findUnique({
          where: { id: automation.lastSuccessJobId },
          select: { summary: true },
        })
      : Promise.resolve(null),
  ]);

  return {
    ebayConnection,
    googleConnection,
    sheetConfig,
    automation,
    lastJob,
    recentJobs,
    runningJob,
    queuedCount,
    lastSuccessSummary: lastSuccessJob?.summary ?? null,
    mappingCount,
    enabledMappingCount,
    orderCount,
    pendingCount,
    failedCount,
    lifetime: {
      imported: totals._sum.ordersImported ?? 0,
      updated: totals._sum.ordersUpdated ?? 0,
      skipped: totals._sum.ordersSkipped ?? 0,
      errors: totals._sum.errorCount ?? 0,
      runs: totals._count._all,
    },
  };
}

export type DashboardData = Awaited<ReturnType<typeof getDashboardData>>;

/** Active destination sheet with its detected columns and live mappings. */
export async function getMappingWorkspace(userId: string) {
  const sheetConfig = await prisma.googleSheetConfig.findFirst({
    where: { userId, isActive: true },
    include: {
      columns: { orderBy: { position: "asc" } },
      fieldMappings: {
        where: { savedConfigId: null },
        orderBy: { position: "asc" },
      },
    },
  });

  const savedConfigurations = await prisma.savedConfiguration.findMany({
    where: { userId },
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
  });

  return { sheetConfig, savedConfigurations };
}
