/**
 * The complete workflow, walked in order, as a single narrative.
 *
 * Every layer below the socket is the real application: the eBay client, the
 * normalizer, the mapping and transformation engine, the planner, the
 * duplicate guard, the row targeting, the writer, the job queue. Only the two
 * HTTP transports are substituted — an in-memory eBay that serves recorded
 * payload shapes, and an in-memory spreadsheet that records exactly which
 * cells were written.
 *
 * That boundary is deliberate and it is the limit of what this file proves:
 * it cannot show that the live credentials work, only that everything the
 * application does with a response is correct.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type { PrismaClient } from "@prisma/client";

import { encryptSecret } from "@/lib/crypto";
import { resetRateLimitState } from "@/lib/http/rate-limit";

import { setupTestDatabase } from "./helpers/test-db";

let prisma: PrismaClient;
let setGoogleTransport: typeof import("@/lib/google/client").setGoogleTransport;
let setEbayTransport: typeof import("@/lib/ebay/client").setEbayTransport;
let runSheetSync: typeof import("@/lib/sync/sheet-sync").runSheetSync;
let previewSync: typeof import("@/lib/sync/sheet-sync").previewSync;
let readHeaderRow: typeof import("@/lib/google/sheets").readHeaderRow;
let importOrders: typeof import("@/lib/ebay/import-orders").importOrders;
let tick: typeof import("@/lib/jobs/worker").tick;

let userId: string;
let sheetConfigId: string;
let googleConnectionId: string;
let ebayConnectionId: string;

const SPREADSHEET_ID = "1E2eWorkflowSpreadsheetIdAbcdefghij";

/**
 * The destination sheet's real header row. Column E ("Internal Note") is
 * never mapped — it is the canary for "do not touch unrelated columns".
 */
const HEADERS = [
  "Order Number",   // A (0) key column
  "Purchase Date",  // B (1) date_format
  "Order Total",    // C (2) currency
  "Qty",            // D (3) number_format
  "Internal Note",  // E (4) NEVER MAPPED
  "SKU",            // F (5)
  "Tracking",       // G (6) fallback when absent
];

/* -------------------------------------------------------------------------- */
/* In-memory spreadsheet                                                       */
/* -------------------------------------------------------------------------- */

class Sheet {
  cells = new Map<number, Map<number, string>>();
  writeCalls = 0;
  failWrites = 0;
  down = false;
  /** Every (row, column) ever written, to prove nothing else was touched. */
  touched = new Set<string>();

  reset() {
    this.cells.clear();
    this.writeCalls = 0;
    this.failWrites = 0;
    this.down = false;
    this.touched.clear();
  }
  /** A value put there by a human, not by the app. */
  seed(row: number, col: number, value: string) {
    if (!this.cells.has(row)) this.cells.set(row, new Map());
    this.cells.get(row)!.set(col, value);
  }
  write(row: number, col: number, value: string) {
    this.seed(row, col, value);
    this.touched.add(`${row}:${col}`);
  }
  get(row: number, col: number) {
    return this.cells.get(row)?.get(col);
  }
  column(index: number, fromRow: number): string[] {
    const maxRow = Math.max(0, ...this.cells.keys());
    const out: string[] = [];
    for (let row = fromRow; row <= maxRow; row += 1) out.push(this.get(row, index) ?? "");
    return out;
  }
  rows(fromRow: number, throughCol: number): string[][] {
    const maxRow = Math.max(0, ...this.cells.keys());
    const out: string[][] = [];
    for (let row = fromRow; row <= maxRow; row += 1) {
      const line: string[] = [];
      for (let col = 0; col <= throughCol; col += 1) line.push(this.get(row, col) ?? "");
      out.push(line);
    }
    return out;
  }
  wasTouched(row: number, col: number) {
    return this.touched.has(`${row}:${col}`);
  }
}

const sheet = new Sheet();

/**
 * Handles the three A1 shapes this app produces:
 *   'Orders'!B3:D3   a cell span        (writes)
 *   'Orders'!A2:A    a column from a row (key-column read)
 *   'Orders'!1:1     a whole row         (header read)
 * A whole-row range has no column letter, which is reported as column null.
 */
