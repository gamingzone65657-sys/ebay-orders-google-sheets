import type { Metadata } from "next";
import Link from "next/link";
import { CheckCircle2, Circle } from "lucide-react";

import { DashboardActions } from "@/components/dashboard/DashboardActions";
import { StatTile } from "@/components/dashboard/StatTile";
import { SyncStatusCards } from "@/components/dashboard/SyncStatusCards";
import { SyncNowPanel } from "@/components/sync/SyncNowPanel";
import { PageHeader } from "@/components/layout/PageHeader";
import {
  ConnectionBadge,
  JobStatusBadge,
} from "@/components/StatusBadge";
import { ButtonLink } from "@/components/ui/Button";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  DetailList,
  EmptyState,
  Notice,
} from "@/components/ui/primitives";
import { frequencyLabel } from "@/lib/constants";
import { isEbayConfigured } from "@/lib/ebay/config";
import { describeTokenStatus } from "@/lib/ebay/tokens";
import { formatDateTime, formatNumber, formatRelative } from "@/lib/format";
import { getDashboardData } from "@/lib/queries";
import { getCurrentUser } from "@/lib/session";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const user = await getCurrentUser();
  const data = await getDashboardData(user.id);
  const now = new Date();

  const ebayStatus = data.ebayConnection?.status ?? "DISCONNECTED";
  const googleStatus = data.googleConnection?.status ?? "DISCONNECTED";
  const ebayConnected = ebayStatus !== "DISCONNECTED";
  const ebayLive = ebayStatus === "CONNECTED" || ebayStatus === "EXPIRED";
  const googleConnected = googleStatus !== "DISCONNECTED";
  const ebayConfigured = isEbayConfigured();
  const tokenStatus = describeTokenStatus(data.ebayConnection);

  const checklist = [
    { label: "Connect eBay", done: ebayConnected, href: "/settings" },
    { label: "Connect Google", done: googleConnected, href: "/settings" },
    {
      label: "Select a destination spreadsheet",
      done: Boolean(data.sheetConfig),
      href: "/google-sheet",
    },
    {
      label: "Map at least one column",
      done: data.enabledMappingCount > 0,
      href: "/field-mapping",
    },
    {
      label: "Turn on automation",
      done: Boolean(data.automation?.enabled),
      href: "/automation",
    },
  ];

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Connection health, destination sheet, and sync activity for this workspace."
      />

      <div className="mt-5">
        <DashboardActions
          ebayConnected={ebayConnected}
          ebayLive={ebayLive}
          ebayConfigured={ebayConfigured}
          googleConnected={googleConnected}
        />
      </div>

      <div className="mt-6">
        <SyncStatusCards
          now={now}
          data={{
            lastSuccessAt: data.automation?.lastSuccessAt ?? null,
            lastSuccessJobId: data.automation?.lastSuccessJobId ?? null,
            lastSuccessSummary: data.lastSuccessSummary,
            lastFailureAt: data.automation?.lastFailureAt ?? null,
            lastFailureJobId: data.automation?.lastFailureJobId ?? null,
            lastFailureReason: data.automation?.lastFailureReason ?? null,
            lastFailureCode: data.automation?.lastFailureCode ?? null,
            consecutiveFailures: data.automation?.consecutiveFailures ?? 0,
            nextRunAt: data.automation?.nextRunAt ?? null,
            automationEnabled: Boolean(data.automation?.enabled),
            disabledReason: data.automation?.disabledReason ?? null,
            intervalLabel: frequencyLabel(
              data.automation?.intervalMinutes ?? 60,
            ),
            running: data.runningJob
              ? {
                  jobId: data.runningJob.id,
                  phase: data.runningJob.phase,
                  trigger: data.runningJob.trigger,
                  current: data.runningJob.progressCurrent,
                  total: data.runningJob.progressTotal,
                }
              : null,
            queued: data.queuedCount,
            syncedThrough: data.sheetConfig?.lastSyncedThrough ?? null,
          }}
        />
      </div>

      <Card className="mt-6">
        <CardHeader
          title="Sync eBay orders into Google Sheets"
          description={
            data.sheetConfig
              ? `Destination: ${data.sheetConfig.spreadsheetName} / ${data.sheetConfig.sheetName}. Only mapped columns are written.`
              : "Choose a destination spreadsheet to enable syncing."
          }
          actions={
            data.sheetConfig?.lastSyncedThrough ? (
              <Badge tone="neutral">
                Synced through {formatDateTime(data.sheetConfig.lastSyncedThrough)}
              </Badge>
            ) : null
          }
        />
        <CardBody>
          <SyncNowPanel
            hasDestination={Boolean(data.sheetConfig)}
            defaultRowMode={data.sheetConfig?.rowMode ?? "ORDER"}
            defaultSyncMode={data.sheetConfig?.syncMode ?? "APPEND_UPDATE"}
            alreadyConfirmed={Boolean(data.sheetConfig?.bulkSyncConfirmedAt)}
          />
        </CardBody>
      </Card>

      {/* Connections + destination -------------------------------------- */}
      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Card>
          <CardHeader
            title="eBay Connection"
            actions={<ConnectionBadge status={ebayStatus} />}
          />
          <CardBody>
            {data.ebayConnection && ebayConnected ? (
              <DetailList
                items={[
                  {
                    label: "Account",
                    value:
                      data.ebayConnection.ebayUsername ??
                      data.ebayConnection.ebayUserId ??
                      "—",
                  },
                  {
                    label: "Environment",
                    value: data.ebayConnection.environment,
                  },
                  {
                    label: "Marketplace",
                    value: data.ebayConnection.marketplaceId ?? "—",
                  },
                  {
                    label: "Token",
                    value: (
                      <span
                        className={
                          tokenStatus.health === "VALID"
                            ? "text-success"
                            : tokenStatus.health === "MISSING"
                              ? "text-muted-foreground"
                              : "text-warning"
                        }
                      >
                        {tokenStatus.label}
                      </span>
                    ),
                  },
                  {
                    label: "Connected",
                    value: formatRelative(data.ebayConnection.connectedAt, now),
                  },
                  {
                    label: "Last successful API call",
                    value: data.ebayConnection.lastApiSuccessAt
                      ? formatRelative(data.ebayConnection.lastApiSuccessAt, now)
                      : "None yet",
                  },
                ]}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                No eBay account linked. Orders cannot be fetched until eBay is
                connected.
                {!ebayConfigured
                  ? " Server credentials are not configured yet either — see Settings."
                  : ""}
              </p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Google Connection"
            actions={<ConnectionBadge status={googleStatus} />}
          />
          <CardBody>
            {data.googleConnection && googleConnected ? (
              <DetailList
                items={[
                  {
                    label: "Account",
                    value: data.googleConnection.email ?? "—",
                  },
                  {
                    label: "Name",
                    value: data.googleConnection.displayName ?? "—",
                  },
                  {
                    label: "Scopes",
                    value: `${
                      data.googleConnection.scopes?.split(" ").length ?? 0
                    } granted`,
                  },
                  {
                    label: "Connected",
                    value: formatRelative(
                      data.googleConnection.connectedAt,
                      now,
                    ),
                  },
                ]}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                No Google account linked. A spreadsheet cannot be selected until
                Google is connected.
              </p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Selected Spreadsheet"
            actions={
              <ButtonLink href="/google-sheet" size="sm">
                Change
              </ButtonLink>
            }
          />
          <CardBody>
            {data.sheetConfig ? (
              <DetailList
                items={[
                  { label: "Spreadsheet", value: data.sheetConfig.spreadsheetName },
                  { label: "Tab", value: data.sheetConfig.sheetName },
                  {
                    label: "Write mode",
                    value: data.sheetConfig.writeMode,
                  },
                  {
                    label: "Columns detected",
                    value: formatNumber(data.sheetConfig._count.columns),
                  },
                  {
                    label: "Key column",
                    value: data.sheetConfig.matchColumn ?? "Not set",
                  },
                  {
                    label: "Mappings",
                    value: `${data.enabledMappingCount} enabled of ${data.mappingCount}`,
                  },
                ]}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                No destination selected yet. Pick a spreadsheet and tab to
                receive orders.
              </p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Last Sync"
            actions={
              data.lastJob ? <JobStatusBadge status={data.lastJob.status} /> : null
            }
          />
          <CardBody>
            {data.lastJob ? (
              <>
                <p className="text-sm text-foreground">
                  {formatRelative(data.lastJob.startedAt, now)}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {formatDateTime(data.lastJob.startedAt)} ·{" "}
                  {data.lastJob.trigger.toLowerCase()} trigger
                </p>
                <p className="mt-2 text-sm text-muted-foreground">
                  {data.lastJob.summary ?? "No summary recorded."}
                </p>
                <Link
                  href={`/sync-history/${data.lastJob.id}`}
                  className="mt-2 inline-block text-sm text-link hover:underline"
                >
                  View run details
                </Link>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                No sync has run in this workspace yet.
              </p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Next Sync"
            actions={
              <Badge tone={data.automation?.enabled ? "success" : "neutral"}>
                {data.automation?.enabled ? "Automation on" : "Automation off"}
              </Badge>
            }
          />
          <CardBody>
            {data.automation?.enabled && data.automation.nextRunAt ? (
              <>
                <p className="text-sm text-foreground">
                  {formatRelative(data.automation.nextRunAt, now)}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {formatDateTime(data.automation.nextRunAt)}
                </p>
                <p className="mt-2 text-sm text-muted-foreground">
                  Every {data.automation.intervalMinutes} minutes, looking back{" "}
                  {data.automation.lookbackDays} days.
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  The scheduler that fires these runs is built in a later phase;
                  the schedule is stored and shown here today.
                </p>
              </>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  Automation is off. Syncs only run when you press Sync Now.
                </p>
                <Link
                  href="/automation"
                  className="mt-2 inline-block text-sm text-link hover:underline"
                >
                  Configure automation
                </Link>
              </>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Setup checklist" />
          <CardBody className="space-y-2">
            {checklist.map((item) => (
              <Link
                key={item.label}
                href={item.href}
                className="flex items-center gap-2 rounded px-1 py-1 text-sm text-foreground hover:bg-muted"
              >
                {item.done ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
                ) : (
                  <Circle className="h-4 w-4 shrink-0 text-muted-foreground/50" />
                )}
                <span className={item.done ? "text-muted-foreground" : ""}>
                  {item.label}
                </span>
              </Link>
            ))}
          </CardBody>
        </Card>
      </div>

      {/* Counters --------------------------------------------------------- */}
      <div className="mt-8">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-sm font-semibold text-foreground">
            Sync totals across {formatNumber(data.lifetime.runs)} runs
          </h2>
        </div>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatTile
            label="Orders Imported"
            value={formatNumber(data.lifetime.imported)}
            hint="New orders written to the sheet"
          />
          <StatTile
            label="Orders Updated"
            value={formatNumber(data.lifetime.updated)}
            hint="Existing rows refreshed"
          />
          <StatTile
            label="Orders Skipped"
            value={formatNumber(data.lifetime.skipped)}
            hint="Cancelled or unpaid orders"
          />
          <StatTile
            label="Errors"
            value={formatNumber(data.lifetime.errors)}
            hint="Failed rows and blocked runs"
            tone={data.lifetime.errors > 0 ? "danger" : "default"}
          />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatTile
            label="Orders in workspace"
            value={formatNumber(data.orderCount)}
          />
          <StatTile
            label="Awaiting sync"
            value={formatNumber(data.pendingCount)}
          />
          <StatTile
            label="Failed orders"
            value={formatNumber(data.failedCount)}
            tone={data.failedCount > 0 ? "danger" : "default"}
          />
          <StatTile
            label="Active mappings"
            value={`${data.enabledMappingCount} / ${data.mappingCount}`}
          />
        </div>
      </div>

      {/* Recent activity -------------------------------------------------- */}
      <Card className="mt-8">
        <CardHeader
          title="Recent sync runs"
          actions={
            <ButtonLink href="/sync-history" size="sm">
              View all
            </ButtonLink>
          }
        />
        {data.recentJobs.length === 0 ? (
          <EmptyState
            title="No sync runs yet"
            description="Press Sync Now to import orders from eBay and write them to your sheet."
          />
        ) : (
          <div className="scroll-area overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-5 py-2 font-medium">Started</th>
                  <th className="px-5 py-2 font-medium">Trigger</th>
                  <th className="px-5 py-2 font-medium">Status</th>
                  <th className="px-5 py-2 text-right font-medium">Imported</th>
                  <th className="px-5 py-2 text-right font-medium">Updated</th>
                  <th className="px-5 py-2 text-right font-medium">Skipped</th>
                  <th className="px-5 py-2 text-right font-medium">Errors</th>
                  <th className="px-5 py-2" />
                </tr>
              </thead>
              <tbody>
                {data.recentJobs.map((job) => (
                  <tr
                    key={job.id}
                    className="border-b border-border last:border-0"
                  >
                    <td className="px-5 py-2.5 whitespace-nowrap text-foreground">
                      {formatDateTime(job.startedAt)}
                    </td>
                    <td className="px-5 py-2.5 text-muted-foreground capitalize">
                      {job.trigger.toLowerCase()}
                    </td>
                    <td className="px-5 py-2.5">
                      <JobStatusBadge status={job.status} />
                    </td>
                    <td className="px-5 py-2.5 text-right tabular-nums">
                      {job.ordersImported}
                    </td>
                    <td className="px-5 py-2.5 text-right tabular-nums">
                      {job.ordersUpdated}
                    </td>
                    <td className="px-5 py-2.5 text-right tabular-nums">
                      {job.ordersSkipped}
                    </td>
                    <td
                      className={`px-5 py-2.5 text-right tabular-nums ${
                        job.errorCount > 0 ? "text-danger" : ""
                      }`}
                    >
                      {job.errorCount}
                    </td>
                    <td className="px-5 py-2.5 text-right">
                      <Link
                        href={`/sync-history/${job.id}`}
                        className="text-link hover:underline"
                      >
                        Details
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
