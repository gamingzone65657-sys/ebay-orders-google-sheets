/**
 * Transformation registry.
 *
 * A FieldMapping stores only the transformation *id* plus a JSON argument
 * bag, so adding a transformation here immediately makes it selectable in the
 * UI and usable by the sync engine — no schema change, and no change to any
 * mapping a user has already saved.
 *
 * Most transformations take the single mapped value. The few that need more
 * than that (combining several eBay fields into one column) receive an
 * optional `TransformContext` whose `resolve` reads any dot-path from the
 * current row. Keeping that as an injected function is what lets this module
 * stay independent of the sync engine.
 */

export type TransformArgType = "text" | "number" | "select";

export interface TransformArgDefinition {
  name: string;
  label: string;
  type: TransformArgType;
  placeholder?: string;
  options?: { value: string; label: string }[];
  defaultValue?: string;
  hint?: string;
}

export interface TransformContext {
  /** Resolves a dot-path (e.g. "lineItem.sku") against the current row. */
  resolve: (path: string) => unknown;
}

export interface TransformationDefinition {
  id: string;
  label: string;
  description: string;
  /** Grouping for the mapping editor's dropdown. */
  group: string;
  args: TransformArgDefinition[];
  apply: (
    value: unknown,
    args: Record<string, string>,
    context?: TransformContext,
  ) => string;
}

/* -------------------------------------------------------------------------- */
/* Coercion helpers                                                            */
/* -------------------------------------------------------------------------- */

function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function asNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(asText(value));
  return Number.isFinite(n) ? n : null;
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const text = asText(value);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

const YES_NO = [
  { value: "no", label: "No" },
  { value: "yes", label: "Yes" },
];

/**
 * Reads a yes/no argument.
 *
 * `fallback` must match the `defaultValue` declared for the same argument:
 * a mapping saved before an argument existed has no stored value, and it
 * would be surprising for it to behave differently from the same
 * transformation configured fresh in the UI.
 */
const isYes = (value: string | undefined, fallback = false) =>
  value === undefined || value === "" ? fallback : value === "yes";

/** Minimal token formatter — avoids a date library for a handful of tokens. */
function formatDate(date: Date, pattern: string, useUtc: boolean): string {
  const parts = {
    year: useUtc ? date.getUTCFullYear() : date.getFullYear(),
    month: (useUtc ? date.getUTCMonth() : date.getMonth()) + 1,
    day: useUtc ? date.getUTCDate() : date.getDate(),
    hours: useUtc ? date.getUTCHours() : date.getHours(),
    minutes: useUtc ? date.getUTCMinutes() : date.getMinutes(),
    seconds: useUtc ? date.getUTCSeconds() : date.getSeconds(),
  };
  return pattern
    .replace(/yyyy/g, String(parts.year))
    .replace(/yy/g, pad(parts.year % 100))
    .replace(/MM/g, pad(parts.month))
    .replace(/dd/g, pad(parts.day))
    .replace(/HH/g, pad(parts.hours))
    .replace(/mm/g, pad(parts.minutes))
    .replace(/ss/g, pad(parts.seconds));
}

/** Shared by the `conditional` transformation and the rules engine. */
export const COMPARISON_OPERATORS = [
  { value: "equals", label: "is exactly" },
  { value: "not_equals", label: "is not" },
  { value: "contains", label: "contains" },
  { value: "not_contains", label: "does not contain" },
  { value: "starts_with", label: "starts with" },
  { value: "ends_with", label: "ends with" },
  { value: "is_empty", label: "is empty" },
  { value: "is_not_empty", label: "is not empty" },
  { value: "greater_than", label: "is greater than" },
  { value: "less_than", label: "is less than" },
] as const;

export type ComparisonOperator = (typeof COMPARISON_OPERATORS)[number]["value"];

