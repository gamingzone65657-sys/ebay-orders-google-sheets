/**
 * Retention for stored buyer data.
 *
 * The application keeps two things it does not need forever:
 *
 *  - `ImportedOrder.rawPayloadJson`, the verbatim eBay payload. It exists so a
 *    mapping added later can be re-applied to orders already imported, which
 *    is only useful while an order is recent. It is also the single largest
 *    concentration of buyer personal data in the database — full name, email,
 *    phone and address, for every order ever seen.
 *
 *  - Old `SyncLog` and `SyncOrderResult` rows, which are diagnostic and lose
 *    their value once nobody is investigating that run.
 *
 * Clearing the payload leaves the order itself intact: the denormalised
 * columns a sync actually writes are untouched, so history, totals and the
 * sheet rows all keep working. What is lost is the ability to re-map an old
 * order against a *new* field, which is the trade this is making explicit.
 *
 * Off by default — deleting a seller's data because a default said so would
 * be worse than keeping it. An operator opts in with RAW_PAYLOAD_RETENTION_DAYS.
 */

import { prisma } from "./db";
import { logInfo } from "./log";

function positiveDays(value: string | undefined): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

export interface RetentionSettings {
  /** Days to keep the verbatim eBay payload. null = keep indefinitely. */
  rawPayloadDays: number | null;
  /** Days to keep run logs and per-order results. null = keep indefinitely. */
  historyDays: number | null;
}

export function retentionSettings(): RetentionSettings {
  return {
    rawPayloadDays: positiveDays(process.env.RAW_PAYLOAD_RETENTION_DAYS),
    historyDays: positiveDays(process.env.SYNC_HISTORY_RETENTION_DAYS),
  };
}

export interface RetentionResult {
  payloadsCleared: number;
  logsDeleted: number;
  orderResultsDeleted: number;
}

/**
 * Applies the configured retention. Safe to call repeatedly; each pass only
 * touches rows that have aged past the threshold.
 */
export async function applyRetention(
  now: Date = new Date(),
  settings: RetentionSettings = retentionSettings(),
): Promise<RetentionResult> {
  const result: RetentionResult = {
    payloadsCleared: 0,
    logsDeleted: 0,
    orderResultsDeleted: 0,
  };

  if (settings.rawPayloadDays !== null) {
    const cutoff = new Date(
      now.getTime() - settings.rawPayloadDays * 24 * 60 * 60 * 1000,
    );
    // Only rows that still hold a payload, so the count means "cleared now".
    const cleared = await prisma.importedOrder.updateMany({
      where: { orderDate: { lt: cutoff }, rawPayloadJson: { not: null } },
      data: { rawPayloadJson: null },
    });
    result.payloadsCleared = cleared.count;

    const clearedItems = await prisma.orderLineItem.updateMany({
      where: {
        rawPayloadJson: { not: null },
        order: { orderDate: { lt: cutoff } },
      },
      data: { rawPayloadJson: null },
    });
    result.payloadsCleared += clearedItems.count;

    await prisma.orderFulfillment.updateMany({
      where: {
        rawPayloadJson: { not: null },
        order: { orderDate: { lt: cutoff } },
      },
      data: { rawPayloadJson: null },
    });
  }

  if (settings.historyDays !== null) {
    const cutoff = new Date(
      now.getTime() - settings.historyDays * 24 * 60 * 60 * 1000,
    );
    const logs = await prisma.syncLog.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    result.logsDeleted = logs.count;

    const results = await prisma.syncOrderResult.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    result.orderResultsDeleted = results.count;
  }

  if (
    result.payloadsCleared > 0 ||
    result.logsDeleted > 0 ||
    result.orderResultsDeleted > 0
  ) {
    logInfo(
      "retention",
      `Cleared ${result.payloadsCleared} raw payload(s), deleted ${result.logsDeleted} log(s) and ${result.orderResultsDeleted} order result(s).`,
    );
  }

  return result;
}
