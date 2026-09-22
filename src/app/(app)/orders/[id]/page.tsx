import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Eye, EyeOff } from "lucide-react";

import { RawJsonViewer } from "@/components/debug/RawJsonViewer";
import { PageHeader } from "@/components/layout/PageHeader";
import {
  OrderStatusBadge,
  OrderSyncBadge,
  SyncOutcomeBadge,
} from "@/components/StatusBadge";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  DetailList,
  EmptyState,
  Notice,
} from "@/components/ui/primitives";
import { SYNC_OPERATION_LABELS } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import { fromJsonColumn } from "@/lib/json";
import {
  maskAddressLine,
  maskEmail,
  maskName,
  maskPhone,
  maskPostal,
  maskRawPayload,
  maskTrackingNumber,
  redactSecretsInText,
} from "@/lib/mask";
import { getCurrentUser } from "@/lib/session";

export const metadata: Metadata = { title: "Order" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function dash(value: string | null | undefined) {
  return value && value.length > 0 ? value : "—";
}

export default async function OrderDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const { id } = await params;
  const query = await searchParams;
  const reveal = (Array.isArray(query.reveal) ? query.reveal[0] : query.reveal) === "1";

  const user = await getCurrentUser();

  const order = await prisma.importedOrder.findFirst({
    where: { id, userId: user.id },
    include: {
      lineItems: { orderBy: { createdAt: "asc" } },
      fulfillments: { orderBy: { shippedDate: "asc" } },
      ebayConnection: {
        select: { ebayUsername: true, environment: true, status: true },
      },
    },
  });

  if (!order) notFound();

  const [syncResults, rowLink] = await Promise.all([
    prisma.syncOrderResult.findMany({
      where: { orderId: order.id },
      orderBy: { createdAt: "desc" },
      take: 25,
    }),
    // The authoritative sheet row lives on the row link, which the write path
    // maintains; ImportedOrder.sheetRowNumber is only a convenience copy.
    order.sheetConfigId
      ? prisma.sheetRowLink.findFirst({
          where: { sheetConfigId: order.sheetConfigId, orderId: order.id },
          orderBy: { rowNumber: "asc" },
          select: { rowNumber: true },
        })
      : Promise.resolve(null),
  ]);

  const currentRow = rowLink?.rowNumber ?? order.sheetRowNumber ?? null;

  const raw = fromJsonColumn<Record<string, unknown> | null>(
    order.rawPayloadJson,
    null,
  );

  const money = (value: number | null | undefined) =>
    value === null || value === undefined
      ? "—"
      : formatMoney(value, order.currency);

  const revealHref = `/orders/${order.id}${reveal ? "" : "?reveal=1"}`;

  return (
    <>
      <Link
        href="/orders"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to orders
      </Link>

      <PageHeader
        title={order.ebayOrderId}
        description={`Placed ${formatDateTime(order.orderDate)}${
          order.marketplaceId ? ` on ${order.marketplaceId}` : ""
        }`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <OrderStatusBadge status={order.orderStatus} />
            <OrderSyncBadge state={order.syncState} />
            <Link
              href={revealHref}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-input bg-card px-3 text-sm font-medium text-foreground hover:bg-muted"
            >
              {reveal ? (
                <>
                  <EyeOff className="h-4 w-4" />
                  Hide buyer details
                </>
              ) : (
                <>
                  <Eye className="h-4 w-4" />
                  Reveal buyer details
                </>
              )}
            </Link>
          </div>
        }
      />


      {!reveal ? (
        <Notice tone="info">
          Buyer name, address, phone, email and tracking numbers are masked.
          Use <strong>Reveal buyer details</strong> to show the values eBay
          returned.
        </Notice>
      ) : null}

      <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Order ------------------------------------------------------- */}
        <Card>
          <CardHeader title="Order" />
          <CardBody>
            <DetailList
              items={[
                { label: "eBay order ID", value: order.ebayOrderId },
                { label: "Legacy order ID", value: dash(order.legacyOrderId) },
                { label: "Sales record #", value: dash(order.salesRecordRef) },
                { label: "Marketplace", value: dash(order.marketplaceId) },
                { label: "Order date", value: formatDateTime(order.orderDate) },
                {
                  label: "Last modified on eBay",
                  value: formatDateTime(order.lastModified),
                },
                {
                  label: "Derived status",
                  value: <OrderStatusBadge status={order.orderStatus} />,
                },
                { label: "Cancel state", value: dash(order.cancelStatus) },
                {
                  label: "Fulfillment status",
                  value: dash(order.fulfillmentStatus),
                },
                { label: "Line items", value: String(order.itemCount) },
                { label: "Total units", value: String(order.totalQuantity) },
                {
                  label: "Imported from",
                  value:
                    `eBay ${order.ebayConnection?.environment ?? ""}`.trim(),
                },
              ]}
            />
          </CardBody>
        </Card>

        {/* Buyer ------------------------------------------------------- */}
        <Card>
          <CardHeader
            title="Buyer"
            description="eBay omits or masks some buyer fields depending on marketplace and policy."
          />
          <CardBody>
            <DetailList
              items={[
                { label: "Username", value: dash(order.buyerUsername) },
                {
                  label: "Name",
                  value: dash(
                    reveal ? order.buyerName : maskName(order.buyerName),
                  ),
                },
                {
                  label: "Email",
                  value: dash(
                    reveal ? order.buyerEmail : maskEmail(order.buyerEmail),
                  ),
                },
                {
                  label: "Phone",
                  value: dash(
                    reveal ? order.buyerPhone : maskPhone(order.buyerPhone),
                  ),
                },
              ]}
            />
            {!order.buyerEmail && !order.buyerPhone ? (
              <p className="mt-3 text-xs text-muted-foreground">
                eBay did not return contact details for this order. That is
                normal — buyer email and phone are only exposed for some
                marketplaces and order types.
              </p>
            ) : null}
          </CardBody>
        </Card>

        {/* Payment ----------------------------------------------------- */}
        <Card>
          <CardHeader
            title="Payment"
            description="Amounts as eBay reported them. Missing components were not present in the response."
          />
          <CardBody>
            <DetailList
              items={[
                { label: "Payment status", value: dash(order.paymentStatus) },
                { label: "Payment methods", value: dash(order.paymentMethods) },
                { label: "Currency", value: order.currency },
                { label: "Subtotal", value: money(order.subtotalAmount) },
                { label: "Shipping", value: money(order.shippingCost) },
                { label: "Tax", value: money(order.taxAmount) },
                { label: "Discount", value: money(order.discountAmount) },
                {
                  label: "Order total",
                  value: (
                    <span className="font-semibold">
                      {formatMoney(order.totalAmount, order.currency)}
                    </span>
                  ),
                },
              ]}
            />
          </CardBody>
        </Card>

        {/* Shipping ---------------------------------------------------- */}
        <Card>
          <CardHeader title="Shipping" />
          <CardBody>
            <DetailList
              items={[
                {
                  label: "Ship to",
                  value: dash(
                    reveal ? order.shipToName : maskName(order.shipToName),
                  ),
                },
                {
                  label: "Address line 1",
                  value: dash(
                    reveal ? order.shipToLine1 : maskAddressLine(order.shipToLine1),
                  ),
                },
                {
                  label: "Address line 2",
                  value: dash(
                    reveal ? order.shipToLine2 : maskAddressLine(order.shipToLine2),
                  ),
                },
                { label: "City", value: dash(order.shipToCity) },
                { label: "State / province", value: dash(order.shipToState) },
                {
                  label: "Postal code",
                  value: dash(
                    reveal ? order.shipToPostal : maskPostal(order.shipToPostal),
                  ),
                },
                { label: "Country", value: dash(order.shipToCountry) },
                {
                  label: "Phone",
                  value: dash(
                    reveal ? order.shipToPhone : maskPhone(order.shipToPhone),
                  ),
                },
                {
                  label: "Shipping service",
                  value: dash(order.shippingServiceCode),
                },
                { label: "Ship by", value: formatDate(order.shipByDate) },
                {
                  label: "Estimated delivery",
                  value:
                    order.minDeliveryDate || order.maxDeliveryDate
                      ? `${formatDate(order.minDeliveryDate)} – ${formatDate(
                          order.maxDeliveryDate,
                        )}`
                      : "—",
                },
              ]}
            />
          </CardBody>
        </Card>
      </div>

      {/* Line items ---------------------------------------------------- */}
      <Card className="mt-6">
        <CardHeader
          title="Line items"
          description={`${order.lineItems.length} item${
            order.lineItems.length === 1 ? "" : "s"
          } on this order.`}
        />
        {order.lineItems.length === 0 ? (
          <EmptyState title="eBay returned no line items for this order." />
        ) : (
          <div className="scroll-area overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-5 py-2.5 font-medium">SKU</th>
                  <th className="px-5 py-2.5 font-medium">Item</th>
                  <th className="px-5 py-2.5 font-medium">Item ID</th>
                  <th className="px-5 py-2.5 text-right font-medium">Qty</th>
                  <th className="px-5 py-2.5 text-right font-medium">Unit</th>
                  <th className="px-5 py-2.5 text-right font-medium">Tax</th>
                  <th className="px-5 py-2.5 text-right font-medium">Shipping</th>
                  <th className="px-5 py-2.5 text-right font-medium">Total</th>
                  <th className="px-5 py-2.5 font-medium">Fulfillment</th>
                </tr>
              </thead>
              <tbody>
                {order.lineItems.map((item) => (
                  <tr
                    key={item.id}
                    className="border-b border-border align-top last:border-0"
                  >
                    <td className="px-5 py-3 font-mono text-xs text-foreground">
                      {dash(item.sku)}
                    </td>
                    <td className="max-w-[280px] px-5 py-3">
                      <div className="text-foreground">{item.title}</div>
                      {item.variation ? (
                        <div className="text-xs text-muted-foreground">
                          {item.variation}
                        </div>
                      ) : null}
                      {item.soldFormat ? (
                        <div className="text-[11px] text-muted-foreground">
                          {item.soldFormat}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-5 py-3 font-mono text-xs text-muted-foreground">
                      {dash(item.legacyItemId)}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums">
                      {item.quantity}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums whitespace-nowrap">
                      {formatMoney(item.unitPrice, item.currency)}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums whitespace-nowrap text-muted-foreground">
                      {item.taxAmount === null
                        ? "—"
                        : formatMoney(item.taxAmount, item.currency)}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums whitespace-nowrap text-muted-foreground">
                      {item.deliveryCost === null
                        ? "—"
                        : formatMoney(item.deliveryCost, item.currency)}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums whitespace-nowrap">
                      {item.lineItemTotal === null
                        ? formatMoney(item.unitPrice * item.quantity, item.currency)
                        : formatMoney(item.lineItemTotal, item.currency)}
                    </td>
                    <td className="px-5 py-3 text-xs text-muted-foreground">
                      {dash(item.fulfillmentStatus)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Tracking ------------------------------------------------------ */}
      <Card className="mt-6">
        <CardHeader
          title="Tracking"
          description="Shipments eBay has recorded against this order."
        />
        {order.fulfillments.length === 0 ? (
          <EmptyState
            title="No shipments recorded"
            description={
              order.trackingNumber
                ? "A tracking number is stored on the order, but eBay returned no shipment records."
                : "eBay has no shipping fulfillment for this order yet."
            }
          />
        ) : (
          <div className="scroll-area overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-5 py-2.5 font-medium">Tracking number</th>
                  <th className="px-5 py-2.5 font-medium">Carrier</th>
                  <th className="px-5 py-2.5 font-medium">Shipped</th>
                  <th className="px-5 py-2.5 font-medium">Fulfillment ID</th>
                </tr>
              </thead>
              <tbody>
                {order.fulfillments.map((fulfillment) => (
                  <tr
                    key={fulfillment.id}
                    className="border-b border-border last:border-0"
                  >
                    <td className="px-5 py-2.5 font-mono text-xs text-foreground">
                      {dash(
                        reveal
                          ? fulfillment.trackingNumber
                          : maskTrackingNumber(fulfillment.trackingNumber),
                      )}
                    </td>
                    <td className="px-5 py-2.5 text-foreground">
                      {dash(fulfillment.shippingCarrierCode)}
                    </td>
                    <td className="px-5 py-2.5 text-muted-foreground">
                      {formatDateTime(fulfillment.shippedDate)}
                    </td>
                    <td className="px-5 py-2.5 font-mono text-xs text-muted-foreground">
                      {dash(fulfillment.ebayFulfillmentId)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Sync history for this order ------------------------------------ */}
      <Card className="mt-6">
        <CardHeader
          title="Sync history"
          description="Every run that touched this order, most recent first."
          actions={<OrderSyncBadge state={order.syncState} />}
        />
        <CardBody className="pb-0">
          <DetailList
            items={[
              { label: "eBay Order ID", value: order.ebayOrderId },
              {
                label: "Google Sheet row",
                value:
                  currentRow === null ? (
                    "Not written yet"
                  ) : (
                    <span className="tabular-nums">{currentRow}</span>
                  ),
              },
              { label: "Last sync", value: formatDateTime(order.lastSyncedAt) },
              { label: "Last update", value: formatDateTime(order.updatedAt) },
              {
                label: "Sync status",
                value: order.syncError
                  ? redactSecretsInText(order.syncError)
                  : order.syncState,
              },
            ]}
          />
        </CardBody>

        {syncResults.length === 0 ? (
          <EmptyState
            title="This order has not been through a sync yet"
            description="Run a sync from the dashboard to write it into your sheet."
          />
        ) : (
          <div className="scroll-area mt-4 overflow-x-auto border-t border-border">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-5 py-2.5 font-medium">Run</th>
                  <th className="px-5 py-2.5 font-medium">Operation</th>
                  <th className="px-5 py-2.5 text-right font-medium">Sheet row</th>
                  <th className="px-5 py-2.5 font-medium">Outcome</th>
                  <th className="px-5 py-2.5 font-medium">Detail</th>
                  <th className="px-5 py-2.5 font-medium">Timestamp</th>
                </tr>
              </thead>
              <tbody>
                {syncResults.map((result) => (
                  <tr
                    key={result.id}
                    className="border-b border-border align-top last:border-0"
                  >
                    <td className="px-5 py-3 whitespace-nowrap">
                      <Link
                        href={`/sync-history/${result.syncJobId}`}
                        className="font-mono text-xs text-link hover:underline"
                      >
                        {result.syncJobId.slice(-10)}
                      </Link>
                      {result.attempt > 1 ? (
                        <div className="mt-0.5 text-[11px] text-muted-foreground">
                          attempt {result.attempt}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-5 py-3 whitespace-nowrap text-muted-foreground">
                      {SYNC_OPERATION_LABELS[result.operation] ?? result.operation}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums text-muted-foreground">
                      {result.rowNumber ?? "—"}
                    </td>
                    <td className="px-5 py-3">
                      <SyncOutcomeBadge outcome={result.outcome} />
                    </td>
                    <td className="max-w-sm px-5 py-3 text-muted-foreground">
                      {result.reason ? redactSecretsInText(result.reason) : "—"}
                    </td>
                    <td className="px-5 py-3 whitespace-nowrap text-muted-foreground">
                      {formatDateTime(result.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Raw payload --------------------------------------------------- */}
      <Card className="mt-6">
        <CardHeader
          title="View Raw eBay Data"
          description="The eBay payload exactly as it was received, kept so new field mappings can be applied to orders already imported."
          actions={<Badge tone={reveal ? "warning" : "neutral"}>
            {reveal ? "Unmasked" : "Masked"}
          </Badge>}
        />
        <CardBody>
          {raw ? (
            <details className="group">
              <summary className="cursor-pointer text-sm font-medium text-link hover:underline">
                Show raw API response
              </summary>
              <div className="mt-3">
                <RawJsonViewer data={maskRawPayload(raw, reveal)} masked={!reveal} />
              </div>
              {reveal ? (
                <p className="mt-2 text-xs text-warning">
                  Buyer details are unmasked on this page. Credentials are
                  redacted regardless.
                </p>
              ) : null}
            </details>
          ) : (
            <p className="text-sm text-muted-foreground">
              No raw payload was stored for this order.
            </p>
          )}
        </CardBody>
      </Card>
    </>
  );
}
