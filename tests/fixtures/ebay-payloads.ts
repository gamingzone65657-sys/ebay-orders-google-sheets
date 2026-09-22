/**
 * Realistic eBay Sell Fulfillment API payloads for tests.
 *
 * `fullOrder` mirrors a complete US order. `sparseOrder` is the important
 * one: it is what eBay actually sends when most optional fields are absent,
 * and the normalizer has to survive it.
 */

import type { EbayOrder } from "@/lib/ebay/types";

export const fullOrder: EbayOrder = {
  orderId: "17-12345-67890",
  legacyOrderId: "271234567890-1234567890",
  creationDate: "2026-09-14T10:22:03.000Z",
  lastModifiedDate: "2026-09-15T08:04:11.000Z",
  orderFulfillmentStatus: "FULFILLED",
  orderPaymentStatus: "PAID",
  sellerId: "seller-abc",
  salesRecordReference: "1042",
  buyer: {
    username: "coastal_finds",
    buyerRegistrationAddress: {
      fullName: "Dana Whitfield",
      email: "dana.whitfield@example.com",
      primaryPhone: { phoneNumber: "+15035551234" },
      contactAddress: {
        addressLine1: "418 Bayview Ave",
        city: "Portland",
        stateOrProvince: "OR",
        postalCode: "97203",
        countryCode: "US",
      },
    },
  },
  pricingSummary: {
    priceSubtotal: { value: "126.50", currency: "USD" },
    priceDiscount: { value: "5.00", currency: "USD" },
    deliveryCost: { value: "9.95", currency: "USD" },
    tax: { value: "11.88", currency: "USD" },
    total: { value: "143.33", currency: "USD" },
  },
  paymentSummary: {
    totalDueSeller: { value: "143.33", currency: "USD" },
    payments: [
      {
        paymentMethod: "CREDIT_CARD",
        paymentReferenceId: "PAY-1",
        paymentDate: "2026-09-14T10:22:40.000Z",
        amount: { value: "143.33", currency: "USD" },
        paymentStatus: "PAID",
      },
      {
        paymentMethod: "EBAY_GIFT_CARD",
        amount: { value: "0.00", currency: "USD" },
        paymentStatus: "PAID",
      },
    ],
  },
  cancelStatus: { cancelState: "NONE_REQUESTED" },
  fulfillmentStartInstructions: [
    {
      fulfillmentInstructionsType: "SHIP_TO",
      minEstimatedDeliveryDate: "2026-09-18T07:00:00.000Z",
      maxEstimatedDeliveryDate: "2026-09-21T07:00:00.000Z",
      ebaySupportedFulfillment: false,
      shippingStep: {
        shippingCarrierCode: "USPS",
        shippingServiceCode: "USPSGroundAdvantage",
        shipTo: {
          fullName: "Dana Whitfield",
          email: "dana.whitfield@example.com",
          primaryPhone: { phoneNumber: "+15035551234" },
          contactAddress: {
            addressLine1: "418 Bayview Ave",
            addressLine2: "Apt 3B",
            city: "Portland",
            stateOrProvince: "OR",
            postalCode: "97203",
            countryCode: "US",
          },
        },
      },
    },
  ],
  lineItems: [
    {
      lineItemId: "10001",
      legacyItemId: "285412330991",
      sku: "TSH-BLK-L",
      title: "Heavyweight Cotton Tee - Black - Large",
      quantity: 2,
      soldFormat: "FIXED_PRICE",
      listingMarketplaceId: "EBAY_US",
      purchaseMarketplaceId: "EBAY_US",
      lineItemFulfillmentStatus: "FULFILLED",
      lineItemCost: { value: "24.00", currency: "USD" },
      total: { value: "48.00", currency: "USD" },
      deliveryCost: { shippingCost: { value: "4.95", currency: "USD" } },
      taxes: [
        { amount: { value: "3.84", currency: "USD" }, taxType: "STATE_SALES_TAX" },
      ],
      variationAspects: [
        { name: "Color", value: "Black" },
        { name: "Size", value: "Large" },
      ],
      lineItemFulfillmentInstructions: {
        shipByDate: "2026-09-17T07:00:00.000Z",
        maxEstimatedDeliveryDate: "2026-09-21T07:00:00.000Z",
      },
    },
    {
      lineItemId: "10002",
      legacyItemId: "285412331002",
      sku: "MUG-CER-01",
      title: "Stoneware Coffee Mug 12oz",
      quantity: 1,
      lineItemFulfillmentStatus: "FULFILLED",
      lineItemCost: { value: "18.50", currency: "USD" },
      total: { value: "18.50", currency: "USD" },
      taxes: [{ amount: { value: "1.48", currency: "USD" } }],
      lineItemFulfillmentInstructions: {
        shipByDate: "2026-09-16T07:00:00.000Z",
      },
    },
  ],
};

