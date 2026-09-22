import { z } from "zod";

import { handle, ok, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";

/**
 * Settings are stored as key/value rows (UserPreference) plus a few first-class
 * User columns, so new toggles in later phases need no migration.
 */
const schema = z.object({
  profile: z
    .object({
      name: z.string().trim().min(1).max(120).optional(),
      timezone: z.string().trim().min(1).max(64).optional(),
    })
    .optional(),
  preferences: z.record(z.string().min(1).max(64), z.string().max(500)).optional(),
});

export async function PUT(request: Request) {
  return handle(async () => {
    const { data, error } = await parseBody(request, schema);
    if (error) return error;

    const user = await getCurrentUser();

    if (data.profile && Object.keys(data.profile).length > 0) {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          name: data.profile.name ?? user.name,
          timezone: data.profile.timezone ?? user.timezone,
        },
      });
    }

    const entries = Object.entries(data.preferences ?? {});
    for (const [key, value] of entries) {
      await prisma.userPreference.upsert({
        where: { userId_key: { userId: user.id, key } },
        create: { userId: user.id, key, value },
        update: { value },
      });
    }

    return ok({ updated: entries.length });
  });
}
