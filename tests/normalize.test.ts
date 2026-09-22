import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  deriveOrderStatus,
  normalizeFulfillment,
  normalizeOrder,
  safeDate,
  safeInt,
  safeNumber,
  safeString,
} from "@/lib/ebay/normalize";
import { buildOrdersFilter } from "@/lib/ebay/orders";

import {
  cancelledOrder,
  fullOrder,
  hostileOrder,
  refundedOrder,
  sparseOrder,
  unusableOrder,
} from "./fixtures/ebay-payloads";

describe("safe readers", () => {
  it("treats blank and non-string values as absent", () => {
    assert.equal(safeString("  "), null);
    assert.equal(safeString(null), null);
    assert.equal(safeString(undefined), null);
    assert.equal(safeString({}), null);
    assert.equal(safeString(" hi "), "hi");
    assert.equal(safeString(42), "42");
  });

  it("rejects unparseable numbers instead of producing NaN", () => {
    assert.equal(safeNumber("abc"), null);
    assert.equal(safeNumber(Number.NaN), null);
    assert.equal(safeNumber(Number.POSITIVE_INFINITY), null);
    assert.equal(safeNumber("12.50"), 12.5);
    assert.equal(safeInt("3.9"), 3);
    assert.equal(safeInt(undefined, 7), 7);
  });

  it("rejects unparseable dates", () => {
    assert.equal(safeDate("not-a-date"), null);
    assert.equal(safeDate(null), null);
    assert.ok(safeDate("2026-09-14T10:22:03.000Z") instanceof Date);
  });
});

describe("deriveOrderStatus", () => {
  it("prefers cancellation over everything else", () => {
    assert.equal(deriveOrderStatus(cancelledOrder), "CANCELLED");
  });

  it("maps a full refund to REFUNDED", () => {
    assert.equal(deriveOrderStatus(refundedOrder), "REFUNDED");
  });

  it("maps a fulfilled order to COMPLETED", () => {
    assert.equal(deriveOrderStatus(fullOrder), "COMPLETED");
  });

  it("falls back to ACTIVE when nothing is decided", () => {
    assert.equal(deriveOrderStatus(sparseOrder), "ACTIVE");
    assert.equal(deriveOrderStatus({}), "ACTIVE");
  });
});

describe("normalizeOrder - complete payload", () => {
  const order = normalizeOrder(fullOrder, "EBAY_US");

  it("returns a record", () => {
    assert.ok(order);
  });

  it("maps identifiers and dates", () => {
    assert.equal(order!.ebayOrderId, "17-12345-67890");
    assert.equal(order!.legacyOrderId, "271234567890-1234567890");
    assert.equal(order!.salesRecordRef, "1042");
    assert.equal(order!.orderDate.toISOString(), "2026-09-14T10:22:03.000Z");
    assert.equal(
      order!.lastModified?.toISOString(),
      "2026-09-15T08:04:11.000Z",
    );
  });

  it("maps buyer details, preferring the shipping contact", () => {
    assert.equal(order!.buyerUsername, "coastal_finds");
    assert.equal(order!.buyerName, "Dana Whitfield");
    assert.equal(order!.buyerEmail, "dana.whitfield@example.com");
    assert.equal(order!.buyerPhone, "+15035551234");
  });

  it("maps the money breakdown", () => {
    assert.equal(order!.totalAmount, 143.33);
    assert.equal(order!.currency, "USD");
    assert.equal(order!.subtotalAmount, 126.5);
    assert.equal(order!.shippingCost, 9.95);
    assert.equal(order!.taxAmount, 11.88);
    assert.equal(order!.discountAmount, 5);
  });

  it("joins every payment method", () => {
    assert.equal(order!.paymentMethods, "CREDIT_CARD, EBAY_GIFT_CARD");
  });

  it("maps the shipping address and service", () => {
    assert.equal(order!.shipToLine1, "418 Bayview Ave");
    assert.equal(order!.shipToLine2, "Apt 3B");
    assert.equal(order!.shipToCity, "Portland");
    assert.equal(order!.shipToState, "OR");
    assert.equal(order!.shipToPostal, "97203");
    assert.equal(order!.shipToCountry, "US");
    assert.equal(order!.shippingServiceCode, "USPSGroundAdvantage");
  });

  it("takes the earliest ship-by date across line items", () => {
    assert.equal(order!.shipByDate?.toISOString(), "2026-09-16T07:00:00.000Z");
  });

  it("maps line items with per-line money and variation text", () => {
    assert.equal(order!.itemCount, 2);
    assert.equal(order!.totalQuantity, 3);

    const [tee, mug] = order!.lineItems;
    assert.equal(tee.sku, "TSH-BLK-L");
    assert.equal(tee.legacyItemId, "285412330991");
    assert.equal(tee.quantity, 2);
    assert.equal(tee.unitPrice, 24);
    assert.equal(tee.lineItemTotal, 48);
    assert.equal(tee.taxAmount, 3.84);
    assert.equal(tee.deliveryCost, 4.95);
    assert.equal(tee.variation, "Color: Black, Size: Large");
    assert.equal(tee.fulfillmentStatus, "FULFILLED");

    assert.equal(mug.sku, "MUG-CER-01");
    assert.equal(mug.deliveryCost, null, "absent shipping stays null, not 0");
    assert.equal(mug.variation, null);
  });
});

