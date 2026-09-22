import type { Metadata } from "next";
import Link from "next/link";
import type { Prisma } from "@prisma/client";

import { PageHeader } from "@/components/layout/PageHeader";
import { ImportOrdersPanel } from "@/components/orders/ImportOrdersPanel";
import { OrdersFilters } from "@/components/orders/OrdersFilters";
import { OrderStatusBadge, OrderSyncBadge } from "@/components/StatusBadge";
import { Badge, Card, EmptyState, Notice } from "@/components/ui/primitives";
import { CONNECTION_STATUS } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { formatDate, formatDateTime, formatMoney, formatNumber } from "@/lib/format";
import { maskName, maskTrackingNumber } from "@/lib/mask";
import { getCurrentUser } from "@/lib/session";

export const metadata: Metadata = { title: "Orders" };

const PAGE_SIZE = 25;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const q = first(params.q).trim();
  const sku = first(params.sku).trim();
  const status = first(params.status);
  const syncState = first(params.syncState);
  const marketplaceId = first(params.marketplaceId);
  const from = first(params.from);
  const to = first(params.to);
  const page = Math.max(1, Number(first(params.page)) || 1);

  const user = await getCurrentUser();

  const where: Prisma.ImportedOrderWhereInput = { userId: user.id };
  const and: Prisma.ImportedOrderWhereInput[] = [];

  if (q) {
    // SQLite's LIKE is already case-insensitive for ASCII, so no mode needed.
    and.push({
      OR: [
        { ebayOrderId: { contains: q } },
        { legacyOrderId: { contains: q } },
        { salesRecordRef: { contains: q } },
        { buyerUsername: { contains: q } },
        { buyerName: { contains: q } },
        { trackingNumber: { contains: q } },
        { lineItems: { some: { title: { contains: q } } } },
        { lineItems: { some: { sku: { contains: q } } } },
      ],
    });
  }
  // SKU is its own filter rather than part of search so it can be combined.
  if (sku) and.push({ lineItems: { some: { sku: { contains: sku } } } });
  if (status) and.push({ orderStatus: status });
  if (syncState) and.push({ syncState });
  if (marketplaceId) and.push({ marketplaceId });
  if (from) and.push({ orderDate: { gte: new Date(`${from}T00:00:00.000Z`) } });
  if (to) and.push({ orderDate: { lte: new Date(`${to}T23:59:59.999Z`) } });
  if (and.length > 0) where.AND = and;

  const [total, orders, marketplaceRows, connection, sourceCounts] =
    await Promise.all([
      prisma.importedOrder.count({ where }),
      prisma.importedOrder.findMany({
        where,
        include: { lineItems: { orderBy: { createdAt: "asc" } } },
        orderBy: { orderDate: "desc" },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      prisma.importedOrder.findMany({
        where: { userId: user.id, marketplaceId: { not: null } },
        distinct: ["marketplaceId"],
        select: { marketplaceId: true },
        orderBy: { marketplaceId: "asc" },
      }),
      prisma.ebayConnection.findFirst({
        where: { userId: user.id, isActive: true },
      }),
      prisma.importedOrder.groupBy({
        by: ["source"],
        where: { userId: user.id },
        _count: { _all: true },
      }),
    ]);

  const marketplaces = marketplaceRows
    .map((row) => row.marketplaceId)
    .filter((value): value is string => Boolean(value));

  const liveCount =
    sourceCounts.find((row) => row.source === "EBAY")?._count._all ?? 0;

  const connectionStatus = connection?.status ?? CONNECTION_STATUS.DISCONNECTED;
  const canImport =
    connectionStatus === CONNECTION_STATUS.CONNECTED ||
    connectionStatus === CONNECTION_STATUS.EXPIRED;
  const disabledReason =
    connectionStatus === CONNECTION_STATUS.DISCONNECTED
      ? "Connect an eBay account to import orders."
      : null;

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const buildPageHref = (target: number) => {
    const next = new URLSearchParams();
    if (q) next.set("q", q);
    if (sku) next.set("sku", sku);
    if (status) next.set("status", status);
    if (syncState) next.set("syncState", syncState);
    if (marketplaceId) next.set("marketplaceId", marketplaceId);
    if (from) next.set("from", from);
    if (to) next.set("to", to);
    if (target > 1) next.set("page", String(target));
    return next.toString() ? `/orders?${next}` : "/orders";
  };

  return (
    <>
      <PageHeader
        title="Orders"
        description={`${formatNumber(total)} order${
          total === 1 ? "" : "s"
        } match the current filters.`}
        actions={
          <div className="flex items-center gap-2">
            {liveCount > 0 ? (
              <Badge tone="success">{formatNumber(liveCount)} from eBay</Badge>
            ) : null}

          </div>
        }
      />



      <Card className="mt-5">
        <div className="border-b border-border px-5 py-4">
          <ImportOrdersPanel
            canImport={canImport}
            disabledReason={disabledReason}
          />
        </div>

        <OrdersFilters
          initial={{ q, sku, status, syncState, marketplaceId, from, to }}
          marketplaces={marketplaces}
        />

        {orders.length === 0 ? (
          <EmptyState
            title={
              total === 0 && !q && !sku
                ? "No orders in this workspace yet"
                : "No orders match these filters"
            }
            description={
              total === 0 && !q && !sku
                ? "Connect eBay and run an import to pull your orders in."
                : "Try a different search term or clear the filters."
            }
          />
        ) : (
          <div className="scroll-area overflow-x-auto">
            <table className="w-full min-w-[1220px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium">Order ID</th>
                  <th className="px-4 py-2.5 font-medium">Date</th>
                  <th className="px-4 py-2.5 font-medium">Buyer</th>
                  <th className="px-4 py-2.5 font-medium">SKU</th>
                  <th className="px-4 py-2.5 font-medium">Item</th>
                  <th className="px-4 py-2.5 text-right font-medium">Qty</th>
                  <th className="px-4 py-2.5 text-right font-medium">Price</th>
                  <th className="px-4 py-2.5 font-medium">Tracking</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Last Synced</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => {
                  const firstItem = order.lineItems[0];
                  const extra = order.lineItems.length - 1;
                  return (
                    <tr
                      key={order.id}
                      className="border-b border-border align-top last:border-0 hover:bg-muted/60"
                    >
                      <td className="px-4 py-3 whitespace-nowrap">
                        <Link
                          href={`/orders/${order.id}`}
                          className="font-mono text-xs text-link hover:underline"
                        >
                          {order.ebayOrderId}
                        </Link>
                        <div className="mt-1 flex items-center gap-1">

                          {order.marketplaceId ? (
                            <span className="text-[11px] text-muted-foreground">
                              {order.marketplaceId}
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                        {formatDate(order.orderDate)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-foreground">
                          {order.buyerUsername ?? "—"}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {maskName(order.buyerName) ?? ""}
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-foreground">
                        {firstItem?.sku ?? "—"}
                        {extra > 0 ? (
                          <span className="ml-1 text-muted-foreground">+{extra}</span>
                        ) : null}
                      </td>
                      <td className="max-w-[240px] px-4 py-3">
                        <div className="truncate text-foreground">
                          {firstItem?.title ?? "—"}
                        </div>
                        {extra > 0 ? (
                          <div className="text-xs text-muted-foreground">
                            and {extra} more line item{extra === 1 ? "" : "s"}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-foreground">
                        {order.totalQuantity}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap text-foreground">
                        {formatMoney(order.totalAmount, order.currency)}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs whitespace-nowrap">
                        {order.trackingNumber ? (
                          <span className="text-foreground">
                            {maskTrackingNumber(order.trackingNumber)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">Not shipped</span>
                        )}
                        {order.shippingCarrier ? (
                          <div className="text-[11px] text-muted-foreground">
                            {order.shippingCarrier}
                          </div>
                        ) : null}
                      </td>
                      <td className="space-y-1 px-4 py-3 whitespace-nowrap">
                        <OrderStatusBadge status={order.orderStatus} />
                        <div>
                          <OrderSyncBadge state={order.syncState} />
                        </div>
                        {order.syncError ? (
                          <div className="max-w-[160px] text-[11px] text-danger">
                            {order.syncError}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-xs whitespace-nowrap text-muted-foreground">
                        {order.lastSyncedAt
                          ? formatDateTime(order.lastSyncedAt)
                          : "Never"}
                        <div className="mt-0.5">
                          <Link
                            href={`/orders/${order.id}`}
                            className="text-link hover:underline"
                          >
                            View
                          </Link>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {total > 0 ? (
          <div className="flex items-center justify-between border-t border-border px-5 py-3 text-sm">
            <p className="text-muted-foreground">
              Page {page} of {pageCount} · showing{" "}
              {formatNumber(orders.length)} of {formatNumber(total)}
            </p>
            <div className="flex items-center gap-2">
              {page > 1 ? (
                <Link
                  href={buildPageHref(page - 1)}
                  className="rounded border border-input px-2.5 py-1 text-foreground hover:bg-muted"
                >
                  Previous
                </Link>
              ) : (
                <span className="rounded border border-border px-2.5 py-1 text-muted-foreground/50">
                  Previous
                </span>
              )}
              {page < pageCount ? (
                <Link
                  href={buildPageHref(page + 1)}
                  className="rounded border border-input px-2.5 py-1 text-foreground hover:bg-muted"
                >
                  Next
                </Link>
              ) : (
                <span className="rounded border border-border px-2.5 py-1 text-muted-foreground/50">
                  Next
                </span>
              )}
            </div>
          </div>
        ) : null}
      </Card>
    </>
  );
}
