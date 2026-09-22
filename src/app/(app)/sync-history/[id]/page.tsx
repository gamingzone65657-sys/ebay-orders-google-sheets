import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { PageHeader } from "@/components/layout/PageHeader";
import {
  LogLevelBadge,
  SyncOutcomeBadge,
  SyncStatusBadge,
} from "@/components/StatusBadge";
import { StatTile } from "@/components/dashboard/StatTile";
import { RetryOrderButton } from "@/components/sync/RetryOrderButton";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  DetailList,
  EmptyState,
  Notice,
} from "@/components/ui/primitives";
import {
  SYNC_OPERATION_LABELS,
  SYNC_OUTCOMES,
  SYNC_TRIGGERS,
} from "@/lib/constants";
import { prisma } from "@/lib/db";
import { formatDateTime, formatDuration, formatNumber } from "@/lib/format";
import { fromJsonColumn } from "@/lib/json";
import { redactSecrets, redactSecretsInText } from "@/lib/mask";
import { getCurrentUser } from "@/lib/session";

export const metadata: Metadata = { title: "Sync run" };

/** Rows shown per outcome section, so one huge run cannot flood the page. */
const SECTION_LIMIT = 200;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

export default async function SyncJobDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const { id } = await params;
  const query = await searchParams;
  const view = first(query.view) || "failed";
  const user = await getCurrentUser();

  const job = await prisma.syncJob.findFirst({
    where: { id, userId: user.id },
    include: {
      logs: { orderBy: { createdAt: "asc" } },
      sheetConfig: true,
      ebayConnection: true,
    },
  });

  if (!job) notFound();

  const [counts, results, sheetConfig] = await Promise.all([
    prisma.syncOrderResult.groupBy({
      by: ["outcome"],
      where: { syncJobId: job.id },
      _count: { _all: true },
    }),
    prisma.syncOrderResult.findMany({
      where: {
        syncJobId: job.id,
        ...(view === "all" ? {} : { outcome: view.toUpperCase() }),
      },
      orderBy: [{ outcome: "asc" }, { createdAt: "asc" }],
      take: SECTION_LIMIT,
      include: {
        order: {
          select: { id: true, ebayOrderId: true, orderDate: true, syncState: true },
        },
      },
    }),
    prisma.googleSheetConfig.findFirst({
      where: { userId: user.id, isActive: true },
      select: { id: true, bulkSyncConfirmedAt: true },
    }),
  ]);

  const countBy = (outcome: string) =>
    counts.find((entry) => entry.outcome === outcome)?._count._all ?? 0;

  const inserted = countBy(SYNC_OUTCOMES.INSERTED);
  const updated = countBy(SYNC_OUTCOMES.UPDATED);
  const skipped = countBy(SYNC_OUTCOMES.SKIPPED);
  const failed = countBy(SYNC_OUTCOMES.FAILED);
  const processed = inserted + updated + skipped + failed;

  // Retrying writes to the *currently selected* destination. If that has
  // changed since this run, a retry would put the row in a different sheet,
  // so it is offered only when the destination still matches.
  const destinationMatches =
    sheetConfig !== null &&
    (job.sheetConfigId === null || job.sheetConfigId === sheetConfig.id);
  const retryBlockedReason = !sheetConfig
    ? "No destination spreadsheet is selected."
    : !destinationMatches
      ? "This run wrote to a different destination than the one selected now."
      : sheetConfig.bulkSyncConfirmedAt === null
        ? "Confirm a sync for this destination before retrying individual orders."
        : undefined;

  const TABS = [
    { id: "failed", label: "Failed", count: failed },
    { id: "inserted", label: "Inserted", count: inserted },
    { id: "updated", label: "Updated", count: updated },
    { id: "skipped", label: "Skipped", count: skipped },
    { id: "all", label: "All processed", count: processed },
  ];

  const tabHref = (next: string) =>
    next === "failed"
      ? `/sync-history/${job.id}`
      : `/sync-history/${job.id}?view=${next}`;

  return (
    <>
      <Link
        href="/sync-history"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to sync history
      </Link>

      <PageHeader
        title="Sync run"
        description={job.summary ?? "No summary recorded for this run."}
        actions={
          <div className="flex items-center gap-2">
            {job.trigger === SYNC_TRIGGERS.RETRY ? (
              <Badge tone="info">Single-order retry</Badge>
            ) : null}
            <SyncStatusBadge job={job} />
          </div>
        }
      />

      {job.errorMessage ? (
        <Notice tone="warning" title="Run error">
          {redactSecretsInText(job.errorMessage)}
        </Notice>
      ) : null}

      {/* --- Totals ----------------------------------------------------- */}
      <div className="mt-5 grid grid-cols-2 gap-4 lg:grid-cols-6">
        <StatTile label="Orders found" value={job.ordersFetched} />
        <StatTile label="Processed" value={processed} />
        <StatTile label="Inserted" value={inserted} />
        <StatTile label="Updated" value={updated} />
        <StatTile label="Skipped" value={skipped} />
        <StatTile
          label="Failed"
          value={failed}
          tone={failed > 0 ? "danger" : "default"}
        />
      </div>

      <Card className="mt-6">
        <CardHeader title="Run details" />
        <CardBody>
          <DetailList
            items={[
              { label: "Sync ID", value: job.id },
              { label: "Trigger", value: job.trigger },
              { label: "Started", value: formatDateTime(job.startedAt) },
              { label: "Completed", value: formatDateTime(job.finishedAt) },
              { label: "Duration", value: formatDuration(job.durationMs) },
              {
                label: "Destination",
                value: job.sheetConfig
                  ? `${job.sheetConfig.spreadsheetName} / ${job.sheetConfig.sheetName}`
                  : "Not recorded",
              },
              {
                label: "eBay account",
                value: job.ebayConnection?.ebayUsername ?? "Not recorded",
              },
              {
                label: "Order window",
                value:
                  job.windowStart && job.windowEnd
                    ? `${formatDateTime(job.windowStart)} → ${formatDateTime(
                        job.windowEnd,
                      )}`
                    : "Not recorded",
              },
              { label: "eBay API calls", value: formatNumber(job.apiCallCount) },
            ]}
          />
        </CardBody>
      </Card>

      {/* --- Per-order results ------------------------------------------ */}
      <Card className="mt-6">
        <CardHeader
          title="Orders in this run"
          description="What happened to each order, and at which step."
        />

        <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-5 py-3">
          {TABS.map((tab) => (
            <Link
              key={tab.id}
              href={tabHref(tab.id)}
              className={`rounded-full px-2.5 py-1 text-xs ${
                view === tab.id
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted"
              }`}
            >
              {tab.label}
              <span className="ml-1.5 tabular-nums opacity-70">{tab.count}</span>
            </Link>
          ))}
        </div>

        {processed === 0 ? (
          <EmptyState
            title="No per-order records for this run"
            description="This run ended before any order was processed, or it predates order-level history."
          />
        ) : results.length === 0 ? (
          <EmptyState title={`No orders were ${view} in this run.`} />
        ) : (
          <div className="scroll-area overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-5 py-2.5 font-medium">Order ID</th>
                  <th className="px-5 py-2.5 font-medium">Operation</th>
                  <th className="px-5 py-2.5 text-right font-medium">Sheet row</th>
                  <th className="px-5 py-2.5 font-medium">Outcome</th>
                  <th className="px-5 py-2.5 font-medium">
                    {view === "failed" ? "Error" : "Detail"}
                  </th>
                  <th className="px-5 py-2.5 font-medium">Timestamp</th>
                  {view === "failed" ? <th className="px-5 py-2.5" /> : null}
                </tr>
              </thead>
              <tbody>
                {results.map((result) => (
                  <tr
                    key={result.id}
                    className="border-b border-border align-top last:border-0"
                  >
                    <td className="px-5 py-3 whitespace-nowrap">
                      {result.order ? (
                        <Link
                          href={`/orders/${result.order.id}`}
                          className="font-mono text-xs text-link hover:underline"
                        >
                          {result.ebayOrderId}
                        </Link>
                      ) : (
                        <span className="font-mono text-xs text-muted-foreground">
                          {result.ebayOrderId}
                        </span>
                      )}
                      {result.lineItemId ? (
                        <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                          item {result.lineItemId}
                        </div>
                      ) : null}
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
                      {result.resolvedAt ? (
                        <div className="mt-1">
                          <Badge tone="success">Resolved</Badge>
                        </div>
                      ) : null}
                    </td>
                    <td className="max-w-md px-5 py-3">
                      <span
                        className={
                          result.outcome === SYNC_OUTCOMES.FAILED
                            ? "text-danger"
                            : "text-muted-foreground"
                        }
                      >
                        {result.reason ? redactSecretsInText(result.reason) : "—"}
                      </span>
                      {result.errorCode ? (
                        <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                          {result.errorCode}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-5 py-3 whitespace-nowrap text-muted-foreground">
                      {formatDateTime(result.createdAt)}
                    </td>
                    {view === "failed" ? (
                      <td className="px-5 py-3 text-right">
                        {result.resolvedAt ? (
                          <span className="text-xs text-muted-foreground">
                            Fixed by a later run
                          </span>
                        ) : (
                          <RetryOrderButton
                            orderId={result.order?.id ?? null}
                            ebayOrderId={result.ebayOrderId}
                            disabled={Boolean(retryBlockedReason)}
                            disabledReason={retryBlockedReason}
                          />
                        )}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
            {results.length === SECTION_LIMIT ? (
              <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
                Showing the first {SECTION_LIMIT} of this outcome.
              </p>
            ) : null}
          </div>
        )}
      </Card>

      {/* --- Logs -------------------------------------------------------- */}
      <Card className="mt-6">
        <CardHeader
          title="Run log"
          description={`${job.logs.length} entr${
            job.logs.length === 1 ? "y" : "ies"
          } recorded for this run.`}
        />
        {job.logs.length === 0 ? (
          <EmptyState title="No log entries were recorded for this run." />
        ) : (
          <ul className="divide-y divide-border">
            {job.logs.map((log) => {
              const context = fromJsonColumn<Record<string, unknown> | null>(
                log.contextJson,
                null,
              );
              return (
                <li key={log.id} className="flex gap-3 px-5 py-3">
                  <div className="w-16 shrink-0 pt-0.5">
                    <LogLevelBadge level={log.level} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-foreground">
                      {redactSecretsInText(log.message)}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {log.step} · {formatDateTime(log.createdAt)}
                    </p>
                    {context ? (
                      <pre className="scroll-area mt-2 overflow-x-auto rounded bg-muted p-2 font-mono text-[11px] text-muted-foreground">
                        {JSON.stringify(redactSecrets(context), null, 2)}
                      </pre>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}
