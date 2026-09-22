/**
 * End-to-end tests for the sync engine.
 *
 * Real planning, dedupe, mapping and write code against an isolated SQLite
 * database, with the Google transport stubbed by an in-memory fake sheet so
 * the effect of every write is observable.
 */

import assert from "node:assert/strict";
import { afterEach, before, beforeEach, describe, it } from "node:test";
import type { PrismaClient } from "@prisma/client";

import { encryptSecret } from "@/lib/crypto";
import { resetRateLimitState } from "@/lib/http/rate-limit";

import { fullOrder } from "./fixtures/ebay-payloads";
import { setupTestDatabase } from "./helpers/test-db";

let prisma: PrismaClient;
let setGoogleTransport: typeof import("@/lib/google/client").setGoogleTransport;
let runSheetSync: typeof import("@/lib/sync/sheet-sync").runSheetSync;
let previewSync: typeof import("@/lib/sync/sheet-sync").previewSync;

let userId: string;
let sheetConfigId: string;

const HEADERS = ["Order Number", "Buyer", "SKU", "Qty", "Total", "Tracking", "Notes"];
const SPREADSHEET_ID = "test-spreadsheet";

/** In-memory stand-in for the destination worksheet. */
class FakeSheet {
  /** rowNumber -> columnIndex -> value */
  cells = new Map<number, Map<number, string>>();
  writeCalls = 0;
  /**
   * Fail this many write *calls* from now on. The client retries 5xx, so a
   * batch only truly fails once its retries are exhausted — set this to at
   * least GOOGLE_MAX_ATTEMPTS to fail one whole batch.
   */
  failWriteCalls = 0;

  reset() {
    this.cells.clear();
    this.writeCalls = 0;
    this.failWriteCalls = 0;
  }

  set(row: number, column: number, value: string) {
    if (!this.cells.has(row)) this.cells.set(row, new Map());
    this.cells.get(row)!.set(column, value);
  }

