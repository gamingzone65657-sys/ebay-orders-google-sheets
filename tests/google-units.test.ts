import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GOOGLE_ERROR_CODES,
  GoogleApiError,
  classifyGoogleError,
  describeGoogleError,
} from "@/lib/google/errors";
import {
  extractSpreadsheetId,
  headerRange,
  quoteSheetTitle,
} from "@/lib/google/sheets";
import { buildWritePlan } from "@/lib/sheets/write-plan";

describe("extractSpreadsheetId", () => {
  const id = "1aBcD_efGH-ijKLmnOpQrStUvWxYz0123456789";

  it("accepts a bare id", () => {
    assert.equal(extractSpreadsheetId(id), id);
  });

  it("accepts a full edit URL", () => {
    assert.equal(
      extractSpreadsheetId(
        `https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`,
      ),
      id,
    );
  });

  it("accepts a URL with query parameters", () => {
    assert.equal(
      extractSpreadsheetId(
        `https://docs.google.com/spreadsheets/d/${id}/edit?usp=sharing`,
      ),
      id,
    );
  });

  it("trims surrounding whitespace", () => {
    assert.equal(extractSpreadsheetId(`  ${id}  `), id);
  });

  it("rejects junk", () => {
    assert.equal(extractSpreadsheetId(""), null);
    assert.equal(extractSpreadsheetId("   "), null);
    assert.equal(extractSpreadsheetId("too-short"), null);
    assert.equal(extractSpreadsheetId("https://example.com/not-a-sheet"), null);
  });
});

describe("A1 notation", () => {
  it("quotes a plain title", () => {
    assert.equal(quoteSheetTitle("Orders"), "'Orders'");
  });

  it("doubles single quotes, which would otherwise break the range", () => {
    assert.equal(quoteSheetTitle("Dan's orders"), "'Dan''s orders'");
  });

  it("builds a whole-row range", () => {
    assert.equal(headerRange("Orders", 1), "'Orders'!1:1");
    assert.equal(headerRange("Orders", 4), "'Orders'!4:4");
  });

  it("clamps a nonsense header row to 1", () => {
    assert.equal(headerRange("Orders", 0), "'Orders'!1:1");
    assert.equal(headerRange("Orders", -3), "'Orders'!1:1");
  });
});

describe("Google error classification", () => {
  it("maps 401 to an expired authorization", () => {
    assert.equal(
      classifyGoogleError(401, {}).code,
      GOOGLE_ERROR_CODES.AUTH_EXPIRED,
    );
  });

  it("separates quota 403s from permission 403s", () => {
    assert.equal(
      classifyGoogleError(403, {
        error: { errors: [{ reason: "rateLimitExceeded" }] },
      }).code,
      GOOGLE_ERROR_CODES.RATE_LIMITED,
    );
    assert.equal(
      classifyGoogleError(403, {
        error: { errors: [{ reason: "userRateLimitExceeded" }] },
      }).code,
      GOOGLE_ERROR_CODES.RATE_LIMITED,
    );
    assert.equal(
      classifyGoogleError(403, {
        error: { errors: [{ reason: "insufficientPermissions" }] },
      }).code,
      GOOGLE_ERROR_CODES.INSUFFICIENT_SCOPE,
    );
    assert.equal(
      classifyGoogleError(403, {
        error: { errors: [{ reason: "forbidden" }] },
      }).code,
      GOOGLE_ERROR_CODES.PERMISSION_DENIED,
    );
  });

  it("maps 404 to not found, so a renamed tab reads clearly", () => {
    assert.equal(
      classifyGoogleError(404, {}).code,
      GOOGLE_ERROR_CODES.NOT_FOUND,
    );
  });

  it("maps 429 and 5xx", () => {
    assert.equal(
      classifyGoogleError(429, {}).code,
      GOOGLE_ERROR_CODES.RATE_LIMITED,
    );
    assert.equal(
      classifyGoogleError(500, {}).code,
      GOOGLE_ERROR_CODES.SERVER_ERROR,
    );
  });

  it("survives a body that is not Google-shaped", () => {
    assert.equal(
      classifyGoogleError(400, null).code,
      GOOGLE_ERROR_CODES.BAD_REQUEST,
    );
    assert.equal(
      classifyGoogleError(400, "text").code,
      GOOGLE_ERROR_CODES.BAD_REQUEST,
    );
  });

  it("knows what is retryable and what needs a reconnect", () => {
    assert.equal(
      new GoogleApiError(GOOGLE_ERROR_CODES.RATE_LIMITED, "x").retryable,
      true,
    );
    assert.equal(
      new GoogleApiError(GOOGLE_ERROR_CODES.NOT_FOUND, "x").retryable,
      false,
    );
    assert.equal(
      new GoogleApiError(GOOGLE_ERROR_CODES.INSUFFICIENT_SCOPE, "x")
        .requiresReconnect,
      true,
    );
    assert.equal(
      new GoogleApiError(GOOGLE_ERROR_CODES.NOT_FOUND, "x").requiresReconnect,
      false,
    );
  });

  it("describes errors without leaking internals", () => {
    const described = describeGoogleError(
      new GoogleApiError(GOOGLE_ERROR_CODES.PERMISSION_DENIED, "raw text"),
    );
    assert.equal(described.code, GOOGLE_ERROR_CODES.PERMISSION_DENIED);
    assert.match(described.message, /does not have access/i);
    assert.equal(describeGoogleError(new Error("boom")).code, "UNKNOWN");
  });
});

