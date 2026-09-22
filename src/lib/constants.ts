/**
 * String unions that stand in for database enums.
 *
 * SQLite has no enum type, and keeping these in code (rather than as DB enums)
 * means adding a new status in Phase 2+ is a code change, not a migration.
 */

/**
 * A connection is only ever what the provider actually granted.
 *
 * There is deliberately no DEMO state. A placeholder status was how this
 * application used to serve generated orders and fixture spreadsheets without
 * credentials, which meant the UI could report "connected" while nothing was.
 * Connecting now requires a real OAuth grant, and an unconfigured deployment
 * says so rather than showing something that looks like data.
 */
export const CONNECTION_STATUS = {
  DISCONNECTED: "DISCONNECTED",
  CONNECTED: "CONNECTED",
  EXPIRED: "EXPIRED",
  ERROR: "ERROR",
} as const;
export type ConnectionStatus =
  (typeof CONNECTION_STATUS)[keyof typeof CONNECTION_STATUS];

export const SYNC_TRIGGERS = {
  MANUAL: "MANUAL",
  SCHEDULED: "SCHEDULED",
  WEBHOOK: "WEBHOOK",
  /** Re-running one previously failed order, not a whole sync. */
  RETRY: "RETRY",
} as const;
export type SyncTrigger = (typeof SYNC_TRIGGERS)[keyof typeof SYNC_TRIGGERS];

export const SYNC_JOB_KINDS = {
  /** eBay -> database. */
  IMPORT: "IMPORT",
  /** database -> Google Sheets (Phase 3). */
  SHEET_SYNC: "SHEET_SYNC",
} as const;
export type SyncJobKind = (typeof SYNC_JOB_KINDS)[keyof typeof SYNC_JOB_KINDS];

/** Where an ImportedOrder came from. Every order is retrieved from eBay. */
export const ORDER_SOURCES = {
  EBAY: "EBAY",
} as const;
export type OrderSource = (typeof ORDER_SOURCES)[keyof typeof ORDER_SOURCES];

export const SYNC_JOB_STATUS = {
  QUEUED: "QUEUED",
  RUNNING: "RUNNING",
  SUCCESS: "SUCCESS",
  PARTIAL: "PARTIAL",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
} as const;
export type SyncJobStatus =
  (typeof SYNC_JOB_STATUS)[keyof typeof SYNC_JOB_STATUS];

/**
 * What happened to one order (or one line item) during one run.
 *
 * Separate from ORDER_SYNC_STATE, which is the order's *current* state: an
 * order can be SKIPPED by one run and INSERTED by the next, and the history
 * has to keep both.
 */
export const SYNC_OUTCOMES = {
  INSERTED: "INSERTED",
  UPDATED: "UPDATED",
  SKIPPED: "SKIPPED",
  FAILED: "FAILED",
} as const;
export type SyncOutcome = (typeof SYNC_OUTCOMES)[keyof typeof SYNC_OUTCOMES];

export const SYNC_OUTCOME_LABELS: Record<SyncOutcome, string> = {
  INSERTED: "Inserted",
  UPDATED: "Updated",
  SKIPPED: "Skipped",
  FAILED: "Failed",
};

/**
 * The operation a unit was in when it was recorded. Doubles as the "Operation"
 * column of the failed-order table, so these read as steps rather than codes.
 */
export const SYNC_OPERATIONS = {
  MAP: "map",
  DEDUPE: "dedupe",
  WRITE: "sheet.write",
  MODE: "sync.mode",
} as const;

export const SYNC_OPERATION_LABELS: Record<string, string> = {
  map: "Build row",
  dedupe: "Duplicate check",
  "sheet.write": "Write to sheet",
  "sync.mode": "Sync mode",
};

/**
 * The four statuses the history page shows, derived from SYNC_JOB_STATUS.
 *
 * CANCELLED keeps a label of its own rather than being folded into Failed:
 * a run held back for bulk-sync confirmation did not fail, and saying it did
 * would send someone looking for a fault that is not there.
 */
export const SYNC_DISPLAY_STATUS = {
  RUNNING: "Running",
  COMPLETED: "Completed",
  COMPLETED_WITH_WARNINGS: "Completed with warnings",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
} as const;
export type SyncDisplayStatus =
  (typeof SYNC_DISPLAY_STATUS)[keyof typeof SYNC_DISPLAY_STATUS];

