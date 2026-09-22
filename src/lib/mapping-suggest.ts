/**
 * Heuristic that proposes an eBay field for a sheet header.
 *
 * Purely a convenience for the "Auto-map columns" button — the result is a
 * normal editable mapping, and nothing downstream depends on these guesses.
 */

import { EBAY_FIELD_CATALOG } from "@/lib/ebay-fields";
import { defaultArgsFor } from "@/lib/transformations";

interface Suggestion {
  sourceField: string;
  transformation: string;
  transformArgs: Record<string, string>;
}

const RULES: { test: RegExp; sourceField: string; transformation?: string }[] = [
  { test: /^(order\s*)?(number|id|no|ref)$/i, sourceField: "order.orderId" },
  { test: /order.*(number|id|ref)/i, sourceField: "order.orderId" },
  { test: /document\s*no/i, sourceField: "order.orderId" },
  {
    test: /(purchase|order|sale)?\s*date$/i,
    sourceField: "order.creationDate",
    transformation: "date_format",
  },
  { test: /synced/i, sourceField: "computed.syncedAt", transformation: "date_format" },
  { test: /ship(ped)?\s*date/i, sourceField: "order.fulfillment.shippedDate", transformation: "date_format" },
  { test: /(buyer|customer|purchaser)\s*(name)?$/i, sourceField: "order.buyer.username" },
  { test: /email/i, sourceField: "order.buyer.email" },
  { test: /^sku$/i, sourceField: "lineItem.sku" },
  { test: /sku/i, sourceField: "computed.skuList" },
  { test: /(product|item|title|description)/i, sourceField: "lineItem.title" },
  { test: /(qty|quantity|units)/i, sourceField: "computed.totalQuantity" },
  { test: /(total|gross|amount)/i, sourceField: "order.pricingSummary.total.value", transformation: "currency" },
  { test: /tax/i, sourceField: "order.pricingSummary.tax.value", transformation: "currency" },
  { test: /(shipping|delivery)\s*(cost|fee)?$/i, sourceField: "order.pricingSummary.deliveryCost.value", transformation: "currency" },
  { test: /currency/i, sourceField: "order.pricingSummary.total.currency" },
  { test: /track/i, sourceField: "order.fulfillment.trackingNumber" },
  { test: /carrier/i, sourceField: "order.fulfillment.shippingCarrierCode" },
  { test: /(ship\s*to|destination|address)/i, sourceField: "order.shipTo.city" },
  { test: /(state|province)/i, sourceField: "order.shipTo.stateOrProvince" },
  { test: /(postal|zip)/i, sourceField: "order.shipTo.postalCode" },
  { test: /countr/i, sourceField: "order.shipTo.countryCode" },
  { test: /status/i, sourceField: "order.orderFulfillmentStatus" },
  { test: /channel|marketplace/i, sourceField: "order.marketplaceId" },
];

const VALID_KEYS = new Set(EBAY_FIELD_CATALOG.map((f) => f.key));

export function suggestMapping(header: string): Suggestion | null {
  const trimmed = header.trim();
  if (!trimmed) return null;

  for (const rule of RULES) {
    if (!rule.test.test(trimmed)) continue;
    if (!VALID_KEYS.has(rule.sourceField)) continue;
    const transformation = rule.transformation ?? "none";
    return {
      sourceField: rule.sourceField,
      transformation,
      transformArgs: defaultArgsFor(transformation),
    };
  }

  // Fall back to an exact label match against the catalogue.
  const byLabel = EBAY_FIELD_CATALOG.find(
    (f) => f.label.toLowerCase() === trimmed.toLowerCase(),
  );
  if (byLabel) {
    return { sourceField: byLabel.key, transformation: "none", transformArgs: {} };
  }

  return null;
}
