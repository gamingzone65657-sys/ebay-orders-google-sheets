/**
 * Catalogue of eBay source fields offered by the mapping UI.
 *
 * This is a *presentation* catalogue only. Nothing in the database or the sync
 * engine reads from it: FieldMapping.sourceField stores the raw dot-path
 * string, and the sync engine resolves that path against the order payload at
 * runtime (see src/lib/json.ts#getByPath).
 *
 * Consequence: when Phase 2 connects the real Sell Fulfillment API, this list
 * can be replaced by one built from a live API response without a migration
 * and without touching any mapping a user has already saved.
 */

export type EbayFieldScope = "order" | "lineItem" | "computed";

export type EbayFieldType =
  | "text"
  | "number"
  | "currency"
  | "date"
  | "boolean";

export interface EbayFieldDefinition {
  /** Dot path stored in FieldMapping.sourceField. */
  key: string;
  label: string;
  group: string;
  scope: EbayFieldScope;
  type: EbayFieldType;
  /** Shown as the "sample" column in the mapping editor. */
  example: string;
  description?: string;
}

export const EBAY_FIELD_CATALOG: EbayFieldDefinition[] = [
  // --- Order ---------------------------------------------------------------
  {
    key: "order.orderId",
    label: "Order ID",
    group: "Order",
    scope: "order",
    type: "text",
    example: "17-12345-67890",
    description: "eBay order identifier. Recommended key column for upserts.",
  },
  {
    key: "order.legacyOrderId",
    label: "Legacy Order ID",
    group: "Order",
    scope: "order",
    type: "text",
    example: "271234567890-1234567890",
  },
  {
    key: "order.creationDate",
    label: "Order Date",
    group: "Order",
    scope: "order",
    type: "date",
    example: "2026-09-14T10:22:03Z",
  },
  {
    key: "order.lastModifiedDate",
    label: "Last Modified",
    group: "Order",
    scope: "order",
    type: "date",
    example: "2026-09-15T08:04:11Z",
  },
  {
    key: "order.orderFulfillmentStatus",
    label: "Fulfillment Status",
    group: "Order",
    scope: "order",
    type: "text",
    example: "FULFILLED",
  },
  {
    key: "order.orderPaymentStatus",
    label: "Payment Status",
    group: "Order",
    scope: "order",
    type: "text",
    example: "PAID",
  },
  {
    key: "order.orderStatus",
    label: "Order Status",
    group: "Order",
    scope: "order",
    type: "text",
    example: "COMPLETED",
  },
  {
    key: "order.marketplaceId",
    label: "Marketplace",
    group: "Order",
    scope: "order",
    type: "text",
    example: "EBAY_US",
  },

  // --- Buyer ---------------------------------------------------------------
  {
    key: "order.buyer.username",
    label: "Buyer Username",
    group: "Buyer",
    scope: "order",
    type: "text",
    example: "buyer_username",
  },
  {
    key: "order.buyer.fullName",
    label: "Buyer Name",
    group: "Buyer",
    scope: "order",
    type: "text",
    example: "Firstname Lastname",
  },
  {
    key: "order.buyer.email",
    label: "Buyer Email",
    group: "Buyer",
    scope: "order",
    type: "text",
    example: "buyer@members.ebay.com",
  },

  // --- Totals --------------------------------------------------------------
  {
    key: "order.pricingSummary.total.value",
    label: "Order Total",
    group: "Totals",
    scope: "order",
    type: "currency",
    example: "148.50",
  },
  {
    key: "order.pricingSummary.total.currency",
    label: "Currency",
    group: "Totals",
    scope: "order",
    type: "text",
    example: "USD",
  },
  {
    key: "order.pricingSummary.deliveryCost.value",
    label: "Shipping Cost",
    group: "Totals",
    scope: "order",
    type: "currency",
    example: "9.95",
  },
  {
    key: "order.pricingSummary.tax.value",
    label: "Tax",
    group: "Totals",
    scope: "order",
    type: "currency",
    example: "11.88",
  },

  // --- Shipping ------------------------------------------------------------
  {
    key: "order.shipTo.fullName",
    label: "Ship To Name",
    group: "Shipping",
    scope: "order",
    type: "text",
    example: "Firstname Lastname",
  },
  {
    key: "order.shipTo.addressLine1",
    label: "Address Line 1",
    group: "Shipping",
    scope: "order",
    type: "text",
    example: "418 Bayview Ave",
  },
  {
    key: "order.shipTo.city",
    label: "City",
    group: "Shipping",
    scope: "order",
    type: "text",
    example: "Portland",
  },
  {
    key: "order.shipTo.stateOrProvince",
    label: "State / Province",
    group: "Shipping",
    scope: "order",
    type: "text",
    example: "OR",
  },
  {
    key: "order.shipTo.postalCode",
    label: "Postal Code",
    group: "Shipping",
    scope: "order",
    type: "text",
    example: "97203",
  },
  {
    key: "order.shipTo.countryCode",
    label: "Country",
    group: "Shipping",
    scope: "order",
    type: "text",
    example: "US",
  },
  {
    key: "order.fulfillment.trackingNumber",
    label: "Tracking Number",
    group: "Shipping",
    scope: "order",
    type: "text",
    example: "9400111899223197428490",
  },
  {
    key: "order.fulfillment.shippingCarrierCode",
    label: "Carrier",
    group: "Shipping",
    scope: "order",
    type: "text",
    example: "USPS",
  },
  {
    key: "order.fulfillment.shippedDate",
    label: "Shipped Date",
    group: "Shipping",
    scope: "order",
    type: "date",
    example: "2026-09-15T17:30:00Z",
  },

  // --- Line item -----------------------------------------------------------
  {
    key: "lineItem.sku",
    label: "SKU",
    group: "Line Item",
    scope: "lineItem",
    type: "text",
    example: "SKU-001",
  },
  {
    key: "lineItem.title",
    label: "Item Title",
    group: "Line Item",
    scope: "lineItem",
    type: "text",
    example: "Heavyweight Cotton Tee - Black - Large",
  },
  {
    key: "lineItem.quantity",
    label: "Quantity",
    group: "Line Item",
    scope: "lineItem",
    type: "number",
    example: "2",
  },
  {
    key: "lineItem.lineItemCost.value",
    label: "Unit Price",
    group: "Line Item",
    scope: "lineItem",
    type: "currency",
    example: "24.00",
  },
  {
    key: "lineItem.legacyItemId",
    label: "Item ID",
    group: "Line Item",
    scope: "lineItem",
    type: "text",
    example: "285412330991",
  },
  {
    key: "lineItem.variationName",
    label: "Variation",
    group: "Line Item",
    scope: "lineItem",
    type: "text",
    example: "Black / Large",
  },

  // --- Computed ------------------------------------------------------------
  {
    key: "computed.itemCount",
    label: "Line Item Count",
    group: "Computed",
    scope: "computed",
    type: "number",
    example: "3",
  },
  {
    key: "computed.totalQuantity",
    label: "Total Quantity",
    group: "Computed",
    scope: "computed",
    type: "number",
    example: "5",
  },
  {
    key: "computed.skuList",
    label: "All SKUs (joined)",
    group: "Computed",
    scope: "computed",
    type: "text",
    example: "SKU-001, SKU-002",
  },
  {
    key: "computed.titleList",
    label: "All item titles (joined)",
    group: "Computed",
    scope: "computed",
    type: "text",
    example: "Cotton Tee, Coffee Mug",
  },
  {
    key: "computed.quantityList",
    label: "All quantities (joined)",
    group: "Computed",
    scope: "computed",
    type: "text",
    example: "2, 1",
  },
  {
    key: "computed.itemSummary",
    label: "Item summary (qty × SKU — title)",
    group: "Computed",
    scope: "computed",
    type: "text",
    example: "2 × SKU-001 — Item title; 1 × SKU-002 — Item title",
    description:
      "One readable line describing every item on the order. Useful for one-row-per-order sheets.",
  },
  {
    key: "computed.skus",
    label: "SKUs (list)",
    group: "Computed",
    scope: "computed",
    type: "text",
    example: "[SKU-001, SKU-002]",
    description:
      'A multi-value field. Pair it with the "Join list" transformation to control the separator.',
  },
  {
    key: "computed.titles",
    label: "Item titles (list)",
    group: "Computed",
    scope: "computed",
    type: "text",
    example: "[Cotton Tee, Coffee Mug]",
    description: 'A multi-value field. Pair it with "Join list".',
  },
  {
    key: "computed.quantities",
    label: "Quantities (list)",
    group: "Computed",
    scope: "computed",
    type: "text",
    example: "[2, 1]",
    description: 'A multi-value field. Pair it with "Join list".',
  },
  {
    key: "computed.syncedAt",
    label: "Synced At",
    group: "Computed",
    scope: "computed",
    type: "date",
    example: "2026-09-21T09:00:00Z",
  },
  {
    key: "computed.lineItemNumber",
    label: "Line Number",
    group: "Computed",
    scope: "computed",
    type: "number",
    example: "2",
    description: "Position of this line item within its order, starting at 1.",
  },
  {
    key: "computed.rowKey",
    label: "Row Key (unique)",
    group: "Computed",
    scope: "computed",
    type: "text",
    example: "17-12345-67890::10002",
    description:
      "Unique identifier for the row: the order id, or order id + line item id in one-row-per-line-item mode. Map this to the key column when a sheet has no natural unique column.",
  },
  {
    key: "static",
    label: "Static value",
    group: "Computed",
    scope: "computed",
    type: "text",
    example: "(uses the Static value field)",
    description: "Writes a fixed literal instead of reading from the order.",
  },
];

export const EBAY_FIELD_GROUPS = Array.from(
  new Set(EBAY_FIELD_CATALOG.map((f) => f.group)),
);

const BY_KEY = new Map(EBAY_FIELD_CATALOG.map((f) => [f.key, f]));

export function getEbayField(key: string): EbayFieldDefinition | undefined {
  return BY_KEY.get(key);
}

export function ebayFieldLabel(key: string): string {
  return BY_KEY.get(key)?.label ?? key;
}