describe("normalizeOrder - degraded payloads", () => {
  it("handles an order with almost nothing on it", () => {
    const order = normalizeOrder(sparseOrder);
    assert.ok(order);
    assert.equal(order!.ebayOrderId, "17-00000-00001");
    assert.equal(order!.buyerUsername, null);
    assert.equal(order!.buyerEmail, null);
    assert.equal(order!.totalAmount, 0);
    assert.equal(order!.currency, "USD");
    assert.equal(order!.subtotalAmount, null);
    assert.equal(order!.shippingCost, null);
    assert.equal(order!.shipToCity, null);
    assert.equal(order!.paymentMethods, null);
    assert.equal(order!.itemCount, 1);
    assert.equal(order!.lineItems[0].quantity, 1, "missing quantity means 1");
  });

  it("rejects an order with no id rather than inventing one", () => {
    assert.equal(normalizeOrder(unusableOrder), null);
    assert.equal(normalizeOrder({}), null);
    assert.equal(normalizeOrder({ orderId: "   " }), null);
  });

  it("absorbs wrong types without throwing", () => {
    const order = normalizeOrder(hostileOrder);
    assert.ok(order);
    // "not-a-date" is unparseable, so it falls back to now rather than NaN.
    assert.ok(!Number.isNaN(order!.orderDate.getTime()));
    assert.equal(order!.totalAmount, 0, "\"abc\" is not a number");
    assert.equal(order!.currency, "USD", "null currency falls back");
    assert.equal(order!.buyerUsername, null, "whitespace username is absent");
    assert.equal(order!.paymentStatus, "12345", "numbers coerce to text");
    assert.equal(order!.shipToCity, null, "non-array instructions ignored");
    assert.equal(order!.lineItems.length, 2);
    assert.equal(order!.lineItems[0].title, "(untitled item)");
    assert.equal(order!.lineItems[0].quantity, 3, "string quantity parses");
    assert.equal(order!.lineItems[1].title, "(untitled item)", "null item");
  });

  it("uses the connection marketplace when the payload omits one", () => {
    assert.equal(normalizeOrder(sparseOrder, "EBAY_GB")!.marketplaceId, "EBAY_GB");
    assert.equal(normalizeOrder(fullOrder, "EBAY_GB")!.marketplaceId, "EBAY_US");
  });
});

describe("normalizeFulfillment", () => {
  it("maps a shipment", () => {
    const result = normalizeFulfillment({
      fulfillmentId: "9405511899223197428490",
      shipmentTrackingNumber: "9405511899223197428490",
      shippingCarrierCode: "USPS",
      shippedDate: "2026-09-15T17:30:00.000Z",
    });
    assert.equal(result.trackingNumber, "9405511899223197428490");
    assert.equal(result.shippingCarrierCode, "USPS");
    assert.equal(result.shippedDate?.toISOString(), "2026-09-15T17:30:00.000Z");
  });

  it("tolerates an empty shipment", () => {
    const result = normalizeFulfillment({});
    assert.equal(result.trackingNumber, null);
    assert.equal(result.shippedDate, null);
  });
});

describe("buildOrdersFilter", () => {
  const from = new Date("2026-09-01T00:00:00.000Z");
  const to = new Date("2026-09-30T00:00:00.000Z");

  it("builds a closed creationdate range", () => {
    assert.equal(
      buildOrdersFilter({ createdFrom: from, createdTo: to }),
      "creationdate:[2026-09-01T00:00:00.000Z..2026-09-30T00:00:00.000Z]",
    );
  });

  it("builds an open-ended range", () => {
    assert.equal(
      buildOrdersFilter({ createdFrom: from }),
      "creationdate:[2026-09-01T00:00:00.000Z..]",
    );
  });

  it("switches field for incremental imports", () => {
    assert.equal(
      buildOrdersFilter({ createdFrom: from, useModifiedDate: true }),
      "lastmodifieddate:[2026-09-01T00:00:00.000Z..]",
    );
  });

  it("returns undefined when unbounded", () => {
    assert.equal(buildOrdersFilter({}), undefined);
  });
});
