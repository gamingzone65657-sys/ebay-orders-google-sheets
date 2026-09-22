/**
 * The eBay → Google Sheets synchronization engine.
 *
 *   eBay API → retrieve orders → retrieve line items / fulfillments
 *   → normalize → apply mapping → apply transformations → check duplicate
 *   → insert or update → save result
 *
 * Two entry points share one planning pass, so the preview a user confirms is
 * computed by exactly the code that then performs the write:
 *
 *   planSync()  — everything except the write. Backs the preview.
 *   runSheetSync() — plan, then write, then record.
 *
 * Failure policy: one bad order must not stop the run. Planning and writing
 * are both per-unit guarded, and anything that fails is recorded against the
 * order rather than aborting the job.
 */

import { createHash } from "node:crypto";

import type { GoogleSheetConfig, GoogleConnection } from "@prisma/client";

import {
  CONNECTION_STATUS,
  ORDER_SYNC_STATE,
  ROW_MODES,
  SYNC_JOB_STATUS,
  SYNC_MODES,
  SYNC_OPERATIONS,
  SYNC_OUTCOMES,
  SYNC_PHASES,
  SYNC_RANGES,
  SYNC_TRIGGERS,
  type RowMode,
  type SyncMode,
  type SyncOutcome,
  type SyncRange,
  type SyncTrigger,
} from "@/lib/constants";
import { prisma } from "@/lib/db";
import { importOrders } from "@/lib/ebay/import-orders";
import { getActiveEbayConnection } from "@/lib/ebay/tokens";
import { describeGoogleError, GoogleApiError } from "@/lib/google/errors";
import {
  assertWritable,
  readKeyColumn,
  readUsedRange,
  writeRows,
  ensureRowCapacity,
  type CellWrite,
  type RowWrite,
} from "@/lib/google/sheets-write";
import { getActiveGoogleConnection } from "@/lib/google/tokens";
import { fromJsonColumn, toJsonColumn } from "@/lib/json";
import type { EbayOrderPayload } from "@/lib/ebay/order-payload";
import { buildWritePlan } from "@/lib/sheets/write-plan";

import { expandOrderToRows, resolveCell, type MappingInput } from "./build-row";
import {
  buildOrderWhere,
  describeFilter,
  orderMatchesSkuFilter,
  skuMatches,
  toFilterSettings,
} from "./filters";
import {
  evaluateRules,
  type CompiledRule,
  type RuleActionArgs,
  type RuleCondition,
} from "./rules";

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export type RowAction =
  | "INSERT"
  | "UPDATE"
  | "SKIP_UNCHANGED"
  | "SKIP_MODE"
  | "FAILED";

export interface PlannedRow {
  rowKey: string;
  orderId: string;
  ebayOrderId: string;
  lineItemId: string | null;
  cells: CellWrite[];
  valuesHash: string;
  existingRow: number | null;
  targetRow: number | null;
  action: RowAction;
  reason?: string;
}

/** An order that never became a row, and why. */
export interface BuildFailure {
  orderId: string;
  ebayOrderId: string;
  reason: string;
}

export interface SyncPlan {
  sheetConfigId: string;
  spreadsheetName: string;
  sheetName: string;
  rowMode: RowMode;
  syncMode: SyncMode;
  windowStart: Date;
  windowEnd: Date;

  ordersFound: number;
  ordersNew: number;
  ordersExisting: number;
  rowsToInsert: number;
  rowsToUpdate: number;
  rowsUnchanged: number;
  rowsSkippedByMode: number;
  /**
   * Orders that could not be turned into a row at all. Carried on the plan
   * rather than flattened into a warning string so the run can record one per
   * order — an order that fails to build must stay visible and retryable,
   * not become a line in a log.
   */
  buildFailures: BuildFailure[];

  /** Human-readable list of the filters that were applied. */
  filterSummary: string[];
  /** Rows dropped by the SKU filter, and by the rule set. */
  filteredBySku: number;
  excludedByRule: number;
  /** Rule id → how many rows it matched, for the rules UI. */
  ruleMatchCounts: Record<string, number>;

  /** Column headers that will be written, in sheet order. */
  fieldsWritten: { header: string; letter: string; sourceField: string }[];
  rows: PlannedRow[];
  /** Conditions that make writing unsafe. Non-empty means refuse to write. */
  blockers: string[];
  warnings: string[];
  /** True once the destination has been confirmed for bulk syncing. */
  confirmationRequired: boolean;
  apiCalls: number;
}

export interface SyncOptions {
  range?: SyncRange;
  customFrom?: Date;
  customTo?: Date;
  rowMode?: RowMode;
  syncMode?: SyncMode;
  /** Skip the eBay import and plan against orders already in the database. */
  skipImport?: boolean;
  trigger?: SyncTrigger;
  /** Required for the first bulk sync into a destination. */
  confirmed?: boolean;
  /** Job to report progress into; one is created when omitted. */
  jobId?: string;
  /**
   * Restrict the run to these ImportedOrder ids.
   *
   * Set by a single-order retry. The date window and the stored order filter
   * are bypassed for these — the point of a retry is this order, and the
   * window that produced the original failure has usually moved on. The SKU
   * filter and the rule set still apply, because those decide whether the row
   * is supposed to exist at all.
   */
  onlyOrderIds?: string[];
}

