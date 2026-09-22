/**
 * Order-level sync history and single-order retry.
 *
 * Runs the real engine against an isolated database with an in-memory fake
 * sheet, so what SyncOrderResult records is whatever actually happened to the
 * sheet — not a description of it written alongside.
 */

import assert from "node:assert/strict";
import { afterEach, before, beforeEach, describe, it } from "node:test";
import type { PrismaClient } from "@prisma/client";

import { encryptSecret } from "@/lib/crypto";
import { resetRateLimitState } from "@/lib/http/rate-limit";

import { setupTestDatabase } from "./helpers/test-db";

let prisma: PrismaClient;
let setGoogleTransport: typeof import("@/lib/google/client").setGoogleTransport;
let runSheetSync: typeof import("@/lib/sync/sheet-sync").runSheetSync;
let retryOrder: typeof import("@/lib/sync/sheet-sync").retryOrder;

let userId: string;
let sheetConfigId: string;

const HEADERS = ["Order Number", "Buyer", "Total"];
const SPREADSHEET_ID = "history-spreadsheet";

class FakeSheet {
  cells = new Map<number, Map<number, string>>();
  /** Fail this many write calls from now on (retries count individually). */
  failWriteCalls = 0;

  reset() {
    this.cells.clear();
    this.failWriteCalls = 0;
  }
  set(row: number, column: number, value: string) {
    if (!this.cells.has(row)) this.cells.set(row, new Map());
    this.cells.get(row)!.set(column, value);
  }
  get(row: number, column: number) {
    return this.cells.get(row)?.get(column);
  }
  column(index: number, fromRow: number): string[] {
    const maxRow = Math.max(0, ...this.cells.keys());
    const out: string[] = [];
    for (let row = fromRow; row <= maxRow; row += 1) {
      out.push(this.get(row, index) ?? "");
    }
    return out;
  }
  /** What a ROWS read returns: trailing empty rows omitted, as Sheets does. */
  rows(fromRow: number, throughColumn: number): string[][] {
    const maxRow = Math.max(0, ...this.cells.keys());
    const out: string[][] = [];
    for (let row = fromRow; row <= maxRow; row += 1) {
      const line: string[] = [];
      for (let col = 0; col <= throughColumn; col += 1) {
        line.push(this.get(row, col) ?? "");
      }
      out.push(line);
    }
    return out;
  }
}

const sheet = new FakeSheet();

