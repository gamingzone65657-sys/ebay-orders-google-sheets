/**
 * Order filtering.
 *
 * Two halves, deliberately separated:
 *
 *   buildOrderWhere()  — the parts that map cleanly onto indexed columns, so
 *                        the database does the work instead of loading every
 *                        order into memory.
 *   matchesSkuFilter() — the part that depends on line items, evaluated
 *                        per row once the order is loaded.
 *
 * Every selection is a list of tokens. An empty list always means "no
 * restriction", which is why the UI's "All" option needs no token: it is
 * simply the absence of any selection.
 */

import type { Prisma } from "@prisma/client";

import type { SkuFilterMode } from "@/lib/constants";

export interface FilterSettings {
  orderStates: string[];
  fulfillmentStates: string[];
  marketplaces: string[];
  skuMode: SkuFilterMode;
  skuValues: string[];
  skuCaseSensitive: boolean;
  dateFrom: Date | null;
  dateTo: Date | null;
}

export const EMPTY_FILTER: FilterSettings = {
  orderStates: [],
  fulfillmentStates: [],
  marketplaces: [],
  skuMode: "ALL",
  skuValues: [],
  skuCaseSensitive: false,
  dateFrom: null,
  dateTo: null,
};

/** Accepts comma- or newline-separated input from the UI. */
export function parseList(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function serializeList(values: string[]): string | null {
  const cleaned = values.map((value) => value.trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned.join(",") : null;
}

/** Turns the stored row into the shape the engine works with. */
export function toFilterSettings(
  row: {
    orderStates: string | null;
    fulfillmentStates: string | null;
    marketplaces: string | null;
    skuMode: string;
    skuValues: string | null;
    skuCaseSensitive: boolean;
    dateFrom: Date | null;
    dateTo: Date | null;
  } | null,
): FilterSettings {
  if (!row) return EMPTY_FILTER;
  return {
    orderStates: parseList(row.orderStates),
    fulfillmentStates: parseList(row.fulfillmentStates),
    marketplaces: parseList(row.marketplaces),
    skuMode: (row.skuMode as SkuFilterMode) ?? "ALL",
    skuValues: parseList(row.skuValues),
    skuCaseSensitive: row.skuCaseSensitive,
    dateFrom: row.dateFrom,
    dateTo: row.dateTo,
  };
}

/* -------------------------------------------------------------------------- */
/* Database-level filtering                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One order state token → the condition that recognises it.
 *
 * These overlap on purpose: eBay reports payment, fulfillment and
 * cancellation independently, so an order can legitimately be both "Paid"
 * and "Shipped". Selected tokens are OR-ed.
 */
const ORDER_STATE_CONDITIONS: Record<string, Prisma.ImportedOrderWhereInput> = {
  PAID: { paymentStatus: "PAID" },
  AWAITING_PAYMENT: { paymentStatus: { in: ["PENDING", "FAILED"] } },
  SHIPPED: { fulfillmentStatus: "FULFILLED" },
  COMPLETED: { orderStatus: "COMPLETED" },
  CANCELLED: { orderStatus: { in: ["CANCELLED", "REFUNDED"] } },
};

const FULFILLMENT_CONDITIONS: Record<string, Prisma.ImportedOrderWhereInput> = {
  // A missing status means eBay never reported one, which in practice is
  // an order nothing has shipped for yet.
  UNFULFILLED: {
    OR: [{ fulfillmentStatus: "NOT_STARTED" }, { fulfillmentStatus: null }],
  },
  PARTIALLY_FULFILLED: { fulfillmentStatus: "IN_PROGRESS" },
  FULFILLED: { fulfillmentStatus: "FULFILLED" },
};

export interface WindowBounds {
  start: Date;
  end: Date;
}

/** Builds the Prisma `where` for a sync, combining the window and filters. */
export function buildOrderWhere(
  userId: string,
  window: WindowBounds,
  filter: FilterSettings,
): Prisma.ImportedOrderWhereInput {
  const and: Prisma.ImportedOrderWhereInput[] = [];

  // The filter's own bounds narrow the chosen range; they never widen it.
  const start =
    filter.dateFrom && filter.dateFrom > window.start
      ? filter.dateFrom
      : window.start;
  const end =
    filter.dateTo && filter.dateTo < window.end ? filter.dateTo : window.end;

  and.push({ orderDate: { gte: start, lte: end } });

  const orderConditions = filter.orderStates
    .map((token) => ORDER_STATE_CONDITIONS[token])
    .filter(Boolean);
  if (orderConditions.length > 0) and.push({ OR: orderConditions });

  const fulfillmentConditions = filter.fulfillmentStates
    .map((token) => FULFILLMENT_CONDITIONS[token])
    .filter(Boolean);
  if (fulfillmentConditions.length > 0) and.push({ OR: fulfillmentConditions });

  if (filter.marketplaces.length > 0) {
    and.push({ marketplaceId: { in: filter.marketplaces } });
  }

  return { userId, AND: and };
}

/* -------------------------------------------------------------------------- */
/* SKU filtering                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Does a single SKU pass the filter?
 *
 * A null SKU is treated as an empty string: an unlisted item should be
 * excluded by an INCLUDE filter and kept by an EXCLUDE one, which falls out
 * naturally from comparing against "".
 */
export function skuMatches(
  sku: string | null | undefined,
  filter: Pick<FilterSettings, "skuMode" | "skuValues" | "skuCaseSensitive">,
): boolean {
  if (filter.skuMode === "ALL" || filter.skuValues.length === 0) return true;

  const normalise = (value: string) =>
    filter.skuCaseSensitive ? value : value.toLowerCase();

  const candidate = normalise(sku ?? "");
  const values = filter.skuValues.map(normalise);

  switch (filter.skuMode) {
    case "INCLUDE":
      return values.includes(candidate);
    case "EXCLUDE":
      return !values.includes(candidate);
    case "CONTAINS":
      return values.some((value) => candidate.includes(value));
    case "STARTS_WITH":
      return values.some((value) => candidate.startsWith(value));
    case "ENDS_WITH":
      return values.some((value) => candidate.endsWith(value));
    default:
      return true;
  }
}

/**
 * Does an order pass the SKU filter?
 *
 * In one-row-per-order mode an order is kept when *any* of its line items
 * matches — excluding a whole multi-item order because one item is filtered
 * out would silently lose the rest. In one-row-per-line-item mode each row
 * is tested individually by the caller.
 *
 * EXCLUDE is the exception: there, an order is dropped only when *every*
 * line item is excluded, which is the same rule stated from the other side.
 */
export function orderMatchesSkuFilter(
  skus: (string | null | undefined)[],
  filter: Pick<FilterSettings, "skuMode" | "skuValues" | "skuCaseSensitive">,
): boolean {
  if (filter.skuMode === "ALL" || filter.skuValues.length === 0) return true;
  if (skus.length === 0) return skuMatches(null, filter);
  return skus.some((sku) => skuMatches(sku, filter));
}

/** Human-readable summary for the filters page and the sync preview. */
export function describeFilter(filter: FilterSettings): string[] {
  const parts: string[] = [];

  if (filter.orderStates.length > 0) {
    parts.push(`order state: ${filter.orderStates.join(" or ")}`);
  }
  if (filter.fulfillmentStates.length > 0) {
    parts.push(`fulfillment: ${filter.fulfillmentStates.join(" or ")}`);
  }
  if (filter.marketplaces.length > 0) {
    parts.push(`marketplace: ${filter.marketplaces.join(", ")}`);
  }
  if (filter.skuMode !== "ALL" && filter.skuValues.length > 0) {
    const verb = filter.skuMode.toLowerCase().replace(/_/g, " ");
    parts.push(`SKU ${verb}: ${filter.skuValues.slice(0, 5).join(", ")}${
      filter.skuValues.length > 5 ? "…" : ""
    }`);
  }
  if (filter.dateFrom) parts.push(`from ${filter.dateFrom.toISOString().slice(0, 10)}`);
  if (filter.dateTo) parts.push(`to ${filter.dateTo.toISOString().slice(0, 10)}`);

  return parts;
}