/** Almost everything optional is missing. This must not throw. */
export const sparseOrder: EbayOrder = {
  orderId: "17-00000-00001",
  creationDate: "2026-09-20T12:00:00.000Z",
  lineItems: [{ lineItemId: "1", title: "Mystery Item" }],
};

/** No orderId at all — the normalizer must reject it rather than guess. */
export const unusableOrder: EbayOrder = {
  creationDate: "2026-09-20T12:00:00.000Z",
  lineItems: [],
};

export const cancelledOrder: EbayOrder = {
  orderId: "17-99999-00002",
  creationDate: "2026-09-19T12:00:00.000Z",
  orderFulfillmentStatus: "NOT_STARTED",
  orderPaymentStatus: "PAID",
  cancelStatus: { cancelState: "CANCELED" },
  pricingSummary: { total: { value: "30.00", currency: "USD" } },
  lineItems: [
    { lineItemId: "2", sku: "CBL-USBC-2M", title: "USB-C Cable", quantity: 1 },
  ],
};

export const refundedOrder: EbayOrder = {
  orderId: "17-99999-00003",
  creationDate: "2026-09-18T12:00:00.000Z",
  orderFulfillmentStatus: "FULFILLED",
  orderPaymentStatus: "FULLY_REFUNDED",
  pricingSummary: { total: { value: "42.00", currency: "GBP" } },
  lineItems: [{ lineItemId: "3", title: "Refunded thing", quantity: 1 }],
};

/** Malformed in ways a defensive parser should absorb. */
export const hostileOrder = {
  orderId: "17-88888-00004",
  creationDate: "not-a-date",
  orderPaymentStatus: 12345,
  pricingSummary: { total: { value: "abc", currency: null } },
  buyer: { username: "   " },
  lineItems: [
    { lineItemId: "4", title: "", quantity: "3", lineItemCost: { value: "7.25" } },
    null,
  ],
  fulfillmentStartInstructions: "not-an-array",
} as unknown as EbayOrder;

/** Builds a page of generated orders for pagination tests. */
export function makeOrderPage(
  startIndex: number,
  count: number,
): EbayOrder[] {
  return Array.from({ length: count }, (_, index) => {
    const n = startIndex + index;
    return {
      orderId: `17-PAGE-${String(n).padStart(5, "0")}`,
      creationDate: new Date(Date.UTC(2026, 8, 1, 0, n % 60)).toISOString(),
      orderFulfillmentStatus: "NOT_STARTED",
      orderPaymentStatus: "PAID",
      pricingSummary: { total: { value: "10.00", currency: "USD" } },
      buyer: { username: `buyer_${n}` },
      lineItems: [
        {
          lineItemId: `li-${n}`,
          sku: `SKU-${n}`,
          title: `Item ${n}`,
          quantity: 1,
          lineItemCost: { value: "10.00", currency: "USD" },
        },
      ],
    } satisfies EbayOrder;
  });
}