export function syncDisplayStatus(job: {
  status: string;
  errorCount?: number;
  rowsFailed?: number;
}): SyncDisplayStatus {
  switch (job.status) {
    case SYNC_JOB_STATUS.QUEUED:
    case SYNC_JOB_STATUS.RUNNING:
      return SYNC_DISPLAY_STATUS.RUNNING;
    case SYNC_JOB_STATUS.FAILED:
      return SYNC_DISPLAY_STATUS.FAILED;
    case SYNC_JOB_STATUS.CANCELLED:
      return SYNC_DISPLAY_STATUS.CANCELLED;
    case SYNC_JOB_STATUS.PARTIAL:
      return SYNC_DISPLAY_STATUS.COMPLETED_WITH_WARNINGS;
    case SYNC_JOB_STATUS.SUCCESS:
      // A run that succeeded overall but lost rows is not a clean "Completed".
      return (job.errorCount ?? 0) > 0 || (job.rowsFailed ?? 0) > 0
        ? SYNC_DISPLAY_STATUS.COMPLETED_WITH_WARNINGS
        : SYNC_DISPLAY_STATUS.COMPLETED;
    default:
      return SYNC_DISPLAY_STATUS.RUNNING;
  }
}

export const ORDER_SYNC_STATE = {
  PENDING: "PENDING",
  SYNCED: "SYNCED",
  SKIPPED: "SKIPPED",
  FAILED: "FAILED",
} as const;
export type OrderSyncState =
  (typeof ORDER_SYNC_STATE)[keyof typeof ORDER_SYNC_STATE];

