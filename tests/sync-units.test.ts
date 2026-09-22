import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SYNC_RANGES } from "@/lib/constants";
import { buildRowRanges } from "@/lib/google/sheets-write";
import { expandOrderToRows } from "@/lib/sync/build-row";
import { resolveRange } from "@/lib/sync/sheet-sync";

import { fullOrder, sparseOrder } from "./fixtures/ebay-payloads";
import type { EbayOrderPayload } from "@/lib/ebay/order-payload";

/* -------------------------------------------------------------------------- */
/* Range building — the "never touch unmapped columns" guarantee               */
/* -------------------------------------------------------------------------- */

describe("buildRowRanges", () => {
  it("emits one range for contiguous columns", () => {
    const ranges = buildRowRanges("Orders", {
      rowNumber: 7,
      cells: [
        { columnIndex: 0, value: "a" },
        { columnIndex: 1, value: "b" },
        { columnIndex: 2, value: "c" },
      ],
    });
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].range, "'Orders'!A7:C7");
    assert.deepEqual(ranges[0].values, [["a", "b", "c"]]);
  });

  it("splits around a gap so the unmapped column is never written", () => {
    // Columns A, B, D, E are mapped; C is not and must not be in any range.
    const ranges = buildRowRanges("Orders", {
      rowNumber: 3,
      cells: [
        { columnIndex: 0, value: "a" },
        { columnIndex: 1, value: "b" },
        { columnIndex: 3, value: "d" },
        { columnIndex: 4, value: "e" },
      ],
    });

    assert.equal(ranges.length, 2);
    assert.deepEqual(
      ranges.map((entry) => entry.range),
      ["'Orders'!A3:B3", "'Orders'!D3:E3"],
    );
    assert.equal(
      ranges.some((entry) => entry.range.includes("C")),
      false,
      "column C must never appear in a written range",
    );
  });

  it("emits a single-cell range for an isolated column", () => {
    const ranges = buildRowRanges("Orders", {
      rowNumber: 2,
      cells: [{ columnIndex: 5, value: "x" }],
    });
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].range, "'Orders'!F2:F2");
  });

  it("handles every column being isolated", () => {
    const ranges = buildRowRanges("Orders", {
      rowNumber: 4,
      cells: [
        { columnIndex: 0, value: "a" },
        { columnIndex: 2, value: "c" },
        { columnIndex: 4, value: "e" },
      ],
    });
    assert.deepEqual(
      ranges.map((entry) => entry.range),
      ["'Orders'!A4:A4", "'Orders'!C4:C4", "'Orders'!E4:E4"],
    );
  });

  it("sorts cells given out of order", () => {
    const ranges = buildRowRanges("Orders", {
      rowNumber: 2,
      cells: [
        { columnIndex: 2, value: "c" },
        { columnIndex: 0, value: "a" },
        { columnIndex: 1, value: "b" },
      ],
    });
    assert.equal(ranges.length, 1);
    assert.deepEqual(ranges[0].values, [["a", "b", "c"]]);
  });

  it("escapes an apostrophe in the sheet title", () => {
    const ranges = buildRowRanges("Dan's orders", {
      rowNumber: 2,
      cells: [{ columnIndex: 0, value: "a" }],
    });
    assert.equal(ranges[0].range, "'Dan''s orders'!A2:A2");
  });

  it("handles columns past Z", () => {
    const ranges = buildRowRanges("Orders", {
      rowNumber: 2,
      cells: [
        { columnIndex: 26, value: "aa" },
        { columnIndex: 27, value: "ab" },
      ],
    });
    assert.equal(ranges[0].range, "'Orders'!AA2:AB2");
  });

  it("returns nothing for a row with no cells", () => {
    assert.deepEqual(buildRowRanges("Orders", { rowNumber: 2, cells: [] }), []);
  });
});

/* -------------------------------------------------------------------------- */
/* Row expansion                                                               */
/* -------------------------------------------------------------------------- */

