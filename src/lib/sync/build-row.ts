/**
 * Turns an order payload + a mapping list into the row that would be written
 * to the sheet.
 *
 * This is the only place that knows how a mapping becomes a cell, and it is
 * entirely data-driven: it never references a specific eBay field or a
 * specific sheet column.
 */

import type {
  EbayOrderPayload,
  EbayOrderLineItem,
} from "@/lib/ebay/order-payload";
import { fromJsonColumn, getByPath } from "@/lib/json";
import { applyTransformation } from "@/lib/transformations";

export interface MappingInput {
  targetColumn: string;
  sourceField: string;
  transformation: string;
  transformArgsJson?: string | null;
  fallbackValue?: string | null;
  staticValue?: string | null;
  enabled: boolean;
  position: number;
}

export interface RowContext {
  order: EbayOrderPayload;
  lineItem: EbayOrderLineItem | null;
  computed: Record<string, unknown>;
  /** Unique key for this row; the duplicate guard compares against it. */
  dedupeKey: string;
}

export function buildRowContext(
  order: EbayOrderPayload,
  lineItem: EbayOrderLineItem | null = order.lineItems?.[0] ?? null,
  syncedAt: Date = new Date(),
  options: { lineItemNumber?: number; perLineItem?: boolean } = {},
): RowContext {
  const lineItems = Array.isArray(order.lineItems) ? order.lineItems : [];

  // In per-line-item mode the order id alone is not unique, so the key is
  // qualified by the line item. Falling back to the position keeps the key
  // stable even when eBay omits a lineItemId.
  const dedupeKey =
    options.perLineItem && lineItem
      ? `${order.orderId}::${lineItem.lineItemId ?? options.lineItemNumber ?? 1}`
      : String(order.orderId);

  const skus = lineItems
    .map((item) => item.sku)
    .filter((sku): sku is string => Boolean(sku));
  const titles = lineItems
    .map((item) => item.title)
    .filter((title): title is string => Boolean(title));
  const quantities = lineItems.map((item) => item.quantity ?? 0);

  return {
    order,
    lineItem,
    computed: {
      itemCount: lineItems.length,
      totalQuantity: quantities.reduce((sum, quantity) => sum + quantity, 0),

      // Pre-joined convenience values.
      skuList: skus.join(", "),
      titleList: titles.join(", "),
      quantityList: quantities.join(", "),
      itemSummary: lineItems
        .map((item) =>
          [
            `${item.quantity ?? 1} × ${item.sku ?? "(no SKU)"}`,
            item.title,
          ]
            .filter(Boolean)
            .join(" — "),
        )
        .join("; "),

      // Raw arrays, so the "Join list" transformation can control the
      // separator, de-duplication and truncation from the UI.
      skus,
      titles,
      quantities,

      syncedAt: syncedAt.toISOString(),
      lineItemNumber: options.lineItemNumber ?? 1,
      rowKey: dedupeKey,
    },
    dedupeKey,
  };
}

/**
 * Expands one order into the rows it should occupy.
 *
 * ORDER mode yields exactly one context. LINE_ITEM mode yields one per line
 * item — and still yields a single context for an order with no line items,
 * so the order is never silently dropped.
 */
export function expandOrderToRows(
  order: EbayOrderPayload,
  perLineItem: boolean,
  syncedAt: Date = new Date(),
): RowContext[] {
  const lineItems = Array.isArray(order.lineItems) ? order.lineItems : [];

  if (!perLineItem || lineItems.length === 0) {
    return [
      buildRowContext(order, lineItems[0] ?? null, syncedAt, {
        lineItemNumber: 1,
        perLineItem: false,
      }),
    ];
  }

  return lineItems.map((lineItem, index) =>
    buildRowContext(order, lineItem, syncedAt, {
      lineItemNumber: index + 1,
      perLineItem: true,
    }),
  );
}

export function resolveCell(
  mapping: MappingInput,
  context: RowContext,
): string {
  const args = fromJsonColumn<Record<string, string>>(
    mapping.transformArgsJson,
    {},
  );

  const raw =
    mapping.sourceField === "static"
      ? (mapping.staticValue ?? "")
      : getByPath(context, mapping.sourceField);

  // Transformations that combine several fields (or need the order's own
  // currency) get a resolver for the whole row rather than just this cell.
  const transformed = applyTransformation(mapping.transformation, raw, args, {
    resolve: (path) => getByPath(context, path),
  });

  if (transformed === "" && mapping.fallbackValue) return mapping.fallbackValue;
  return transformed;
}

/** Ordered [header, value] pairs for the enabled mappings. */
export function buildRow(
  mappings: MappingInput[],
  context: RowContext,
): { header: string; value: string }[] {
  return mappings
    .filter((m) => m.enabled)
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((mapping) => ({
      header: mapping.targetColumn,
      value: resolveCell(mapping, context),
    }));
}
