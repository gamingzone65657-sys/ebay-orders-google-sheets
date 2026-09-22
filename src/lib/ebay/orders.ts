/**
 * Order retrieval from the Sell Fulfillment API, with real pagination.
 *
 * `getOrders` returns at most 200 orders per call and reports a `total`, so a
 * seller with 1,800 orders in the window needs 9 calls. This walks every page
 * — stopping only on an explicit guard — rather than returning the first one.
 */

import type { EbayConnection } from "@prisma/client";

import { ebayRequest } from "./client";
import { EBAY_ERROR_CODES, EbayApiError } from "./errors";
import {
  normalizeFulfillment,
  normalizeOrder,
  type NormalizedFulfillment,
  type NormalizedOrder,
} from "./normalize";
import type {
  EbayGetFulfillmentsResponse,
  EbayGetOrdersResponse,
} from "./types";

/** eBay's documented maximum for getOrders. */
export const MAX_PAGE_SIZE = 200;
/** Stops a runaway loop if eBay's `total` and page contents disagree. */
const DEFAULT_MAX_PAGES = 50;

export interface FetchOrdersOptions {
  /** Lower bound on creationdate. */
  createdFrom?: Date;
  /** Upper bound on creationdate. Defaults to now. */
  createdTo?: Date;
  /**
   * Use lastmodifieddate instead of creationdate. Incremental imports want
   * this so an older order that just shipped is picked up again.
   */
  useModifiedDate?: boolean;
  pageSize?: number;
  maxPages?: number;
  /** Hard cap on orders retrieved, for a first-run safety valve. */
  maxOrders?: number;
  onPage?: (info: {
    page: number;
    offset: number;
    received: number;
    total: number | null;
    attempts: number;
  }) => void;
  signal?: AbortSignal;
}

export interface FetchOrdersResult {
  orders: NormalizedOrder[];
  /** eBay's reported total for the filter, when it provided one. */
  reportedTotal: number | null;
  pages: number;
  apiCalls: number;
  /** True when a guard stopped the walk before eBay ran out of pages. */
  truncated: boolean;
  /** Orders eBay returned that could not be normalized (no order id). */
  unusable: number;
}

function toEbayTimestamp(date: Date): string {
  // eBay wants ISO-8601 with milliseconds and a Z suffix.
  return date.toISOString();
}

/**
 * eBay's filter grammar: `field:[from..to]`, comma-separated.
 * An open-ended upper bound is written as `[from..]`.
 */
export function buildOrdersFilter(options: FetchOrdersOptions): string | undefined {
  const field = options.useModifiedDate ? "lastmodifieddate" : "creationdate";
  const from = options.createdFrom;
  const to = options.createdTo;

  if (!from && !to) return undefined;
  if (from && to) {
    return `${field}:[${toEbayTimestamp(from)}..${toEbayTimestamp(to)}]`;
  }
  if (from) return `${field}:[${toEbayTimestamp(from)}..]`;
  return `${field}:[..${toEbayTimestamp(to!)}]`;
}

export async function fetchOrders(
  connection: EbayConnection,
  options: FetchOrdersOptions = {},
): Promise<FetchOrdersResult> {
  const pageSize = Math.min(
    Math.max(1, options.pageSize ?? MAX_PAGE_SIZE),
    MAX_PAGE_SIZE,
  );
  const maxPages = Math.max(1, options.maxPages ?? DEFAULT_MAX_PAGES);
  const filter = buildOrdersFilter(options);

  const collected: NormalizedOrder[] = [];
  const seen = new Set<string>();

  let offset = 0;
  let page = 0;
  let apiCalls = 0;
  let reportedTotal: number | null = null;
  let truncated = false;
  let unusable = 0;

  while (page < maxPages) {
    const response = await ebayRequest<EbayGetOrdersResponse>(connection, {
      path: "/sell/fulfillment/v1/order",
      query: { limit: pageSize, offset, filter },
      marketplaceId: connection.marketplaceId,
      signal: options.signal,
    });

    apiCalls += response.attempts;
    page += 1;

    const body = response.data;
    if (body === null || typeof body !== "object") {
      throw new EbayApiError(
        EBAY_ERROR_CODES.INVALID_RESPONSE,
        "eBay returned an order page that was not an object.",
      );
    }

    const orders = Array.isArray(body.orders) ? body.orders : [];
    if (typeof body.total === "number" && Number.isFinite(body.total)) {
      reportedTotal = body.total;
    }

    for (const raw of orders) {
      const normalized = normalizeOrder(raw ?? {}, connection.marketplaceId);
      if (!normalized) {
        unusable += 1;
        continue;
      }
      // eBay can repeat an order across pages if data shifts mid-walk.
      if (seen.has(normalized.ebayOrderId)) continue;
      seen.add(normalized.ebayOrderId);
      collected.push(normalized);
    }

    options.onPage?.({
      page,
      offset,
      received: orders.length,
      total: reportedTotal,
      attempts: response.attempts,
    });

    if (options.maxOrders && collected.length >= options.maxOrders) {
      truncated = collected.length > options.maxOrders;
      collected.length = Math.min(collected.length, options.maxOrders);
      break;
    }

    // Stop conditions: a short page means we reached the end; `total` gives
    // an explicit bound when eBay supplies it.
    if (orders.length === 0 || orders.length < pageSize) break;

    offset += pageSize;
    if (reportedTotal !== null && offset >= reportedTotal) break;

    if (page >= maxPages) {
      truncated = true;
      break;
    }
  }

  return {
    orders: collected,
    reportedTotal,
    pages: page,
    apiCalls,
    truncated,
    unusable,
  };
}

/**
 * Shipment records for one order, which is the only place tracking numbers
 * appear. Costs one API call per order, so callers budget these.
 */
export async function fetchOrderFulfillments(
  connection: EbayConnection,
  ebayOrderId: string,
  signal?: AbortSignal,
): Promise<{ fulfillments: NormalizedFulfillment[]; apiCalls: number }> {
  const response = await ebayRequest<EbayGetFulfillmentsResponse>(connection, {
    path: `/sell/fulfillment/v1/order/${encodeURIComponent(
      ebayOrderId,
    )}/shipping_fulfillment`,
    marketplaceId: connection.marketplaceId,
    signal,
  });

  const raw = Array.isArray(response.data?.fulfillments)
    ? response.data.fulfillments
    : [];

  return {
    fulfillments: raw.map((entry) => normalizeFulfillment(entry ?? {})),
    apiCalls: response.attempts,
  };
}

/**
 * Cheapest possible authenticated call, used by "Test connection". A single
 * order page with limit=1 verifies credentials, token, and scope together.
 */
export async function pingOrdersApi(
  connection: EbayConnection,
): Promise<{ reachable: true; reportedTotal: number | null }> {
  const response = await ebayRequest<EbayGetOrdersResponse>(connection, {
    path: "/sell/fulfillment/v1/order",
    query: { limit: 1 },
    marketplaceId: connection.marketplaceId,
  });
  return {
    reachable: true,
    reportedTotal:
      typeof response.data?.total === "number" ? response.data.total : null,
  };
}
