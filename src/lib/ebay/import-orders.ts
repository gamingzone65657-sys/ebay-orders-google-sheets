/**
 * Imports eBay orders into the local database.
 *
 * This is the whole Phase 2 pipeline: connection check → paginated fetch →
 * normalize → upsert → optional shipment lookup → job record with per-step
 * logs. It writes nothing to Google; Phase 3 consumes what lands here.
 */

import type { EbayConnection } from "@prisma/client";

import {
  CONNECTION_STATUS,
  ORDER_SYNC_STATE,
  SYNC_JOB_STATUS,
  SYNC_TRIGGERS,
  type SyncTrigger,
} from "@/lib/constants";
import { prisma } from "@/lib/db";
import { toJsonColumn } from "@/lib/json";

import { EBAY_ERROR_CODES, EbayApiError, describeEbayError } from "./errors";
import { fetchOrderFulfillments, fetchOrders } from "./orders";
import type { NormalizedOrder } from "./normalize";
import { getActiveEbayConnection } from "./tokens";

/** Per-run budget for the one-call-per-order shipment lookup. */
const DEFAULT_FULFILLMENT_BUDGET = Number(
  process.env.EBAY_FULFILLMENT_CALL_BUDGET ?? 120,
);

export interface ImportOptions {
  trigger?: SyncTrigger;
  /** Window size when createdFrom is not given explicitly. */
  lookbackDays?: number;
  createdFrom?: Date;
  createdTo?: Date;
  /** Filter on lastmodifieddate so re-shipped older orders are refreshed. */
  useModifiedDate?: boolean;
  /** Fetch tracking numbers. One extra API call per shipped order. */
  includeFulfillments?: boolean;
  maxOrders?: number;
  maxPages?: number;
}

export interface ImportResult {
  jobId: string;
  status: string;
  fetched: number;
  imported: number;
  updated: number;
  skipped: number;
  errors: number;
  pages: number;
  apiCalls: number;
  truncated: boolean;
  reportedTotal: number | null;
  summary: string;
  errorCode?: string;
  errorMessage?: string;
}

interface LogEntry {
  level: string;
  step: string;
  message: string;
  context?: unknown;
}

