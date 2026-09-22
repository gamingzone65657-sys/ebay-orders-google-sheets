/**
 * The IF/THEN rules engine.
 *
 *   IF   SKU contains "ABC"          THEN import
 *   IF   marketplace is EBAY_GB      THEN use mapping set "UK export"
 *   IF   tracking is empty           THEN set "Status" to "Awaiting dispatch"
 *
 * Kept deliberately small: a flat list of conditions combined with ALL or
 * ANY, and four actions. No nesting, no expression language. Everything is
 * configured from the UI and stored as data, so extending the vocabulary is
 * a change to the catalogues below — never to a user's saved rules.
 *
 * Evaluation order matters and is explicit: rules run in `position` order,
 * and the outcome of the whole set is resolved by `evaluateRules`.
 */

import { compareValues, COMPARISON_OPERATORS } from "@/lib/transformations";

import type { RowContext } from "./build-row";
import { getByPath } from "@/lib/json";

/* -------------------------------------------------------------------------- */
/* Catalogues (what the UI offers)                                             */
/* -------------------------------------------------------------------------- */

/**
 * Fields a rule can test. Each maps to a dot-path resolved against the row,
 * exactly like a field mapping — so the two stay consistent.
 */
export const RULE_FIELDS = [
  { key: "lineItem.sku", label: "SKU" },
  { key: "lineItem.title", label: "Item title" },
  { key: "lineItem.quantity", label: "Item quantity" },
  { key: "computed.skuList", label: "All SKUs on the order" },
  { key: "order.marketplaceId", label: "Marketplace" },
  { key: "order.orderStatus", label: "Order status" },
  { key: "order.orderPaymentStatus", label: "Payment status" },
  { key: "order.orderFulfillmentStatus", label: "Fulfillment status" },
  { key: "order.buyer.username", label: "Buyer username" },
  { key: "order.pricingSummary.total.value", label: "Order total" },
  { key: "order.pricingSummary.total.currency", label: "Currency" },
  { key: "order.fulfillment.trackingNumber", label: "Tracking number" },
  { key: "order.shipTo.countryCode", label: "Ship-to country" },
  { key: "order.shipTo.stateOrProvince", label: "Ship-to state" },
  { key: "computed.totalQuantity", label: "Total quantity" },
  { key: "computed.itemCount", label: "Number of line items" },
] as const;

export const RULE_OPERATORS = COMPARISON_OPERATORS;

export const RULE_ACTIONS = [
  {
    id: "EXCLUDE",
    label: "Skip this row",
    description: "Matching rows are not written to the sheet.",
    needsColumn: false,
    needsValue: false,
    needsMappingSet: false,
  },
  {
    id: "INCLUDE_ONLY",
    label: "Import only matching rows",
    description:
      "Acts as a whitelist. Once any rule uses this, a row must match at least one of them to be written.",
    needsColumn: false,
    needsValue: false,
    needsMappingSet: false,
  },
  {
    id: "SET_VALUE",
    label: "Set a column to a value",
    description:
      "Overrides one mapped column for matching rows, after transformations run.",
    needsColumn: true,
    needsValue: true,
    needsMappingSet: false,
  },
  {
    id: "USE_MAPPING_SET",
    label: "Use a saved configuration",
    description:
      "Matching rows are built with a different saved mapping set instead of the default one.",
    needsColumn: false,
    needsValue: false,
    needsMappingSet: true,
  },
] as const;

export type RuleAction = (typeof RULE_ACTIONS)[number]["id"];

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export interface RuleCondition {
  field: string;
  operator: string;
  value: string;
}

export interface RuleActionArgs {
  /** Target column header for SET_VALUE. */
  column?: string;
  /** Literal to write for SET_VALUE. */
  value?: string;
  /** SavedConfiguration id for USE_MAPPING_SET. */
  savedConfigId?: string;
}

export interface CompiledRule {
  id: string;
  name: string;
  enabled: boolean;
  position: number;
  match: "ALL" | "ANY";
  conditions: RuleCondition[];
  action: RuleAction;
  args: RuleActionArgs;
}

export interface RuleOutcome {
  /** Whether the row survives the rule set. */
  include: boolean;
  /** Why it was dropped, for the run log. */
  reason?: string;
  /** Column header → literal value, applied after transformations. */
  overrides: Map<string, string>;
  /** Saved configuration to build this row with, if a rule said so. */
  mappingSetId: string | null;
  /** Ids of the rules that matched, for per-rule match counts. */
  matchedRuleIds: string[];
}

/* -------------------------------------------------------------------------- */
/* Evaluation                                                                  */
/* -------------------------------------------------------------------------- */

export function conditionMatches(
  condition: RuleCondition,
  context: RowContext,
): boolean {
  const value = getByPath(context, condition.field);
  return compareValues(value, condition.operator, condition.value);
}

export function ruleMatches(rule: CompiledRule, context: RowContext): boolean {
  // A rule with no conditions is treated as "never matches" rather than
  // "always matches": an unfinished rule should be inert, not destructive.
  if (rule.conditions.length === 0) return false;

  return rule.match === "ANY"
    ? rule.conditions.some((condition) => conditionMatches(condition, context))
    : rule.conditions.every((condition) => conditionMatches(condition, context));
}

