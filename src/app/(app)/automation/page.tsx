import type { Metadata } from "next";

import { AutomationForm } from "@/components/automation/AutomationForm";
import { PageHeader } from "@/components/layout/PageHeader";
import { Badge, Card, CardBody, CardHeader, Notice } from "@/components/ui/primitives";
import { prisma } from "@/lib/db";
import { formatDateTime, formatRelative } from "@/lib/format";
import { getCurrentUser } from "@/lib/session";

export const metadata: Metadata = { title: "Automation" };

export default async function AutomationPage() {
  const user = await getCurrentUser();
  const now = new Date();

  const [automation, sheetConfig, enabledMappings, ebayConnection] =
    await Promise.all([
      prisma.automationSetting.findUnique({ where: { userId: user.id } }),
      prisma.googleSheetConfig.findFirst({
        where: { userId: user.id, isActive: true },
      }),
      prisma.fieldMapping.count({
        where: {
          sheetConfig: { userId: user.id, isActive: true },
          savedConfigId: null,
          enabled: true,
        },
      }),
      prisma.ebayConnection.findFirst({
        where: { userId: user.id, isActive: true },
      }),
    ]);

  const blockers: string[] = [];
  if (!ebayConnection || ebayConnection.status === "DISCONNECTED") {
    blockers.push("eBay is not connected.");
  }
  if (!sheetConfig) blockers.push("No destination spreadsheet is selected.");
  if (enabledMappings === 0) blockers.push("No field mappings are enabled.");

  return (
    <>
      <PageHeader
        title="Automation"
        description="Run the sync on a schedule instead of pressing Sync Now."
        actions={
          <Badge tone={automation?.enabled ? "success" : "neutral"}>
            {automation?.enabled ? "Enabled" : "Disabled"}
          </Badge>
        }
      />

      {automation?.disabledReason ? (
        <div className="mb-4 rounded-md border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger">
          <p className="font-medium">Automation was paused automatically</p>
          <p className="mt-1">{automation.disabledReason}</p>
          <p className="mt-1 text-xs">
            Fix the underlying problem, then tick &ldquo;Run syncs
            automatically&rdquo; below and save to resume.
          </p>
        </div>
      ) : null}

      <Notice tone="info" title="Running the background worker">
        A schedule only fires while something is polling for due work. Run{" "}
        <code className="rounded bg-foreground/10 px-1 py-0.5 font-mono text-xs">
          npm run worker
        </code>{" "}
        alongside the app, or point a cron at{" "}
        <code className="rounded bg-foreground/10 px-1 py-0.5 font-mono text-xs">
          POST /api/jobs/tick
        </code>{" "}
        with the <code className="font-mono text-xs">CRON_SECRET</code> header.
        Both are safe to run at once. <strong>Sync Now</strong> always works
        without either.
      </Notice>

      {blockers.length > 0 ? (
        <div className="mt-4">
          <Notice tone="warning" title="Automation cannot run yet">
            <ul className="list-inside list-disc">
              {blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          </Notice>
        </div>
      ) : null}

      <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Schedule"
            description="Applies to every automated run in this workspace."
          />
          <CardBody>
            <AutomationForm
              initial={{
                enabled: automation?.enabled ?? false,
                intervalMinutes: automation?.intervalMinutes ?? 60,
                timezone: automation?.timezone ?? "UTC",
                lookbackDays: automation?.lookbackDays ?? 7,
                activeFromHour: automation?.activeFromHour ?? null,
                activeToHour: automation?.activeToHour ?? null,
                orderStatusFilter: automation?.orderStatusFilter ?? null,
                retryLimit: automation?.retryLimit ?? 3,
                retryBackoffSecs: automation?.retryBackoffSecs ?? 60,
                notifyOnError: automation?.notifyOnError ?? true,
                notifyOnSuccess: automation?.notifyOnSuccess ?? false,
                notifyEmail: automation?.notifyEmail ?? null,
              }}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Current schedule" />
          <CardBody>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Last successful sync</dt>
                <dd className="text-success">
                  {automation?.lastSuccessAt
                    ? formatRelative(automation.lastSuccessAt, now)
                    : "Never"}
                </dd>
                {automation?.lastSuccessAt ? (
                  <dd className="text-xs text-muted-foreground">
                    {formatDateTime(automation.lastSuccessAt)}
                  </dd>
                ) : null}
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Last failed sync</dt>
                <dd
                  className={
                    automation?.lastFailureAt ? "text-danger" : "text-foreground"
                  }
                >
                  {automation?.lastFailureAt
                    ? formatRelative(automation.lastFailureAt, now)
                    : "None"}
                </dd>
                {automation?.lastFailureReason ? (
                  <dd className="text-xs text-danger">
                    {automation.lastFailureCode
                      ? `${automation.lastFailureCode}: `
                      : ""}
                    {automation.lastFailureReason}
                  </dd>
                ) : null}
                {automation && automation.consecutiveFailures > 0 ? (
                  <dd className="text-xs text-muted-foreground">
                    {automation.consecutiveFailures} consecutive failure
                    {automation.consecutiveFailures === 1 ? "" : "s"}
                  </dd>
                ) : null}
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Last run (any outcome)</dt>
                <dd className="text-foreground">
                  {automation?.lastRunAt
                    ? formatRelative(automation.lastRunAt, now)
                    : "Never"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Next run</dt>
                <dd className="text-foreground">
                  {automation?.enabled && automation.nextRunAt
                    ? formatRelative(automation.nextRunAt, now)
                    : "Not scheduled"}
                </dd>
                {automation?.enabled && automation.nextRunAt ? (
                  <dd className="text-xs text-muted-foreground">
                    {formatDateTime(automation.nextRunAt)}
                  </dd>
                ) : null}
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Destination</dt>
                <dd className="text-foreground">
                  {sheetConfig
                    ? `${sheetConfig.spreadsheetName} / ${sheetConfig.sheetName}`
                    : "Not selected"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Enabled mappings</dt>
                <dd className="text-foreground">{enabledMappings}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Status filter</dt>
                <dd className="text-foreground">
                  {automation?.orderStatusFilter ?? "All statuses"}
                </dd>
              </div>
            </dl>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