/* -------------------------------------------------------------------------- */
/* Write plan — the safety guarantee                                           */
/* -------------------------------------------------------------------------- */

const columns = [
  { header: "Order ID", position: 0, letter: "A" },
  { header: "Buyer", position: 1, letter: "B" },
  { header: "SKU", position: 2, letter: "C" },
  { header: "Qty", position: 3, letter: "D" },
  { header: "Price", position: 4, letter: "E" },
  { header: "Tracking", position: 5, letter: "F" },
  { header: "Internal notes", position: 6, letter: "G" },
];

const mapping = (
  targetColumn: string,
  position: number,
  enabled = true,
  sourceField = "order.orderId",
) => ({ targetColumn, sourceField, enabled, position });

describe("buildWritePlan", () => {
  it("resolves mapped columns to their letters", () => {
    const plan = buildWritePlan(columns, [
      mapping("Order ID", 0),
      mapping("Buyer", 1, true, "order.buyer.username"),
      mapping("Tracking", 2, true, "order.fulfillment.trackingNumber"),
    ]);

    assert.equal(plan.safe, true);
    assert.deepEqual(
      plan.mapped.map((column) => column.letter),
      ["A", "B", "F"],
    );
  });

  it("lists every unmapped column as untouched", () => {
    const plan = buildWritePlan(columns, [mapping("Order ID", 0)]);
    const untouched = plan.untouched.map((column) => column.header);
    assert.ok(untouched.includes("Internal notes"));
    assert.ok(untouched.includes("Price"));
    assert.equal(untouched.includes("Order ID"), false);
    assert.equal(plan.untouched.length, 6);
  });

  it("ignores disabled mappings", () => {
    const plan = buildWritePlan(columns, [
      mapping("Order ID", 0),
      mapping("Buyer", 1, false),
    ]);
    assert.equal(plan.mapped.length, 1);
    assert.ok(plan.untouched.some((column) => column.header === "Buyer"));
  });

  it("matches headers case-insensitively", () => {
    const plan = buildWritePlan(columns, [mapping("  order id  ", 0)]);
    assert.equal(plan.mapped.length, 1);
    assert.equal(plan.mapped[0].letter, "A");
  });

  it("blocks when two mappings target the same column", () => {
    const plan = buildWritePlan(columns, [
      mapping("SKU", 0),
      mapping("sku", 1),
    ]);
    assert.equal(plan.safe, false);
    assert.equal(plan.duplicateTargets.length, 1);
    assert.match(plan.blockers.join(" "), /same column/i);
  });

  it("warns, but does not block, for a few unknown columns", () => {
    const plan = buildWritePlan(columns, [
      mapping("Order ID", 0),
      mapping("Profit", 1),
    ]);
    assert.equal(plan.safe, true);
    assert.deepEqual(plan.wouldCreate, ["Profit"]);
    assert.match(plan.warnings.join(" "), /do(es)? not exist/i);
  });

  it("refuses to create dozens of columns at once", () => {
    const plan = buildWritePlan(
      columns,
      Array.from({ length: 12 }, (_, index) =>
        mapping(`New column ${index}`, index),
      ),
    );
    assert.equal(plan.safe, false);
    assert.match(plan.blockers.join(" "), /Refusing to add that many/i);
  });

  it("blocks when nothing is enabled", () => {
    assert.equal(buildWritePlan(columns, []).safe, false);
    assert.equal(
      buildWritePlan(columns, [mapping("Order ID", 0, false)]).safe,
      false,
    );
  });

  it("reports blank header cells and never maps them", () => {
    const withBlank = [...columns, { header: "  ", position: 7, letter: "H" }];
    const plan = buildWritePlan(withBlank, [mapping("Order ID", 0)]);
    assert.deepEqual(plan.blankHeaderPositions, [7]);
    assert.equal(
      plan.untouched.some((column) => column.header.trim() === ""),
      false,
    );
  });

  it("falls back to a computed letter when one was not stored", () => {
    const plan = buildWritePlan(
      [{ header: "Order ID", position: 27, letter: null }],
      [mapping("Order ID", 0)],
    );
    assert.equal(plan.mapped[0].letter, "AB");
  });
});