/**
 * Runs the whole rule set against one row.
 *
 * Resolution order:
 *   1. Any matching EXCLUDE drops the row immediately — an explicit "skip"
 *      is never overridden by a later rule.
 *   2. If any INCLUDE_ONLY rule exists, the row must match at least one.
 *   3. SET_VALUE overrides accumulate; a later rule wins on the same column.
 *   4. The last matching USE_MAPPING_SET wins.
 */
export function evaluateRules(
  rules: CompiledRule[],
  context: RowContext,
): RuleOutcome {
  const active = rules
    .filter((rule) => rule.enabled)
    .slice()
    .sort((a, b) => a.position - b.position);

  const overrides = new Map<string, string>();
  const matchedRuleIds: string[] = [];
  let mappingSetId: string | null = null;

  const whitelistRules = active.filter(
    (rule) => rule.action === "INCLUDE_ONLY",
  );
  let matchedWhitelist = false;

  for (const rule of active) {
    if (!ruleMatches(rule, context)) continue;
    matchedRuleIds.push(rule.id);

    switch (rule.action) {
      case "EXCLUDE":
        return {
          include: false,
          reason: `Rule "${rule.name}" excluded this row.`,
          overrides,
          mappingSetId,
          matchedRuleIds,
        };
      case "INCLUDE_ONLY":
        matchedWhitelist = true;
        break;
      case "SET_VALUE":
        if (rule.args.column) {
          overrides.set(rule.args.column.trim(), rule.args.value ?? "");
        }
        break;
      case "USE_MAPPING_SET":
        if (rule.args.savedConfigId) mappingSetId = rule.args.savedConfigId;
        break;
    }
  }

  if (whitelistRules.length > 0 && !matchedWhitelist) {
    return {
      include: false,
      reason: `No "import only" rule matched this row.`,
      overrides,
      mappingSetId,
      matchedRuleIds,
    };
  }

  return { include: true, overrides, mappingSetId, matchedRuleIds };
}

/* -------------------------------------------------------------------------- */
/* Validation + serialisation                                                  */
/* -------------------------------------------------------------------------- */

const VALID_OPERATORS = new Set(RULE_OPERATORS.map((entry) => entry.value));
const VALID_ACTIONS = new Set(RULE_ACTIONS.map((entry) => entry.id as string));

/** Operators that ignore the comparison value. */
const VALUELESS_OPERATORS = new Set(["is_empty", "is_not_empty"]);

export function validateRule(rule: {
  name: string;
  match: string;
  conditions: RuleCondition[];
  action: string;
  args: RuleActionArgs;
}): string[] {
  const problems: string[] = [];

  if (!rule.name.trim()) problems.push("A rule needs a name.");
  if (rule.match !== "ALL" && rule.match !== "ANY") {
    problems.push("Match must be ALL or ANY.");
  }
  if (!VALID_ACTIONS.has(rule.action)) {
    problems.push(`Unknown action "${rule.action}".`);
  }
  if (rule.conditions.length === 0) {
    problems.push("A rule needs at least one condition, or it will never run.");
  }

  rule.conditions.forEach((condition, index) => {
    const position = index + 1;
    if (!condition.field.trim()) {
      problems.push(`Condition ${position} has no field.`);
    }
    if (!VALID_OPERATORS.has(condition.operator as never)) {
      problems.push(`Condition ${position} has an unknown test.`);
    }
    if (
      !VALUELESS_OPERATORS.has(condition.operator) &&
      !condition.value.trim()
    ) {
      problems.push(`Condition ${position} needs a value to compare against.`);
    }
  });

  if (rule.action === "SET_VALUE" && !rule.args.column?.trim()) {
    problems.push("Set a column for the 'set a column to a value' action.");
  }
  if (rule.action === "USE_MAPPING_SET" && !rule.args.savedConfigId?.trim()) {
    problems.push("Choose a saved configuration for this action.");
  }

  return problems;
}

/** Renders a rule as one readable sentence for the list view. */
export function describeRule(rule: CompiledRule, columnLabel?: string): string {
  const fieldLabel = (key: string) =>
    RULE_FIELDS.find((entry) => entry.key === key)?.label ?? key;
  const operatorLabel = (value: string) =>
    RULE_OPERATORS.find((entry) => entry.value === value)?.label ?? value;

  const conditions = rule.conditions
    .map((condition) => {
      const base = `${fieldLabel(condition.field)} ${operatorLabel(condition.operator)}`;
      return VALUELESS_OPERATORS.has(condition.operator)
        ? base
        : `${base} "${condition.value}"`;
    })
    .join(rule.match === "ANY" ? " or " : " and ");

  const action =
    rule.action === "EXCLUDE"
      ? "skip the row"
      : rule.action === "INCLUDE_ONLY"
        ? "import it"
        : rule.action === "SET_VALUE"
          ? `set ${rule.args.column ?? "?"} to "${rule.args.value ?? ""}"`
          : `use ${columnLabel ?? "a saved configuration"}`;

  return conditions ? `If ${conditions}, then ${action}.` : "(no conditions)";
}