/** Evaluates one comparison. Exported so rules and transforms agree exactly. */
export function compareValues(
  value: unknown,
  operator: string,
  compareTo: string,
): boolean {
  const left = asText(value).trim();
  const right = (compareTo ?? "").trim();
  const lowerLeft = left.toLowerCase();
  const lowerRight = right.toLowerCase();

  switch (operator) {
    case "equals":
      return lowerLeft === lowerRight;
    case "not_equals":
      return lowerLeft !== lowerRight;
    case "contains":
      return right !== "" && lowerLeft.includes(lowerRight);
    case "not_contains":
      return right === "" || !lowerLeft.includes(lowerRight);
    case "starts_with":
      return right !== "" && lowerLeft.startsWith(lowerRight);
    case "ends_with":
      return right !== "" && lowerLeft.endsWith(lowerRight);
    case "is_empty":
      return left === "";
    case "is_not_empty":
      return left !== "";
    case "greater_than": {
      const a = asNumber(value);
      const b = asNumber(right);
      return a !== null && b !== null && a > b;
    }
    case "less_than": {
      const a = asNumber(value);
      const b = asNumber(right);
      return a !== null && b !== null && a < b;
    }
    default:
      return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                    */
/* -------------------------------------------------------------------------- */

export const TRANSFORMATIONS: TransformationDefinition[] = [
  /* --- Basic ------------------------------------------------------------ */
  {
    id: "none",
    label: "None",
    description: "Write the value exactly as eBay returns it.",
    group: "Basic",
    args: [],
    apply: (value) => asText(value),
  },
  {
    id: "default_if_empty",
    label: "Default if empty",
    description: "Substitute a value when the source resolves to nothing.",
    group: "Basic",
    args: [
      {
        name: "value",
        label: "Default value",
        type: "text",
        placeholder: "N/A",
        defaultValue: "N/A",
      },
    ],
    apply: (value, args) => {
      const text = asText(value).trim();
      return text.length > 0 ? text : (args.value ?? "");
    },
  },

  /* --- Text ------------------------------------------------------------- */
  {
    id: "trim",
    label: "Trim whitespace",
    description: "Remove leading and trailing whitespace.",
    group: "Text",
    args: [],
    apply: (value) => asText(value).trim(),
  },
  {
    id: "uppercase",
    label: "UPPERCASE",
    description: "Convert the value to upper case.",
    group: "Text",
    args: [],
    apply: (value) => asText(value).toUpperCase(),
  },
  {
    id: "lowercase",
    label: "lowercase",
    description: "Convert the value to lower case.",
    group: "Text",
    args: [],
    apply: (value) => asText(value).toLowerCase(),
  },
  {
    id: "title_case",
    label: "Title Case",
    description: "Capitalise the first letter of each word.",
    group: "Text",
    args: [],
    apply: (value) =>
      asText(value)
        .toLowerCase()
        .replace(/\b\p{L}/gu, (character) => character.toUpperCase()),
  },
  {
    id: "prefix",
    label: "Add prefix",
    description: "Put fixed text in front of the value.",
    group: "Text",
    args: [
      { name: "text", label: "Prefix", type: "text", placeholder: "eBay-" },
      {
        name: "skipEmpty",
        label: "Skip when the value is empty",
        type: "select",
        options: YES_NO,
        defaultValue: "yes",
      },
    ],
    apply: (value, args) => {
      const text = asText(value);
      if (text === "" && isYes(args.skipEmpty, true)) return "";
      return `${args.text ?? ""}${text}`;
    },
  },
  {
    id: "suffix",
    label: "Add suffix",
    description: "Put fixed text after the value.",
    group: "Text",
    args: [
      { name: "text", label: "Suffix", type: "text", placeholder: " pcs" },
      {
        name: "skipEmpty",
        label: "Skip when the value is empty",
        type: "select",
        options: YES_NO,
        defaultValue: "yes",
      },
    ],
    apply: (value, args) => {
      const text = asText(value);
      if (text === "" && isYes(args.skipEmpty, true)) return "";
      return `${text}${args.text ?? ""}`;
    },
  },
  {
    id: "prefix_suffix",
    label: "Add prefix and suffix",
    description: "Wrap the value with fixed text on both sides.",
    group: "Text",
    args: [
      { name: "prefix", label: "Prefix", type: "text", placeholder: "#" },
      { name: "suffix", label: "Suffix", type: "text", placeholder: " pcs" },
    ],
    apply: (value, args) =>
      `${args.prefix ?? ""}${asText(value)}${args.suffix ?? ""}`,
  },
  {
    id: "text_cleanup",
    label: "Clean up text",
    description:
      "Tidy messy listing text: collapse spaces, drop line breaks, strip HTML.",
    group: "Text",
    args: [
      {
        name: "collapseSpaces",
        label: "Collapse repeated spaces",
        type: "select",
        options: YES_NO,
        defaultValue: "yes",
      },
      {
        name: "removeLineBreaks",
        label: "Remove line breaks",
        type: "select",
        options: YES_NO,
        defaultValue: "yes",
      },
      {
        name: "stripHtml",
        label: "Strip HTML tags",
        type: "select",
        options: YES_NO,
        defaultValue: "yes",
      },
      {
        name: "removeSymbols",
        label: "Remove emoji and control characters",
        type: "select",
        options: YES_NO,
        defaultValue: "no",
      },
    ],
    apply: (value, args) => {
      let text = asText(value);
      if (isYes(args.stripHtml, true)) {
        text = text.replace(/<[^>]*>/g, " ");
        // Decode the handful of entities that actually show up in titles.
        text = text
          .replace(/&nbsp;/gi, " ")
          .replace(/&amp;/gi, "&")
          .replace(/&lt;/gi, "<")
          .replace(/&gt;/gi, ">")
          .replace(/&quot;/gi, '"')
          .replace(/&#39;/g, "'");
      }
      if (isYes(args.removeLineBreaks, true)) text = text.replace(/[\r\n]+/g, " ");
      if (isYes(args.removeSymbols, false)) {
        // Control characters plus the pictographic ranges.
        text = text
          .replace(/[\p{C}]/gu, "")
          .replace(/[\p{Extended_Pictographic}]/gu, "");
      }
      if (isYes(args.collapseSpaces, true)) text = text.replace(/\s{2,}/g, " ");
      return text.trim();
    },
  },
  {
    id: "replace",
    label: "Find and replace",
    description: "Swap one piece of text for another.",
    group: "Text",
    args: [
      { name: "find", label: "Find", type: "text", placeholder: "Ltd" },
      { name: "replaceWith", label: "Replace with", type: "text", placeholder: "Limited" },
      {
        name: "all",
        label: "Replace every occurrence",
        type: "select",
        options: YES_NO,
        defaultValue: "yes",
      },
      {
        name: "caseSensitive",
        label: "Case sensitive",
        type: "select",
        options: YES_NO,
        defaultValue: "no",
      },
    ],
    apply: (value, args) => {
      const text = asText(value);
      const find = args.find ?? "";
      if (find === "") return text;
      // Escaped: this is a literal find/replace, not a regex field, so a
      // user typing "(" must not produce an invalid pattern.
      const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const flags = `${isYes(args.all, true) ? "g" : ""}${
        isYes(args.caseSensitive, false) ? "" : "i"
      }`;
      return text.replace(new RegExp(escaped, flags), args.replaceWith ?? "");
    },
  },
  {
    id: "truncate",
    label: "Truncate",
    description: "Shorten long text to a maximum length.",
    group: "Text",
    args: [
      {
        name: "length",
        label: "Max length",
        type: "number",
        placeholder: "80",
        defaultValue: "80",
      },
    ],
    apply: (value, args) => {
      const text = asText(value);
      const max = Number(args.length ?? 80);
      if (!Number.isFinite(max) || max <= 0 || text.length <= max) return text;
      return `${text.slice(0, max - 1)}…`;
    },
  },

  /* --- Numbers and dates ------------------------------------------------ */
  {
    id: "date_format",
    label: "Format date",
    description: "Reformat a timestamp using yyyy / MM / dd / HH / mm / ss.",
    group: "Numbers & dates",
    args: [
      {
        name: "pattern",
        label: "Pattern",
        type: "text",
        placeholder: "yyyy-MM-dd",
        defaultValue: "yyyy-MM-dd",
        hint: "yyyy, yy, MM, dd, HH, mm, ss",
      },
      {
        name: "timezone",
        label: "Timezone",
        type: "select",
        defaultValue: "utc",
        options: [
          { value: "utc", label: "UTC" },
          { value: "local", label: "Server local" },
        ],
      },
    ],
    apply: (value, args) => {
      const date = asDate(value);
      if (!date) return "";
      return formatDate(
        date,
        args.pattern || "yyyy-MM-dd",
        (args.timezone ?? "utc") !== "local",
      );
    },
  },
  {
    id: "number_format",
    label: "Format number",
    description: "Fixed decimals with configurable separators.",
    group: "Numbers & dates",
    args: [
      {
        name: "decimals",
        label: "Decimal places",
        type: "number",
        defaultValue: "2",
      },
      {
        name: "thousands",
        label: "Thousands separator",
        type: "select",
        defaultValue: "comma",
        options: [
          { value: "comma", label: "1,234.56" },
          { value: "dot", label: "1.234,56" },
          { value: "space", label: "1 234.56" },
          { value: "none", label: "1234.56" },
        ],
      },
    ],
    apply: (value, args) => {
      const n = asNumber(value);
      if (n === null) return "";
      const decimals = Math.max(0, Math.min(10, Number(args.decimals ?? 2) || 0));
      const fixed = Math.abs(n).toFixed(decimals);
      const [whole, fraction] = fixed.split(".");

      const style = args.thousands ?? "comma";
      const groupWith = style === "dot" ? "." : style === "space" ? " " : ",";
      const decimalMark = style === "dot" ? "," : ".";
      const grouped =
        style === "none"
          ? whole
          : whole.replace(/\B(?=(\d{3})+(?!\d))/g, groupWith);

      const sign = n < 0 ? "-" : "";
      return fraction ? `${sign}${grouped}${decimalMark}${fraction}` : `${sign}${grouped}`;
    },
  },
  {
    id: "number_round",
    label: "Round number",
    description: "Round to a fixed number of decimal places.",
    group: "Numbers & dates",
    args: [
      {
        name: "decimals",
        label: "Decimals",
        type: "number",
        placeholder: "2",
        defaultValue: "2",
      },
    ],
    apply: (value, args) => {
      const n = asNumber(value);
      if (n === null) return "";
      const decimals = Number(args.decimals ?? 2);
      return n.toFixed(Number.isFinite(decimals) ? Math.max(0, decimals) : 2);
    },
  },
  {
    id: "currency",
    label: "Format currency",
    description: "Render a number with a currency symbol.",
    group: "Numbers & dates",
    args: [
      {
        name: "currency",
        label: "Currency code",
        type: "text",
        placeholder: "USD",
        defaultValue: "USD",
        hint: 'Leave blank to use the order\'s own currency.',
      },
      {
        name: "locale",
        label: "Locale",
        type: "text",
        placeholder: "en-US",
        defaultValue: "en-US",
      },
      {
        name: "symbol",
        label: "Include symbol",
        type: "select",
        options: YES_NO,
        defaultValue: "yes",
      },
    ],
    apply: (value, args, context) => {
      const n = asNumber(value);
      if (n === null) return "";

      // An empty currency code means "whatever this order is in", which is
      // the right default on a multi-marketplace account.
      const code =
        (args.currency ?? "").trim() ||
        asText(context?.resolve("order.pricingSummary.total.currency")) ||
        "USD";

      if (!isYes(args.symbol, true)) return n.toFixed(2);
      try {
        return new Intl.NumberFormat(args.locale || "en-US", {
          style: "currency",
          currency: code.toUpperCase(),
        }).format(n);
      } catch {
        return n.toFixed(2);
      }
    },
  },

  /* --- Logic ------------------------------------------------------------ */
  {
    id: "conditional",
    label: "Conditional value",
    description:
      "Write one value when a test passes and another when it does not.",
    group: "Logic",
    args: [
      {
        name: "operator",
        label: "Test",
        type: "select",
        defaultValue: "is_not_empty",
        options: COMPARISON_OPERATORS.map((operator) => ({
          value: operator.value,
          label: operator.label,
        })),
      },
      { name: "compareTo", label: "Compare to", type: "text", placeholder: "FULFILLED" },
      { name: "thenValue", label: "Then write", type: "text", placeholder: "Yes" },
      {
        name: "elseValue",
        label: "Otherwise write",
        type: "text",
        placeholder: "No",
        hint: "Leave blank to keep the original value.",
      },
    ],
    apply: (value, args) => {
      const matched = compareValues(
        value,
        args.operator ?? "is_not_empty",
        args.compareTo ?? "",
      );
      if (matched) return args.thenValue ?? "";
      const otherwise = args.elseValue ?? "";
      return otherwise === "" ? asText(value) : otherwise;
    },
  },
  {
    id: "boolean_label",
    label: "Yes / No",
    description: "Render truthy values as Yes and falsy values as No.",
    group: "Logic",
    args: [
      { name: "trueLabel", label: "True label", type: "text", defaultValue: "Yes" },
      { name: "falseLabel", label: "False label", type: "text", defaultValue: "No" },
    ],
    apply: (value, args) => {
      const text = asText(value).toLowerCase();
      const truthy =
        value === true ||
        ["true", "yes", "y", "1", "paid", "fulfilled"].includes(text);
      return truthy ? (args.trueLabel ?? "Yes") : (args.falseLabel ?? "No");
    },
  },

  /* --- Combine ---------------------------------------------------------- */
  {
    id: "combine_fields",
    label: "Combine fields",
    description:
      "Join several eBay fields into one column, e.g. SKU and title together.",
    group: "Combine",
    args: [
      {
        name: "fields",
        label: "Fields to combine",
        type: "text",
        placeholder: "lineItem.sku, lineItem.title",
        hint: "Comma-separated field keys. The mapped field is used first.",
      },
      {
        name: "separator",
        label: "Separator",
        type: "text",
        defaultValue: " — ",
      },
      {
        name: "skipEmpty",
        label: "Skip empty fields",
        type: "select",
        options: YES_NO,
        defaultValue: "yes",
      },
    ],
    apply: (value, args, context) => {
      const separator = args.separator ?? " — ";
      const paths = (args.fields ?? "")
        .split(",")
        .map((path) => path.trim())
        .filter(Boolean);

      const parts = [
        asText(value),
        ...paths.map((path) => asText(context?.resolve(path))),
      ];

      return (isYes(args.skipEmpty, true) ? parts.filter((part) => part !== "") : parts)
        .join(separator);
    },
  },
  {
    id: "join_list",
    label: "Join list",
    description:
      "Join a multi-value field (all SKUs, all titles) with a separator.",
    group: "Combine",
    args: [
      {
        name: "separator",
        label: "Separator",
        type: "text",
        placeholder: ", ",
        defaultValue: ", ",
      },
      {
        name: "unique",
        label: "Remove duplicates",
        type: "select",
        options: YES_NO,
        defaultValue: "no",
      },
      {
        name: "limit",
        label: "Maximum items (0 = no limit)",
        type: "number",
        defaultValue: "0",
      },
    ],
    apply: (value, args) => {
      const separator = args.separator ?? ", ";
      let parts = Array.isArray(value)
        ? value.map(asText).filter((part) => part !== "")
        : asText(value)
            .split(separator)
            .map((part) => part.trim())
            .filter(Boolean);

      if (isYes(args.unique, false)) parts = [...new Set(parts)];

      const limit = Number(args.limit ?? 0);
      if (Number.isFinite(limit) && limit > 0 && parts.length > limit) {
        const shown = parts.slice(0, limit);
        return `${shown.join(separator)}${separator}+${parts.length - limit} more`;
      }
      return parts.join(separator);
    },
  },
];

/* -------------------------------------------------------------------------- */
/* Lookups                                                                     */
/* -------------------------------------------------------------------------- */

const TRANSFORM_BY_ID = new Map(TRANSFORMATIONS.map((entry) => [entry.id, entry]));

export const TRANSFORMATION_GROUPS = Array.from(
  new Set(TRANSFORMATIONS.map((entry) => entry.group)),
);

export function getTransformation(
  id: string,
): TransformationDefinition | undefined {
  return TRANSFORM_BY_ID.get(id);
}

export function transformationLabel(id: string): string {
  return TRANSFORM_BY_ID.get(id)?.label ?? id;
}

/** Applies a transformation by id, falling back to a plain string render. */
export function applyTransformation(
  id: string,
  value: unknown,
  args: Record<string, string> = {},
  context?: TransformContext,
): string {
  const transformation = TRANSFORM_BY_ID.get(id);
  if (!transformation) return asText(value);
  try {
    return transformation.apply(value, args, context);
  } catch {
    // A bad argument must degrade to the raw value, never break a sync.
    return asText(value);
  }
}

export function defaultArgsFor(id: string): Record<string, string> {
  const transformation = TRANSFORM_BY_ID.get(id);
  if (!transformation) return {};
  const out: Record<string, string> = {};
  for (const arg of transformation.args) {
    if (arg.defaultValue !== undefined) out[arg.name] = arg.defaultValue;
  }
  return out;
}
