/**
 * Failure-mode tests for the production review.
 *
 * Each one drives the real engine into a specific broken state and asserts
 * the two properties that matter most: no order is silently lost, and no run
 * appends a duplicate or writes over a row it did not own.
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
let previewSync: typeof import("@/lib/sync/sheet-sync").previewSync;

let userId: string;
let sheetConfigId: string;
let googleConnectionId: string;

// "Notes" (index 4) is deliberately never mapped: it is how a row that holds
// a human's scribble is distinguished from a row that holds order data.
const HEADERS = ["Order Number", "Buyer", "SKU", "Tracking", "Notes"];
const SPREADSHEET_ID = "reliability-spreadsheet";

class FakeSheet {
  cells = new Map<number, Map<number, string>>();
  writeCalls = 0;
  failWriteCalls = 0;
  /** Throw a connection-level error instead of returning a response. */
  networkDown = false;

  reset() {
    this.cells.clear();
    this.writeCalls = 0;
    this.failWriteCalls = 0;
    this.networkDown = false;
  }
  set(row: number, column: number, value: string) {
    if (!this.cells.has(row)) this.cells.set(row, new Map());
    this.cells.get(row)!.set(column, value);
  }
  get(row: number, column: number) {
    return this.cells.get(row)?.get(column);
  }
  /** Values of one column from `fromRow` to the last populated row. */
  column(index: number, fromRow: number): string[] {
    const maxRow = Math.max(0, ...this.cells.keys());
    const out: string[] = [];
    for (let row = fromRow; row <= maxRow; row += 1) {
      out.push(this.get(row, index) ?? "");
    }
    return out;
  }
  /** Rows as the Sheets API returns them, trailing blanks omitted. */
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
  populatedRows(): number[] {
    return [...this.cells.keys()].sort((a, b) => a - b);
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
  if (sheet.networkDown) {
    throw new TypeError("fetch failed");
  }

  const parsed = new URL(url);
  const path = decodeURIComponent(parsed.pathname);

  if (path.endsWith("/values:batchUpdate")) {
    sheet.writeCalls += 1;
    if (sheet.failWriteCalls > 0) {
      sheet.failWriteCalls -= 1;
      return json(
        { error: { message: "backend error", errors: [{ reason: "backendError" }] } },
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
    // The used-range probe reads A{firstDataRow}:{lastLetter} as ROWS.
    if (row > 1) {
      return json({ values: sheet.rows(row, lastColumn) });
    }
    return json({ values: [HEADERS] });
  }

  if (path.includes("/v4/spreadsheets/")) {
    return json({
      spreadsheetId: SPREADSHEET_ID,
      properties: { title: "Reliability Sheet" },
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
  { targetColumn: "SKU", sourceField: "lineItem.sku" },
  {
    targetColumn: "Tracking",
    sourceField: "order.fulfillment.trackingNumber",
    fallbackValue: "Not shipped",
  },
];

interface OrderShape {
  id: string;
  buyer?: string | null;
  sku?: string | null;
  tracking?: string | null;
  lineItems?: number;
}

function payloadFor(o: OrderShape) {
  const count = o.lineItems ?? 1;
  return {
    orderId: o.id,
    creationDate: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    orderStatus: "ACTIVE",
    ...(o.buyer === null ? {} : { buyer: { username: o.buyer ?? "a_buyer" } }),
    pricingSummary: { total: { value: "10.00", currency: "USD" } },
    lineItems: Array.from({ length: count }, (_, i) => ({
      lineItemId: `${o.id}-${i + 1}`,
      ...(o.sku === null ? {} : { sku: o.sku ?? `SKU-${i + 1}` }),
      title: "Item",
      quantity: 1,
    })),
    ...(o.tracking
      ? {
          fulfillmentStartInstructions: [],
          trackingNumber: o.tracking,
        }
      : {}),
  };
}

async function seedOrder(o: OrderShape) {
  const payload = payloadFor(o);
  const count = o.lineItems ?? 1;
  return prisma.importedOrder.create({
    data: {
      userId,
      ebayOrderId: o.id,
      orderDate: new Date(payload.creationDate),
      source: "EBAY",
      syncState: "PENDING",
      orderStatus: "ACTIVE",
      buyerUsername: o.buyer === null ? null : (o.buyer ?? "a_buyer"),
      buyerName: o.buyer === null ? null : "A Buyer",
      totalAmount: 10,
      currency: "USD",
      itemCount: count,
      totalQuantity: count,
      trackingNumber: o.tracking ?? null,
      rawPayloadJson: JSON.stringify(payload),
      lineItems: {
        create: Array.from({ length: count }, (_, i) => ({
          ebayLineItemId: `${o.id}-${i + 1}`,
          sku: o.sku === null ? null : (o.sku ?? `SKU-${i + 1}`),
          title: "Item",
          quantity: 1,
        })),
      },
    },
  });
}

async function resetWorkspace(
  options: { rowMode?: string; matchColumn?: string } = {},
) {
  await prisma.syncOrderResult.deleteMany({});
  await prisma.sheetRowLink.deleteMany({});
  await prisma.importedOrder.deleteMany({ where: { userId } });
  await prisma.syncJob.deleteMany({ where: { userId } });
  await prisma.fieldMapping.deleteMany({ where: { sheetConfigId } });

  await prisma.googleConnection.update({
    where: { id: googleConnectionId },
    data: {
      status: "CONNECTED",
      accessToken: encryptSecret("google-token"),
      refreshToken: encryptSecret("google-refresh"),
      tokenExpiresAt: new Date(Date.now() + 3_600_000),
    },
  });

  await prisma.googleSheetConfig.update({
    where: { id: sheetConfigId },
    data: {
      rowMode: options.rowMode ?? "ORDER",
      syncMode: "APPEND_UPDATE",
      matchColumn: options.matchColumn ?? "Order Number",
      lastSyncedThrough: null,
      bulkSyncConfirmedAt: new Date(),
    },
  });

  await prisma.fieldMapping.createMany({
    data: MAPPINGS.map((mapping, index) => ({
      sheetConfigId,
      targetColumn: mapping.targetColumn,
      sourceField: mapping.sourceField,
      transformation: "none",
      fallbackValue: mapping.fallbackValue ?? null,
      enabled: true,
      position: index,
    })),
  });

  sheet.reset();
}

before(async () => {
  setupTestDatabase("reliability");
  process.env.GOOGLE_CLIENT_ID = "test-google-client";
  process.env.GOOGLE_CLIENT_SECRET = "test-google-secret";
  process.env.GOOGLE_MIN_REQUEST_INTERVAL_MS = "0";

  ({ prisma } = await import("@/lib/db"));
  ({ setGoogleTransport } = await import("@/lib/google/client"));
  ({ runSheetSync, previewSync } = await import("@/lib/sync/sheet-sync"));

  const user = await prisma.user.create({
    data: { email: "reliability@test.local", name: "Reliability" },
  });
  userId = user.id;

  const connection = await prisma.googleConnection.create({
    data: {
      userId,
      status: "CONNECTED",
      email: "seller@example.com",
      accessToken: encryptSecret("google-token"),
      refreshToken: encryptSecret("google-refresh"),
      tokenExpiresAt: new Date(Date.now() + 3_600_000),
      scopes:
        "openid email profile https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/spreadsheets",
      connectedAt: new Date(),
    },
  });
  googleConnectionId = connection.id;

  const config = await prisma.googleSheetConfig.create({
    data: {
      userId,
      googleConnectionId: connection.id,
      spreadsheetId: SPREADSHEET_ID,
      spreadsheetName: "Reliability Sheet",
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

/* ========================================================================== */
/* Never overwrite, never duplicate                                            */
/* ========================================================================== */

describe("appending can never land on an existing row", () => {
  it("appends below rows whose key cell is blank", async () => {
    await resetWorkspace();

    // A keyed row, then rows a person scribbled in the unmapped Notes column.
    // These hold no order data, so they are stepped over, not treated as
    // unrecognisable orders.
    sheet.set(2, 0, "ORD-EXISTING");
    sheet.set(3, 4, "ask about gift wrap");
    sheet.set(4, 4, "chase supplier");

    await seedOrder({ id: "ORD-1" });
    const result = await run();

    assert.equal(result.inserted, 1);
    assert.equal(
      sheet.get(3, 4),
      "ask about gift wrap",
      "an existing row must not be overwritten",
    );
    assert.equal(sheet.get(4, 4), "chase supplier");
    assert.equal(sheet.get(5, 0), "ORD-1", "the new row goes after the data");
  });

  it("warns that unkeyed rows were stepped over", async () => {
    await resetWorkspace();
    sheet.set(2, 0, "ORD-EXISTING");
    sheet.set(3, 4, "a note, not an order");

    await seedOrder({ id: "ORD-NEW" });
    const preview = await previewSync(userId, {
      skipImport: true,
      range: "LAST_90D" as never,
    });

    assert.ok(
      preview.warnings.some((w) => w.includes("no order data")),
      `expected an unkeyed-row warning, got ${JSON.stringify(preview.warnings)}`,
    );
  });

  it("still appends normally into a genuinely empty sheet", async () => {
    // The guard must not fire on the ordinary first sync.
    await resetWorkspace();
    await seedOrder({ id: "ORD-1" });

    const result = await run();
    assert.equal(result.status, "SUCCESS");
    assert.equal(sheet.get(2, 0), "ORD-1");
  });

  it("refuses to sync when every existing row lacks a key", async () => {
    await resetWorkspace();
    // A sheet full of data where the chosen key column is the wrong one.
    for (let row = 2; row <= 12; row += 1) sheet.set(row, 1, `buyer_${row}`);

    await seedOrder({ id: "ORD-1" });
    const result = await run();

    assert.equal(result.status, "FAILED");
    assert.equal(result.errorCode, "BLOCKED");
    assert.ok(
      result.blockers[0].includes("key column"),
      result.blockers[0],
    );
    assert.equal(sheet.writeCalls, 0, "nothing may be written while blocked");
    assert.equal(sheet.get(2, 1), "buyer_2", "existing data is intact");
  });

  it("does not duplicate when the same sync is run twice in a row", async () => {
    await resetWorkspace();
    await seedOrder({ id: "ORD-1" });
    await seedOrder({ id: "ORD-2" });

    await run();
    await run();
    await run();

    const keys = sheet.column(0, 2).filter(Boolean);
    assert.deepEqual(keys, ["ORD-1", "ORD-2"], "three runs, two rows");
  });

  it("does not duplicate after a failed write is retried by a later run", async () => {
    await resetWorkspace();
    await seedOrder({ id: "ORD-1" });

    sheet.failWriteCalls = 10; // exhaust the client's retries
    const failed = await run();
    assert.equal(failed.failed, 1);

    sheet.failWriteCalls = 0;
    await run();
    await run();

    const keys = sheet.column(0, 2).filter(Boolean);
    assert.deepEqual(keys, ["ORD-1"]);
  });
});

/* ========================================================================== */
/* Connections and tokens                                                      */
/* ========================================================================== */

describe("Google disconnected or unusable", () => {
  it("fails with a reason and writes nothing when Google is disconnected", async () => {
    await resetWorkspace();
    await seedOrder({ id: "ORD-1" });
    await prisma.googleConnection.update({
      where: { id: googleConnectionId },
      data: { status: "DISCONNECTED", accessToken: null, refreshToken: null },
    });

    const result = await run();

    assert.equal(result.status, "FAILED");
    assert.equal(result.errorCode, "NOT_CONNECTED");
    assert.equal(sheet.writeCalls, 0);
    // The order must still be there to sync once Google is reconnected.
    const order = await prisma.importedOrder.findFirstOrThrow({
      where: { ebayOrderId: "ORD-1" },
    });
    assert.notEqual(order.syncState, "SYNCED");
  });

  it("does not mark a blocked run as successful", async () => {
    await resetWorkspace();
    await seedOrder({ id: "ORD-1" });
    await prisma.googleConnection.update({
      where: { id: googleConnectionId },
      data: { status: "DEMO", accessToken: null, refreshToken: null },
    });

    const result = await run();
    assert.notEqual(result.status, "SUCCESS");

    const job = await prisma.syncJob.findUniqueOrThrow({
      where: { id: result.jobId },
    });
    assert.equal(job.status, "FAILED");
    assert.ok(job.errorMessage);
  });

  it("reports an expired authorization rather than losing the order", async () => {
    await resetWorkspace();
    await seedOrder({ id: "ORD-1" });

    // Expired access token and a refresh token Google will reject.
    await prisma.googleConnection.update({
      where: { id: googleConnectionId },
      data: { tokenExpiresAt: new Date(Date.now() - 60_000) },
    });
    setGoogleTransport(async (url) => {
      if (url.includes("oauth2") || url.includes("/token")) {
        return json({ error: "invalid_grant" }, 400);
      }
      return fakeTransport(url, {});
    });

    const result = await run();

    assert.notEqual(result.status, "SUCCESS");
    assert.equal(sheet.writeCalls, 0);
    const order = await prisma.importedOrder.findFirstOrThrow({
      where: { ebayOrderId: "ORD-1" },
    });
    assert.notEqual(order.syncState, "SYNCED");
  });
});

describe("network interruption", () => {
  it("fails the run rather than writing a partial, unrecorded result", async () => {
    await resetWorkspace();
    await seedOrder({ id: "ORD-1" });

    sheet.networkDown = true;
    const result = await run();

    assert.notEqual(result.status, "SUCCESS");
    assert.equal(sheet.writeCalls, 0);
  });

  it("recovers completely once the network returns", async () => {
    await resetWorkspace();
    await seedOrder({ id: "ORD-1" });
    await seedOrder({ id: "ORD-2" });

    sheet.networkDown = true;
    await run();

    sheet.networkDown = false;
    const recovered = await run();

    assert.equal(recovered.status, "SUCCESS");
    const keys = sheet.column(0, 2).filter(Boolean).sort();
    assert.deepEqual(keys, ["ORD-1", "ORD-2"], "no order was lost");
  });
});

/* ========================================================================== */
/* Degraded order data                                                         */
/* ========================================================================== */

describe("orders missing fields still sync", () => {
  it("writes an order with no SKU", async () => {
    await resetWorkspace();
    await seedOrder({ id: "ORD-NOSKU", sku: null });

    const result = await run();

    assert.equal(result.inserted, 1);
    assert.equal(result.failed, 0);
    assert.equal(sheet.get(2, 0), "ORD-NOSKU");
    assert.equal(sheet.get(2, 2), "", "the SKU cell is empty, not missing");
  });

  it("writes an order with no buyer information", async () => {
    await resetWorkspace();
    await seedOrder({ id: "ORD-NOBUYER", buyer: null });

    const result = await run();

    assert.equal(result.inserted, 1);
    assert.equal(result.failed, 0);
    assert.equal(sheet.get(2, 0), "ORD-NOBUYER");
    assert.equal(sheet.get(2, 1), "");
  });

  it("uses the fallback when tracking is missing", async () => {
    await resetWorkspace();
    await seedOrder({ id: "ORD-NOTRACK" });

    await run();
    assert.equal(sheet.get(2, 3), "Not shipped");
  });

  it("writes one row per line item without duplicating on a re-run", async () => {
    await resetWorkspace({ rowMode: "LINE_ITEM", matchColumn: "Order Number" });

    // In LINE_ITEM mode the key must be unique per row, so map the row key.
    await prisma.fieldMapping.updateMany({
      where: { sheetConfigId, targetColumn: "Order Number" },
      data: { sourceField: "computed.rowKey" },
    });

    await seedOrder({ id: "ORD-MULTI", lineItems: 3 });

    const first = await run();
    assert.equal(first.inserted, 3);

    await run();
    const keys = sheet.column(0, 2).filter(Boolean);
    assert.equal(keys.length, 3, "a re-run must not add more rows");
    assert.equal(new Set(keys).size, 3, "each line item has its own key");
  });

  it("keeps the run going when one order cannot be built", async () => {
    await resetWorkspace();
    await seedOrder({ id: "ORD-GOOD" });
    // A stored payload that is not an object at all.
    await prisma.importedOrder.create({
      data: {
        userId,
        ebayOrderId: "ORD-BROKEN",
        orderDate: new Date(Date.now() - 86_400_000),
        orderStatus: "ACTIVE",
        rawPayloadJson: "not json",
      },
    });

    const result = await run();

    assert.equal(sheet.get(2, 0), "ORD-GOOD", "the good order still syncs");
    // The broken one is accounted for, never silently dropped.
    const recorded = await prisma.syncOrderResult.findMany({
      where: { syncJobId: result.jobId },
    });
    assert.ok(
      recorded.some((r) => r.ebayOrderId === "ORD-BROKEN"),
      "a broken order must still appear in the run's record",
    );
  });
});