export interface SheetSyncResult {
  jobId: string;
  status: string;
  phase: string;
  found: number;
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  summary: string;
  blockers: string[];
  errorCode?: string;
  errorMessage?: string;
  confirmationRequired?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Date ranges                                                                 */
/* -------------------------------------------------------------------------- */

const DAY_MS = 24 * 60 * 60 * 1000;

/** How far back to look when "since last sync" has no previous run. */
const FIRST_RUN_LOOKBACK_DAYS = 30;

export function resolveRange(
  range: SyncRange,
  config: Pick<GoogleSheetConfig, "lastSyncedThrough">,
  options: { customFrom?: Date; customTo?: Date; now?: Date } = {},
): { start: Date; end: Date; label: string } {
  const now = options.now ?? new Date();

  switch (range) {
    case SYNC_RANGES.LAST_24H:
      return { start: new Date(now.getTime() - DAY_MS), end: now, label: "last 24 hours" };
    case SYNC_RANGES.LAST_7D:
      return { start: new Date(now.getTime() - 7 * DAY_MS), end: now, label: "last 7 days" };
    case SYNC_RANGES.LAST_30D:
      return { start: new Date(now.getTime() - 30 * DAY_MS), end: now, label: "last 30 days" };
    case SYNC_RANGES.LAST_90D:
      return { start: new Date(now.getTime() - 90 * DAY_MS), end: now, label: "last 90 days" };
    case SYNC_RANGES.CUSTOM: {
      const start = options.customFrom ?? new Date(now.getTime() - 30 * DAY_MS);
      const end = options.customTo ?? now;
      return { start, end, label: "custom range" };
    }
    case SYNC_RANGES.SINCE_LAST:
    default: {
      if (config.lastSyncedThrough) {
        // Overlap slightly: an order modified moments before the previous
        // cutoff could have been written before eBay finished updating it.
        const start = new Date(config.lastSyncedThrough.getTime() - 60 * 60 * 1000);
        return { start, end: now, label: "since last successful sync" };
      }
      return {
        start: new Date(now.getTime() - FIRST_RUN_LOOKBACK_DAYS * DAY_MS),
        end: now,
        label: `first run (last ${FIRST_RUN_LOOKBACK_DAYS} days)`,
      };
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function hashCells(cells: CellWrite[]): string {
  const canonical = cells
    .slice()
    .sort((a, b) => a.columnIndex - b.columnIndex)
    .map((cell) => `${cell.columnIndex}:${cell.value}`)
    .join("\u0000");
  return createHash("sha1").update(canonical).digest("hex").slice(0, 16);
}

/* -------------------------------------------------------------------------- */
/* Per-order outcome records                                                   */
/* -------------------------------------------------------------------------- */

interface OrderResultDraft {
  orderId: string;
  ebayOrderId: string;
  lineItemId: string | null;
  dedupeKey: string;
  outcome: SyncOutcome;
  operation: string;
  reason: string | null;
  errorCode: string | null;
  rowNumber: number | null;
}

/**
 * What the plan already knows about a row, before any write is attempted.
 *
 * An INSERT/UPDATE starts as FAILED-not-attempted rather than as a success:
 * if the run dies before the write loop reaches it, the record left behind
 * has to say the row never made it, not that it was written.
 */
function plannedOutcome(row: PlannedRow): Pick<
  OrderResultDraft,
  "outcome" | "operation" | "reason" | "errorCode"
> {
  switch (row.action) {
    case "FAILED":
      return {
        outcome: SYNC_OUTCOMES.FAILED,
        operation: SYNC_OPERATIONS.MAP,
        reason: row.reason ?? "The row could not be built from this order.",
        errorCode: "MAPPING_FAILED",
      };
    case "SKIP_UNCHANGED":
      return {
        outcome: SYNC_OUTCOMES.SKIPPED,
        operation: SYNC_OPERATIONS.DEDUPE,
        reason: row.reason ?? "Already in the sheet with these values.",
        errorCode: null,
      };
    case "SKIP_MODE":
      return {
        outcome: SYNC_OUTCOMES.SKIPPED,
        operation: SYNC_OPERATIONS.MODE,
        reason: row.reason ?? "Excluded by the current sync mode.",
        errorCode: null,
      };
    default:
      return {
        outcome: SYNC_OUTCOMES.FAILED,
        operation: SYNC_OPERATIONS.WRITE,
        reason: "Not attempted — the run ended before this row was written.",
        errorCode: "NOT_ATTEMPTED",
      };
  }
}

async function setPhase(
  jobId: string,
  phase: string,
  label?: string,
  progress?: { current?: number; total?: number },
): Promise<void> {
  await prisma.syncJob
    .update({
      where: { id: jobId },
      data: {
        phase,
        progressLabel: label ?? null,
        ...(progress?.current !== undefined
          ? { progressCurrent: progress.current }
          : {}),
        ...(progress?.total !== undefined
          ? { progressTotal: progress.total }
          : {}),
      },
    })
    .catch(() => undefined);
}

/* -------------------------------------------------------------------------- */
/* Planning                                                                    */
/* -------------------------------------------------------------------------- */

export async function planSync(
  userId: string,
  options: SyncOptions = {},
  hooks: { onPhase?: (phase: string, label: string) => Promise<void> } = {},
): Promise<SyncPlan> {
  const sheetConfig = await prisma.googleSheetConfig.findFirst({
    where: { userId, isActive: true },
    include: {
      columns: { orderBy: { position: "asc" } },
      fieldMappings: {
        where: { savedConfigId: null },
        orderBy: { position: "asc" },
      },
      filter: true,
      rules: { orderBy: { position: "asc" } },
    },
  });

  if (!sheetConfig) {
    throw new Error("No destination spreadsheet is selected.");
  }

  const rowMode = (options.rowMode ?? sheetConfig.rowMode) as RowMode;
  const syncMode = (options.syncMode ?? sheetConfig.syncMode) as SyncMode;
  const perLineItem = rowMode === ROW_MODES.LINE_ITEM;

  const { start, end } = resolveRange(
    options.range ?? SYNC_RANGES.SINCE_LAST,
    sheetConfig,
    { customFrom: options.customFrom, customTo: options.customTo },
  );

  const blockers: string[] = [];
  const warnings: string[] = [];

  // --- Safety: which columns may be touched at all ------------------------
  const writePlan = buildWritePlan(
    sheetConfig.columns.map((column) => ({
      header: column.header,
      position: column.position,
      letter: column.letter,
    })),
    sheetConfig.fieldMappings.map((mapping) => ({
      targetColumn: mapping.targetColumn,
      sourceField: mapping.sourceField,
      enabled: mapping.enabled,
      position: mapping.position,
    })),
  );
  blockers.push(...writePlan.blockers);
  warnings.push(...writePlan.warnings);

  // Only mappings that resolve to a real, existing column are writable.
  const columnByHeader = new Map(
    sheetConfig.columns.map((column) => [
      column.header.trim().toLowerCase(),
      column,
    ]),
  );

  const writableMappings = sheetConfig.fieldMappings
    .filter((mapping) => mapping.enabled && mapping.targetColumn.trim() !== "")
    .map((mapping) => ({
      mapping,
      column: columnByHeader.get(mapping.targetColumn.trim().toLowerCase()),
    }))
    .filter(
      (entry): entry is { mapping: (typeof sheetConfig.fieldMappings)[number]; column: NonNullable<typeof entry.column> } =>
        entry.column !== undefined,
    );

  // --- Safety: the key column ---------------------------------------------
  const matchHeader = sheetConfig.matchColumn?.trim() ?? "";
  const keyColumn = matchHeader
    ? columnByHeader.get(matchHeader.toLowerCase())
    : undefined;

  if (!matchHeader) {
    blockers.push(
      "No key column is set. Choose the column that uniquely identifies a row so orders can be matched instead of duplicated.",
    );
  } else if (!keyColumn) {
    blockers.push(
      `The key column "${matchHeader}" is not in the header row. Re-read the headers or pick a different key column.`,
    );
  } else if (
    !writableMappings.some(
      (entry) => entry.column.position === keyColumn.position,
    )
  ) {
    blockers.push(
      `The key column "${matchHeader}" has no enabled mapping, so new rows would be written without a key and could be duplicated on the next run.`,
    );
  }

  // --- Filters and rules ---------------------------------------------------
  const filter = toFilterSettings(sheetConfig.filter);
  const compiledRules: CompiledRule[] = sheetConfig.rules.map((rule) => ({
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    position: rule.position,
    match: rule.match === "ANY" ? "ANY" : "ALL",
    conditions: fromJsonColumn<RuleCondition[]>(rule.conditionsJson, []),
    action: rule.action as CompiledRule["action"],
    args: fromJsonColumn<RuleActionArgs>(rule.actionArgsJson, {}),
  }));

  // --- Load orders ---------------------------------------------------------
  await hooks.onPhase?.(SYNC_PHASES.PROCESSING, "Processing…");

  const targeted = (options.onlyOrderIds ?? []).filter(Boolean);

  const orders = await prisma.importedOrder.findMany({
    where: targeted.length > 0
      ? { userId, id: { in: targeted } }
      : buildOrderWhere(userId, { start, end }, filter),
    include: { lineItems: { orderBy: { createdAt: "asc" } } },
    orderBy: { orderDate: "asc" },
  });

  /** Compiles a mapping list against the sheet's real columns. */
  const compileMappings = (
    source: {
      targetColumn: string;
      sourceField: string;
      transformation: string;
      transformArgsJson?: string | null;
      fallbackValue?: string | null;
      staticValue?: string | null;
      enabled: boolean;
      position: number;
    }[],
  ): (MappingInput & { columnIndex: number })[] =>
    source
      .filter((entry) => entry.enabled && entry.targetColumn.trim() !== "")
      .map((entry) => ({
        entry,
        column: columnByHeader.get(entry.targetColumn.trim().toLowerCase()),
      }))
      .filter((pair) => pair.column !== undefined)
      .map((pair) => ({
        targetColumn: pair.entry.targetColumn,
        sourceField: pair.entry.sourceField,
        transformation: pair.entry.transformation,
        transformArgsJson: pair.entry.transformArgsJson ?? null,
        fallbackValue: pair.entry.fallbackValue ?? null,
        staticValue: pair.entry.staticValue ?? null,
        enabled: true,
        position: pair.entry.position,
        columnIndex: pair.column!.position,
      }));

  const defaultMappings = compileMappings(sheetConfig.fieldMappings);

  // Alternate mapping sets, loaded only if a USE_MAPPING_SET rule needs them.
  const mappingSetCache = new Map<
    string,
    (MappingInput & { columnIndex: number })[]
  >();
  const neededSetIds = [
    ...new Set(
      compiledRules
        .filter((rule) => rule.enabled && rule.action === "USE_MAPPING_SET")
        .map((rule) => rule.args.savedConfigId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  if (neededSetIds.length > 0) {
    const savedConfigs = await prisma.savedConfiguration.findMany({
      where: { id: { in: neededSetIds }, userId },
    });
    for (const saved of savedConfigs) {
      const payload = fromJsonColumn<{
        mappings?: {
          targetColumn: string;
          sourceField: string;
          transformation?: string;
          transformArgs?: Record<string, string>;
          fallbackValue?: string | null;
          staticValue?: string | null;
          enabled?: boolean;
        }[];
      }>(saved.payloadJson, {});

      mappingSetCache.set(
        saved.id,
        compileMappings(
          (payload.mappings ?? []).map((mapping, index) => ({
            targetColumn: mapping.targetColumn,
            sourceField: mapping.sourceField,
            transformation: mapping.transformation ?? "none",
            transformArgsJson: mapping.transformArgs
              ? JSON.stringify(mapping.transformArgs)
              : null,
            fallbackValue: mapping.fallbackValue ?? null,
            staticValue: mapping.staticValue ?? null,
            enabled: mapping.enabled ?? true,
            position: index,
          })),
        ),
      );
    }

    const missing = neededSetIds.filter((id) => !mappingSetCache.has(id));
    if (missing.length > 0) {
      warnings.push(
        `${missing.length} rule(s) point at a saved configuration that no longer exists; those rows use the default mappings.`,
      );
    }
  }

  // --- Build rows ----------------------------------------------------------
  const syncedAt = new Date();
  const rows: PlannedRow[] = [];
  const failures: BuildFailure[] = [];
  const ruleMatchCounts = new Map<string, number>();

  let ordersFilteredBySku = 0;
  let rowsExcludedByRule = 0;
  let rowsRetargeted = 0;

  for (const order of orders) {
    try {
      const payload = fromJsonColumn<EbayOrderPayload | null>(
        order.rawPayloadJson,
        null,
      );
      if (!payload) {
        failures.push({
          orderId: order.id,
          ebayOrderId: order.ebayOrderId,
          reason: "No stored eBay payload; re-import this order.",
        });
        continue;
      }

      // Shipment details do not live in the stored payload.
      //
      // eBay's Orders API does not return tracking — it comes from a separate
      // shipping_fulfillment call, which the importer writes to the order's
      // own columns. The mapper resolves every source field as a path into
      // this payload, so without merging them here the documented
      // `order.fulfillment.*` fields would resolve to nothing and a tracking
      // column would stay on its fallback forever, however many times eBay
      // reported the shipment.
      //
      // Merged rather than overwritten: a payload that already carries a
      // fulfillment object keeps it.
      if (!payload.fulfillment && (order.trackingNumber || order.shippedAt)) {
        (payload as EbayOrderPayload & { fulfillment?: unknown }).fulfillment = {
          trackingNumber: order.trackingNumber,
          shippingCarrierCode: order.shippingCarrier,
          // ISO, matching every other date in the payload, so a date_format
          // transformation behaves the same here as on any other field.
          shippedDate: order.shippedAt ? order.shippedAt.toISOString() : null,
        };
      }

      // In one-row-per-order mode the SKU filter is an order-level decision,
      // because dropping a whole multi-item order over one item would
      // silently lose the rest.
      //
      // SKUs come from the stored payload, not the OrderLineItem rows: the
      // payload is what the mapper reads, and filtering on a second source
      // could silently disagree with what actually gets written.
      if (
        !perLineItem &&
        !orderMatchesSkuFilter(
          (Array.isArray(payload.lineItems) ? payload.lineItems : []).map(
            (item) => item?.sku ?? null,
          ),
          filter,
        )
      ) {
        ordersFilteredBySku += 1;
        continue;
      }

      const contexts = expandOrderToRows(payload, perLineItem, syncedAt);

      contexts.forEach((context, index) => {
        // Per-line-item mode filters each row on its own SKU.
        if (perLineItem && !skuMatches(context.lineItem?.sku ?? null, filter)) {
          ordersFilteredBySku += 1;
          return;
        }

        const outcome = evaluateRules(compiledRules, context);
        for (const ruleId of outcome.matchedRuleIds) {
          ruleMatchCounts.set(ruleId, (ruleMatchCounts.get(ruleId) ?? 0) + 1);
        }

        if (!outcome.include) {
          rowsExcludedByRule += 1;
          return;
        }

        const mappings = outcome.mappingSetId
          ? (mappingSetCache.get(outcome.mappingSetId) ?? defaultMappings)
          : defaultMappings;
        if (outcome.mappingSetId && mappingSetCache.has(outcome.mappingSetId)) {
          rowsRetargeted += 1;
        }

        const cells = mappings.map((mapping) => ({
          columnIndex: mapping.columnIndex,
          value: resolveCell(mapping, context),
        }));

        // SET_VALUE rules override the mapped result, so a rule always wins
        // over the mapping it is meant to correct.
        if (outcome.overrides.size > 0) {
          for (const [header, value] of outcome.overrides) {
            const column = columnByHeader.get(header.toLowerCase());
            if (!column) continue;
            const existing = cells.find(
              (cell) => cell.columnIndex === column.position,
            );
            if (existing) existing.value = value;
            else cells.push({ columnIndex: column.position, value });
          }
        }

        // The row key is whatever actually lands in the key column, because
        // that is what a future run will read back out of the sheet.
        const keyCell = keyColumn
          ? cells.find((cell) => cell.columnIndex === keyColumn.position)
          : undefined;
        const rowKey = (keyCell?.value ?? "").trim();

        rows.push({
          rowKey,
          orderId: order.id,
          ebayOrderId: order.ebayOrderId,
          lineItemId:
            perLineItem && context.lineItem
              ? (context.lineItem.lineItemId ?? String(index + 1))
              : null,
          cells,
          valuesHash: hashCells(cells),
          existingRow: null,
          targetRow: null,
          action: "INSERT",
        });
      });
    } catch (error) {
      failures.push({
        orderId: order.id,
        ebayOrderId: order.ebayOrderId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (ordersFilteredBySku > 0) {
    warnings.push(
      `${ordersFilteredBySku} ${perLineItem ? "row" : "order"}(s) were filtered out by the SKU filter.`,
    );
  }
  if (rowsExcludedByRule > 0) {
    warnings.push(`${rowsExcludedByRule} row(s) were excluded by your rules.`);
  }
  if (rowsRetargeted > 0) {
    warnings.push(
      `${rowsRetargeted} row(s) were built with an alternate saved configuration.`,
    );
  }

  for (const failure of failures) {
    warnings.push(`${failure.ebayOrderId}: ${failure.reason}`);
  }

  // --- Duplicate protection -------------------------------------------------
  const missingKeys = rows.filter((row) => row.rowKey === "").length;
  if (missingKeys > 0) {
    blockers.push(
      `${missingKeys} row(s) would be written with an empty key column. They cannot be de-duplicated, so the sync is refused.`,
    );
  }

  const keyCounts = new Map<string, number>();
  for (const row of rows) {
    if (row.rowKey === "") continue;
    keyCounts.set(row.rowKey, (keyCounts.get(row.rowKey) ?? 0) + 1);
  }
  const collidingKeys = [...keyCounts.entries()].filter(([, count]) => count > 1);
  if (collidingKeys.length > 0) {
    blockers.push(
      perLineItem
        ? `The key column does not uniquely identify a line item — ${collidingKeys.length} key(s) repeat across rows. Map the key column to "Row Key (unique)" or the line item id.`
        : `${collidingKeys.length} key(s) repeat across the orders in this window, which would collapse distinct orders onto one row.`,
    );
  }

  // --- Reconcile against the sheet -----------------------------------------
  let apiCalls = 0;
  // Reconciling against the sheet requires a live connection. Without one the
  // planner falls back to the locally recorded row links so a preview can
  // still be shown — it never invents sheet contents.
  const connection = await getActiveGoogleConnection(userId);
  const canReadSheet = connection?.status === CONNECTION_STATUS.CONNECTED;

  let existingByKey = new Map<string, number>();
  let lastPopulatedRow = sheetConfig.firstDataRow - 1;

  if (keyColumn && canReadSheet && connection) {
    const index = await readKeyColumn(
      connection,
      sheetConfig.spreadsheetId,
      sheetConfig.sheetName,
      keyColumn.position,
      sheetConfig.firstDataRow,
    );
    apiCalls += index.apiCalls;
    existingByKey = index.byKey;
    lastPopulatedRow = index.lastPopulatedRow;
    if (index.duplicateKeys.length > 0) {
      warnings.push(
        `The sheet already contains ${index.duplicateKeys.length} duplicated key(s); the first row of each is used and the others are left alone.`,
      );
    }

    // The key column is not enough to say where the data ends: a row whose
    // key cell is blank is still a row.
    //
    // Probed across every column the sheet is known to have, not just the
    // mapped ones. A note in a column this sync never writes still means the
    // row is in use, and reading only as far as the last mapped column would
    // make exactly that row look empty and invite an append on top of it.
    const widestColumn = Math.max(
      keyColumn.position,
      ...sheetConfig.columns.map((column) => column.position),
    );
    const used = await readUsedRange(
      connection,
      sheetConfig.spreadsheetId,
      sheetConfig.sheetName,
      sheetConfig.firstDataRow,
      widestColumn,
    );
    apiCalls += used.apiCalls;

    if (used.lastPopulatedRow > lastPopulatedRow) {
      // A row with no key is only alarming if it looks like an order this app
      // would have written — that is, it holds data in the columns this sync
      // maps. A note someone typed in an unrelated column is not an order, and
      // refusing to sync because of it would be wrong.
      //
      // The distinction matters: unrecognisable *order* rows mean the key
      // column is wrong and a sync would append a second copy of every one of
      // them. Stray notes mean nothing except that the data starts lower down.
      const mappedIndexes = writableMappings
        .map((entry) => entry.column.position)
        .filter((position) => position !== keyColumn.position);

      const ordersWithoutKeys = used.rows.filter((row, offset) => {
        const rowNumber = used.firstRow + offset;
        if (rowNumber <= lastPopulatedRow) return false; // already keyed
        if ((row[keyColumn.position] ?? "") !== "") return false;
        return mappedIndexes.some((index) => (row[index] ?? "") !== "");
      }).length;

      if (ordersWithoutKeys > 0) {
        blockers.push(
          `${ordersWithoutKeys} row(s) hold order data but have nothing in the key column "${keyColumn.header}", so they cannot be matched and syncing would append a duplicate of each. Check that the key column is the one holding your order numbers.`,
        );
      } else {
        warnings.push(
          `${used.lastPopulatedRow - lastPopulatedRow} row(s) below the last keyed row hold no order data. They are left untouched and new rows are appended after them.`,
        );
      }

      lastPopulatedRow = used.lastPopulatedRow;
    }
  } else if (keyColumn) {
    // No live connection: fall back to the row links recorded locally so a
    // preview still shows sensible new/existing counts.
    const links = await prisma.sheetRowLink.findMany({
      where: { sheetConfigId: sheetConfig.id },
    });
    existingByKey = new Map(links.map((link) => [link.dedupeKey, link.rowNumber]));
    lastPopulatedRow = links.reduce(
      (max, link) => Math.max(max, link.rowNumber),
      sheetConfig.firstDataRow - 1,
    );
  }

  const priorHashes = new Map(
    (
      await prisma.sheetRowLink.findMany({
        where: { sheetConfigId: sheetConfig.id },
        select: { dedupeKey: true, valuesHash: true },
      })
    ).map((link) => [link.dedupeKey, link.valuesHash]),
  );

  // --- Classify -------------------------------------------------------------
  let nextRow = Math.max(lastPopulatedRow + 1, sheetConfig.firstDataRow);
  const seenOrders = new Set<string>();
  const newOrders = new Set<string>();
  const existingOrders = new Set<string>();

  for (const row of rows) {
    seenOrders.add(row.ebayOrderId);
    const existing = row.rowKey ? existingByKey.get(row.rowKey) : undefined;
    row.existingRow = existing ?? null;

    if (existing) {
      existingOrders.add(row.ebayOrderId);
      if (syncMode === SYNC_MODES.APPEND) {
        row.action = "SKIP_MODE";
        row.reason = "Append-only mode leaves existing rows untouched.";
      } else if (priorHashes.get(row.rowKey) === row.valuesHash) {
        row.action = "SKIP_UNCHANGED";
        row.reason = "Nothing changed since the last write.";
      } else {
        row.action = "UPDATE";
        row.targetRow = existing;
      }
    } else {
      newOrders.add(row.ebayOrderId);
      if (syncMode === SYNC_MODES.UPDATE) {
        row.action = "SKIP_MODE";
        row.reason = "Update-only mode does not add new rows.";
      } else if (row.rowKey === "") {
        row.action = "FAILED";
        row.reason = "No key value for this row.";
      } else {
        row.action = "INSERT";
        row.targetRow = nextRow;
        nextRow += 1;
      }
    }
  }

  const fieldsWritten = writableMappings
    .slice()
    .sort((a, b) => a.column.position - b.column.position)
    .map((entry) => ({
      header: entry.column.header,
      letter: entry.column.letter ?? "",
      sourceField: entry.mapping.sourceField,
    }));

  return {
    sheetConfigId: sheetConfig.id,
    spreadsheetName: sheetConfig.spreadsheetName,
    sheetName: sheetConfig.sheetName,
    rowMode,
    syncMode,
    windowStart: start,
    windowEnd: end,
    ordersFound: seenOrders.size,
    ordersNew: [...newOrders].filter((id) => !existingOrders.has(id)).length,
    ordersExisting: existingOrders.size,
    rowsToInsert: rows.filter((row) => row.action === "INSERT").length,
    rowsToUpdate: rows.filter((row) => row.action === "UPDATE").length,
    rowsUnchanged: rows.filter((row) => row.action === "SKIP_UNCHANGED").length,
    rowsSkippedByMode: rows.filter((row) => row.action === "SKIP_MODE").length,
    buildFailures: failures,
    filterSummary: describeFilter(filter),
    filteredBySku: ordersFilteredBySku,
    excludedByRule: rowsExcludedByRule,
    ruleMatchCounts: Object.fromEntries(ruleMatchCounts),
    fieldsWritten,
    rows,
    blockers,
    warnings,
    confirmationRequired: sheetConfig.bulkSyncConfirmedAt === null,
    apiCalls,
  };
}

/* -------------------------------------------------------------------------- */
/* Running                                                                     */
/* -------------------------------------------------------------------------- */

export async function runSheetSync(
  userId: string,
  options: SyncOptions = {},
): Promise<SheetSyncResult> {
  const trigger = options.trigger ?? SYNC_TRIGGERS.MANUAL;
  const startedAt = new Date();
  const isTargeted = (options.onlyOrderIds ?? []).length > 0;

  const job = options.jobId
    ? await prisma.syncJob.findUniqueOrThrow({ where: { id: options.jobId } })
    : await prisma.syncJob.create({
        data: {
          userId,
          kind: "SHEET_SYNC",
          trigger,
          status: SYNC_JOB_STATUS.RUNNING,
          phase: SYNC_PHASES.QUEUED,
          startedAt,
        },
      });

  const logs: { level: string; step: string; message: string; orderId?: string }[] = [];
  const log = (
    level: string,
    step: string,
    message: string,
    orderId?: string,
  ) => logs.push({ level, step, message, orderId });

  /**
   * Per-unit outcomes, keyed by the sheet key so the write loop can revise a
   * planned outcome in place. Persisted by `finish`, in the same way as logs,
   * so every exit path records what happened to each order rather than only
   * the ones that reached the end.
   */
  const results = new Map<string, OrderResultDraft>();
  const seedResults = (plan: SyncPlan) => {
    // Orders that never produced a row are recorded first, so a later real
    // row for the same key overwrites this rather than the other way round.
    for (const failure of plan.buildFailures) {
      results.set(`build:${failure.ebayOrderId}`, {
        orderId: failure.orderId,
        ebayOrderId: failure.ebayOrderId,
        lineItemId: null,
        dedupeKey: `build:${failure.ebayOrderId}`,
        outcome: SYNC_OUTCOMES.FAILED,
        operation: SYNC_OPERATIONS.MAP,
        reason: failure.reason,
        errorCode: "BUILD_FAILED",
        rowNumber: null,
      });
    }

    for (const row of plan.rows) {
      results.set(row.rowKey, {
        orderId: row.orderId,
        ebayOrderId: row.ebayOrderId,
        lineItemId: row.lineItemId,
        dedupeKey: row.rowKey,
        rowNumber: row.targetRow ?? row.existingRow,
        ...plannedOutcome(row),
      });
    }
  };

  const finish = async (
    status: string,
    phase: string,
    summary: string,
    counters: {
      found?: number;
      inserted?: number;
      updated?: number;
      skipped?: number;
      failed?: number;
      apiCalls?: number;
    },
    extra: {
      errorCode?: string;
      errorMessage?: string;
      blockers?: string[];
      confirmationRequired?: boolean;
      windowStart?: Date;
      windowEnd?: Date;
    } = {},
  ): Promise<SheetSyncResult> => {
    const finishedAt = new Date();
    await prisma.syncJob.update({
      where: { id: job.id },
      data: {
        status,
        phase,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        ordersFetched: counters.found ?? 0,
        rowsInserted: counters.inserted ?? 0,
        rowsUpdated: counters.updated ?? 0,
        rowsSkipped: counters.skipped ?? 0,
        rowsFailed: counters.failed ?? 0,
        errorCount: counters.failed ?? 0,
        apiCallCount: counters.apiCalls ?? 0,
        windowStart: extra.windowStart ?? null,
        windowEnd: extra.windowEnd ?? null,
        summary,
        errorMessage: extra.errorMessage ?? null,
        progressLabel: null,
      },
    });

    if (logs.length > 0) {
      await prisma.syncLog.createMany({
        data: logs.map((entry) => ({
          syncJobId: job.id,
          level: entry.level,
          step: entry.step,
          message: entry.message,
          orderId: entry.orderId ?? null,
        })),
      });
    }

    if (results.size > 0) {
      const drafts = [...results.values()];

      // How many times this unit has been attempted, so the failed-order view
      // can show "attempt 3" rather than implying every retry was the first.
      const priorAttempts = await prisma.syncOrderResult.groupBy({
        by: ["dedupeKey"],
        where: { dedupeKey: { in: drafts.map((d) => d.dedupeKey) } },
        _count: { _all: true },
      });
      const attemptByKey = new Map(
        priorAttempts.map((entry) => [entry.dedupeKey, entry._count._all]),
      );

      await prisma.syncOrderResult.createMany({
        data: drafts.map((draft) => ({
          syncJobId: job.id,
          orderId: draft.orderId,
          ebayOrderId: draft.ebayOrderId,
          lineItemId: draft.lineItemId,
          dedupeKey: draft.dedupeKey,
          outcome: draft.outcome,
          operation: draft.operation,
          reason: draft.reason?.slice(0, 500) ?? null,
          errorCode: draft.errorCode,
          rowNumber: draft.rowNumber,
          attempt: (attemptByKey.get(draft.dedupeKey) ?? 0) + 1,
        })),
      });

      // A unit that came good closes out its earlier failures, so the error
      // list shows what still needs attention rather than growing forever.
      const succeeded = drafts
        .filter((draft) => draft.outcome !== SYNC_OUTCOMES.FAILED)
        .map((draft) => draft.dedupeKey);

      if (succeeded.length > 0) {
        await prisma.syncOrderResult.updateMany({
          where: {
            dedupeKey: { in: succeeded },
            outcome: SYNC_OUTCOMES.FAILED,
            resolvedAt: null,
            syncJobId: { not: job.id },
          },
          data: { resolvedAt: new Date(), resolvedByJobId: job.id },
        });
      }
    }

    return {
      jobId: job.id,
      status,
      phase,
      found: counters.found ?? 0,
      inserted: counters.inserted ?? 0,
      updated: counters.updated ?? 0,
      skipped: counters.skipped ?? 0,
      failed: counters.failed ?? 0,
      summary,
      blockers: extra.blockers ?? [],
      errorCode: extra.errorCode,
      errorMessage: extra.errorMessage,
      confirmationRequired: extra.confirmationRequired,
    };
  };

  // Set when the eBay half of the run failed. A run cannot be reported as a
  // clean success afterwards, however well the sheet write goes.
  let importFailed = false;
  let importFailureSummary = "";

  try {
    // --- 1. Fetch from eBay -----------------------------------------------
    let importApiCalls = 0;
    if (!options.skipImport) {
      await setPhase(job.id, SYNC_PHASES.FETCHING, "Fetching orders…");
      const sheetConfigForRange = await prisma.googleSheetConfig.findFirst({
        where: { userId, isActive: true },
      });
      if (!sheetConfigForRange) {
        return finish(
          SYNC_JOB_STATUS.FAILED,
          SYNC_PHASES.FAILED,
          "Blocked: no destination spreadsheet is selected.",
          {},
          {
            errorCode: "NOT_CONFIGURED",
            errorMessage: "No destination spreadsheet is selected.",
          },
        );
      }

      const window = resolveRange(
        options.range ?? SYNC_RANGES.SINCE_LAST,
        sheetConfigForRange,
        { customFrom: options.customFrom, customTo: options.customTo },
      );
      const lookbackDays = Math.max(
        1,
        Math.ceil((Date.now() - window.start.getTime()) / DAY_MS),
      );

      const imported = await importOrders(userId, {
        trigger,
        lookbackDays,
        createdFrom: window.start,
        createdTo: window.end,
        useModifiedDate: true,
      });
      importApiCalls = imported.apiCalls;

      if (imported.status === SYNC_JOB_STATUS.FAILED) {
        log("WARN", "fetch.orders", `eBay import did not run: ${imported.summary}`);
        // Not fatal on its own: orders already in the database can still be
        // written. But the run must not go on to report a clean success — a
        // seller whose eBay connection is broken would otherwise see "sync
        // completed" and have no idea their orders stopped arriving.
        importFailed = true;
        importFailureSummary = imported.summary;
      } else {
        log(
          "INFO",
          "fetch.orders",
          `Imported ${imported.imported} new and ${imported.updated} updated order(s) from eBay.`,
        );
      }
    }

    // --- 2-6. Normalize, map, transform, dedupe ---------------------------
    await setPhase(job.id, SYNC_PHASES.PROCESSING, "Processing…");
    const plan = await planSync(userId, options);
    seedResults(plan);

    await prisma.syncJob.update({
      where: { id: job.id },
      data: {
        sheetConfigId: plan.sheetConfigId,
        progressTotal: plan.rows.length,
      },
    });

    // Record what each rule actually did, so the rules page can show a rule
    // that matches nothing rather than leaving the user to guess.
    const allRules = await prisma.syncRule.findMany({
      where: { sheetConfigId: plan.sheetConfigId },
      select: { id: true },
    });
    const evaluatedAt = new Date();
    for (const rule of allRules) {
      await prisma.syncRule
        .update({
          where: { id: rule.id },
          data: {
            lastMatchCount: plan.ruleMatchCounts[rule.id] ?? 0,
            lastEvaluatedAt: evaluatedAt,
          },
        })
        .catch(() => undefined);
    }

    if (plan.filterSummary.length > 0) {
      log("INFO", "filters", `Filters applied — ${plan.filterSummary.join("; ")}.`);
    }
    if (plan.filteredBySku > 0) {
      log("INFO", "filters", `${plan.filteredBySku} row(s) removed by the SKU filter.`);
    }
    if (plan.excludedByRule > 0) {
      log("INFO", "rules", `${plan.excludedByRule} row(s) excluded by rules.`);
    }

    if (plan.blockers.length > 0) {
      for (const blocker of plan.blockers) log("ERROR", "preflight", blocker);
      return finish(
        SYNC_JOB_STATUS.FAILED,
        SYNC_PHASES.FAILED,
        `Blocked: ${plan.blockers[0]}`,
        { found: plan.ordersFound, apiCalls: plan.apiCalls + importApiCalls },
        {
          blockers: plan.blockers,
          // A configuration blocker fails identically on every retry, so it
          // must not be classified as transient.
          errorCode: "BLOCKED",
          errorMessage: plan.blockers[0],
          windowStart: plan.windowStart,
          windowEnd: plan.windowEnd,
        },
      );
    }

    if (plan.confirmationRequired && !options.confirmed) {
      log(
        "WARN",
        "preflight",
        "First bulk sync into this destination requires confirmation.",
      );
      return finish(
        SYNC_JOB_STATUS.CANCELLED,
        SYNC_PHASES.FAILED,
        "Awaiting confirmation for the first bulk sync.",
        { found: plan.ordersFound, apiCalls: plan.apiCalls + importApiCalls },
        {
          confirmationRequired: true,
          errorMessage:
            "Review the preview and confirm before the first bulk sync into this sheet.",
          windowStart: plan.windowStart,
          windowEnd: plan.windowEnd,
        },
      );
    }

    for (const warning of plan.warnings) log("WARN", "preflight", warning);

    const writable = plan.rows.filter(
      (row) => row.action === "INSERT" || row.action === "UPDATE",
    );
    const skipped =
      plan.rowsUnchanged +
      plan.rowsSkippedByMode +
      plan.rows.filter((row) => row.action === "FAILED").length;

    if (writable.length === 0) {
      if (!isTargeted) {
        await prisma.googleSheetConfig.update({
          where: { id: plan.sheetConfigId },
          data: { lastSyncedThrough: plan.windowEnd },
        });
      }
      log("INFO", "complete", "Nothing to write; the sheet is already current.");
      return finish(
        plan.buildFailures.length > 0 || importFailed
          ? SYNC_JOB_STATUS.PARTIAL
          : SYNC_JOB_STATUS.SUCCESS,
        SYNC_PHASES.COMPLETED,
        importFailed
          ? `eBay could not be read (${importFailureSummary}). ${plan.ordersFound} stored order(s) were already current.`
          : `${plan.ordersFound} order(s) found, nothing to write.`,
        {
          found: plan.ordersFound,
          skipped,
          failed: plan.buildFailures.length,
          apiCalls: plan.apiCalls + importApiCalls,
        },
        { windowStart: plan.windowStart, windowEnd: plan.windowEnd },
      );
    }

    // --- 7. Write ----------------------------------------------------------
    await setPhase(job.id, SYNC_PHASES.WRITING, "Writing to Google Sheets…", {
      current: 0,
      total: writable.length,
    });

    const connection = await getActiveGoogleConnection(userId);
    if (!connection || connection.status !== CONNECTION_STATUS.CONNECTED) {
      const message = "No Google account is connected.";
      log("ERROR", "sheet.write", message);
      return finish(
        SYNC_JOB_STATUS.FAILED,
        SYNC_PHASES.FAILED,
        `Blocked: ${message}`,
        { found: plan.ordersFound, apiCalls: plan.apiCalls + importApiCalls },
        {
          errorCode: "NOT_CONNECTED",
          errorMessage: message,
          windowStart: plan.windowStart,
          windowEnd: plan.windowEnd,
        },
      );
    }

    assertWritable(connection.scopes);

    const sheetConfig = await prisma.googleSheetConfig.findUniqueOrThrow({
      where: { id: plan.sheetConfigId },
    });

    let apiCalls = plan.apiCalls + importApiCalls;
    let inserted = 0;
    let updated = 0;
    // Orders that never became a row are failures of this run, and must be
    // in the count before the status is decided.
    let failed = plan.buildFailures.length;

    // Grow the grid before appending past the last row, otherwise Sheets
    // rejects the write rather than extending the sheet itself.
    const highestRow = writable.reduce(
      (max, row) => Math.max(max, row.targetRow ?? 0),
      0,
    );
    if (sheetConfig.sheetGid) {
      try {
        const grow = await ensureRowCapacity(
          connection,
          sheetConfig.spreadsheetId,
          Number(sheetConfig.sheetGid),
          highestRow,
          sheetConfig.gridRowCount,
        );
        apiCalls += grow.apiCalls;
        if (grow.grown) {
          log("INFO", "sheet.write", `Extended the sheet to fit row ${highestRow}.`);
        }
      } catch (error) {
        log(
          "WARN",
          "sheet.write",
          `Could not extend the grid: ${describeGoogleError(error).message}`,
        );
      }
    }

    // Write in batches so one failure costs a batch, not the run.
    const BATCH = 50;
    for (let offset = 0; offset < writable.length; offset += BATCH) {
      const batch = writable.slice(offset, offset + BATCH);
      const payload: RowWrite[] = batch.map((row) => ({
        rowNumber: row.targetRow as number,
        cells: row.cells,
      }));

      try {
        const result = await writeRows(
          connection,
          sheetConfig.spreadsheetId,
          sheetConfig.sheetName,
          payload,
        );
        apiCalls += result.apiCalls;

        for (const row of batch) {
          if (row.action === "INSERT") inserted += 1;
          else updated += 1;

          results.set(row.rowKey, {
            orderId: row.orderId,
            ebayOrderId: row.ebayOrderId,
            lineItemId: row.lineItemId,
            dedupeKey: row.rowKey,
            outcome:
              row.action === "INSERT"
                ? SYNC_OUTCOMES.INSERTED
                : SYNC_OUTCOMES.UPDATED,
            operation: SYNC_OPERATIONS.WRITE,
            reason: null,
            errorCode: null,
            rowNumber: row.targetRow,
          });

          await prisma.sheetRowLink.upsert({
            where: {
              sheetConfigId_dedupeKey: {
                sheetConfigId: sheetConfig.id,
                dedupeKey: row.rowKey,
              },
            },
            create: {
              sheetConfigId: sheetConfig.id,
              dedupeKey: row.rowKey,
              rowNumber: row.targetRow as number,
              orderId: row.orderId,
              lineItemId: row.lineItemId,
              valuesHash: row.valuesHash,
              lastWrittenAt: new Date(),
            },
            update: {
              rowNumber: row.targetRow as number,
              valuesHash: row.valuesHash,
              lastWrittenAt: new Date(),
            },
          });
        }

        const writtenOrderIds = [...new Set(batch.map((row) => row.orderId))];
        await prisma.importedOrder.updateMany({
          where: { id: { in: writtenOrderIds } },
          data: {
            syncState: ORDER_SYNC_STATE.SYNCED,
            syncError: null,
            lastSyncedAt: new Date(),
            lastSyncJobId: job.id,
            sheetConfigId: sheetConfig.id,
          },
        });
      } catch (error) {
        // A failed batch marks only its own rows, and the loop continues.
        failed += batch.length;
        const described = describeGoogleError(error);
        log(
          "ERROR",
          "sheet.write",
          `Batch of ${batch.length} row(s) failed: ${described.message}`,
        );

        for (const row of batch) {
          results.set(row.rowKey, {
            orderId: row.orderId,
            ebayOrderId: row.ebayOrderId,
            lineItemId: row.lineItemId,
            dedupeKey: row.rowKey,
            outcome: SYNC_OUTCOMES.FAILED,
            operation: SYNC_OPERATIONS.WRITE,
            reason: described.message,
            errorCode: described.code,
            rowNumber: row.targetRow,
          });

          await prisma.importedOrder
            .update({
              where: { id: row.orderId },
              data: {
                syncState: ORDER_SYNC_STATE.FAILED,
                syncError: described.message.slice(0, 500),
                lastSyncJobId: job.id,
              },
            })
            .catch(() => undefined);
        }

        if (
          error instanceof GoogleApiError &&
          (error.code === "AUTH_EXPIRED" ||
            error.code === "INSUFFICIENT_SCOPE" ||
            error.code === "NOT_FOUND")
        ) {
          log(
            "ERROR",
            "sheet.write",
            "Stopping early: this failure will affect every remaining batch.",
          );
          break;
        }
      }

      await setPhase(
        job.id,
        SYNC_PHASES.WRITING,
        "Writing to Google Sheets…",
        { current: Math.min(offset + BATCH, writable.length) },
      );
    }

    // --- 8. Save result ----------------------------------------------------
    // A targeted retry covers one old order, not a window, so it must not move
    // the incremental cursor — doing so would skip everything between the
    // retried order's date and now on the next scheduled run.
    if (inserted + updated > 0 && !isTargeted) {
      await prisma.googleSheetConfig.update({
        where: { id: sheetConfig.id },
        data: {
          lastSyncedThrough: plan.windowEnd,
          ...(sheetConfig.bulkSyncConfirmedAt
            ? {}
            : { bulkSyncConfirmedAt: new Date() }),
        },
      });
    }

    const status =
      failed > 0
        ? inserted + updated > 0
          ? SYNC_JOB_STATUS.PARTIAL
          : SYNC_JOB_STATUS.FAILED
        : importFailed
          ? SYNC_JOB_STATUS.PARTIAL
          : SYNC_JOB_STATUS.SUCCESS;

    const summary = `${plan.ordersFound} found, ${inserted} inserted, ${updated} updated, ${skipped} skipped, ${failed} failed.`;
    log("INFO", "complete", summary);

    return finish(
      status,
      failed > 0 && inserted + updated === 0
        ? SYNC_PHASES.FAILED
        : SYNC_PHASES.COMPLETED,
      summary,
      {
        found: plan.ordersFound,
        inserted,
        updated,
        skipped,
        failed,
        apiCalls,
      },
      { windowStart: plan.windowStart, windowEnd: plan.windowEnd },
    );
  } catch (error) {
    const described = describeGoogleError(error);
    log("ERROR", "sync", described.message);
    return finish(
      SYNC_JOB_STATUS.FAILED,
      SYNC_PHASES.FAILED,
      `Failed: ${described.message}`,
      {},
      { errorCode: described.code, errorMessage: described.detail ?? described.message },
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Retrying a single order                                                     */
/* -------------------------------------------------------------------------- */

export interface RetryOrderResult {
  ok: boolean;
  jobId: string | null;
  outcome: SyncOutcome | null;
  message: string;
  code?: string;
}

/**
 * Re-runs one order through the pipeline without touching the rest.
 *
 * This is the same engine a full sync uses, narrowed to one order, rather
 * than a second write path: a retry that took a shortcut could write a row a
 * normal sync would have refused. It skips the eBay import (the order is
 * already stored) and leaves the incremental cursor alone.
 */
export async function retryOrder(
  userId: string,
  orderId: string,
): Promise<RetryOrderResult> {
  const order = await prisma.importedOrder.findFirst({
    where: { id: orderId, userId },
    select: { id: true, ebayOrderId: true },
  });

  if (!order) {
    return {
      ok: false,
      jobId: null,
      outcome: null,
      message: "That order is no longer in this workspace.",
      code: "ORDER_NOT_FOUND",
    };
  }

  const sheetConfig = await prisma.googleSheetConfig.findFirst({
    where: { userId, isActive: true },
    select: { id: true, bulkSyncConfirmedAt: true },
  });

  if (!sheetConfig) {
    return {
      ok: false,
      jobId: null,
      outcome: null,
      message: "No destination spreadsheet is selected.",
      code: "NOT_CONFIGURED",
    };
  }

  // Retrying one order must not be the write that first fills an unconfirmed
  // destination — that confirmation gate exists precisely so nobody's sheet
  // gets written to before they have seen a preview.
  if (sheetConfig.bulkSyncConfirmedAt === null) {
    return {
      ok: false,
      jobId: null,
      outcome: null,
      message:
        "This destination has not been confirmed yet. Run a sync and confirm the preview once, then retries can write to it.",
      code: "CONFIRMATION_REQUIRED",
    };
  }

  const result = await runSheetSync(userId, {
    onlyOrderIds: [order.id],
    skipImport: true,
    confirmed: true,
    trigger: SYNC_TRIGGERS.RETRY,
  });

  // Read back what the run recorded for this order rather than inferring it
  // from the counters, so the message matches the history exactly.
  const recorded = await prisma.syncOrderResult.findMany({
    where: { syncJobId: result.jobId, ebayOrderId: order.ebayOrderId },
    orderBy: { createdAt: "asc" },
  });

  const failedRow = recorded.find((row) => row.outcome === SYNC_OUTCOMES.FAILED);
  const wrote = recorded.filter(
    (row) =>
      row.outcome === SYNC_OUTCOMES.INSERTED ||
      row.outcome === SYNC_OUTCOMES.UPDATED,
  );

  if (failedRow) {
    return {
      ok: false,
      jobId: result.jobId,
      outcome: SYNC_OUTCOMES.FAILED,
      message: failedRow.reason ?? result.errorMessage ?? "The retry failed.",
      code: failedRow.errorCode ?? result.errorCode,
    };
  }

  if (wrote.length > 0) {
    const verb = wrote[0].outcome === SYNC_OUTCOMES.INSERTED ? "added" : "updated";
    return {
      ok: true,
      jobId: result.jobId,
      outcome: wrote[0].outcome as SyncOutcome,
      message:
        wrote.length === 1
          ? `Order ${order.ebayOrderId} ${verb} at row ${wrote[0].rowNumber ?? "?"}.`
          : `Order ${order.ebayOrderId}: ${wrote.length} rows ${verb}.`,
    };
  }

  if (recorded.length > 0) {
    return {
      ok: true,
      jobId: result.jobId,
      outcome: SYNC_OUTCOMES.SKIPPED,
      message: recorded[0].reason ?? "Nothing to write — the sheet is already current.",
    };
  }

  // No row was planned at all: a filter or rule removed it, or the run was
  // blocked before planning finished.
  return {
    ok: false,
    jobId: result.jobId,
    outcome: null,
    message:
      result.blockers[0] ??
      result.errorMessage ??
      "This order produced no row — a filter or rule excludes it.",
    code: result.errorCode ?? "NO_ROW_PLANNED",
  };
}

/** Serialisable preview for the confirmation screen. */
export async function previewSync(userId: string, options: SyncOptions = {}) {
  const plan = await planSync(userId, options);
  return {
    spreadsheetName: plan.spreadsheetName,
    sheetName: plan.sheetName,
    rowMode: plan.rowMode,
    syncMode: plan.syncMode,
    windowStart: plan.windowStart.toISOString(),
    windowEnd: plan.windowEnd.toISOString(),
    ordersFound: plan.ordersFound,
    ordersNew: plan.ordersNew,
    ordersExisting: plan.ordersExisting,
    rowsToInsert: plan.rowsToInsert,
    rowsToUpdate: plan.rowsToUpdate,
    rowsUnchanged: plan.rowsUnchanged,
    rowsSkippedByMode: plan.rowsSkippedByMode,
    filterSummary: plan.filterSummary,
    filteredBySku: plan.filteredBySku,
    excludedByRule: plan.excludedByRule,
    ruleMatchCounts: plan.ruleMatchCounts,
    fieldsWritten: plan.fieldsWritten,
    blockers: plan.blockers,
    warnings: plan.warnings,
    confirmationRequired: plan.confirmationRequired,
    sample: plan.rows.slice(0, 5).map((row) => ({
      rowKey: row.rowKey,
      action: row.action,
      targetRow: row.targetRow,
      values: row.cells
        .slice()
        .sort((a, b) => a.columnIndex - b.columnIndex)
        .map((cell) => cell.value),
    })),
  };
}

export type SyncPreview = Awaited<ReturnType<typeof previewSync>>;