describe("expandOrderToRows", () => {
  it("produces exactly one row per order in ORDER mode", () => {
    const rows = expandOrderToRows(fullOrder as EbayOrderPayload, false);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].dedupeKey, "17-12345-67890");
    assert.equal(rows[0].computed.itemCount, 2);
    assert.equal(rows[0].computed.totalQuantity, 3);
  });

  it("produces one row per line item in LINE_ITEM mode", () => {
    const rows = expandOrderToRows(fullOrder as EbayOrderPayload, true);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => row.dedupeKey),
      ["17-12345-67890::10001", "17-12345-67890::10002"],
    );
    assert.equal(rows[0].lineItem?.sku, "TSH-BLK-L");
    assert.equal(rows[1].lineItem?.sku, "MUG-CER-01");
  });

  it("numbers line items from 1", () => {
    const rows = expandOrderToRows(fullOrder as EbayOrderPayload, true);
    assert.deepEqual(
      rows.map((row) => row.computed.lineItemNumber),
      [1, 2],
    );
  });

  it("exposes the row key as a computed field", () => {
    const [row] = expandOrderToRows(sparseOrder as EbayOrderPayload, true);
    assert.equal(row.computed.rowKey, row.dedupeKey);
  });

  it("still yields one row for an order with no line items", () => {
    const order = { orderId: "17-EMPTY", lineItems: [] } as unknown as EbayOrderPayload;
    const rows = expandOrderToRows(order, true);
    assert.equal(rows.length, 1, "an order is never silently dropped");
    assert.equal(rows[0].dedupeKey, "17-EMPTY");
    assert.equal(rows[0].lineItem, null);
  });

  it("falls back to the position when a line item has no id", () => {
    const order = {
      orderId: "17-NOID",
      lineItems: [{ sku: "A" }, { sku: "B" }],
    } as unknown as EbayOrderPayload;
    const rows = expandOrderToRows(order, true);
    assert.deepEqual(
      rows.map((row) => row.dedupeKey),
      ["17-NOID::1", "17-NOID::2"],
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Date ranges                                                                 */
/* -------------------------------------------------------------------------- */

describe("resolveRange", () => {
  const now = new Date("2026-09-22T12:00:00.000Z");
  const hours = (a: Date, b: Date) =>
    Math.round((b.getTime() - a.getTime()) / (60 * 60 * 1000));

  it("handles the fixed windows", () => {
    const cases: [string, number][] = [
      [SYNC_RANGES.LAST_24H, 24],
      [SYNC_RANGES.LAST_7D, 24 * 7],
      [SYNC_RANGES.LAST_30D, 24 * 30],
      [SYNC_RANGES.LAST_90D, 24 * 90],
    ];
    for (const [range, expected] of cases) {
      const result = resolveRange(range as never, { lastSyncedThrough: null }, { now });
      assert.equal(hours(result.start, result.end), expected, range);
      assert.equal(result.end.getTime(), now.getTime());
    }
  });

  it("uses the previous cutoff for 'since last sync', with an overlap", () => {
    const last = new Date("2026-09-22T06:00:00.000Z");
    const result = resolveRange(
      SYNC_RANGES.SINCE_LAST,
      { lastSyncedThrough: last },
      { now },
    );
    // One hour of overlap guards against an order modified right on the edge.
    assert.equal(result.start.toISOString(), "2026-09-22T05:00:00.000Z");
    assert.equal(result.end.getTime(), now.getTime());
  });

  it("falls back to 30 days when there is no previous sync", () => {
    const result = resolveRange(
      SYNC_RANGES.SINCE_LAST,
      { lastSyncedThrough: null },
      { now },
    );
    assert.equal(hours(result.start, result.end), 24 * 30);
    assert.match(result.label, /first run/);
  });

  it("uses the supplied custom range", () => {
    const from = new Date("2026-01-01T00:00:00.000Z");
    const to = new Date("2026-02-01T00:00:00.000Z");
    const result = resolveRange(
      SYNC_RANGES.CUSTOM,
      { lastSyncedThrough: null },
      { now, customFrom: from, customTo: to },
    );
    assert.equal(result.start.getTime(), from.getTime());
    assert.equal(result.end.getTime(), to.getTime());
  });
});
