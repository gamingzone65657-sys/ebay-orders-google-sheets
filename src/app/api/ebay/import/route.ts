import { z } from "zod";

import { handle, ok, parseBody } from "@/lib/api";
import { SYNC_TRIGGERS } from "@/lib/constants";
import { importOrders } from "@/lib/ebay/import-orders";
import { getCurrentUser } from "@/lib/session";

export const dynamic = "force-dynamic";
/** A wide first import can legitimately take a while. */
export const maxDuration = 300;

const schema = z.object({
  lookbackDays: z.coerce.number().int().min(1).max(365).optional(),
  createdFrom: z.string().datetime().optional(),
  createdTo: z.string().datetime().optional(),
  useModifiedDate: z.boolean().optional(),
  includeFulfillments: z.boolean().optional(),
  maxOrders: z.coerce.number().int().min(1).max(10000).optional(),
  maxPages: z.coerce.number().int().min(1).max(200).optional(),
});

/**
 * Pulls orders from eBay into the database.
 *
 * Always returns 200 with the job outcome, including for failures: a blocked
 * or partially-failed import is a recorded SyncJob the seller can open, not
 * an HTTP error. Genuine server faults still surface as 500 via `handle`.
 */
export async function POST(request: Request) {
  return handle(async () => {
    const { data, error } = await parseBody(request, schema);
    if (error) return error;

    const user = await getCurrentUser();

    const result = await importOrders(user.id, {
      trigger: SYNC_TRIGGERS.MANUAL,
      lookbackDays: data.lookbackDays,
      createdFrom: data.createdFrom ? new Date(data.createdFrom) : undefined,
      createdTo: data.createdTo ? new Date(data.createdTo) : undefined,
      useModifiedDate: data.useModifiedDate,
      includeFulfillments: data.includeFulfillments,
      maxOrders: data.maxOrders,
      maxPages: data.maxPages,
    });

    return ok(result);
  });
}
