/**
 * The shape of a stored eBay order payload.
 *
 * This mirrors the eBay Sell Fulfillment API `getOrders` response closely
 * enough that the dot-paths in src/lib/ebay-fields.ts resolve against it, and
 * it is what `ImportedOrder.rawPayloadJson` holds verbatim.
 *
 * Every field is optional. The payload is whatever eBay actually returned for
 * a given order, on a given marketplace, with a given set of granted scopes —
 * an order with no shipment has no `fulfillment`, an account without the
 * buyer-detail scope gets no `email`. Typing these as required would be a
 * claim about eBay's response that this application is not in a position to
 * make, and the mapper already treats a missing path as an empty cell.
 *
 * `fulfillment` is the one key eBay does not send on the order itself:
 * shipments come from a separate call, and the sync engine merges them here
 * so `order.fulfillment.*` resolves like any other path.
 */

export interface EbayOrderLineItem {
  lineItemId?: string;
  legacyItemId?: string;
  sku?: string;
  title?: string;
  quantity?: number;
  variationName?: string | null;
  lineItemCost?: { value?: string; currency?: string };
  total?: { value?: string; currency?: string };
  tax?: { value?: string; currency?: string };
  deliveryCost?: { value?: string; currency?: string };
  lineItemFulfillmentStatus?: string;
}

export interface EbayOrderPayload {
  orderId?: string;
  legacyOrderId?: string;
  salesRecordReference?: string;
  creationDate?: string;
  lastModifiedDate?: string;
  orderStatus?: string;
  orderPaymentStatus?: string;
  orderFulfillmentStatus?: string;
  cancelStatus?: { cancelState?: string };
  marketplaceId?: string;

  buyer?: {
    username?: string;
    fullName?: string;
    email?: string;
    buyerRegistrationAddress?: Record<string, unknown>;
  };

  pricingSummary?: {
    total?: { value?: string; currency?: string };
    priceSubtotal?: { value?: string; currency?: string };
    deliveryCost?: { value?: string; currency?: string };
    tax?: { value?: string; currency?: string };
    priceDiscount?: { value?: string; currency?: string };
  };

  shipTo?: {
    fullName?: string;
    email?: string;
    primaryPhone?: { phoneNumber?: string };
    contactAddress?: Record<string, unknown>;
    addressLine1?: string;
    addressLine2?: string;
    city?: string;
    stateOrProvince?: string;
    postalCode?: string;
    countryCode?: string;
  };

  /** Merged in by the sync engine from the shipping-fulfillment call. */
  fulfillment?: {
    trackingNumber?: string | null;
    shippingCarrierCode?: string | null;
    shippedDate?: string | null;
  };

  fulfillmentStartInstructions?: unknown[];
  paymentSummary?: Record<string, unknown>;
  lineItems?: EbayOrderLineItem[];

  /** eBay adds fields over time; nothing here should break when it does. */
  [key: string]: unknown;
}
