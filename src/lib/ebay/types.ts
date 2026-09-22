/**
 * Shapes returned by the eBay Sell Fulfillment API.
 *
 * Every property is optional on purpose. eBay omits fields it has no value
 * for, varies them by marketplace, and adds new ones over time; the
 * normalizer treats anything missing as absent rather than assuming a shape.
 */

export interface EbayAmount {
  value?: string;
  currency?: string;
}

export interface EbayContactAddress {
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  stateOrProvince?: string;
  postalCode?: string;
  countryCode?: string;
  county?: string;
}

export interface EbayPhone {
  phoneNumber?: string;
}

export interface EbayShipTo {
  fullName?: string;
  contactAddress?: EbayContactAddress;
  primaryPhone?: EbayPhone;
  email?: string;
  companyName?: string;
}

export interface EbayBuyerRegistrationAddress {
  fullName?: string;
  contactAddress?: EbayContactAddress;
  primaryPhone?: EbayPhone;
  email?: string;
}

export interface EbayBuyer {
  username?: string;
  taxAddress?: EbayContactAddress;
  taxIdentifier?: { taxpayerId?: string; taxIdentifierType?: string };
  buyerRegistrationAddress?: EbayBuyerRegistrationAddress;
}

export interface EbayPricingSummary {
  priceSubtotal?: EbayAmount;
  priceDiscount?: EbayAmount;
  deliveryCost?: EbayAmount;
  deliveryDiscount?: EbayAmount;
  tax?: EbayAmount;
  total?: EbayAmount;
  adjustment?: EbayAmount;
  fee?: EbayAmount;
}

export interface EbayPayment {
  paymentMethod?: string;
  paymentReferenceId?: string;
  paymentDate?: string;
  amount?: EbayAmount;
  paymentStatus?: string;
}

export interface EbayRefund {
  refundId?: string;
  refundDate?: string;
  amount?: EbayAmount;
  refundStatus?: string;
}

export interface EbayPaymentSummary {
  totalDueSeller?: EbayAmount;
  refunds?: EbayRefund[];
  payments?: EbayPayment[];
}

export interface EbayCancelStatus {
  /** NONE_REQUESTED | CANCEL_REQUESTED | CANCEL_CLOSED_FOR_COMMITMENT | CANCELED */
  cancelState?: string;
  cancelRequests?: unknown[];
  cancelledDate?: string;
}

export interface EbayShippingStep {
  shipTo?: EbayShipTo;
  shippingCarrierCode?: string;
  shippingServiceCode?: string;
  shipToReferenceId?: string;
}

export interface EbayFulfillmentStartInstruction {
  fulfillmentInstructionsType?: string;
  minEstimatedDeliveryDate?: string;
  maxEstimatedDeliveryDate?: string;
  ebaySupportedFulfillment?: boolean;
  shippingStep?: EbayShippingStep;
  finalDestinationAddress?: EbayContactAddress;
}

export interface EbayLineItemTax {
  amount?: EbayAmount;
  taxType?: string;
}

export interface EbayVariationAspect {
  name?: string;
  value?: string;
}

export interface EbayLineItemFulfillmentInstructions {
  minEstimatedDeliveryDate?: string;
  maxEstimatedDeliveryDate?: string;
  shipByDate?: string;
  guaranteedDelivery?: boolean;
}

export interface EbayLineItem {
  lineItemId?: string;
  legacyItemId?: string;
  legacyVariationId?: string;
  sku?: string;
  title?: string;
  quantity?: number;
  soldFormat?: string;
  listingMarketplaceId?: string;
  purchaseMarketplaceId?: string;
  /** NOT_STARTED | IN_PROGRESS | FULFILLED */
  lineItemFulfillmentStatus?: string;
  lineItemCost?: EbayAmount;
  total?: EbayAmount;
  deliveryCost?: { shippingCost?: EbayAmount; importCharges?: EbayAmount };
  discountedLineItemCost?: EbayAmount;
  taxes?: EbayLineItemTax[];
  appliedPromotions?: unknown[];
  properties?: { buyerProtection?: boolean; soldViaAdCampaign?: boolean };
  variationAspects?: EbayVariationAspect[];
  lineItemFulfillmentInstructions?: EbayLineItemFulfillmentInstructions;
  itemLocation?: { location?: string; countryCode?: string; postalCode?: string };
  refunds?: EbayRefund[];
}

export interface EbayOrder {
  orderId?: string;
  legacyOrderId?: string;
  creationDate?: string;
  lastModifiedDate?: string;
  /** NOT_STARTED | IN_PROGRESS | FULFILLED */
  orderFulfillmentStatus?: string;
  /** PAID | PENDING | FAILED | PARTIALLY_REFUNDED | FULLY_REFUNDED */
  orderPaymentStatus?: string;
  sellerId?: string;
  buyer?: EbayBuyer;
  buyerCheckoutNotes?: string;
  pricingSummary?: EbayPricingSummary;
  paymentSummary?: EbayPaymentSummary;
  cancelStatus?: EbayCancelStatus;
  fulfillmentStartInstructions?: EbayFulfillmentStartInstruction[];
  fulfillmentHrefs?: string[];
  lineItems?: EbayLineItem[];
  salesRecordReference?: string;
  totalFeeBasisAmount?: EbayAmount;
  totalMarketplaceFee?: EbayAmount;
  /** Not returned by every marketplace; may be absent entirely. */
  marketplaceId?: string;
  program?: { fulfillmentProgram?: unknown };
}

export interface EbayGetOrdersResponse {
  href?: string;
  total?: number;
  next?: string;
  prev?: string;
  limit?: number;
  offset?: number;
  orders?: EbayOrder[];
  warnings?: unknown[];
}

export interface EbayShippingFulfillment {
  fulfillmentId?: string;
  shipmentTrackingNumber?: string;
  shippingCarrierCode?: string;
  shippedDate?: string;
  lineItems?: { lineItemId?: string; quantity?: number }[];
}

export interface EbayGetFulfillmentsResponse {
  fulfillments?: EbayShippingFulfillment[];
  total?: number;
  warnings?: unknown[];
}