  get(row: number, column: number): string | undefined {
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

  rowCount(): number {
    return this.cells.size;
  }

  /**
   * Rows as the Sheets API returns them for a ROWS read, which is what the
   * planner's used-range probe asks for. Trailing empty rows are omitted by
   * Sheets, so the length of this array is the used height of the range.
   */
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

/**
 * Parses "'Orders'!B3:D3" into row plus first/last column indices.
 * Also accepts the open-ended form the key-column read uses ("'Orders'!A2:A").
 */
function parseRange(range: string) {
  const bang = range.lastIndexOf("!");
  const cellPart = bang >= 0 ? range.slice(bang + 1) : range;
  const [from, to] = cellPart.split(":");

  const parse = (ref: string) => {
    const match = ref.match(/^([A-Z]+)(\d*)$/);
    if (!match) throw new Error(`unparseable ref ${ref}`);
    let column = 0;
    for (const char of match[1]) {
      column = column * 26 + (char.charCodeAt(0) - 64);
    }
    return {
      column: column - 1,
      row: match[2] === "" ? null : Number(match[2]),
    };
  };

  const start = parse(from);
  const end = to ? parse(to) : start;
  return {
    row: start.row ?? 1,
    firstColumn: start.column,
    lastColumn: end.column,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Routes Google API calls to the fake sheet. */
async function fakeTransport(url: string, init: RequestInit): Promise<Response> {
  const parsed = new URL(url);
  const path = decodeURIComponent(parsed.pathname);

  if (path.endsWith("/values:batchUpdate")) {
    sheet.writeCalls += 1;
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
    return json({ totalUpdatedCells: cells, totalUpdatedRanges: body.data.length });
  }

  if (path.includes(":batchUpdate")) {
    return json({ replies: [] }); // appendDimension
  }

  if (path.includes("/values/")) {
    const range = path.slice(path.indexOf("/values/") + "/values/".length);
    const { firstColumn, lastColumn, row } = parseRange(range);
    // Key-column reads come back as COLUMNS.
    if (parsed.searchParams.get("majorDimension") === "COLUMNS") {
      return json({ values: [sheet.column(firstColumn, row)] });
    }
    // ROWS: the header row itself, or the used-range probe over the data.
    if (row > 1) return json({ values: sheet.rows(row, lastColumn) });
    return json({ values: [HEADERS] });
  }

  if (path.includes("/v4/spreadsheets/")) {
    return json({
      spreadsheetId: SPREADSHEET_ID,
      properties: { title: "Test Sheet" },
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

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const MAPPINGS = [
  { targetColumn: "Order Number", sourceField: "order.orderId" },
  { targetColumn: "Buyer", sourceField: "order.buyer.username" },
  { targetColumn: "SKU", sourceField: "lineItem.sku" },
  { targetColumn: "Qty", sourceField: "lineItem.quantity" },
  { targetColumn: "Total", sourceField: "order.pricingSummary.total.value" },
  {
    targetColumn: "Tracking",
    sourceField: "order.fulfillment.trackingNumber",
    fallbackValue: "Not shipped",
  },
];

async function resetWorkspace(
  options: {
    rowMode?: string;
    syncMode?: string;
    matchColumn?: string;
    mappings?: typeof MAPPINGS;
    confirmed?: boolean;
  } = {},
) {
  await prisma.sheetRowLink.deleteMany({});
  await prisma.importedOrder.deleteMany({ where: { userId } });
  await prisma.syncJob.deleteMany({ where: { userId } });
  await prisma.fieldMapping.deleteMany({ where: { sheetConfigId } });
  await prisma.syncRule.deleteMany({ where: { sheetConfigId } });
  await prisma.syncFilter.deleteMany({ where: { sheetConfigId } });

  await prisma.googleSheetConfig.update({
    where: { id: sheetConfigId },
    data: {
      rowMode: options.rowMode ?? "ORDER",
      syncMode: options.syncMode ?? "APPEND_UPDATE",
      matchColumn: options.matchColumn ?? "Order Number",
      lastSyncedThrough: null,
      bulkSyncConfirmedAt: options.confirmed === false ? null : new Date(),
    },
  });

  await prisma.fieldMapping.createMany({
    data: (options.mappings ?? MAPPINGS).map((mapping, index) => ({
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

/**
 * Stores an order the way the real importer does: the verbatim payload plus
 * the denormalised columns and line-item rows derived from it, since the
 * filters query those columns.
 */
async function seedOrder(payload: Record<string, unknown>) {
  const order = payload as {
    orderId: string;
    creationDate: string;
    marketplaceId?: string;
    orderStatus?: string;
    orderPaymentStatus?: string;
    orderFulfillmentStatus?: string;
    buyer?: { username?: string };
    pricingSummary?: { total?: { value?: string; currency?: string } };
    lineItems?: {
      lineItemId?: string;
      sku?: string;
      title?: string;
      quantity?: number;
    }[];
  };

  const lineItems = Array.isArray(order.lineItems) ? order.lineItems : [];

  return prisma.importedOrder.create({
    data: {
      userId,
      ebayOrderId: order.orderId,
      orderDate: new Date(order.creationDate),
      source: "EBAY",
      syncState: "PENDING",
      marketplaceId: order.marketplaceId ?? null,
      orderStatus: order.orderStatus ?? "ACTIVE",
      paymentStatus: order.orderPaymentStatus ?? null,
      fulfillmentStatus: order.orderFulfillmentStatus ?? null,
      buyerUsername: order.buyer?.username ?? null,
      totalAmount: Number(order.pricingSummary?.total?.value ?? 0),
      currency: order.pricingSummary?.total?.currency ?? "USD",
      itemCount: lineItems.length,
      totalQuantity: lineItems.reduce(
        (sum, item) => sum + (item.quantity ?? 0),
        0,
      ),
      rawPayloadJson: JSON.stringify(payload),
      lineItems: {
        create: lineItems.map((item) => ({
          ebayLineItemId: item.lineItemId ?? null,
          sku: item.sku ?? null,
          title: item.title ?? "(untitled item)",
          quantity: item.quantity ?? 1,
        })),
      },
    },
  });
}

before(async () => {
  setupTestDatabase("sync");
  process.env.GOOGLE_CLIENT_ID = "test-google-client";
  process.env.GOOGLE_CLIENT_SECRET = "test-google-secret";
  process.env.GOOGLE_MIN_REQUEST_INTERVAL_MS = "0";

  ({ prisma } = await import("@/lib/db"));
  ({ setGoogleTransport } = await import("@/lib/google/client"));
  ({ runSheetSync, previewSync } = await import("@/lib/sync/sheet-sync"));

  const user = await prisma.user.create({
    data: { email: "sync@test.local", name: "Sync Tester" },
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
      spreadsheetName: "Test Sheet",
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
  runSheetSync(userId, { skipImport: true, confirmed: true, range: "LAST_90D" as never, ...options });

/* -------------------------------------------------------------------------- */

describe("sync engine — inserting", () => {
  it("writes mapped columns into the sheet", async () => {
    await resetWorkspace();
    await seedOrder(fullOrder as unknown as Record<string, unknown>);

    const result = await run();

    assert.equal(result.status, "SUCCESS");
    assert.equal(result.inserted, 1);
    assert.equal(result.updated, 0);
    assert.equal(result.failed, 0);

    // Row 2 is the first data row.
    assert.equal(sheet.get(2, 0), "17-12345-67890");
    assert.equal(sheet.get(2, 1), "coastal_finds");
    assert.equal(sheet.get(2, 2), "TSH-BLK-L");
    assert.equal(sheet.get(2, 4), "143.33");
  });

  it("never writes a column that is not mapped", async () => {
    await resetWorkspace();
    await seedOrder(fullOrder as unknown as Record<string, unknown>);
    await run();

    // "Notes" is column G (index 6) and has no mapping.
    assert.equal(sheet.get(2, 6), undefined, "unmapped column must be untouched");
  });

  it("preserves an existing value in an unmapped column", async () => {
    await resetWorkspace();
    await seedOrder(fullOrder as unknown as Record<string, unknown>);
    sheet.set(2, 6, "hand-written note");

    await run();

    // Row 2 already held something, so the order is appended below it rather
    // than sharing it. The app cannot tell that a note was left in
    // anticipation of a particular order, and putting an order's identity on
    // a row that already says something else would conflate the two.
    assert.equal(sheet.get(2, 6), "hand-written note", "the note is untouched");
    assert.equal(sheet.get(2, 0), undefined, "row 2 was not claimed");
    assert.equal(sheet.get(3, 0), "17-12345-67890", "the order went below it");
    assert.equal(sheet.get(3, 6), undefined, "and its own note column is unwritten");
  });

  it("applies the fallback when a field is absent", async () => {
    await resetWorkspace();
    await seedOrder({
      orderId: "17-NOTRACK",
      creationDate: new Date().toISOString(),
      buyer: { username: "someone" },
      lineItems: [{ lineItemId: "1", sku: "X", quantity: 1 }],
    });

    await run();
    assert.equal(sheet.get(2, 5), "Not shipped");
  });
});

describe("sync engine — duplicate protection", () => {
  it("updates instead of appending on a second run", async () => {
    await resetWorkspace();
    await seedOrder(fullOrder as unknown as Record<string, unknown>);

    const first = await run();
    const second = await run();

    assert.equal(first.inserted, 1);
    assert.equal(second.inserted, 0, "no second row is created");
    assert.equal(sheet.rowCount(), 1, "the sheet still has exactly one data row");
  });

  it("skips a row whose values have not changed", async () => {
    await resetWorkspace();
    await seedOrder(fullOrder as unknown as Record<string, unknown>);

    await run();
    const writesAfterFirst = sheet.writeCalls;
    const second = await run();

    assert.equal(second.updated, 0);
    assert.ok(second.skipped >= 1);
    assert.equal(
      sheet.writeCalls,
      writesAfterFirst,
      "an unchanged row costs no write call",
    );
  });

  it("updates the existing row when tracking arrives later", async () => {
    await resetWorkspace();
    const order = await seedOrder(fullOrder as unknown as Record<string, unknown>);

    await run();
    assert.equal(sheet.get(2, 5), "Not shipped");

    // eBay later reports a tracking number on the same order.
    const updatedPayload = {
      ...(fullOrder as unknown as Record<string, unknown>),
      fulfillment: { trackingNumber: "9405511899223197428490" },
    };
    await prisma.importedOrder.update({
      where: { id: order.id },
      data: { rawPayloadJson: JSON.stringify(updatedPayload) },
    });

    const second = await run();

    assert.equal(second.updated, 1);
    assert.equal(second.inserted, 0);
    assert.equal(sheet.get(2, 5), "9405511899223197428490");
    assert.equal(sheet.rowCount(), 1, "still one row for this order");
  });

  it("matches rows already in the sheet that this database has never seen", async () => {
    await resetWorkspace();
    await seedOrder(fullOrder as unknown as Record<string, unknown>);

    // Simulate a sheet populated by a previous install.
    sheet.set(2, 0, "17-12345-67890");
    sheet.set(2, 6, "existing note");

    const result = await run();

    assert.equal(result.inserted, 0, "the existing row is found by key, not duplicated");
    assert.equal(result.updated, 1);
    assert.equal(sheet.get(2, 6), "existing note");
  });

  it("appends after the last populated row", async () => {
    await resetWorkspace();
    await seedOrder(fullOrder as unknown as Record<string, unknown>);
    sheet.set(2, 0, "some-other-order");
    sheet.set(3, 0, "another-order");

    await run();

    assert.equal(sheet.get(4, 0), "17-12345-67890");
    assert.equal(sheet.get(2, 0), "some-other-order", "existing rows untouched");
  });
});

describe("sync engine — modes", () => {
  it("APPEND leaves existing rows alone", async () => {
    await resetWorkspace({ syncMode: "APPEND" });
    const order = await seedOrder(fullOrder as unknown as Record<string, unknown>);
    await run({ syncMode: "APPEND" });

    await prisma.importedOrder.update({
      where: { id: order.id },
      data: {
        rawPayloadJson: JSON.stringify({
          ...(fullOrder as unknown as Record<string, unknown>),
          fulfillment: { trackingNumber: "TRACK-1" },
        }),
      },
    });

    const second = await run({ syncMode: "APPEND" });
    assert.equal(second.updated, 0);
    assert.equal(sheet.get(2, 5), "Not shipped", "existing row not refreshed");
  });

  it("UPDATE does not add new rows", async () => {
    await resetWorkspace({ syncMode: "UPDATE" });
    await seedOrder(fullOrder as unknown as Record<string, unknown>);

    const result = await run({ syncMode: "UPDATE" });
    assert.equal(result.inserted, 0);
    assert.equal(sheet.rowCount(), 0, "nothing was written");
    assert.ok(result.skipped >= 1);
  });

  it("APPEND_UPDATE does both", async () => {
    await resetWorkspace();
    const first = await seedOrder(fullOrder as unknown as Record<string, unknown>);
    await run();

    await prisma.importedOrder.update({
      where: { id: first.id },
      data: {
        rawPayloadJson: JSON.stringify({
          ...(fullOrder as unknown as Record<string, unknown>),
          fulfillment: { trackingNumber: "TRACK-9" },
        }),
      },
    });
    await seedOrder({
      orderId: "17-BRAND-NEW",
      creationDate: new Date().toISOString(),
      buyer: { username: "newbuyer" },
      lineItems: [{ lineItemId: "9", sku: "NEW-1", quantity: 1 }],
    });

    const second = await run();
    assert.equal(second.inserted, 1);
    assert.equal(second.updated, 1);
  });
});

describe("sync engine — line item mode", () => {
  it("writes one row per line item when the key is unique", async () => {
    await resetWorkspace({
      rowMode: "LINE_ITEM",
      matchColumn: "Order Number",
      mappings: [
        { targetColumn: "Order Number", sourceField: "computed.rowKey" },
        { targetColumn: "SKU", sourceField: "lineItem.sku" },
        { targetColumn: "Qty", sourceField: "lineItem.quantity" },
      ],
    });
    await seedOrder(fullOrder as unknown as Record<string, unknown>);

    const result = await run({ rowMode: "LINE_ITEM" });

    assert.equal(result.inserted, 2, "a two-item order writes two rows");
    assert.equal(sheet.get(2, 2), "TSH-BLK-L");
    assert.equal(sheet.get(3, 2), "MUG-CER-01");
    assert.equal(sheet.get(2, 0), "17-12345-67890::10001");
  });

  it("refuses when the key column is not unique per line item", async () => {
    await resetWorkspace({
      rowMode: "LINE_ITEM",
      mappings: [
        { targetColumn: "Order Number", sourceField: "order.orderId" },
        { targetColumn: "SKU", sourceField: "lineItem.sku" },
      ],
    });
    await seedOrder(fullOrder as unknown as Record<string, unknown>);

    const result = await run({ rowMode: "LINE_ITEM" });

    assert.equal(result.status, "FAILED");
    assert.match(result.blockers.join(" "), /uniquely identify a line item/i);
    assert.equal(sheet.rowCount(), 0, "nothing was written");
  });

  it("does not duplicate line items on a re-run", async () => {
    await resetWorkspace({
      rowMode: "LINE_ITEM",
      mappings: [
        { targetColumn: "Order Number", sourceField: "computed.rowKey" },
        { targetColumn: "SKU", sourceField: "lineItem.sku" },
      ],
    });
    await seedOrder(fullOrder as unknown as Record<string, unknown>);

    await run({ rowMode: "LINE_ITEM" });
    await run({ rowMode: "LINE_ITEM" });

    assert.equal(sheet.rowCount(), 2);
  });
});

describe("sync engine — safety and failures", () => {
  it("refuses to write without a key column", async () => {
    await resetWorkspace({ matchColumn: "" });
    await seedOrder(fullOrder as unknown as Record<string, unknown>);

    const result = await run();
    assert.equal(result.status, "FAILED");
    assert.match(result.blockers.join(" "), /key column/i);
    assert.equal(sheet.rowCount(), 0);
  });

  it("refuses when the key column has no mapping", async () => {
    await resetWorkspace({
      matchColumn: "Notes",
      mappings: [{ targetColumn: "SKU", sourceField: "lineItem.sku" }],
    });
    await seedOrder(fullOrder as unknown as Record<string, unknown>);

    const result = await run();
    assert.equal(result.status, "FAILED");
    assert.match(result.blockers.join(" "), /no enabled mapping/i);
  });

  it("requires confirmation before the first bulk sync", async () => {
    await resetWorkspace({ confirmed: false });
    await seedOrder(fullOrder as unknown as Record<string, unknown>);

    const blocked = await runSheetSync(userId, {
      skipImport: true,
      range: "LAST_90D" as never,
    });
    assert.equal(blocked.confirmationRequired, true);
    assert.equal(sheet.rowCount(), 0, "nothing written before confirmation");

    const confirmed = await run();
    assert.equal(confirmed.inserted, 1);
  });

  it("keeps going when one write batch fails", async () => {
    await resetWorkspace();
    for (let index = 0; index < 60; index += 1) {
      await seedOrder({
        orderId: `17-BULK-${String(index).padStart(3, "0")}`,
        creationDate: new Date().toISOString(),
        buyer: { username: `buyer${index}` },
        lineItems: [{ lineItemId: `${index}`, sku: `SKU-${index}`, quantity: 1 }],
      });
    }

    // One attempt per call, so the first batch fails outright rather than
    // being retried into success; batches are 50 rows, so the second
    // batch of 10 must still be written.
    process.env.GOOGLE_MAX_ATTEMPTS = "1";
    sheet.failWriteCalls = 1;

    try {
      const result = await run();

      assert.equal(result.failed, 50, "only the failed batch is counted failed");
      assert.equal(result.inserted, 10, "the remaining batch still wrote");
      assert.equal(result.status, "PARTIAL");

      const failedOrders = await prisma.importedOrder.count({
        where: { userId, syncState: "FAILED" },
      });
      assert.equal(failedOrders, 50, "failed orders are recorded individually");
    } finally {
      delete process.env.GOOGLE_MAX_ATTEMPTS;
    }
  });

  it("retries a transient write failure rather than giving up", async () => {
    await resetWorkspace();
    await seedOrder(fullOrder as unknown as Record<string, unknown>);

    // One failure, then success — the client's retry should absorb it.
    sheet.failWriteCalls = 1;

    const result = await run();
    assert.equal(result.failed, 0);
    assert.equal(result.inserted, 1);
    assert.equal(sheet.get(2, 0), "17-12345-67890");
  });

  it("records a bad order without stopping the run", async () => {
    await resetWorkspace();
    await seedOrder(fullOrder as unknown as Record<string, unknown>);
    // An order with no stored payload cannot be mapped.
    await prisma.importedOrder.create({
      data: {
        userId,
        ebayOrderId: "17-NO-PAYLOAD",
        orderDate: new Date(),
        source: "EBAY",
        syncState: "PENDING",
        rawPayloadJson: null,
      },
    });

    const result = await run();
    assert.equal(result.inserted, 1, "the good order still synced");
    // A run that could not map an order is NOT a clean success: the order was
    // neither written nor skipped on purpose, and saying SUCCESS would hide
    // that it needs attention.
    assert.equal(result.status, "PARTIAL");
    assert.equal(result.failed, 1);

    const recorded = await prisma.syncOrderResult.findMany({
      where: { syncJobId: result.jobId, outcome: "FAILED" },
    });
    assert.ok(
      recorded.some((entry) => entry.ebayOrderId === "17-NO-PAYLOAD"),
      "the unmappable order must be recorded per-order, not just counted",
    );
  });

  it("marks orders SYNCED after a successful write", async () => {
    await resetWorkspace();
    await seedOrder(fullOrder as unknown as Record<string, unknown>);
    await run();

    const order = await prisma.importedOrder.findFirstOrThrow({
      where: { userId, ebayOrderId: "17-12345-67890" },
    });
    assert.equal(order.syncState, "SYNCED");
    assert.ok(order.lastSyncedAt);
  });

  it("advances the sync cursor on success", async () => {
    await resetWorkspace();
    await seedOrder(fullOrder as unknown as Record<string, unknown>);
    await run();

    const config = await prisma.googleSheetConfig.findUniqueOrThrow({
      where: { id: sheetConfigId },
    });
    assert.ok(config.lastSyncedThrough, "cursor set for 'since last sync'");
  });
});

/* -------------------------------------------------------------------------- */
/* Filters and rules, end to end                                               */
/* -------------------------------------------------------------------------- */

async function setFilter(data: Record<string, unknown>) {
  await prisma.syncFilter.upsert({
    where: { sheetConfigId },
    create: { sheetConfigId, ...data },
    update: data,
  });
}

async function addRule(data: {
  name: string;
  action: string;
  conditions: { field: string; operator: string; value: string }[];
  args?: Record<string, string>;
  match?: string;
  position?: number;
  enabled?: boolean;
}) {
  return prisma.syncRule.create({
    data: {
      sheetConfigId,
      name: data.name,
      action: data.action,
      enabled: data.enabled ?? true,
      position: data.position ?? 0,
      match: data.match ?? "ALL",
      conditionsJson: JSON.stringify(data.conditions),
      actionArgsJson: JSON.stringify(data.args ?? {}),
    },
  });
}

/** Two orders with distinguishable SKUs, marketplaces and statuses. */
async function seedTwoOrders() {
  await seedOrder({
    orderId: "17-ABC-ORDER",
    creationDate: new Date().toISOString(),
    buyer: { username: "abc_buyer" },
    marketplaceId: "EBAY_GB",
    orderPaymentStatus: "PAID",
    pricingSummary: { total: { value: "50.00", currency: "GBP" } },
    lineItems: [
      { lineItemId: "1", sku: "ABC-100", title: "Widget", quantity: 1 },
    ],
  });
  await seedOrder({
    orderId: "17-XYZ-ORDER",
    creationDate: new Date().toISOString(),
    buyer: { username: "xyz_buyer" },
    marketplaceId: "EBAY_US",
    orderPaymentStatus: "PENDING",
    pricingSummary: { total: { value: "10.00", currency: "USD" } },
    lineItems: [
      { lineItemId: "2", sku: "XYZ-200", title: "Gadget", quantity: 1 },
    ],
  });
}

describe("filters", () => {
  it("restricts by marketplace", async () => {
    await resetWorkspace();
    await seedTwoOrders();
    await setFilter({ marketplaces: "EBAY_GB" });

    const result = await run();
    assert.equal(result.inserted, 1);
    assert.equal(sheet.get(2, 0), "17-ABC-ORDER");
  });

  it("restricts by payment state", async () => {
    await resetWorkspace();
    await seedTwoOrders();
    await setFilter({ orderStates: "AWAITING_PAYMENT" });

    const result = await run();
    assert.equal(result.inserted, 1);
    assert.equal(sheet.get(2, 0), "17-XYZ-ORDER");
  });

  it("treats an empty selection as no restriction", async () => {
    await resetWorkspace();
    await seedTwoOrders();
    await setFilter({ orderStates: null, marketplaces: null });

    const result = await run();
    assert.equal(result.inserted, 2);
  });

  it("includes only the listed SKUs", async () => {
    await resetWorkspace();
    await seedTwoOrders();
    await setFilter({ skuMode: "INCLUDE", skuValues: "ABC-100" });

    const result = await run();
    assert.equal(result.inserted, 1);
    assert.equal(sheet.get(2, 2), "ABC-100");
  });

  it("excludes the listed SKUs", async () => {
    await resetWorkspace();
    await seedTwoOrders();
    await setFilter({ skuMode: "EXCLUDE", skuValues: "ABC-100" });

    const result = await run();
    assert.equal(result.inserted, 1);
    assert.equal(sheet.get(2, 2), "XYZ-200");
  });

  it("supports contains / starts with / ends with", async () => {
    for (const [mode, value, expected] of [
      ["CONTAINS", "BC-1", "ABC-100"],
      ["STARTS_WITH", "XYZ", "XYZ-200"],
      ["ENDS_WITH", "100", "ABC-100"],
    ] as const) {
      await resetWorkspace();
      await seedTwoOrders();
      await setFilter({ skuMode: mode, skuValues: value });

      const result = await run();
      assert.equal(result.inserted, 1, `${mode} inserted one row`);
      assert.equal(sheet.get(2, 2), expected, `${mode} picked the right SKU`);
    }
  });

  it("keeps a multi-item order when only one item matches", async () => {
    await resetWorkspace();
    await seedOrder({
      orderId: "17-MIXED",
      creationDate: new Date().toISOString(),
      buyer: { username: "mixed" },
      lineItems: [
        { lineItemId: "1", sku: "KEEP-1", title: "Keep", quantity: 1 },
        { lineItemId: "2", sku: "DROP-1", title: "Drop", quantity: 1 },
      ],
    });
    await setFilter({ skuMode: "INCLUDE", skuValues: "KEEP-1" });

    const result = await run();
    assert.equal(result.inserted, 1, "the order survives as one row");
  });

  it("filters each row on its own SKU in line-item mode", async () => {
    await resetWorkspace({
      rowMode: "LINE_ITEM",
      mappings: [
        { targetColumn: "Order Number", sourceField: "computed.rowKey" },
        { targetColumn: "SKU", sourceField: "lineItem.sku" },
      ],
    });
    await seedOrder({
      orderId: "17-MIXED-LI",
      creationDate: new Date().toISOString(),
      buyer: { username: "mixed" },
      lineItems: [
        { lineItemId: "1", sku: "KEEP-1", title: "Keep", quantity: 1 },
        { lineItemId: "2", sku: "DROP-1", title: "Drop", quantity: 1 },
      ],
    });
    await setFilter({ skuMode: "INCLUDE", skuValues: "KEEP-1" });

    const result = await run({ rowMode: "LINE_ITEM" });
    assert.equal(result.inserted, 1, "only the matching line item is written");
    assert.equal(sheet.get(2, 2), "KEEP-1");
  });

  it("narrows the sync window with its own date bounds", async () => {
    await resetWorkspace();
    await seedOrder({
      orderId: "17-OLD",
      creationDate: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
      buyer: { username: "old" },
      lineItems: [{ lineItemId: "1", sku: "OLD-1", quantity: 1 }],
    });
    await seedOrder({
      orderId: "17-NEW",
      creationDate: new Date().toISOString(),
      buyer: { username: "new" },
      lineItems: [{ lineItemId: "2", sku: "NEW-1", quantity: 1 }],
    });
    await setFilter({
      dateFrom: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    });

    const result = await run();
    assert.equal(result.inserted, 1);
    assert.equal(sheet.get(2, 0), "17-NEW");
  });
});

describe("rules", () => {
  it("excludes rows matching an EXCLUDE rule", async () => {
    await resetWorkspace();
    await seedTwoOrders();
    await addRule({
      name: "Drop XYZ",
      action: "EXCLUDE",
      conditions: [
        { field: "lineItem.sku", operator: "starts_with", value: "XYZ" },
      ],
    });

    const result = await run();
    assert.equal(result.inserted, 1);
    assert.equal(sheet.get(2, 2), "ABC-100");
  });

  it("implements 'IF SKU contains ABC THEN import' as a whitelist", async () => {
    await resetWorkspace();
    await seedTwoOrders();
    await addRule({
      name: "Only ABC",
      action: "INCLUDE_ONLY",
      conditions: [
        { field: "lineItem.sku", operator: "contains", value: "ABC" },
      ],
    });

    const result = await run();
    assert.equal(result.inserted, 1);
    assert.equal(sheet.get(2, 2), "ABC-100");
  });

  it("overrides a column with SET_VALUE", async () => {
    await resetWorkspace();
    await seedTwoOrders();
    await addRule({
      name: "Flag GB",
      action: "SET_VALUE",
      args: { column: "Buyer", value: "UK CUSTOMER" },
      conditions: [
        { field: "order.marketplaceId", operator: "equals", value: "EBAY_GB" },
      ],
    });

    await run();
    const gbRow = sheet.get(2, 0) === "17-ABC-ORDER" ? 2 : 3;
    const usRow = gbRow === 2 ? 3 : 2;
    assert.equal(sheet.get(gbRow, 1), "UK CUSTOMER");
    assert.notEqual(sheet.get(usRow, 1), "UK CUSTOMER");
  });

  it("switches mapping set with USE_MAPPING_SET", async () => {
    await resetWorkspace();
    await seedTwoOrders();

    const saved = await prisma.savedConfiguration.create({
      data: {
        userId,
        name: "UK export",
        payloadJson: JSON.stringify({
          mappings: [
            { targetColumn: "Order Number", sourceField: "order.orderId" },
            { targetColumn: "Buyer", sourceField: "static", staticValue: "UK" },
          ],
        }),
      },
    });

    await addRule({
      name: "UK config",
      action: "USE_MAPPING_SET",
      args: { savedConfigId: saved.id },
      conditions: [
        { field: "order.marketplaceId", operator: "equals", value: "EBAY_GB" },
      ],
    });

    await run();

    const gbRow = sheet.get(2, 0) === "17-ABC-ORDER" ? 2 : 3;
    const usRow = gbRow === 2 ? 3 : 2;
    assert.equal(sheet.get(gbRow, 1), "UK", "GB row used the alternate set");
    assert.equal(
      sheet.get(gbRow, 2),
      undefined,
      "the alternate set has no SKU mapping, so that column is untouched",
    );
    assert.equal(sheet.get(usRow, 1), "xyz_buyer", "US row used the default set");

    await prisma.savedConfiguration.delete({ where: { id: saved.id } });
  });

  it("lets EXCLUDE beat a whitelist", async () => {
    await resetWorkspace();
    await seedTwoOrders();
    await addRule({
      name: "Allow all",
      position: 0,
      action: "INCLUDE_ONLY",
      conditions: [
        { field: "lineItem.sku", operator: "is_not_empty", value: "" },
      ],
    });
    await addRule({
      name: "But not XYZ",
      position: 1,
      action: "EXCLUDE",
      conditions: [
        { field: "lineItem.sku", operator: "starts_with", value: "XYZ" },
      ],
    });

    const result = await run();
    assert.equal(result.inserted, 1);
    assert.equal(sheet.get(2, 2), "ABC-100");
  });

  it("ignores a disabled rule", async () => {
    await resetWorkspace();
    await seedTwoOrders();
    await addRule({
      name: "Disabled",
      enabled: false,
      action: "EXCLUDE",
      conditions: [
        { field: "lineItem.sku", operator: "is_not_empty", value: "" },
      ],
    });

    const result = await run();
    assert.equal(result.inserted, 2);
  });

  it("records how many rows each rule matched", async () => {
    await resetWorkspace();
    await seedTwoOrders();
    const rule = await addRule({
      name: "Count me",
      action: "SET_VALUE",
      args: { column: "Buyer", value: "TAGGED" },
      conditions: [
        { field: "lineItem.sku", operator: "is_not_empty", value: "" },
      ],
    });

    await run();

    const stored = await prisma.syncRule.findUniqueOrThrow({
      where: { id: rule.id },
    });
    assert.equal(stored.lastMatchCount, 2);
    assert.ok(stored.lastEvaluatedAt);
  });

  it("reports filter and rule effects in the preview", async () => {
    await resetWorkspace();
    await seedTwoOrders();
    await setFilter({ marketplaces: "EBAY_GB" });
    await addRule({
      name: "Drop everything",
      action: "EXCLUDE",
      conditions: [
        { field: "lineItem.sku", operator: "is_not_empty", value: "" },
      ],
    });

    const preview = await previewSync(userId, {
      skipImport: true,
      range: "LAST_90D" as never,
    });

    assert.equal(preview.ordersFound, 0, "everything was excluded");
    assert.equal(preview.excludedByRule, 1);
    assert.match(preview.filterSummary.join(" "), /EBAY_GB/);
  });
});

describe("sync preview", () => {
  it("reports what would happen without writing", async () => {
    await resetWorkspace();
    await seedOrder(fullOrder as unknown as Record<string, unknown>);

    const preview = await previewSync(userId, {
      skipImport: true,
      range: "LAST_90D" as never,
    });

    assert.equal(preview.ordersFound, 1);
    assert.equal(preview.ordersNew, 1);
    assert.equal(preview.rowsToInsert, 1);
    assert.equal(preview.rowsToUpdate, 0);
    assert.equal(sheet.rowCount(), 0, "preview writes nothing");
  });

  it("lists exactly the fields that will be written", async () => {
    await resetWorkspace();
    await seedOrder(fullOrder as unknown as Record<string, unknown>);

    const preview = await previewSync(userId, {
      skipImport: true,
      range: "LAST_90D" as never,
    });

    assert.deepEqual(
      preview.fieldsWritten.map((field) => field.header),
      ["Order Number", "Buyer", "SKU", "Qty", "Total", "Tracking"],
    );
    assert.equal(
      preview.fieldsWritten.some((field) => field.header === "Notes"),
      false,
      "unmapped columns are not listed as written",
    );
  });

  it("distinguishes new from existing after a first sync", async () => {
    await resetWorkspace();
    await seedOrder(fullOrder as unknown as Record<string, unknown>);
    await run();
    await seedOrder({
      orderId: "17-SECOND",
      creationDate: new Date().toISOString(),
      buyer: { username: "second" },
      lineItems: [{ lineItemId: "2", sku: "S-2", quantity: 1 }],
    });

    const preview = await previewSync(userId, {
      skipImport: true,
      range: "LAST_90D" as never,
    });

    assert.equal(preview.ordersFound, 2);
    assert.equal(preview.ordersNew, 1);
    assert.equal(preview.ordersExisting, 1);
    assert.equal(preview.rowsToInsert, 1);
  });
});