function parseRange(range: string) {
  const bang = range.lastIndexOf("!");
  const cellPart = bang >= 0 ? range.slice(bang + 1) : range;
  const [from, to] = cellPart.split(":");
  const parse = (ref: string) => {
    const match = ref.match(/^([A-Z]+)(\d*)$/);
    if (!match) throw new Error(`unparseable ref ${ref}`);
    let column = 0;
    for (const char of match[1]) column = column * 26 + (char.charCodeAt(0) - 64);
    return { column: column - 1, row: match[2] === "" ? null : Number(match[2]) };
  };
  const start = parse(from);
  const end = to ? parse(to) : start;
  return { row: start.row ?? 1, firstColumn: start.column, lastColumn: end.column };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function fakeTransport(url: string, init: RequestInit): Promise<Response> {
  const parsed = new URL(url);
  const path = decodeURIComponent(parsed.pathname);

  if (path.endsWith("/values:batchUpdate")) {
    if (sheet.failWriteCalls > 0) {
      sheet.failWriteCalls -= 1;
      return json(
        {
          error: {
            message: "transient backend error",
            errors: [{ reason: "backendError" }],
          },
        },
        500,
      );
    }
    const body = JSON.parse(String(init.body)) as {
      data: { range: string; values: string[][] }[];
    };
    let cells = 0;
    for (const entry of body.data) {
      const { row, firstColumn } = parseRange(entry.range);
      entry.values[0]?.forEach((value, offset) => {
        sheet.set(row, firstColumn + offset, value);
        cells += 1;
      });
    }
    return json({ totalUpdatedCells: cells });
  }

  if (path.includes(":batchUpdate")) return json({ replies: [] });

  if (path.includes("/values/")) {
    const range = path.slice(path.indexOf("/values/") + "/values/".length);
    const { firstColumn, lastColumn, row } = parseRange(range);
    if (parsed.searchParams.get("majorDimension") === "COLUMNS") {
      return json({ values: [sheet.column(firstColumn, row)] });
    }
    if (row > 1) return json({ values: sheet.rows(row, lastColumn) });
    return json({ values: [HEADERS] });
  }

  if (path.includes("/v4/spreadsheets/")) {
    return json({
      spreadsheetId: SPREADSHEET_ID,
      properties: { title: "History Sheet" },
      sheets: [
        {
          properties: {
            sheetId: 0,
            title: "Orders",
            index: 0,
            sheetType: "GRID",
            gridProperties: { rowCount: 1000, columnCount: 26 },
          },
        },
      ],
    });
  }

  return json({});
}

const MAPPINGS = [
  { targetColumn: "Order Number", sourceField: "order.orderId" },
  { targetColumn: "Buyer", sourceField: "order.buyer.username" },
  { targetColumn: "Total", sourceField: "order.pricingSummary.total.value" },
];

function payloadFor(id: string, buyer: string, total: string) {
  return {
    orderId: id,
    creationDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    orderStatus: "ACTIVE",
    buyer: { username: buyer },
    pricingSummary: { total: { value: total, currency: "USD" } },
    lineItems: [
      { lineItemId: `${id}-1`, sku: "SKU-1", title: "Item", quantity: 1 },
    ],
  };
}

async function seedOrder(id: string, buyer = "a_buyer", total = "10.00") {
  const payload = payloadFor(id, buyer, total);
  return prisma.importedOrder.create({
    data: {
      userId,
      ebayOrderId: id,
      orderDate: new Date(payload.creationDate),
      source: "EBAY",
      syncState: "PENDING",
      orderStatus: "ACTIVE",
      buyerUsername: buyer,
      totalAmount: Number(total),
      currency: "USD",
      itemCount: 1,
      totalQuantity: 1,
      rawPayloadJson: JSON.stringify(payload),
      lineItems: {
        create: [
          {
            ebayLineItemId: `${id}-1`,
            sku: "SKU-1",
            title: "Item",
            quantity: 1,
          },
        ],
      },
    },
  });
}

async function resetWorkspace(options: { confirmed?: boolean } = {}) {
  await prisma.syncOrderResult.deleteMany({});
  await prisma.sheetRowLink.deleteMany({});
  await prisma.importedOrder.deleteMany({ where: { userId } });
  await prisma.syncJob.deleteMany({ where: { userId } });
  await prisma.fieldMapping.deleteMany({ where: { sheetConfigId } });

  await prisma.googleSheetConfig.update({
    where: { id: sheetConfigId },
    data: {
      rowMode: "ORDER",
      syncMode: "APPEND_UPDATE",
      matchColumn: "Order Number",
      lastSyncedThrough: null,
      bulkSyncConfirmedAt: options.confirmed === false ? null : new Date(),
    },
  });

  await prisma.fieldMapping.createMany({
    data: MAPPINGS.map((mapping, index) => ({
      sheetConfigId,
      targetColumn: mapping.targetColumn,
      sourceField: mapping.sourceField,
      transformation: "none",
      enabled: true,
      position: index,
    })),
  });

  sheet.reset();
}

before(async () => {
  setupTestDatabase("history");
  process.env.GOOGLE_CLIENT_ID = "test-google-client";
  process.env.GOOGLE_CLIENT_SECRET = "test-google-secret";
  process.env.GOOGLE_MIN_REQUEST_INTERVAL_MS = "0";

  ({ prisma } = await import("@/lib/db"));
  ({ setGoogleTransport } = await import("@/lib/google/client"));
  ({ runSheetSync, retryOrder } = await import("@/lib/sync/sheet-sync"));

  const user = await prisma.user.create({
    data: { email: "history@test.local", name: "History Tester" },
  });
  userId = user.id;

  const connection = await prisma.googleConnection.create({
    data: {
      userId,
      status: "CONNECTED",
      email: "seller@example.com",
      accessToken: encryptSecret("google-token"),
      refreshToken: encryptSecret("google-refresh"),
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      scopes:
        "openid email profile https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/spreadsheets",
      connectedAt: new Date(),
    },
  });

  const config = await prisma.googleSheetConfig.create({
    data: {
      userId,
      googleConnectionId: connection.id,
      spreadsheetId: SPREADSHEET_ID,
      spreadsheetName: "History Sheet",
      sheetName: "Orders",
      sheetGid: "0",
      headerRow: 1,
      firstDataRow: 2,
      gridRowCount: 1000,
      gridColumnCount: 26,
      columns: {
        create: HEADERS.map((header, index) => ({
          header,
          letter: String.fromCharCode(65 + index),
          position: index,
        })),
      },
    },
  });
  sheetConfigId = config.id;
});

beforeEach(() => {
  resetRateLimitState();
  setGoogleTransport(fakeTransport);
});

afterEach(() => {
  setGoogleTransport(null);
  resetRateLimitState();
});

const run = (options: Record<string, unknown> = {}) =>
  runSheetSync(userId, {
    skipImport: true,
    confirmed: true,
    range: "LAST_90D" as never,
    ...options,
  });

/* -------------------------------------------------------------------------- */

describe("order-level history", () => {
  it("records one row per order with the outcome and sheet row", async () => {
    await resetWorkspace();
    await seedOrder("ORD-1");
    await seedOrder("ORD-2");

    const result = await run();
    assert.equal(result.inserted, 2);

    const records = await prisma.syncOrderResult.findMany({
      where: { syncJobId: result.jobId },
      orderBy: { ebayOrderId: "asc" },
    });

    assert.equal(records.length, 2);
    for (const record of records) {
      assert.equal(record.outcome, "INSERTED");
      assert.equal(record.operation, "sheet.write");
      assert.equal(record.attempt, 1);
      assert.ok(record.rowNumber && record.rowNumber >= 2);
      assert.equal(record.reason, null);
    }
    assert.deepEqual(
      records.map((r) => r.ebayOrderId),
      ["ORD-1", "ORD-2"],
    );
  });

  it("distinguishes an update from an insert on the second run", async () => {
    await resetWorkspace();
    const order = await seedOrder("ORD-1", "buyer_one");
    await run();

    // Change a mapped value so the row is not skipped as unchanged.
    await prisma.importedOrder.update({
      where: { id: order.id },
      data: {
        buyerUsername: "buyer_two",
        rawPayloadJson: JSON.stringify(payloadFor("ORD-1", "buyer_two", "10.00")),
      },
    });

    const second = await run();
    const record = await prisma.syncOrderResult.findFirstOrThrow({
      where: { syncJobId: second.jobId },
    });
    assert.equal(record.outcome, "UPDATED");
    assert.equal(sheet.get(2, 1), "buyer_two");
  });

  it("records an unchanged row as skipped, with the reason", async () => {
    await resetWorkspace();
    await seedOrder("ORD-1");
    await run();

    const second = await run();
    const record = await prisma.syncOrderResult.findFirstOrThrow({
      where: { syncJobId: second.jobId },
    });
    assert.equal(record.outcome, "SKIPPED");
    assert.equal(record.operation, "dedupe");
    assert.ok(record.reason, "a skip must say why");
  });

  it("records a failed write with its error code, not just a count", async () => {
    await resetWorkspace();
    await seedOrder("ORD-1");

    // Exhaust the client's retries so the batch genuinely fails.
    sheet.failWriteCalls = 10;
    const result = await run();

    assert.equal(result.failed, 1);
    const record = await prisma.syncOrderResult.findFirstOrThrow({
      where: { syncJobId: result.jobId },
    });
    assert.equal(record.outcome, "FAILED");
    assert.equal(record.operation, "sheet.write");
    assert.equal(record.errorCode, "SERVER_ERROR");
    assert.ok(record.reason && record.reason.length > 0);
    assert.equal(record.resolvedAt, null);
  });

  it("links the order to the run that last touched it", async () => {
    await resetWorkspace();
    const order = await seedOrder("ORD-1");
    const result = await run();

    const stored = await prisma.importedOrder.findUniqueOrThrow({
      where: { id: order.id },
    });
    assert.equal(stored.lastSyncJobId, result.jobId);
    assert.equal(stored.syncState, "SYNCED");
    assert.ok(stored.lastSyncedAt);
  });
});

/* -------------------------------------------------------------------------- */

describe("retrying a single order", () => {
  it("writes the failed order without touching the others", async () => {
    await resetWorkspace();
    const failing = await seedOrder("ORD-FAIL");

    sheet.failWriteCalls = 10;
    const first = await run();
    assert.equal(first.failed, 1);
    assert.equal(sheet.get(2, 0), undefined, "nothing was written");

    // The transient failure clears.
    sheet.failWriteCalls = 0;
    const retry = await retryOrder(userId, failing.id);

    assert.equal(retry.ok, true, retry.message);
    assert.equal(retry.outcome, "INSERTED");
    assert.equal(sheet.get(2, 0), "ORD-FAIL");
  });

  it("plans only the retried order", async () => {
    await resetWorkspace();
    await seedOrder("ORD-A");
    const target = await seedOrder("ORD-B");
    await run();

    const retry = await retryOrder(userId, target.id);
    assert.equal(retry.ok, true, retry.message);

    const records = await prisma.syncOrderResult.findMany({
      where: { syncJobId: retry.jobId! },
    });
    assert.equal(records.length, 1, "a retry must not re-plan the whole sync");
    assert.equal(records[0].ebayOrderId, "ORD-B");
  });

  it("marks the earlier failure resolved instead of leaving it open", async () => {
    await resetWorkspace();
    const failing = await seedOrder("ORD-FAIL");

    sheet.failWriteCalls = 10;
    const first = await run();
    sheet.failWriteCalls = 0;
    await retryOrder(userId, failing.id);

    const original = await prisma.syncOrderResult.findFirstOrThrow({
      where: { syncJobId: first.jobId },
    });
    assert.equal(original.outcome, "FAILED", "the record of the failure stays");
    assert.ok(original.resolvedAt, "but it is marked resolved");
    assert.ok(original.resolvedByJobId);

    const open = await prisma.syncOrderResult.count({
      where: { outcome: "FAILED", resolvedAt: null },
    });
    assert.equal(open, 0);
  });

  it("counts the attempt so a repeated failure is visible as such", async () => {
    await resetWorkspace();
    const failing = await seedOrder("ORD-FAIL");

    sheet.failWriteCalls = 10;
    await run();
    sheet.failWriteCalls = 10;
    const retry = await retryOrder(userId, failing.id);

    assert.equal(retry.ok, false);
    const record = await prisma.syncOrderResult.findFirstOrThrow({
      where: { syncJobId: retry.jobId! },
    });
    assert.equal(record.attempt, 2);
    assert.equal(record.outcome, "FAILED");
  });

  it("records the retry as its own run, tagged RETRY", async () => {
    await resetWorkspace();
    const order = await seedOrder("ORD-1");
    await run();
    const retry = await retryOrder(userId, order.id);

    const job = await prisma.syncJob.findUniqueOrThrow({
      where: { id: retry.jobId! },
    });
    assert.equal(job.trigger, "RETRY");
  });

  it("does not move the incremental cursor", async () => {
    await resetWorkspace();
    const order = await seedOrder("ORD-1");
    await run();

    const before = await prisma.googleSheetConfig.findUniqueOrThrow({
      where: { id: sheetConfigId },
    });

    // Force a real write on the retry rather than an unchanged skip.
    await prisma.importedOrder.update({
      where: { id: order.id },
      data: {
        buyerUsername: "changed",
        rawPayloadJson: JSON.stringify(payloadFor("ORD-1", "changed", "10.00")),
      },
    });
    await retryOrder(userId, order.id);

    const after = await prisma.googleSheetConfig.findUniqueOrThrow({
      where: { id: sheetConfigId },
    });
    assert.deepEqual(
      after.lastSyncedThrough,
      before.lastSyncedThrough,
      "a one-order retry must not claim the whole window was synced",
    );
  });

  it("finds an order outside the current sync window", async () => {
    await resetWorkspace();
    const old = await prisma.importedOrder.create({
      data: {
        userId,
        ebayOrderId: "ORD-OLD",
        // Far outside LAST_90D.
        orderDate: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
        source: "EBAY",
        syncState: "FAILED",
        orderStatus: "ACTIVE",
        buyerUsername: "old_buyer",
        totalAmount: 5,
        currency: "USD",
        rawPayloadJson: JSON.stringify(payloadFor("ORD-OLD", "old_buyer", "5.00")),
      },
    });

    const retry = await retryOrder(userId, old.id);
    assert.equal(retry.ok, true, retry.message);
    assert.equal(sheet.get(2, 0), "ORD-OLD");
  });

  it("refuses an order from another workspace", async () => {
    await resetWorkspace();
    const other = await prisma.user.create({
      data: { email: `other-${Date.now()}@test.local` },
    });
    const foreign = await prisma.importedOrder.create({
      data: {
        userId: other.id,
        ebayOrderId: "ORD-FOREIGN",
        orderDate: new Date(),
        orderStatus: "ACTIVE",
      },
    });

    const retry = await retryOrder(userId, foreign.id);
    assert.equal(retry.ok, false);
    assert.equal(retry.code, "ORDER_NOT_FOUND");
  });

  it("refuses to be the first write into an unconfirmed destination", async () => {
    await resetWorkspace({ confirmed: false });
    const order = await seedOrder("ORD-1");

    const retry = await retryOrder(userId, order.id);
    assert.equal(retry.ok, false);
    assert.equal(retry.code, "CONFIRMATION_REQUIRED");
    assert.equal(sheet.get(2, 0), undefined, "nothing may be written");
  });
});
