import { z } from "zod";

import { handle, ok, parseBody } from "@/lib/api";
import { MAX_INTERVAL_MINUTES, MIN_INTERVAL_MINUTES } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { clampInterval, computeNextRun } from "@/lib/jobs/schedule";
import { getCurrentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

const schema = z.object({
  enabled: z.boolean(),
  intervalMinutes: z.coerce
    .number()
    .int()
    .min(MIN_INTERVAL_MINUTES)
    .max(MAX_INTERVAL_MINUTES),
  timezone: z.string().min(1).max(64),
  lookbackDays: z.coerce.number().int().min(1).max(90),
  activeFromHour: z.coerce.number().int().min(0).max(23).nullable(),
  activeToHour: z.coerce.number().int().min(0).max(23).nullable(),
  orderStatusFilter: z.string().max(200).nullable(),
  retryLimit: z.coerce.number().int().min(1).max(10),
  retryBackoffSecs: z.coerce.number().int().min(5).max(3600),
  notifyOnError: z.boolean(),
  notifyOnSuccess: z.boolean(),
  notifyEmail: z.string().email().nullable().or(z.literal("")),
});

export async function PUT(request: Request) {
  return handle(async () => {
    const { data, error } = await parseBody(request, schema);
    if (error) return error;

    const user = await getCurrentUser();
    const existing = await prisma.automationSetting.findUnique({
      where: { userId: user.id },
    });

    const intervalMinutes = clampInterval(data.intervalMinutes);
    const now = new Date();

    const nextRunAt = computeNextRun(
      {
        enabled: data.enabled,
        intervalMinutes,
        timezone: data.timezone,
        activeFromHour: data.activeFromHour,
        activeToHour: data.activeToHour,
        lastSuccessAt: existing?.lastSuccessAt ?? null,
        lastRunAt: existing?.lastRunAt ?? null,
      },
      now,
    );

    const payload = {
      enabled: data.enabled,
      intervalMinutes,
      timezone: data.timezone,
      lookbackDays: data.lookbackDays,
      activeFromHour: data.activeFromHour,
      activeToHour: data.activeToHour,
      orderStatusFilter: data.orderStatusFilter || null,
      retryLimit: data.retryLimit,
      retryBackoffSecs: data.retryBackoffSecs,
      notifyOnError: data.notifyOnError,
      notifyOnSuccess: data.notifyOnSuccess,
      notifyEmail: data.notifyEmail ? data.notifyEmail : null,
      nextRunAt,
      // Saving the form is an explicit act, so it clears a suspension and
      // the failure streak that caused it.
      ...(data.enabled
        ? { disabledReason: null, consecutiveFailures: 0 }
        : { disabledReason: null }),
    };

    const saved = await prisma.automationSetting.upsert({
      where: { userId: user.id },
      create: { userId: user.id, ...payload },
      update: payload,
    });

    return ok({
      enabled: saved.enabled,
      intervalMinutes: saved.intervalMinutes,
      nextRunAt: saved.nextRunAt?.toISOString() ?? null,
    });
  });
}
