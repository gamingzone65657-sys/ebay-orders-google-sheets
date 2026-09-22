import Link from "next/link";
import { AlertTriangle, CheckCircle2, Clock, Loader2, PauseCircle } from "lucide-react";

import { Badge } from "@/components/ui/primitives";
import { SYNC_PHASE_LABELS, type SyncPhase } from "@/lib/constants";
import { formatDateTime, formatRelative } from "@/lib/format";

export interface SyncStatusData {
  lastSuccessAt: Date | null;
  lastSuccessJobId: string | null;
  lastSuccessSummary: string | null;
  lastFailureAt: Date | null;
  lastFailureJobId: string | null;
  lastFailureReason: string | null;
  lastFailureCode: string | null;
  consecutiveFailures: number;
  nextRunAt: Date | null;
  automationEnabled: boolean;
  disabledReason: string | null;
  intervalLabel: string;
  running: {
    jobId: string;
    phase: string;
    trigger: string;
    current: number;
    total: number;
  } | null;
  queued: number;
  /** Upper bound of the window the next incremental run will cover. */
  syncedThrough: Date | null;
}

function Tile({
  label,
  icon,
  tone,
  children,
}: {
  label: string;
  icon: React.ReactNode;
  tone: "ok" | "bad" | "busy" | "idle";
  children: React.ReactNode;
}) {
  const border =
    tone === "ok"
      ? "border-success-border bg-success-bg"
      : tone === "bad"
        ? "border-danger-border bg-danger-bg"
        : tone === "busy"
          ? "border-info-border bg-info-bg"
          : "border-border bg-card";

  return (
    <div className={`rounded-lg border px-4 py-3 ${border}`}>
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {icon}
        {label}
      </p>
      <div className="mt-1.5 text-sm text-foreground">{children}</div>
    </div>
  );
}

export function SyncStatusCards({
  data,
  now,
}: {
  data: SyncStatusData;
  now: Date;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {/* Current status ------------------------------------------------ */}
      <Tile
        label="Current status"
        tone={data.running ? "busy" : data.disabledReason ? "bad" : "idle"}
        icon={
          data.running ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : data.disabledReason ? (
            <PauseCircle className="h-3.5 w-3.5" />
          ) : (
            <Clock className="h-3.5 w-3.5" />
          )
        }
      >
        {data.running ? (
          <>
            <p className="font-medium">
              {SYNC_PHASE_LABELS[data.running.phase as SyncPhase] ??
                data.running.phase}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {data.running.trigger.toLowerCase()} run
              {data.running.total > 0
                ? ` · ${data.running.current}/${data.running.total} rows`
                : ""}
            </p>
            <Link
              href={`/sync-history/${data.running.jobId}`}
              className="mt-1 inline-block text-xs text-link hover:underline"
            >
              Watch this run
            </Link>
          </>
        ) : data.disabledReason ? (
          <>
            <p className="font-medium text-danger">Automation paused</p>
            <p className="mt-0.5 text-xs text-danger">{data.disabledReason}</p>
          </>
        ) : (
          <>
            <p className="font-medium">Idle</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {data.queued > 0
                ? `${data.queued} job(s) waiting in the queue`
                : "Nothing running or queued"}
            </p>
          </>
        )}
      </Tile>

      {/* Last successful ----------------------------------------------- */}
      <Tile
        label="Last successful sync"
        tone={data.lastSuccessAt ? "ok" : "idle"}
        icon={<CheckCircle2 className="h-3.5 w-3.5" />}
      >
        {data.lastSuccessAt ? (
          <>
            <p className="font-medium">
              {formatRelative(data.lastSuccessAt, now)}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {formatDateTime(data.lastSuccessAt)}
            </p>
            {data.lastSuccessSummary ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {data.lastSuccessSummary}
              </p>
            ) : null}
            {data.lastSuccessJobId ? (
              <Link
                href={`/sync-history/${data.lastSuccessJobId}`}
                className="mt-1 inline-block text-xs text-link hover:underline"
              >
                View run
              </Link>
            ) : null}
          </>
        ) : (
          <p className="text-muted-foreground">Never</p>
        )}
      </Tile>

      {/* Last failed ---------------------------------------------------- */}
      <Tile
        label="Last failed sync"
        tone={
          data.lastFailureAt &&
          (!data.lastSuccessAt || data.lastFailureAt > data.lastSuccessAt)
            ? "bad"
            : "idle"
        }
        icon={<AlertTriangle className="h-3.5 w-3.5" />}
      >
        {data.lastFailureAt ? (
          <>
            <p className="font-medium">
              {formatRelative(data.lastFailureAt, now)}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {formatDateTime(data.lastFailureAt)}
            </p>
            {data.lastFailureReason ? (
              <p className="mt-1 line-clamp-3 text-xs text-danger">
                {data.lastFailureCode ? `${data.lastFailureCode}: ` : ""}
                {data.lastFailureReason}
              </p>
            ) : null}
            {data.consecutiveFailures > 1 ? (
              <Badge tone="danger" className="mt-1">
                {data.consecutiveFailures} in a row
              </Badge>
            ) : null}
            {data.lastFailureJobId ? (
              <Link
                href={`/sync-history/${data.lastFailureJobId}`}
                className="mt-1 ml-1 inline-block text-xs text-link hover:underline"
              >
                View run
              </Link>
            ) : null}
          </>
        ) : (
          <p className="text-muted-foreground">None</p>
        )}
      </Tile>

      {/* Next scheduled -------------------------------------------------- */}
      <Tile
        label="Next scheduled sync"
        tone="idle"
        icon={<Clock className="h-3.5 w-3.5" />}
      >
        {data.automationEnabled && data.nextRunAt ? (
          <>
            <p className="font-medium">{formatRelative(data.nextRunAt, now)}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {formatDateTime(data.nextRunAt)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{data.intervalLabel}</p>
          </>
        ) : (
          <>
            <p className="text-muted-foreground">
              {data.automationEnabled ? "Not scheduled" : "Automation is off"}
            </p>
            <Link
              href="/automation"
              className="mt-1 inline-block text-xs text-link hover:underline"
            >
              Configure automation
            </Link>
          </>
        )}
        {data.syncedThrough ? (
          <p className="mt-1 text-[11px] text-muted-foreground">
            Incremental from {formatDateTime(data.syncedThrough)}
          </p>
        ) : null}
      </Tile>
    </div>
  );
}
