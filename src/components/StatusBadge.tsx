import { Badge, type BadgeTone } from "@/components/ui/primitives";
import {
  SYNC_DISPLAY_STATUS,
  SYNC_OUTCOMES,
  syncDisplayStatus,
  type SyncDisplayStatus,
} from "@/lib/constants";

const CONNECTION_TONES: Record<string, { tone: BadgeTone; label: string }> = {
  CONNECTED: { tone: "success", label: "Connected" },
  DISCONNECTED: { tone: "neutral", label: "Not connected" },
  EXPIRED: { tone: "warning", label: "Token expired" },
  ERROR: { tone: "danger", label: "Error" },
};

export function ConnectionBadge({ status }: { status: string }) {
  const entry = CONNECTION_TONES[status] ?? {
    tone: "neutral" as BadgeTone,
    label: status,
  };
  return <Badge tone={entry.tone}>{entry.label}</Badge>;
}

const JOB_TONES: Record<string, { tone: BadgeTone; label: string }> = {
  QUEUED: { tone: "neutral", label: "Queued" },
  RUNNING: { tone: "info", label: "Running" },
  SUCCESS: { tone: "success", label: "Success" },
  PARTIAL: { tone: "warning", label: "Partial" },
  FAILED: { tone: "danger", label: "Failed" },
  CANCELLED: { tone: "neutral", label: "Cancelled" },
};

export function JobStatusBadge({ status }: { status: string }) {
  const entry = JOB_TONES[status] ?? {
    tone: "neutral" as BadgeTone,
    label: status,
  };
  return <Badge tone={entry.tone}>{entry.label}</Badge>;
}

const DISPLAY_STATUS_TONES: Record<SyncDisplayStatus, BadgeTone> = {
  [SYNC_DISPLAY_STATUS.RUNNING]: "info",
  [SYNC_DISPLAY_STATUS.COMPLETED]: "success",
  [SYNC_DISPLAY_STATUS.COMPLETED_WITH_WARNINGS]: "warning",
  [SYNC_DISPLAY_STATUS.FAILED]: "danger",
  [SYNC_DISPLAY_STATUS.CANCELLED]: "neutral",
};

/**
 * The status the history page shows, which is derived from the run's counters
 * rather than its raw status — a run that "succeeded" while losing rows is
 * reported as completed with warnings.
 */
export function SyncStatusBadge({
  job,
}: {
  job: { status: string; errorCount?: number; rowsFailed?: number };
}) {
  const label = syncDisplayStatus(job);
  return <Badge tone={DISPLAY_STATUS_TONES[label]}>{label}</Badge>;
}

const OUTCOME_TONES: Record<string, BadgeTone> = {
  [SYNC_OUTCOMES.INSERTED]: "success",
  [SYNC_OUTCOMES.UPDATED]: "info",
  [SYNC_OUTCOMES.SKIPPED]: "neutral",
  [SYNC_OUTCOMES.FAILED]: "danger",
};

export function SyncOutcomeBadge({ outcome }: { outcome: string }) {
  const label = outcome.charAt(0) + outcome.slice(1).toLowerCase();
  return <Badge tone={OUTCOME_TONES[outcome] ?? "neutral"}>{label}</Badge>;
}

const ORDER_SYNC_TONES: Record<string, { tone: BadgeTone; label: string }> = {
  SYNCED: { tone: "success", label: "Synced" },
  PENDING: { tone: "info", label: "Pending" },
  SKIPPED: { tone: "neutral", label: "Skipped" },
  FAILED: { tone: "danger", label: "Failed" },
};

export function OrderSyncBadge({ state }: { state: string }) {
  const entry = ORDER_SYNC_TONES[state] ?? {
    tone: "neutral" as BadgeTone,
    label: state,
  };
  return <Badge tone={entry.tone}>{entry.label}</Badge>;
}

const LOG_TONES: Record<string, BadgeTone> = {
  DEBUG: "neutral",
  INFO: "info",
  WARN: "warning",
  ERROR: "danger",
};

export function LogLevelBadge({ level }: { level: string }) {
  return <Badge tone={LOG_TONES[level] ?? "neutral"}>{level}</Badge>;
}

/** Humanises the eBay status strings without mapping them to a fixed set. */
export function OrderStatusBadge({ status }: { status: string }) {
  const tone: BadgeTone =
    status === "COMPLETED"
      ? "success"
      : status === "CANCELLED" || status === "REFUNDED"
        ? "danger"
        : "info";
  const label =
    status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, " ");
  return <Badge tone={tone}>{label}</Badge>;
}
