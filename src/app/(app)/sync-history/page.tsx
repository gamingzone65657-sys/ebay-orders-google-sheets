import type { Metadata } from "next";
import Link from "next/link";
import type { Prisma } from "@prisma/client";

import { PageHeader } from "@/components/layout/PageHeader";
import { SyncStatusBadge } from "@/components/StatusBadge";
import {
  Badge,
  Card,
  EmptyState,
  Notice,
} from "@/components/ui/primitives";
import { SYNC_JOB_STATUS } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { formatDateTime, formatDuration, formatNumber } from "@/lib/format";
import { getCurrentUser } from "@/lib/session";

export const metadata: Metadata = { title: "Sync History" };

const PAGE_SIZE = 20;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

export default async function SyncHistoryPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const status = first(params.status);
  const trigger = first(params.trigger);
  const page = Math.max(1, Number(first(params.page)) || 1);

  const user = await getCurrentUser();

  const where: Prisma.SyncJobWhereInput = { userId: user.id };
  if (status) where.status = status;
  if (trigger) where.trigger = trigger;

  const [total, jobs] = await Promise.all([
    prisma.syncJob.count({ where }),
    prisma.syncJob.findMany({
      where,
      orderBy: { startedAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const filterHref = (next: { status?: string; trigger?: string; page?: number }) => {
    const search = new URLSearchParams();
    const nextStatus = next.status ?? status;
    const nextTrigger = next.trigger ?? trigger;
    if (nextStatus) search.set("status", nextStatus);
    if (nextTrigger) search.set("trigger", nextTrigger);
    if (next.page && next.page > 1) search.set("page", String(next.page));
    return search.toString() ? `/sync-history?${search}` : "/sync-history";
  };

  const statusFilters = ["", ...Object.values(SYNC_JOB_STATUS)];
  const triggerFilters = ["", "MANUAL", "SCHEDULED", "RETRY", "WEBHOOK"];

  return (
    <>
      <PageHeader
        title="Sync History"
        description={`${formatNumber(total)} run${total === 1 ? "" : "s"} recorded.`}
      />


      <Card className="mt-5">
        <div className="flex flex-wrap items-center gap-6 border-b border-border px-5 py-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs font-medium text-muted-foreground">
              Status
            </span>
            {statusFilters.map((value) => (
              <Link
                key={value || "all"}
                href={filterHref({ status: value, page: 1 })}
                className={`rounded-full px-2.5 py-1 text-xs ${
                  status === value
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-muted"
                }`}
              >
                {value
                  ? value.charAt(0) + value.slice(1).toLowerCase()
                  : "All"}
              </Link>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs font-medium text-muted-foreground">
              Trigger
            </span>
            {triggerFilters.map((value) => (
              <Link
                key={value || "all"}
                href={filterHref({ trigger: value, page: 1 })}
                className={`rounded-full px-2.5 py-1 text-xs ${
                  trigger === value
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-muted"
                }`}
              >
                {value
                  ? value.charAt(0) + value.slice(1).toLowerCase()
                  : "All"}
              </Link>
            ))}
          </div>
        </div>

        {jobs.length === 0 ? (
          <EmptyState
            title="No sync runs match these filters"
            description="Trigger a run from the dashboard to populate the history."
          />
        ) : (
          <div className="scroll-area overflow-x-auto">
            <table className="w-full min-w-[1140px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium">Sync ID</th>
                  <th className="px-4 py-2.5 font-medium">Started</th>
                  <th className="px-4 py-2.5 font-medium">Completed</th>
                  <th className="px-4 py-2.5 text-right font-medium">Duration</th>
                  <th className="px-4 py-2.5 text-right font-medium">
                    Orders found
                  </th>
                  <th className="px-4 py-2.5 text-right font-medium">Inserted</th>
                  <th className="px-4 py-2.5 text-right font-medium">Updated</th>
                  <th className="px-4 py-2.5 text-right font-medium">Skipped</th>
                  <th className="px-4 py-2.5 text-right font-medium">Failed</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => {
                  // A run still in flight has no completion time yet; showing a
                  // duration for it would be a number that keeps changing.
                  const running =
                    job.status === SYNC_JOB_STATUS.RUNNING ||
                    job.status === SYNC_JOB_STATUS.QUEUED;

                  return (
                    <tr
                      key={job.id}
                      className="border-b border-border last:border-0 hover:bg-muted/60"
                    >
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        <Link
                          href={`/sync-history/${job.id}`}
                          className="font-mono text-xs text-link hover:underline"
                          title={job.id}
                        >
                          {job.id.slice(-10)}
                        </Link>
                        <div className="mt-0.5 flex items-center gap-1.5">
                          <span className="text-[11px] text-muted-foreground capitalize">
                            {job.trigger.toLowerCase()}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-foreground">
                        {formatDateTime(job.startedAt)}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-muted-foreground">
                        {running ? "—" : formatDateTime(job.finishedAt)}
                      </td>
                      <td className="px-4 py-2.5 text-right whitespace-nowrap text-muted-foreground">
                        {running ? "—" : formatDuration(job.durationMs)}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                        {formatNumber(job.ordersFetched)}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {formatNumber(job.rowsInserted)}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {formatNumber(job.rowsUpdated)}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {formatNumber(job.rowsSkipped)}
                      </td>
                      <td
                        className={`px-4 py-2.5 text-right tabular-nums ${
                          job.rowsFailed > 0 ? "font-medium text-danger" : ""
                        }`}
                      >
                        {formatNumber(job.rowsFailed)}
                      </td>
                      <td className="px-4 py-2.5">
                        <SyncStatusBadge job={job} />
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
              Page {page} of {pageCount}
            </p>
            <div className="flex items-center gap-2">
              {page > 1 ? (
                <Link
                  href={filterHref({ page: page - 1 })}
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
                  href={filterHref({ page: page + 1 })}
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
