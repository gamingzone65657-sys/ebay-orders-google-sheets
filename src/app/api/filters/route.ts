import { z } from "zod";

import { fail, handle, ok, parseBody } from "@/lib/api";
import {
  FULFILLMENT_FILTERS,
  ORDER_STATE_FILTERS,
  SKU_FILTER_MODES,
} from "@/lib/constants";
import { prisma } from "@/lib/db";
import { parseList, serializeList } from "@/lib/sync/filters";
import { getCurrentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

const ORDER_STATES = ORDER_STATE_FILTERS.map((entry) => entry.id);
const FULFILLMENTS = FULFILLMENT_FILTERS.map((entry) => entry.id);
const SKU_MODES = SKU_FILTER_MODES.map((entry) => entry.id);

const schema = z.object({
  orderStates: z.array(z.enum(ORDER_STATES as [string, ...string[]])).default([]),
  fulfillmentStates: z
    .array(z.enum(FULFILLMENTS as [string, ...string[]]))
    .default([]),
  marketplaces: z.array(z.string().min(1).max(32)).default([]),
  skuMode: z.enum(SKU_MODES as [string, ...string[]]).default("ALL"),
  /** Free text: comma- or newline-separated. */
  skuValues: z.string().max(10_000).default(""),
  skuCaseSensitive: z.boolean().default(false),
  dateFrom: z.string().datetime().nullable().default(null),
  dateTo: z.string().datetime().nullable().default(null),
});

/**
 * Saves the order/fulfillment/marketplace/SKU filters for the active
 * destination. Selections are stored as token lists, so a new option is a
 * constants change rather than a migration.
 */
export async function PUT(request: Request) {
  return handle(async () => {
    const { data, error } = await parseBody(request, schema);
    if (error) return error;

    const user = await getCurrentUser();
    const sheetConfig = await prisma.googleSheetConfig.findFirst({
      where: { userId: user.id, isActive: true },
      select: { id: true },
    });
    if (!sheetConfig) {
      return fail("Select a destination spreadsheet first.", 409);
    }

    const needsValues = SKU_FILTER_MODES.find(
      (mode) => mode.id === data.skuMode,
    )?.needsValues;
    const skuValues = parseList(data.skuValues);
    if (needsValues && skuValues.length === 0) {
      return fail(
        "That SKU filter needs at least one SKU or fragment to match against.",
        422,
      );
    }

    const dateFrom = data.dateFrom ? new Date(data.dateFrom) : null;
    const dateTo = data.dateTo ? new Date(data.dateTo) : null;
    if (dateFrom && dateTo && dateFrom >= dateTo) {
      return fail("The filter's start date must be before its end date.", 422);
    }

    const payload = {
      orderStates: serializeList(data.orderStates),
      fulfillmentStates: serializeList(data.fulfillmentStates),
      marketplaces: serializeList(data.marketplaces),
      skuMode: data.skuMode,
      skuValues: serializeList(skuValues),
      skuCaseSensitive: data.skuCaseSensitive,
      dateFrom,
      dateTo,
    };

    const saved = await prisma.syncFilter.upsert({
      where: { sheetConfigId: sheetConfig.id },
      create: { sheetConfigId: sheetConfig.id, ...payload },
      update: payload,
    });

    return ok({ id: saved.id, skuValues: skuValues.length });
  });
}
