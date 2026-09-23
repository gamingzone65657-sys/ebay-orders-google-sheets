import { apiError, handle, ok } from "@/lib/api";
import { CONNECTION_STATUS } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { isEbayConfigured, resolveEnvironment } from "@/lib/ebay/config";
import { isGoogleConfigured, expectedRedirectUri } from "@/lib/google/config";
import { JOB_HEARTBEAT_TIMEOUT_MS } from "@/lib/constants";
import { checkProductionReadiness } from "@/lib/production-check";
import { readFlag } from "@/lib/env";
import { registrationOpen } from "@/lib/registration";
import { retentionSettings } from "@/lib/retention";
import { anonymousFallbackAllowed } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Deployment health.
 *
 * Reports whether each dependency is *configured and reachable*, never what it
 * is configured with: no client ids, no redirect hosts, no database URL, no
 * account identifiers. Everything here is a boolean, a count, or a timestamp.
 *
 * Protected by the same secret as the cron endpoint, because a public health
 * page tells an attacker exactly which parts of a deployment are unfinished.
 * Without HEALTH_SECRET or CRON_SECRET set it refuses rather than opening.
 */
function authorized(request: Request): boolean {
  const secret =
    process.env.HEALTH_SECRET?.trim() || process.env.CRON_SECRET?.trim();
  if (!secret) return false;

  const presented =
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    request.headers.get("x-health-secret") ??
    new URL(request.url).searchParams.get("secret") ??
    "";

  // Constant-time-ish: compare lengths first, then every byte.
  if (presented.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i += 1) {
    diff |= presented.charCodeAt(i) ^ secret.charCodeAt(i);
  }
  return diff === 0;
}

export async function GET(request: Request) {
  return handle(async () => {
    if (!authorized(request)) {
      return apiError({
        code: "UNAUTHORIZED",
        message:
          "Set HEALTH_SECRET (or CRON_SECRET) and present it as a bearer token to read this endpoint.",
        status: 401,
      });
    }

    // --- Database ---------------------------------------------------------
    let database: { connected: boolean; error?: string };
    let counts: Record<string, number> | null = null;
    try {
      const [users, ebay, google, sheets, orders, jobs] = await Promise.all([
        prisma.user.count(),
        prisma.ebayConnection.count({
          where: { status: CONNECTION_STATUS.CONNECTED },
        }),
        prisma.googleConnection.count({
          where: { status: CONNECTION_STATUS.CONNECTED },
        }),
        prisma.googleSheetConfig.count({ where: { isActive: true } }),
        prisma.importedOrder.count(),
        prisma.syncJob.count(),
      ]);
      database = { connected: true };
      counts = {
        users,
        connectedEbayAccounts: ebay,
        connectedGoogleAccounts: google,
        activeSheetConfigs: sheets,
        importedOrders: orders,
        syncJobs: jobs,
      };
    } catch (error) {
      database = {
        connected: false,
        error: error instanceof Error ? error.name : "Unknown error",
      };
    }

    // --- Background work --------------------------------------------------
    // "Running" means a worker has claimed something recently. A queue that is
    // simply empty is healthy, so that is reported separately from staleness.
    const now = Date.now();
    let worker: Record<string, unknown> = { observable: false };
    let scheduler: Record<string, unknown> = { observable: false };

    if (database.connected) {
      const [queued, running, lastFinished, automation] = await Promise.all([
        prisma.syncJob.count({ where: { status: "QUEUED" } }),
        prisma.syncJob.findFirst({
          where: { status: "RUNNING" },
          orderBy: { startedAt: "desc" },
          select: { heartbeatAt: true },
        }),
        prisma.syncJob.findFirst({
          where: { finishedAt: { not: null } },
          orderBy: { finishedAt: "desc" },
          select: { finishedAt: true, status: true },
        }),
        prisma.automationSetting.findFirst({
          where: { enabled: true },
          select: { intervalMinutes: true, nextRunAt: true, disabledReason: true },
        }),
      ]);

      const heartbeat = running?.heartbeatAt?.getTime() ?? null;
      worker = {
        observable: true,
        queuedJobs: queued,
        jobRunning: Boolean(running),
        heartbeatStale:
          heartbeat === null ? null : now - heartbeat > JOB_HEARTBEAT_TIMEOUT_MS,
        lastFinishedAt: lastFinished?.finishedAt?.toISOString() ?? null,
        lastFinishedStatus: lastFinished?.status ?? null,
      };

      scheduler = {
        observable: true,
        automationEnabled: Boolean(automation),
        intervalMinutes: automation?.intervalMinutes ?? null,
        nextRunAt: automation?.nextRunAt?.toISOString() ?? null,
        suspended: Boolean(automation?.disabledReason),
        // Either mechanism can drive it; both being absent is the problem.
        tickEndpointEnabled: Boolean(process.env.CRON_SECRET?.trim()),
      };
    }

    // --- Configuration ----------------------------------------------------
    const singleUser = readFlag("SINGLE_USER_MODE");
    const accountsWithPassword = database.connected
      ? await prisma.user.count({ where: { passwordHash: { not: null } } })
      : 0;
    const findings = checkProductionReadiness();
    const blockers = findings.filter((f) => f.severity === "blocker");
    const appUrl = process.env.APP_URL?.trim() ?? "";
    const retention = retentionSettings();

    const body = {
      status: blockers.length === 0 && database.connected ? "ok" : "degraded",
      environment: process.env.NODE_ENV ?? "unknown",
      checkedAt: new Date().toISOString(),

      database,
      counts,

      ebay: {
        configured: isEbayConfigured(),
        environment: resolveEnvironment(),
        // The whole point of the migration: prove production is in use.
        usingProductionApi: resolveEnvironment() === "PRODUCTION",
      },
      google: {
        configured: isGoogleConfigured(),
        redirectUriConfigured: Boolean(expectedRedirectUri()),
      },
      application: {
        appUrlConfigured: Boolean(appUrl),
        appUrlIsHttps: /^https:\/\//i.test(appUrl),
        appUrlIsLocalhost: /localhost|127\.0\.0\.1/i.test(appUrl),
        authSecretConfigured:
          (process.env.AUTH_SECRET ?? "").length >= 32,
        // Reported as "set", not as "in effect": production ignores it.
        singleUserModeVariableSet: singleUser.enabled,
        singleUserModeVerdict: singleUser.verdict,
        // What actually decides whether an anonymous request is served.
        anonymousAccessAllowed: anonymousFallbackAllowed(),
        registrationOpen: registrationOpen(),
        // Zero means nobody can sign in — the deployment is locked out of
        // itself, which is the one authentication state worth alarming on.
        accountsWithPassword,
      },
      worker,
      scheduler,
      retention: {
        rawPayloadDays: retention.rawPayloadDays,
        historyDays: retention.historyDays,
      },

      // Titles and severities only — the detail text names variables, which is
      // fine, but this keeps the payload to "what is wrong", not "what is set".
      readiness: findings.map((f) => ({ severity: f.severity, title: f.title })),
    };

    return ok(body, blockers.length === 0 && database.connected ? 200 : 503);
  });
}
