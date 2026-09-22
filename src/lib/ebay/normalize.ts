/**
 * Translates an eBay order payload into this application's internal order
 * model.
 *
 * The contract: **nothing here may assume a field exists.** Every read goes
 * through a helper that tolerates null, undefined, the wrong type, and
 * unparseable values. A malformed order degrades to a partially-populated
 * record rather than throwing and failing the whole import.
 *
 * This is also the only place that knows eBay's vocabulary. Downstream code —
 * the orders table, the field-mapping engine, Phase 3's Sheets writer — reads
 * the normalized shape, so a change to eBay's response only lands here.
 */

import type {
  EbayAmount,
  EbayLineItem,
  EbayOrder,
  EbayShippingFulfillment,
} from "./types";

/* -------------------------------------------------------------------------- */
/* Safe readers                                                                */
/* -------------------------------------------------------------------------- */

export function safeString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

export function safeNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function safeInt(value: unknown, fallback = 0): number {
  const parsed = safeNumber(value);
  if (parsed === null) return fallback;
  return Math.trunc(parsed);
}

export function safeDate(value: unknown): Date | null {
  const text = safeString(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function amountValue(amount: EbayAmount | undefined | null): number | null {
  if (!amount) return null;
  return safeNumber(amount.value);
}

export function amountCurrency(
  amount: EbayAmount | undefined | null,
): string | null {
  if (!amount) return null;
  return safeString(amount.currency);
}

function sumAmounts(amounts: (EbayAmount | undefined)[]): number | null {
  let total: number | null = null;
  for (const amount of amounts) {
    const value = amountValue(amount);
    if (value === null) continue;
    total = (total ?? 0) + value;
  }
  return total;
}

/* -------------------------------------------------------------------------- */
/* Status derivation                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The Fulfillment API has no single "order status" field — it reports
 * fulfillment, payment, and cancellation independently. This derives the one
 * status the UI filters on, while the three source values are stored
 * verbatim alongside it.
 */
export function deriveOrderStatus(order: EbayOrder): string {
  const cancelState = safeString(order.cancelStatus?.cancelState)?.toUpperCase();
  if (cancelState === "CANCELED" || cancelState === "CANCELLED") {
    return "CANCELLED";
  }

  const paymentStatus = safeString(order.orderPaymentStatus)?.toUpperCase();
  if (paymentStatus === "FULLY_REFUNDED") return "REFUNDED";

  const fulfillmentStatus = safeString(
    order.orderFulfillmentStatus,
  )?.toUpperCase();
  if (fulfillmentStatus === "FULFILLED") return "COMPLETED";

  return "ACTIVE";
}

/* -------------------------------------------------------------------------- */
/* Normalized model                                                            */
/* -------------------------------------------------------------------------- */

export interface NormalizedLineItem {
  ebayLineItemId: string | null;
  legacyItemId: string | null;
  sku: string | null;
  title: string;
  quantity: number;
  unitPrice: number;
  currency: string;
  variation: string | null;
  lineItemTotal: number | null;
  taxAmount: number | null;
  deliveryCost: number | null;
  discountAmount: number | null;
  fulfillmentStatus: string | null;
  listingMarketplaceId: string | null;
  soldFormat: string | null;
  rawPayload: EbayLineItem;
}

export interface NormalizedFulfillment {
  ebayFulfillmentId: string | null;
  trackingNumber: string | null;
  shippingCarrierCode: string | null;
  shippingServiceCode: string | null;
  shippedDate: Date | null;
  rawPayload: EbayShippingFulfillment;
}

export interface NormalizedOrder {
  ebayOrderId: string;
  legacyOrderId: string | null;
  salesRecordRef: string | null;
  marketplaceId: string | null;

  orderDate: Date;
  lastModified: Date | null;

  buyerUsername: string | null;
  buyerName: string | null;
  buyerEmail: string | null;
  buyerPhone: string | null;

  itemCount: number;
  totalQuantity: number;
  totalAmount: number;
  currency: string;
  subtotalAmount: number | null;
  shippingCost: number | null;
  taxAmount: number | null;
  discountAmount: number | null;

  orderStatus: string;
  paymentStatus: string | null;
  fulfillmentStatus: string | null;
  cancelStatus: string | null;
  paymentMethods: string | null;

  shippingServiceCode: string | null;
  shipByDate: Date | null;
  minDeliveryDate: Date | null;
  maxDeliveryDate: Date | null;

  shipToName: string | null;
  shipToLine1: string | null;
  shipToLine2: string | null;
  shipToCity: string | null;
  shipToState: string | null;
  shipToCountry: string | null;
  shipToPostal: string | null;
  shipToPhone: string | null;

  lineItems: NormalizedLineItem[];
  rawPayload: EbayOrder;
}

function normalizeVariation(lineItem: EbayLineItem): string | null {
  const aspects = Array.isArray(lineItem.variationAspects)
    ? lineItem.variationAspects
    : [];
  const parts = aspects
    .map((aspect) => {
      const name = safeString(aspect?.name);
      const value = safeString(aspect?.value);
      if (!value) return null;
      return name ? `${name}: ${value}` : value;
    })
    .filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(", ") : null;
}

export function normalizeLineItem(
  lineItem: EbayLineItem,
  fallbackCurrency: string,
): NormalizedLineItem {
  const quantity = Math.max(1, safeInt(lineItem.quantity, 1));
  const unitPrice = amountValue(lineItem.lineItemCost) ?? 0;
  const taxes = Array.isArray(lineItem.taxes) ? lineItem.taxes : [];

  return {
    ebayLineItemId: safeString(lineItem.lineItemId),
    legacyItemId: safeString(lineItem.legacyItemId),
    sku: safeString(lineItem.sku),
    // eBay always sends a title, but a blank one must not break the table.
    title: safeString(lineItem.title) ?? "(untitled item)",
    quantity,
    unitPrice,
    currency:
      amountCurrency(lineItem.lineItemCost) ??
      amountCurrency(lineItem.total) ??
      fallbackCurrency,
    variation: normalizeVariation(lineItem),
    lineItemTotal: amountValue(lineItem.total),
    taxAmount: sumAmounts(taxes.map((tax) => tax?.amount)),
    deliveryCost: amountValue(lineItem.deliveryCost?.shippingCost),
    discountAmount: (() => {
      const discounted = amountValue(lineItem.discountedLineItemCost);
      if (discounted === null) return null;
      const gross = unitPrice * quantity;
      const delta = Number((gross - discounted).toFixed(2));
      return delta > 0 ? delta : null;
    })(),
    fulfillmentStatus: safeString(lineItem.lineItemFulfillmentStatus),
    listingMarketplaceId: safeString(lineItem.listingMarketplaceId),
    soldFormat: safeString(lineItem.soldFormat),
    rawPayload: lineItem,
  };
}

/**
 * @param order          raw payload from getOrders
 * @param defaultMarketplaceId  marketplace of the connection, used when the
 *                              payload does not carry one
 */
export function normalizeOrder(
  order: EbayOrder,
  defaultMarketplaceId: string | null = null,
): NormalizedOrder | null {
  const ebayOrderId = safeString(order?.orderId);
  // Without an order id there is no dedupe key, so the record is unusable.
  if (!ebayOrderId) return null;

  const currency =
    amountCurrency(order.pricingSummary?.total) ??
    amountCurrency(order.pricingSummary?.priceSubtotal) ??
    "USD";

  const rawLineItems = Array.isArray(order.lineItems) ? order.lineItems : [];
  const lineItems = rawLineItems.map((lineItem) =>
    normalizeLineItem(lineItem ?? {}, currency),
  );

  const shippingStep = Array.isArray(order.fulfillmentStartInstructions)
    ? order.fulfillmentStartInstructions[0]
    : undefined;
  const shipTo = shippingStep?.shippingStep?.shipTo;
  const contact = shipTo?.contactAddress;
  const registration = order.buyer?.buyerRegistrationAddress;

  const payments = Array.isArray(order.paymentSummary?.payments)
    ? order.paymentSummary.payments
    : [];
  const paymentMethods = payments
    .map((payment) => safeString(payment?.paymentMethod))
    .filter((method): method is string => method !== null);

  // shipByDate lives per line item; the earliest is the one that matters.
  const shipByDates = rawLineItems
    .map((item) => safeDate(item?.lineItemFulfillmentInstructions?.shipByDate))
    .filter((date): date is Date => date !== null)
    .sort((a, b) => a.getTime() - b.getTime());

  const totalQuantity = lineItems.reduce((sum, item) => sum + item.quantity, 0);

  return {
    ebayOrderId,
    legacyOrderId: safeString(order.legacyOrderId),
    salesRecordRef: safeString(order.salesRecordReference),
    marketplaceId:
      safeString(order.marketplaceId) ??
      safeString(rawLineItems[0]?.purchaseMarketplaceId) ??
      safeString(rawLineItems[0]?.listingMarketplaceId) ??
      defaultMarketplaceId,

    // creationDate is effectively always present; fall back to "now" rather
    // than dropping an order that is otherwise complete.
    orderDate: safeDate(order.creationDate) ?? new Date(),
    lastModified: safeDate(order.lastModifiedDate),

    buyerUsername: safeString(order.buyer?.username),
    buyerName:
      safeString(shipTo?.fullName) ?? safeString(registration?.fullName),
    // eBay masks or omits buyer email on most marketplaces; treat as optional.
    buyerEmail: safeString(shipTo?.email) ?? safeString(registration?.email),
    buyerPhone:
      safeString(shipTo?.primaryPhone?.phoneNumber) ??
      safeString(registration?.primaryPhone?.phoneNumber),

    itemCount: lineItems.length,
    totalQuantity,
    totalAmount: amountValue(order.pricingSummary?.total) ?? 0,
    currency,
    subtotalAmount: amountValue(order.pricingSummary?.priceSubtotal),
    shippingCost: amountValue(order.pricingSummary?.deliveryCost),
    taxAmount: amountValue(order.pricingSummary?.tax),
    discountAmount: amountValue(order.pricingSummary?.priceDiscount),

    orderStatus: deriveOrderStatus(order),
    paymentStatus: safeString(order.orderPaymentStatus),
    fulfillmentStatus: safeString(order.orderFulfillmentStatus),
    cancelStatus: safeString(order.cancelStatus?.cancelState),
    paymentMethods: paymentMethods.length > 0 ? paymentMethods.join(", ") : null,

    shippingServiceCode: safeString(shippingStep?.shippingStep?.shippingServiceCode),
    shipByDate: shipByDates[0] ?? null,
    minDeliveryDate: safeDate(shippingStep?.minEstimatedDeliveryDate),
    maxDeliveryDate: safeDate(shippingStep?.maxEstimatedDeliveryDate),

    shipToName: safeString(shipTo?.fullName),
    shipToLine1: safeString(contact?.addressLine1),
    shipToLine2: safeString(contact?.addressLine2),
    shipToCity: safeString(contact?.city),
    shipToState: safeString(contact?.stateOrProvince),
    shipToCountry: safeString(contact?.countryCode),
    shipToPostal: safeString(contact?.postalCode),
    shipToPhone: safeString(shipTo?.primaryPhone?.phoneNumber),

    lineItems,
    rawPayload: order,
  };
}

export function normalizeFulfillment(
  fulfillment: EbayShippingFulfillment,
): NormalizedFulfillment {
  return {
    ebayFulfillmentId: safeString(fulfillment?.fulfillmentId),
    trackingNumber: safeString(fulfillment?.shipmentTrackingNumber),
    shippingCarrierCode: safeString(fulfillment?.shippingCarrierCode),
    shippingServiceCode: null,
    shippedDate: safeDate(fulfillment?.shippedDate),
    rawPayload: fulfillment,
  };
}