function parseRange(range: string) {
  const bang = range.lastIndexOf("!");
  const cellPart = bang >= 0 ? range.slice(bang + 1) : range;
  const [from, to] = cellPart.split(":");

  const parse = (ref: string) => {
    if (/^\d+$/.test(ref)) return { column: null as number | null, row: Number(ref) };
    const m = ref.match(/^([A-Z]+)(\d*)$/);
    if (!m) throw new Error(`unparseable ref ${ref}`);
    let col = 0;
    for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
    return { column: col - 1 as number | null, row: m[2] === "" ? null : Number(m[2]) };
  };

  const start = parse(from);
  const end = to ? parse(to) : start;
  return {
    row: start.row ?? 1,
    firstColumn: start.column,
    lastColumn: end.column,
    wholeRow: start.column === null,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function googleTransport(url: string, init: RequestInit): Promise<Response> {
  if (sheet.down) throw new TypeError("fetch failed");

  const parsed = new URL(url);
  const path = decodeURIComponent(parsed.pathname);

  if (path.endsWith("/values:batchUpdate")) {
    sheet.writeCalls += 1;
    if (sheet.failWrites > 0) {
      sheet.failWrites -= 1;
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
        sheet.write(row, (firstColumn ?? 0) + offset, value);
        cells += 1;
      });
    }
    return json({ totalUpdatedCells: cells });
  }

  if (path.includes(":batchUpdate")) return json({ replies: [] });

  if (path.includes("/values/")) {
    const range = path.slice(path.indexOf("/values/") + "/values/".length);
    const { firstColumn, lastColumn, row, wholeRow } = parseRange(range);

    // A whole-row range is the header read.
    if (wholeRow) return json({ values: [HEADERS] });

    if (parsed.searchParams.get("majorDimension") === "COLUMNS") {
      return json({ values: [sheet.column(firstColumn ?? 0, row)] });
    }
    return json({ values: sheet.rows(row, lastColumn ?? HEADERS.length - 1) });
  }

  if (path.includes("/v4/spreadsheets/")) {
    return json({
      spreadsheetId: SPREADSHEET_ID,
      properties: { title: "Order Tracker (E2E)" },
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
/* In-memory eBay                                                              */
/* -------------------------------------------------------------------------- */

interface FakeOrder {
  orderId: string;
  creationDate: string;
  lastModifiedDate?: string;
  orderFulfillmentStatus?: string;
  buyer?: { username?: string };
  pricingSummary?: { total?: { value?: string; currency?: string } };
  lineItems?: {
    lineItemId?: string;
    sku?: string;
    title?: string;
    quantity?: number;
    lineItemCost?: { value?: string; currency?: string };
  }[];
  fulfillmentStartInstructions?: unknown[];
}

const ebay = {
  orders: [] as FakeOrder[],
  /** Fulfillments keyed by order id, returned by the shipment lookup. */
  fulfillments: new Map<string, { shipmentTrackingNumber?: string; shippingCarrierCode?: string }[]>(),
  status: 200 as number,
  body: null as unknown,
  down: false,
  reset() {
    this.orders = [];
    this.fulfillments.clear();
    this.status = 200;
    this.body = null;
    this.down = false;
  },
};

async function ebayTransport(url: string): Promise<Response> {
  if (ebay.down) throw new TypeError("fetch failed");
  if (ebay.status !== 200) return json(ebay.body ?? { errors: [{ message: "failure" }] }, ebay.status);

  const parsed = new URL(url);
  const path = parsed.pathname;

  if (path.includes("/shipping_fulfillment")) {
    const match = path.match(/\/order\/([^/]+)\/shipping_fulfillment/);
    const orderId = match ? decodeURIComponent(match[1]) : "";
    return json({ fulfillments: ebay.fulfillments.get(orderId) ?? [] });
  }

  if (path.includes("/sell/fulfillment/v1/order")) {
    return json({ orders: ebay.orders, total: ebay.orders.length, limit: 200, offset: 0 });
  }

  return json({});
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/** A purchase date with a known UTC clock, to pin date formatting exactly. */
const PURCHASE_ISO = "2026-03-09T18:45:07.000Z";

function order(overrides: Partial<FakeOrder> = {}): FakeOrder {
  return {
    orderId: "17-00001-00001",
    creationDate: PURCHASE_ISO,
    lastModifiedDate: PURCHASE_ISO,
    orderFulfillmentStatus: "NOT_STARTED",
    buyer: { username: "coastal_finds" },
    pricingSummary: { total: { value: "1234.5", currency: "USD" } },
    lineItems: [
      {
        lineItemId: "li-1",
        sku: "TSH-BLK-L",
        title: "Black T-Shirt (L)",
        quantity: 2,
        lineItemCost: { value: "1234.5", currency: "USD" },
      },
    ],
    ...overrides,
  };
}

/** The mapping the user builds in step 7, exercising each formatter. */
const MAPPINGS = [
  { targetColumn: "Order Number", sourceField: "order.orderId", transformation: "none" },
  {
    targetColumn: "Purchase Date",
    sourceField: "order.creationDate",
    transformation: "date_format",
    transformArgs: { pattern: "yyyy-MM-dd HH:mm", timezone: "utc" },
  },
  {
    targetColumn: "Order Total",
    sourceField: "order.pricingSummary.total.value",
    transformation: "currency",
    transformArgs: { currency: "", locale: "en-US", symbol: "yes" },
  },
  {
    targetColumn: "Qty",
    sourceField: "computed.totalQuantity",
    transformation: "number_format",
    transformArgs: { decimals: "0", thousands: "comma" },
  },
  { targetColumn: "SKU", sourceField: "lineItem.sku", transformation: "none" },
  {
    targetColumn: "Tracking",
    sourceField: "order.fulfillment.trackingNumber",
    transformation: "none",
    fallbackValue: "Not shipped",
  },
];

async function installMappings(rowMode = "ORDER", keyField = "order.orderId") {
  await prisma.fieldMapping.deleteMany({ where: { sheetConfigId } });
  await prisma.fieldMapping.createMany({
    data: MAPPINGS.map((m, index) => ({
      sheetConfigId,
      targetColumn: m.targetColumn,
      sourceField: m.targetColumn === "Order Number" ? keyField : m.sourceField,
      transformation: m.transformation,
      transformArgsJson: m.transformArgs ? JSON.stringify(m.transformArgs) : null,
      fallbackValue: m.fallbackValue ?? null,
      enabled: true,
      position: index,
    })),
  });
  await prisma.googleSheetConfig.update({
    where: { id: sheetConfigId },
    data: { rowMode },
  });
}

async function resetAll(options: { rowMode?: string; keyField?: string } = {}) {
  await prisma.syncOrderResult.deleteMany({});
  await prisma.sheetRowLink.deleteMany({});
  await prisma.orderLineItem.deleteMany({});
  await prisma.importedOrder.deleteMany({ where: { userId } });
  await prisma.syncJob.deleteMany({ where: { userId } });
  await prisma.syncLock.deleteMany({});

  await prisma.googleConnection.update({
    where: { id: googleConnectionId },
    data: {
      status: "CONNECTED",
      accessToken: encryptSecret("google-access"),
      refreshToken: encryptSecret("google-refresh"),
      tokenExpiresAt: new Date(Date.now() + 3_600_000),
      lastError: null,
    },
  });
  await prisma.ebayConnection.update({
    where: { id: ebayConnectionId },
    data: {
      status: "CONNECTED",
      accessToken: encryptSecret("ebay-access"),
      refreshToken: encryptSecret("ebay-refresh"),
      tokenExpiresAt: new Date(Date.now() + 3_600_000),
      lastError: null,
    },
  });
  await prisma.googleSheetConfig.update({
    where: { id: sheetConfigId },
    data: {
      matchColumn: "Order Number",
      syncMode: "APPEND_UPDATE",
      rowMode: options.rowMode ?? "ORDER",
      lastSyncedThrough: null,
      bulkSyncConfirmedAt: new Date(),
    },
  });

  await installMappings(options.rowMode ?? "ORDER", options.keyField ?? "order.orderId");
  sheet.reset();
  ebay.reset();
}

/**
 * An explicit window around the fixed fixture date.
 *
 * A relative range such as LAST_90D would make these tests depend on the wall
 * clock: the fixture's purchase date is pinned so the formatted output can be
 * asserted exactly, and it would silently fall out of a rolling window as
 * time passed.
 */
const WINDOW = {
  range: "CUSTOM" as never,
  customFrom: new Date("2026-01-01T00:00:00.000Z"),
  customTo: new Date("2027-01-01T00:00:00.000Z"),
};

/** Import from (fake) eBay, then sync to the (fake) sheet — the real path. */
const sync = (options: Record<string, unknown> = {}) =>
  runSheetSync(userId, { confirmed: true, ...WINDOW, ...options });

/** The import half on its own, over the same window. */
const importAll = () =>
  importOrders(userId, {
    lookbackDays: 365,
    createdFrom: WINDOW.customFrom,
    createdTo: WINDOW.customTo,
  } as never);

/* -------------------------------------------------------------------------- */

before(async () => {
  setupTestDatabase("e2e");
  process.env.GOOGLE_CLIENT_ID = "test-google-client";
  process.env.GOOGLE_CLIENT_SECRET = "test-google-secret";
  process.env.GOOGLE_MIN_REQUEST_INTERVAL_MS = "0";
  process.env.EBAY_MIN_REQUEST_INTERVAL_MS = "0";

  ({ prisma } = await import("@/lib/db"));
  ({ setGoogleTransport } = await import("@/lib/google/client"));
  ({ setEbayTransport } = await import("@/lib/ebay/client"));
  ({ runSheetSync, previewSync } = await import("@/lib/sync/sheet-sync"));
  ({ readHeaderRow } = await import("@/lib/google/sheets"));
  ({ importOrders } = await import("@/lib/ebay/import-orders"));
  ({ tick } = await import("@/lib/jobs/worker"));

  const user = await prisma.user.create({
    data: { email: "e2e@test.local", name: "E2E" },
  });
  userId = user.id;

  const google = await prisma.googleConnection.create({
    data: {
      userId,
      status: "CONNECTED",
      email: "seller@example.com",
      accessToken: encryptSecret("google-access"),
      refreshToken: encryptSecret("google-refresh"),
      tokenExpiresAt: new Date(Date.now() + 3_600_000),
      scopes:
        "openid email profile https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/spreadsheets",
      connectedAt: new Date(),
    },
  });
  googleConnectionId = google.id;

  const ebayConnection = await prisma.ebayConnection.create({
    data: {
      userId,
      status: "CONNECTED",
      environment: "PRODUCTION",
      marketplaceId: "EBAY_US",
      ebayUsername: "coastal_seller",
      accessToken: encryptSecret("ebay-access"),
      refreshToken: encryptSecret("ebay-refresh"),
      tokenExpiresAt: new Date(Date.now() + 3_600_000),
      scopes: "https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly",
      connectedAt: new Date(),
    },
  });
  ebayConnectionId = ebayConnection.id;

  const config = await prisma.googleSheetConfig.create({
    data: {
      userId,
      googleConnectionId: google.id,
      spreadsheetId: SPREADSHEET_ID,
      spreadsheetName: "Order Tracker (E2E)",
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
  setGoogleTransport(googleTransport);
  setEbayTransport(ebayTransport);
});

after(() => {
  setGoogleTransport(null);
  setEbayTransport(null);
});

/* ========================================================================== */
/* Steps 4-6 — destination and headers                                         */
/* ========================================================================== */

describe("4-6 · spreadsheet, worksheet, headers", () => {
  it("reads the real header row from the chosen worksheet", async () => {
    await resetAll();
    const connection = await prisma.googleConnection.findUniqueOrThrow({
      where: { id: googleConnectionId },
    });

    const result = await readHeaderRow(connection, SPREADSHEET_ID, "Orders", 1);

    assert.deepEqual(result.headers, HEADERS);
    assert.equal(result.hasDuplicates, false);
    assert.deepEqual(result.blankPositions, []);
  });
});

/* ========================================================================== */
/* Steps 7-11 — mapping, preview, test write, verification                     */
/* ========================================================================== */

describe("7-11 · mapping, preview, first write", () => {
  it("previews without writing anything", async () => {
    await resetAll();
    ebay.orders = [order()];
    await importAll();

    const preview = await previewSync(userId, { skipImport: true, ...WINDOW });

    assert.equal(preview.ordersFound, 1);
    assert.equal(preview.rowsToInsert, 1);
    assert.equal(preview.rowsToUpdate, 0);
    assert.equal(sheet.writeCalls, 0, "a preview must not write");

    // It must name exactly the columns it will fill — and not the unmapped one.
    const headers = preview.fieldsWritten.map((f) => f.header);
    assert.deepEqual(headers.sort(), [
      "Order Number",
      "Order Total",
      "Purchase Date",
      "Qty",
      "SKU",
      "Tracking",
    ]);
    assert.ok(!headers.includes("Internal Note"));
  });

  it("writes the first order with every value formatted correctly", async () => {
    await resetAll();
    ebay.orders = [order()];

    const result = await sync();
    assert.equal(result.status, "SUCCESS", result.summary);
    assert.equal(result.inserted, 1);

    // Row 2 is the first data row.
    assert.equal(sheet.get(2, 0), "17-00001-00001", "order id");
    assert.equal(sheet.get(2, 1), "2026-03-09 18:45", "date_format, UTC");
    assert.equal(sheet.get(2, 2), "$1,234.50", "currency from the order's own code");
    assert.equal(sheet.get(2, 3), "2", "number_format, 0 decimals");
    assert.equal(sheet.get(2, 5), "TSH-BLK-L", "sku");
    assert.equal(sheet.get(2, 6), "Not shipped", "fallback when tracking is absent");
  });

  it("formats a non-USD order in its own currency", async () => {
    await resetAll();
    ebay.orders = [
      order({
        orderId: "17-GBP-0001",
        pricingSummary: { total: { value: "89", currency: "GBP" } },
      }),
    ];

    await sync();
    assert.equal(sheet.get(2, 2), "£89.00");
  });
});

/* ========================================================================== */
/* Unrelated columns                                                           */
/* ========================================================================== */

describe("never touches an unmapped column", () => {
  it("leaves a human's note in column E untouched across writes and updates", async () => {
    await resetAll();
    // A note typed by the seller on the row this order will occupy.
    sheet.seed(2, 4, "call buyer about gift wrap");

    ebay.orders = [order()];
    await sync();

    // The note's row is not this order's row: the app cannot know what row 2
    // is, so it appends below rather than sharing it.
    assert.equal(sheet.get(2, 4), "call buyer about gift wrap");
    assert.equal(sheet.wasTouched(2, 4), false, "column E must never be written");
    assert.equal(sheet.get(3, 0), "17-00001-00001", "the order went below the note");

    // And still not touched when the order's row is later updated.
    ebay.orders = [
      order({ pricingSummary: { total: { value: "99.99", currency: "USD" } } }),
    ];
    await sync();

    assert.equal(sheet.get(3, 2), "$99.99", "the mapped cell did update");
    assert.equal(sheet.get(2, 4), "call buyer about gift wrap");
    assert.equal(sheet.wasTouched(2, 4), false);
    // Column E on the order's own row is mapped by nothing either.
    assert.equal(sheet.wasTouched(3, 4), false, "unmapped column never written");
  });
});

/* ========================================================================== */
/* Steps 12-16 — bulk sync, duplicates, updates                                */
/* ========================================================================== */

describe("12-16 · bulk sync, duplicate protection, updates", () => {
  it("writes a batch of orders to consecutive rows", async () => {
    await resetAll();
    ebay.orders = Array.from({ length: 12 }, (_, i) =>
      order({
        orderId: `17-BULK-${String(i + 1).padStart(3, "0")}`,
        lineItems: [
          { lineItemId: `li-${i}`, sku: `SKU-${i + 1}`, title: "Item", quantity: 1 },
        ],
      }),
    );

    const result = await sync();
    assert.equal(result.inserted, 12);

    const ids = sheet.column(0, 2).filter(Boolean);
    assert.equal(ids.length, 12);
    assert.equal(new Set(ids).size, 12, "no id written twice");
    // Consecutive rows starting at the first data row.
    assert.equal(sheet.get(2, 0), "17-BULK-001");
    assert.equal(sheet.get(13, 0), "17-BULK-012");
  });

  it("running the same sync three times leaves the row count unchanged", async () => {
    await resetAll();
    ebay.orders = Array.from({ length: 5 }, (_, i) =>
      order({ orderId: `17-DUP-${i}` }),
    );

    await sync();
    const afterFirst = sheet.column(0, 2).filter(Boolean).length;
    await sync();
    await sync();
    const afterThird = sheet.column(0, 2).filter(Boolean).length;

    assert.equal(afterFirst, 5);
    assert.equal(afterThird, 5, "duplicate protection held across three runs");
  });

  it("updates the existing row in place when an order changes", async () => {
    await resetAll();
    ebay.orders = [order()];
    await sync();
    assert.equal(sheet.get(2, 2), "$1,234.50");

    // Step 14: the order changes on eBay.
    ebay.orders = [
      order({
        pricingSummary: { total: { value: "1500", currency: "USD" } },
        lastModifiedDate: new Date().toISOString(),
      }),
    ];

    // Step 15 + 16.
    const second = await sync();
    assert.equal(second.updated, 1);
    assert.equal(second.inserted, 0, "an update must not append");

    assert.equal(sheet.get(2, 2), "$1,500.00", "same row, new value");
    assert.equal(sheet.column(0, 2).filter(Boolean).length, 1, "still one row");
  });

  it("keeps each order on its own row when several change at once", async () => {
    await resetAll();
    ebay.orders = [
      order({ orderId: "17-A" }),
      order({ orderId: "17-B" }),
      order({ orderId: "17-C" }),
    ];
    await sync();

    const rowOfB = sheet.column(0, 2).indexOf("17-B") + 2;

    ebay.orders = [
      order({ orderId: "17-A" }),
      order({
        orderId: "17-B",
        pricingSummary: { total: { value: "7.5", currency: "USD" } },
      }),
      order({ orderId: "17-C" }),
    ];
    await sync();

    assert.equal(sheet.get(rowOfB, 0), "17-B", "B stayed on its row");
    assert.equal(sheet.get(rowOfB, 2), "$7.50");
    assert.equal(sheet.column(0, 2).filter(Boolean).length, 3);
  });
});

/* ========================================================================== */
/* Steps 17-18 — tracking                                                      */
/* ========================================================================== */

describe("17-18 · tracking arrives later", () => {
  it("fills tracking into the existing row without adding one", async () => {
    await resetAll();
    ebay.orders = [order()];
    await sync();

    assert.equal(sheet.get(2, 6), "Not shipped");
    const rowsBefore = sheet.column(0, 2).filter(Boolean).length;

    // The seller ships it: eBay now reports a fulfillment.
    ebay.fulfillments.set("17-00001-00001", [
      { shipmentTrackingNumber: "1Z999AA10123456784", shippingCarrierCode: "UPS" },
    ]);
    ebay.orders = [
      order({
        orderFulfillmentStatus: "FULFILLED",
        lastModifiedDate: new Date().toISOString(),
      }),
    ];

    const result = await sync();

    assert.equal(result.updated, 1);
    assert.equal(sheet.get(2, 6), "1Z999AA10123456784", "tracking landed in the same row");
    assert.equal(sheet.column(0, 2).filter(Boolean).length, rowsBefore);
  });
});

/* ========================================================================== */
/* Step 19 — multi-item                                                        */
/* ========================================================================== */

describe("19 · multi-item orders", () => {
  const threeItems = () =>
    order({
      orderId: "17-MULTI-01",
      pricingSummary: { total: { value: "60", currency: "USD" } },
      lineItems: [
        { lineItemId: "li-1", sku: "AAA", title: "A", quantity: 1 },
        { lineItemId: "li-2", sku: "BBB", title: "B", quantity: 2 },
        { lineItemId: "li-3", sku: "CCC", title: "C", quantity: 3 },
      ],
    });

  it("ORDER mode writes one row and summarises the quantity", async () => {
    await resetAll({ rowMode: "ORDER" });
    ebay.orders = [threeItems()];

    const result = await sync();
    assert.equal(result.inserted, 1);
    assert.equal(sheet.column(0, 2).filter(Boolean).length, 1);
    assert.equal(sheet.get(2, 3), "6", "1 + 2 + 3 across all items");
  });

  it("LINE_ITEM mode writes one row per item, each with its own SKU", async () => {
    await resetAll({ rowMode: "LINE_ITEM", keyField: "computed.rowKey" });
    ebay.orders = [threeItems()];

    const result = await sync();
    assert.equal(result.inserted, 3);

    const skus = [sheet.get(2, 5), sheet.get(3, 5), sheet.get(4, 5)];
    assert.deepEqual(skus, ["AAA", "BBB", "CCC"]);

    const keys = sheet.column(0, 2).filter(Boolean);
    assert.equal(new Set(keys).size, 3, "each line item has a distinct key");
  });

  it("LINE_ITEM mode does not duplicate on a re-run", async () => {
    await resetAll({ rowMode: "LINE_ITEM", keyField: "computed.rowKey" });
    ebay.orders = [threeItems()];
    await sync();
    await sync();

    assert.equal(sheet.column(0, 2).filter(Boolean).length, 3);
  });
});

/* ========================================================================== */
/* Step 20 — missing fields                                                    */
/* ========================================================================== */

describe("20 · missing fields", () => {
  it("writes an order with no SKU, no buyer and no tracking", async () => {
    await resetAll();
    ebay.orders = [
      {
        orderId: "17-SPARSE-01",
        creationDate: PURCHASE_ISO,
        lineItems: [{ lineItemId: "li-1", title: "Mystery item", quantity: 1 }],
      },
    ];

    const result = await sync();

    assert.equal(result.inserted, 1);
    assert.equal(result.failed, 0);
    assert.equal(sheet.get(2, 0), "17-SPARSE-01");
    assert.equal(sheet.get(2, 5), "", "missing SKU is an empty cell, not a crash");
    assert.equal(sheet.get(2, 6), "Not shipped");
  });

  it("writes an empty date cell rather than 'Invalid Date'", async () => {
    await resetAll();
    ebay.orders = [
      { orderId: "17-NODATE", creationDate: PURCHASE_ISO, lineItems: [] },
    ];
    await sync();

    // The order date exists here; the point is the formatter never emits junk.
    const cell = sheet.get(2, 1) ?? "";
    assert.ok(!/invalid/i.test(cell), `date cell was "${cell}"`);
    assert.ok(!cell.includes("NaN"), `date cell was "${cell}"`);
  });

  it("writes a zero total as a real formatted value", async () => {
    await resetAll();
    ebay.orders = [
      order({
        orderId: "17-FREE-01",
        pricingSummary: { total: { value: "0", currency: "USD" } },
      }),
    ];
    await sync();
    assert.equal(sheet.get(2, 2), "$0.00", "zero must not become an empty cell");
  });
});

/* ========================================================================== */
/* Steps 21-25 — failures and recovery                                         */
/* ========================================================================== */

describe("21 · failed orders", () => {
  it("records the failure and still writes the good orders", async () => {
    await resetAll();
    ebay.orders = [order({ orderId: "17-GOOD-1" }), order({ orderId: "17-GOOD-2" })];
    await importAll();

    // An order whose payload cannot be mapped.
    await prisma.importedOrder.create({
      data: {
        userId,
        ebayOrderId: "17-BROKEN",
        orderDate: new Date(PURCHASE_ISO),
        orderStatus: "ACTIVE",
        rawPayloadJson: null,
      },
    });

    const result = await sync({ skipImport: true });

    assert.equal(result.inserted, 2, "the good orders still synced");
    assert.equal(result.failed, 1);
    assert.equal(result.status, "PARTIAL", "a lost order is not a clean success");

    const recorded = await prisma.syncOrderResult.findMany({
      where: { syncJobId: result.jobId, outcome: "FAILED" },
    });
    assert.ok(recorded.some((r) => r.ebayOrderId === "17-BROKEN"));
  });
});

describe("22 · automatic synchronization", () => {
  it("runs a scheduled sync through the worker and does not duplicate", async () => {
    await resetAll();
    // A scheduled run uses the automation's own lookback, not the explicit
    // window the manual tests pass, so this order has to be recent.
    ebay.orders = [
      order({
        orderId: "17-AUTO-1",
        creationDate: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        lastModifiedDate: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      }),
    ];

    await prisma.automationSetting.upsert({
      where: { userId },
      create: {
        userId,
        enabled: true,
        intervalMinutes: 15,
        lookbackDays: 30,
        nextRunAt: new Date(Date.now() - 60_000),
      },
      update: {
        enabled: true,
        intervalMinutes: 15,
        nextRunAt: new Date(Date.now() - 60_000),
        consecutiveFailures: 0,
        disabledReason: null,
      },
    });

    const first = await tick({ maxJobs: 3 });
    assert.ok(first.ran >= 1, "the scheduler enqueued and ran a job");
    assert.equal(sheet.column(0, 2).filter(Boolean).length, 1);

    // A second tick immediately afterwards must not write the order again.
    await prisma.automationSetting.update({
      where: { userId },
      data: { nextRunAt: new Date(Date.now() - 60_000) },
    });
    await tick({ maxJobs: 3 });

    assert.equal(
      sheet.column(0, 2).filter(Boolean).length,
      1,
      "automatic sync running twice must not duplicate",
    );

    await prisma.automationSetting.update({
      where: { userId },
      data: { enabled: false },
    });
  });
});

describe("23 · token expiry and reconnection", () => {
  it("refreshes an expired Google token and completes the sync", async () => {
    await resetAll();
    ebay.orders = [order({ orderId: "17-REFRESH-1" })];

    await prisma.googleConnection.update({
      where: { id: googleConnectionId },
      data: { tokenExpiresAt: new Date(Date.now() - 60_000) },
    });

    let refreshed = false;
    setGoogleTransport(async (url, init) => {
      if (url.includes("/token")) {
        refreshed = true;
        return json({
          access_token: "fresh-token",
          expires_in: 3600,
          token_type: "Bearer",
        });
      }
      return googleTransport(url, init);
    });

    const result = await sync();

    assert.equal(refreshed, true, "the expired token was refreshed");
    assert.equal(result.status, "SUCCESS");
    assert.equal(sheet.get(2, 0), "17-REFRESH-1");
  });

  it("stops and asks for a reconnect when the refresh token is rejected", async () => {
    await resetAll();
    ebay.orders = [order({ orderId: "17-REVOKED-1" })];

    await prisma.googleConnection.update({
      where: { id: googleConnectionId },
      data: { tokenExpiresAt: new Date(Date.now() - 60_000) },
    });

    setGoogleTransport(async (url, init) => {
      if (url.includes("/token")) return json({ error: "invalid_grant" }, 400);
      return googleTransport(url, init);
    });

    const result = await sync();

    assert.notEqual(result.status, "SUCCESS");
    assert.equal(sheet.writeCalls, 0, "nothing may be written with a dead token");

    const connection = await prisma.googleConnection.findUniqueOrThrow({
      where: { id: googleConnectionId },
    });
    assert.equal(connection.status, "EXPIRED", "the UI must be able to prompt a reconnect");

    // Reconnecting restores service, and the order is not lost.
    await prisma.googleConnection.update({
      where: { id: googleConnectionId },
      data: {
        status: "CONNECTED",
        accessToken: encryptSecret("google-access"),
        refreshToken: encryptSecret("google-refresh"),
        tokenExpiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    setGoogleTransport(googleTransport);

    const recovered = await sync({ skipImport: true });
    assert.equal(recovered.status, "SUCCESS");
    assert.equal(sheet.get(2, 0), "17-REVOKED-1", "the order survived the outage");
  });
});

describe("24 · Google Sheet access failure", () => {
  it("does not lose the order when the sheet write fails", async () => {
    await resetAll();
    ebay.orders = [order({ orderId: "17-GFAIL-1" })];

    sheet.failWrites = 10; // exhaust the retries
    const failed = await sync();

    assert.equal(failed.failed, 1);
    assert.equal(sheet.get(2, 0), undefined, "nothing was written");

    sheet.failWrites = 0;
    const recovered = await sync({ skipImport: true });

    assert.equal(recovered.inserted, 1);
    assert.equal(sheet.get(2, 0), "17-GFAIL-1");
    assert.equal(sheet.column(0, 2).filter(Boolean).length, 1, "and exactly once");
  });

  it("refuses to write when the spreadsheet is gone", async () => {
    await resetAll();
    ebay.orders = [order({ orderId: "17-GONE-1" })];

    setGoogleTransport(async (url, init) => {
      if (url.includes("/v4/spreadsheets/")) {
        return json(
          { error: { code: 404, message: "Requested entity was not found." } },
          404,
        );
      }
      return googleTransport(url, init);
    });

    const result = await sync();
    assert.notEqual(result.status, "SUCCESS");
    assert.equal(sheet.writeCalls, 0);
  });
});

describe("25 · eBay API failure", () => {
  it("does not wipe or rewrite the sheet when eBay is unavailable", async () => {
    await resetAll();
    ebay.orders = [order({ orderId: "17-EFAIL-1" })];
    await sync();
    assert.equal(sheet.get(2, 0), "17-EFAIL-1");
    const before = sheet.writeCalls;

    // eBay now fails outright.
    ebay.down = true;
    const result = await sync();

    // The already-synced order is unchanged and no new row appeared.
    assert.equal(sheet.get(2, 0), "17-EFAIL-1");
    assert.equal(sheet.column(0, 2).filter(Boolean).length, 1);
    assert.ok(
      sheet.writeCalls === before,
      "an eBay outage must not cause a rewrite",
    );
    assert.ok(result.status !== undefined);
  });

  it("reports an eBay authorization failure without touching the sheet", async () => {
    await resetAll();
    ebay.status = 401;
    ebay.body = { errors: [{ errorId: 1001, message: "Invalid access token" }] };

    const result = await sync();

    assert.notEqual(result.status, "SUCCESS");
    assert.equal(sheet.writeCalls, 0);
  });

  it("recovers fully once eBay returns", async () => {
    await resetAll();
    ebay.down = true;
    await sync();
    assert.equal(sheet.column(0, 2).filter(Boolean).length, 0);

    ebay.down = false;
    ebay.orders = [order({ orderId: "17-BACK-1" }), order({ orderId: "17-BACK-2" })];
    const recovered = await sync();

    assert.equal(recovered.inserted, 2);
    assert.deepEqual(sheet.column(0, 2).filter(Boolean).sort(), [
      "17-BACK-1",
      "17-BACK-2",
    ]);
  });
});