function windowStart(options: ImportOptions): Date {
  if (options.createdFrom) return options.createdFrom;
  const days = Math.max(1, options.lookbackDays ?? 30);
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/** Maps one normalized order onto the ImportedOrder columns. */
function toOrderColumns(order: NormalizedOrder, connectionId: string) {
  return {
    source: "EBAY",
    ebayConnectionId: connectionId,
    legacyOrderId: order.legacyOrderId,
    salesRecordRef: order.salesRecordRef,
    marketplaceId: order.marketplaceId,
    orderDate: order.orderDate,
    lastModified: order.lastModified,
    buyerUsername: order.buyerUsername,
    buyerName: order.buyerName,
    buyerEmail: order.buyerEmail,
    buyerPhone: order.buyerPhone,
    itemCount: order.itemCount,
    totalQuantity: order.totalQuantity,
    totalAmount: order.totalAmount,
    currency: order.currency,
    subtotalAmount: order.subtotalAmount,
    shippingCost: order.shippingCost,
    taxAmount: order.taxAmount,
    discountAmount: order.discountAmount,
    orderStatus: order.orderStatus,
    paymentStatus: order.paymentStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    cancelStatus: order.cancelStatus,
    paymentMethods: order.paymentMethods,
    shippingServiceCode: order.shippingServiceCode,
    shipByDate: order.shipByDate,
    minDeliveryDate: order.minDeliveryDate,
    maxDeliveryDate: order.maxDeliveryDate,
    shipToName: order.shipToName,
    shipToLine1: order.shipToLine1,
    shipToLine2: order.shipToLine2,
    shipToCity: order.shipToCity,
    shipToState: order.shipToState,
    shipToCountry: order.shipToCountry,
    shipToPostal: order.shipToPostal,
    shipToPhone: order.shipToPhone,
    rawPayloadJson: toJsonColumn(order.rawPayload),
  };
}

function toLineItemRows(order: NormalizedOrder) {
  return order.lineItems.map((item) => ({
    ebayLineItemId: item.ebayLineItemId,
    legacyItemId: item.legacyItemId,
    sku: item.sku,
    title: item.title,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    currency: item.currency,
    variation: item.variation,
    lineItemTotal: item.lineItemTotal,
    taxAmount: item.taxAmount,
    deliveryCost: item.deliveryCost,
    discountAmount: item.discountAmount,
    fulfillmentStatus: item.fulfillmentStatus,
    listingMarketplaceId: item.listingMarketplaceId,
    soldFormat: item.soldFormat,
    rawPayloadJson: toJsonColumn(item.rawPayload),
  }));
}

/**
 * Persists one order. Line items are replaced wholesale because eBay can
 * cancel or merge them, and reconciling in place would be more code for no
 * behavioural gain at these volumes.
 */
async function upsertOrder(
  userId: string,
  connectionId: string,
  order: NormalizedOrder,
): Promise<"imported" | "updated"> {
  const columns = toOrderColumns(order, connectionId);
  const lineItems = toLineItemRows(order);

  const existing = await prisma.importedOrder.findUnique({
    where: { userId_ebayOrderId: { userId, ebayOrderId: order.ebayOrderId } },
    select: { id: true },
  });

  if (!existing) {
    await prisma.importedOrder.create({
      data: {
        ...columns,
        userId,
        ebayOrderId: order.ebayOrderId,
        // Imported, not yet written to a sheet — Phase 3 flips this.
        syncState: ORDER_SYNC_STATE.PENDING,
        lineItems: { create: lineItems },
      },
    });
    return "imported";
  }

  await prisma.$transaction([
    prisma.orderLineItem.deleteMany({ where: { orderId: existing.id } }),
    prisma.importedOrder.update({
      where: { id: existing.id },
      data: {
        ...columns,
        lineItems: { create: lineItems },
      },
    }),
  ]);
  return "updated";
}

async function syncFulfillments(
  connection: EbayConnection,
  userId: string,
  order: NormalizedOrder,
): Promise<number> {
  const { fulfillments, apiCalls } = await fetchOrderFulfillments(
    connection,
    order.ebayOrderId,
  );

  const record = await prisma.importedOrder.findUnique({
    where: { userId_ebayOrderId: { userId, ebayOrderId: order.ebayOrderId } },
    select: { id: true },
  });
  if (!record) return apiCalls;

  for (const fulfillment of fulfillments) {
    const key = fulfillment.ebayFulfillmentId;
    const data = {
      trackingNumber: fulfillment.trackingNumber,
      shippingCarrierCode: fulfillment.shippingCarrierCode,
      shippingServiceCode: fulfillment.shippingServiceCode,
      shippedDate: fulfillment.shippedDate,
      rawPayloadJson: toJsonColumn(fulfillment.rawPayload),
    };

    if (key) {
      await prisma.orderFulfillment.upsert({
        where: {
          orderId_ebayFulfillmentId: {
            orderId: record.id,
            ebayFulfillmentId: key,
          },
        },
        create: { orderId: record.id, ebayFulfillmentId: key, ...data },
        update: data,
      });
    } else if (fulfillment.trackingNumber) {
      // No id to key on; avoid duplicating the same tracking number.
      const duplicate = await prisma.orderFulfillment.findFirst({
        where: {
          orderId: record.id,
          trackingNumber: fulfillment.trackingNumber,
        },
        select: { id: true },
      });
      if (duplicate) {
        await prisma.orderFulfillment.update({
          where: { id: duplicate.id },
          data,
        });
      } else {
        await prisma.orderFulfillment.create({
          data: { orderId: record.id, ebayFulfillmentId: null, ...data },
        });
      }
    }
  }

  // Mirror the first shipment onto the order for list rendering.
  const primary = fulfillments.find((entry) => entry.trackingNumber);
  if (primary) {
    await prisma.importedOrder.update({
      where: { id: record.id },
      data: {
        trackingNumber: primary.trackingNumber,
        shippingCarrier: primary.shippingCarrierCode,
        shippedAt: primary.shippedDate,
      },
    });
  }

  return apiCalls;
}

export async function importOrders(
  userId: string,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const trigger = options.trigger ?? SYNC_TRIGGERS.MANUAL;
  const startedAt = new Date();
  const logs: LogEntry[] = [];
  const log = (
    level: LogEntry["level"],
    step: string,
    message: string,
    context?: unknown,
  ) => logs.push({ level, step, message, context });

  const connection = await getActiveEbayConnection(userId);

  const job = await prisma.syncJob.create({
    data: {
      userId,
      kind: "IMPORT",
      trigger,
      status: SYNC_JOB_STATUS.RUNNING,
      ebayConnectionId: connection?.id ?? null,
      startedAt,
    },
  });

  let pages = 0;
  let apiCalls = 0;
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;

  const finish = async (
    status: string,
    summary: string,
    extra: {
      fetched?: number;
      truncated?: boolean;
      reportedTotal?: number | null;
      errorCode?: string;
      errorMessage?: string;
      windowStart?: Date;
      windowEnd?: Date;
    } = {},
  ): Promise<ImportResult> => {
    const finishedAt = new Date();
    await prisma.syncJob.update({
      where: { id: job.id },
      data: {
        status,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        ordersFetched: extra.fetched ?? 0,
        ordersImported: imported,
        ordersUpdated: updated,
        ordersSkipped: skipped,
        errorCount: errors,
        pagesFetched: pages,
        apiCallCount: apiCalls,
        windowStart: extra.windowStart ?? null,
        windowEnd: extra.windowEnd ?? null,
        summary,
        errorMessage: extra.errorMessage ?? null,
      },
    });

    if (logs.length > 0) {
      await prisma.syncLog.createMany({
        data: logs.map((entry) => ({
          syncJobId: job.id,
          level: entry.level,
          step: entry.step,
          message: entry.message,
          contextJson: toJsonColumn(entry.context ?? null),
        })),
      });
    }

    return {
      jobId: job.id,
      status,
      fetched: extra.fetched ?? 0,
      imported,
      updated,
      skipped,
      errors,
      pages,
      apiCalls,
      truncated: extra.truncated ?? false,
      reportedTotal: extra.reportedTotal ?? null,
      summary,
      errorCode: extra.errorCode,
      errorMessage: extra.errorMessage,
    };
  };

  // --- Preflight -----------------------------------------------------------
  if (!connection || connection.status === CONNECTION_STATUS.DISCONNECTED) {
    errors = 1;
    log("ERROR", "preflight", "No eBay account is connected.");
    return finish(SYNC_JOB_STATUS.FAILED, "Blocked: eBay is not connected.", {
      errorCode: EBAY_ERROR_CODES.NOT_CONNECTED,
      errorMessage: "No eBay account is connected.",
    });
  }


  const from = windowStart(options);
  const to = options.createdTo ?? new Date();
  const includeFulfillments = options.includeFulfillments ?? true;

  log(
    "INFO",
    "preflight",
    `Import started (${trigger.toLowerCase()} trigger) against ${connection.environment}.`,
    {
      window: { from: from.toISOString(), to: to.toISOString() },
      dateField: options.useModifiedDate ? "lastmodifieddate" : "creationdate",
      marketplaceId: connection.marketplaceId,
    },
  );

  // --- Fetch ---------------------------------------------------------------
  let fetchResult;
  try {
    fetchResult = await fetchOrders(connection, {
      createdFrom: from,
      createdTo: to,
      useModifiedDate: options.useModifiedDate,
      maxOrders: options.maxOrders,
      maxPages: options.maxPages,
      onPage: (info) => {
        pages = info.page;
        log(
          "DEBUG",
          "fetch.page",
          `Page ${info.page}: ${info.received} order(s) at offset ${info.offset}` +
            (info.total !== null ? ` of ${info.total} reported` : ""),
          { attempts: info.attempts },
        );
      },
    });
  } catch (error) {
    const described = describeEbayError(error);
    errors = 1;
    log("ERROR", "fetch.orders", described.message, {
      code: described.code,
      detail: described.detail,
      retryAfterSeconds: described.retryAfterSeconds,
    });
    return finish(SYNC_JOB_STATUS.FAILED, `Blocked: ${described.message}`, {
      errorCode: described.code,
      errorMessage: described.detail ?? described.message,
      windowStart: from,
      windowEnd: to,
    });
  }

  apiCalls += fetchResult.apiCalls;
  pages = fetchResult.pages;

  log(
    "INFO",
    "fetch.orders",
    `Fetched ${fetchResult.orders.length} order(s) across ${fetchResult.pages} page(s)` +
      (fetchResult.reportedTotal !== null
        ? `; eBay reported ${fetchResult.reportedTotal} in this window`
        : ""),
    { apiCalls: fetchResult.apiCalls, truncated: fetchResult.truncated },
  );

  if (fetchResult.unusable > 0) {
    log(
      "WARN",
      "normalize",
      `${fetchResult.unusable} order(s) were returned without an order id and could not be stored.`,
    );
    skipped += fetchResult.unusable;
  }

  if (fetchResult.truncated) {
    log(
      "WARN",
      "fetch.orders",
      "The page or order guard stopped the walk before eBay ran out of results. Narrow the date window or raise the limit to import the rest.",
    );
  }

  // --- Persist -------------------------------------------------------------
  const shippedOrders: NormalizedOrder[] = [];

  for (const order of fetchResult.orders) {
    try {
      const outcome = await upsertOrder(userId, connection.id, order);
      if (outcome === "imported") imported += 1;
      else updated += 1;

      const status = order.fulfillmentStatus?.toUpperCase();
      if (status === "FULFILLED" || status === "IN_PROGRESS") {
        shippedOrders.push(order);
      }
    } catch (error) {
      errors += 1;
      log("ERROR", "persist", `Failed to store order ${order.ebayOrderId}.`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  log(
    "INFO",
    "persist",
    `Stored ${imported} new and ${updated} updated order(s).`,
  );

  // --- Shipments -----------------------------------------------------------
  if (includeFulfillments && shippedOrders.length > 0) {
    const budget = Math.min(shippedOrders.length, DEFAULT_FULFILLMENT_BUDGET);
    let done = 0;

    for (const order of shippedOrders.slice(0, budget)) {
      try {
        apiCalls += await syncFulfillments(connection, userId, order);
        done += 1;
      } catch (error) {
        errors += 1;
        const described = describeEbayError(error);
        log(
          "WARN",
          "fetch.fulfillments",
          `Could not read shipments for ${order.ebayOrderId}: ${described.message}`,
          { code: described.code },
        );
        // A rate limit will hit every subsequent order too — stop early.
        if (
          error instanceof EbayApiError &&
          error.code === EBAY_ERROR_CODES.RATE_LIMITED
        ) {
          log(
            "WARN",
            "fetch.fulfillments",
            "Stopping shipment lookups for this run because eBay is rate limiting.",
          );
          break;
        }
      }
    }

    log(
      "INFO",
      "fetch.fulfillments",
      `Read shipments for ${done} of ${shippedOrders.length} shipped order(s).` +
        (shippedOrders.length > budget
          ? ` ${shippedOrders.length - budget} deferred to the next run to stay within the API budget.`
          : ""),
    );
  }

  await prisma.ebayConnection.update({
    where: { id: connection.id },
    data: { lastCheckedAt: new Date() },
  });

  const status =
    errors > 0 ? SYNC_JOB_STATUS.PARTIAL : SYNC_JOB_STATUS.SUCCESS;
  const summary = `${imported} imported, ${updated} updated, ${skipped} skipped, ${errors} error(s) across ${pages} page(s).`;
  log("INFO", "complete", `Import finished. ${summary}`);

  return finish(status, summary, {
    fetched: fetchResult.orders.length,
    truncated: fetchResult.truncated,
    reportedTotal: fetchResult.reportedTotal,
    windowStart: from,
    windowEnd: to,
  });
}
