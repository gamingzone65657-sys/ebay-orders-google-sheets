import { z } from "zod";

import { fail, handle, ok, parseBody } from "@/lib/api";
import { ROW_MODES, SYNC_MODES, SYNC_RANGES } from "@/lib/constants";
import { previewSync } from "@/lib/sync/sheet-sync";
import { getCurrentUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

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
});

/**
 * Dry run: what a sync would do, without touching the spreadsheet.
 *
 * Deliberately shares `planSync` with the real run, so the numbers a user
 * confirms are produced by the same code that then performs the write —
 * a separate "estimate" implementation would be free to disagree with it.
 */
export async function POST(request: Request) {
  return handle(async () => {
    const { data, error } = await parseBody(request, schema);
    if (error) return error;

    if (data.range === SYNC_RANGES.CUSTOM && (!data.customFrom || !data.customTo)) {
      return fail("A custom range needs both a start and an end date.", 422);
    }

    const user = await getCurrentUser();

    try {
      const preview = await previewSync(user.id, {
        range: data.range,
        customFrom: data.customFrom ? new Date(data.customFrom) : undefined,
        customTo: data.customTo ? new Date(data.customTo) : undefined,
        rowMode: data.rowMode,
        syncMode: data.syncMode,
      });
      return ok(preview);
    } catch (caught) {
      return fail(
        caught instanceof Error
          ? caught.message
          : "The preview could not be built.",
        409,
      );
    }
  });
}