export const ORDER_STATUSES = [
  "ACTIVE",
  "COMPLETED",
  "CANCELLED",
  "REFUNDED",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const FULFILLMENT_STATUSES = [
  "NOT_STARTED",
  "IN_PROGRESS",
  "FULFILLED",
] as const;

export const PAYMENT_STATUSES = ["PENDING", "PAID", "FAILED", "REFUNDED"] as const;

/** How an order is expanded into spreadsheet rows. */
export const ROW_MODES = {
  /** One row per order; multi-item orders are summarised onto that row. */
  ORDER: "ORDER",
  /** One row per line item; a 3-item order produces 3 rows. */
  LINE_ITEM: "LINE_ITEM",
} as const;
export type RowMode = (typeof ROW_MODES)[keyof typeof ROW_MODES];

export const ROW_MODE_DESCRIPTIONS: Record<RowMode, string> = {
  ORDER:
    "One row per order. Line-item fields show the first item; use the computed fields for all-item summaries.",
  LINE_ITEM:
    "One row per line item. An order with three items writes three rows, each with its own SKU, quantity and price.",
};

/** What a sync run is permitted to do to the sheet. */
export const SYNC_MODES = {
  APPEND: "APPEND",
  UPDATE: "UPDATE",
  APPEND_UPDATE: "APPEND_UPDATE",
} as const;
export type SyncMode = (typeof SYNC_MODES)[keyof typeof SYNC_MODES];

export const SYNC_MODE_DESCRIPTIONS: Record<SyncMode, string> = {
  APPEND:
    "Only add rows for orders that are not in the sheet yet. Existing rows are never touched.",
  UPDATE:
    "Only refresh rows that already exist. New orders are skipped, not added.",
  APPEND_UPDATE:
    "Add rows for new orders and refresh the ones already there. The usual choice.",
};

/** Date windows offered by the sync panel. */
export const SYNC_RANGES = {
  SINCE_LAST: "SINCE_LAST",
  LAST_24H: "LAST_24H",
  LAST_7D: "LAST_7D",
  LAST_30D: "LAST_30D",
  LAST_90D: "LAST_90D",
  CUSTOM: "CUSTOM",
} as const;
export type SyncRange = (typeof SYNC_RANGES)[keyof typeof SYNC_RANGES];

export const SYNC_RANGE_LABELS: Record<SyncRange, string> = {
  SINCE_LAST: "Since last successful sync",
  LAST_24H: "Last 24 hours",
  LAST_7D: "Last 7 days",
  LAST_30D: "Last 30 days",
  LAST_90D: "Last 90 days",
  CUSTOM: "Custom range",
};

/* -------------------------------------------------------------------------- */
/* Filters                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Order states offered by the filter UI.
 *
 * These are *views* over eBay's three independent status fields rather than
 * a single enum, which is why they overlap: one order can be both Paid and
 * Shipped. Selections are OR-ed, and selecting none means "all orders".
 */
export const ORDER_STATE_FILTERS = [
  {
    id: "PAID",
    label: "Paid",
    description: "Payment has completed.",
  },
  {
    id: "AWAITING_PAYMENT",
    label: "Awaiting payment",
    description: "Payment is pending or failed.",
  },
  {
    id: "SHIPPED",
    label: "Shipped",
    description: "eBay reports the order as fulfilled.",
  },
  {
    id: "COMPLETED",
    label: "Completed",
    description: "Derived status is complete.",
  },
  {
    id: "CANCELLED",
    label: "Cancelled",
    description: "Cancelled or refunded.",
  },
] as const;

export type OrderStateFilter = (typeof ORDER_STATE_FILTERS)[number]["id"];

export const FULFILLMENT_FILTERS = [
  {
    id: "UNFULFILLED",
    label: "Unfulfilled",
    description: "Nothing shipped yet.",
  },
  {
    id: "PARTIALLY_FULFILLED",
    label: "Partially fulfilled",
    description: "Some items shipped.",
  },
  {
    id: "FULFILLED",
    label: "Fulfilled",
    description: "Everything shipped.",
  },
] as const;

export type FulfillmentFilter = (typeof FULFILLMENT_FILTERS)[number]["id"];

export const SKU_FILTER_MODES = [
  { id: "ALL", label: "All SKUs", needsValues: false },
  { id: "INCLUDE", label: "Include selected SKUs", needsValues: true },
  { id: "EXCLUDE", label: "Exclude selected SKUs", needsValues: true },
  { id: "CONTAINS", label: "SKU contains", needsValues: true },
  { id: "STARTS_WITH", label: "SKU starts with", needsValues: true },
  { id: "ENDS_WITH", label: "SKU ends with", needsValues: true },
] as const;

export type SkuFilterMode = (typeof SKU_FILTER_MODES)[number]["id"];

/* -------------------------------------------------------------------------- */
/* Scheduling                                                                  */
/* -------------------------------------------------------------------------- */

/** Frequencies offered by the automation UI. Any other value is "custom". */
export const FREQUENCY_PRESETS = [
  { minutes: 15, label: "Every 15 minutes" },
  { minutes: 30, label: "Every 30 minutes" },
  { minutes: 60, label: "Every hour" },
  { minutes: 180, label: "Every 3 hours" },
  { minutes: 360, label: "Every 6 hours" },
  { minutes: 1440, label: "Daily" },
] as const;

export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 10080; // one week

export function frequencyLabel(minutes: number): string {
  const preset = FREQUENCY_PRESETS.find((entry) => entry.minutes === minutes);
  if (preset) return preset.label;
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return `Every ${days} day${days === 1 ? "" : "s"}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `Every ${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `Every ${minutes} minutes`;
}

/**
 * Consecutive failures after which the scheduler stops trying.
 *
 * A permanently broken integration (revoked token, deleted sheet) would
 * otherwise retry forever, burning quota and filling the log.
 */
export const MAX_CONSECUTIVE_FAILURES = 5;

/** A RUNNING job whose worker has not checked in for this long is stale. */
export const JOB_HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000;

/** Live phases reported while a sync runs. */
export const SYNC_PHASES = {
  QUEUED: "QUEUED",
  FETCHING: "FETCHING",
  PROCESSING: "PROCESSING",
  WRITING: "WRITING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
} as const;
export type SyncPhase = (typeof SYNC_PHASES)[keyof typeof SYNC_PHASES];

export const SYNC_PHASE_LABELS: Record<SyncPhase, string> = {
  QUEUED: "Queued…",
  FETCHING: "Fetching orders…",
  PROCESSING: "Processing…",
  WRITING: "Writing to Google Sheets…",
  COMPLETED: "Completed",
  FAILED: "Failed",
};

export const WRITE_MODES = {
  APPEND: "APPEND",
  UPSERT: "UPSERT",
  OVERWRITE: "OVERWRITE",
} as const;
export type WriteMode = (typeof WRITE_MODES)[keyof typeof WRITE_MODES];

export const WRITE_MODE_DESCRIPTIONS: Record<WriteMode, string> = {
  APPEND: "Always add a new row for every order returned by eBay.",
  UPSERT: "Update the row that matches the key column, otherwise append it.",
  OVERWRITE: "Clear the data range and rewrite every row on each sync.",
};

export const LOG_LEVELS = ["DEBUG", "INFO", "WARN", "ERROR"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const USER_ROLES = ["owner", "member", "viewer"] as const;

export const SHEET_COLUMN_TYPES = [
  "text",
  "number",
  "currency",
  "date",
  "boolean",
] as const;
export type SheetColumnType = (typeof SHEET_COLUMN_TYPES)[number];

/** Marketplaces offered in the UI. Extended freely; nothing keys off these. */
export const EBAY_MARKETPLACES = [
  { id: "EBAY_US", label: "eBay United States" },
  { id: "EBAY_GB", label: "eBay United Kingdom" },
  { id: "EBAY_DE", label: "eBay Germany" },
  { id: "EBAY_AU", label: "eBay Australia" },
  { id: "EBAY_CA", label: "eBay Canada" },
] as const;
