"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";

import { FeedbackBanner } from "@/components/FeedbackBanner";
import { Button } from "@/components/ui/Button";
import { Badge, inputClass, selectClass } from "@/components/ui/primitives";
import { useApiAction } from "@/components/useApiAction";
import {
  EBAY_FIELD_CATALOG,
  EBAY_FIELD_GROUPS,
  getEbayField,
} from "@/lib/ebay-fields";
import type { EbayOrderPayload } from "@/lib/ebay/order-payload";
import { buildRowContext, resolveCell } from "@/lib/sync/build-row";
import {
  TRANSFORMATIONS,
  TRANSFORMATION_GROUPS,
  defaultArgsFor,
  getTransformation,
} from "@/lib/transformations";

export interface MappingRow {
  key: string;
  targetColumn: string;
  sourceField: string;
  transformation: string;
  transformArgs: Record<string, string>;
  fallbackValue: string;
  staticValue: string;
  enabled: boolean;
}

interface MappingEditorProps {
  sheetColumns: string[];
  initialMappings: MappingRow[];
  /** The most recent real imported order, or null when there are none. */
  previewOrder: EbayOrderPayload | null;
}

function newKey() {
  return `row-${Math.random().toString(36).slice(2, 10)}`;
}

function serialise(rows: MappingRow[]) {
  return JSON.stringify(
    rows.map(({ key: _key, ...rest }) => rest),
  );
}

export function MappingEditor({
  sheetColumns,
  initialMappings,
  previewOrder,
}: MappingEditorProps) {
  const { run, pending, feedback, setFeedback } = useApiAction();
  const [rows, setRows] = useState<MappingRow[]>(initialMappings);
  const [baseline, setBaseline] = useState(() => serialise(initialMappings));

  const dirty = serialise(rows) !== baseline;

  const previewContext = useMemo(
    () =>
      previewOrder ? buildRowContext(previewOrder, null, new Date()) : null,
    [previewOrder],
  );

  const update = (key: string, patch: Partial<MappingRow>) => {
    setRows((current) =>
      current.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    );
  };

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= rows.length) return;
    setRows((current) => {
      const next = current.slice();
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const addRow = () => {
    const used = new Set(rows.map((r) => r.targetColumn.toLowerCase()));
    const nextColumn =
      sheetColumns.find((c) => !used.has(c.toLowerCase())) ?? "";
    setRows((current) => [
      ...current,
      {
        key: newKey(),
        targetColumn: nextColumn,
        sourceField: "order.orderId",
        transformation: "none",
        transformArgs: {},
        fallbackValue: "",
        staticValue: "",
        enabled: true,
      },
    ]);
  };

  const removeRow = (key: string) => {
    setRows((current) => current.filter((row) => row.key !== key));
  };

  const save = async () => {
    const invalid = rows.find((row) => !row.targetColumn.trim());
    if (invalid) {
      setFeedback({
        tone: "error",
        message: "Every mapping needs a destination column.",
      });
      return;
    }

    const result = await run(
      "save",
      {
        url: "/api/mappings",
        method: "PUT",
        body: {
          mappings: rows.map((row) => ({
            targetColumn: row.targetColumn.trim(),
            sourceField: row.sourceField,
            transformation: row.transformation,
            transformArgs: row.transformArgs,
            fallbackValue: row.fallbackValue || null,
            staticValue: row.staticValue || null,
            enabled: row.enabled,
          })),
        },
      },
      { successMessage: `Saved ${rows.length} mapping(s).` },
    );

    if (result.ok) setBaseline(serialise(rows));
  };

  const enabledCount = rows.filter((row) => row.enabled).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>
            {rows.length} mapping{rows.length === 1 ? "" : "s"} ·{" "}
            {enabledCount} enabled
          </span>
          {dirty ? <Badge tone="warning">Unsaved changes</Badge> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={addRow} disabled={pending !== null}>
            <Plus className="h-4 w-4" />
            Add mapping
          </Button>
          <Button
            onClick={() =>
              run(
                "automap",
                { url: "/api/mappings", body: { action: "auto-map" } },
                {
                  successMessage:
                    "Suggested mappings added for unmapped columns. Review and save.",
                },
              )
            }
            disabled={pending !== null}
          >
            {pending === "automap" ? "Matching…" : "Auto-map columns"}
          </Button>
          <Button
            variant="secondary"
            disabled={!dirty || pending !== null}
            onClick={() => {
              setRows(initialMappings);
              setBaseline(serialise(initialMappings));
              setFeedback(null);
            }}
          >
            Discard
          </Button>
          <Button
            variant="primary"
            disabled={!dirty || pending !== null}
            onClick={save}
          >
            {pending === "save" ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </div>

      <FeedbackBanner feedback={feedback} />

      <datalist id="sheet-columns">
        {sheetColumns.map((column) => (
          <option key={column} value={column} />
        ))}
      </datalist>

      <div className="scroll-area overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full min-w-[1100px] text-sm">
          <thead>
            <tr className="border-b border-border bg-muted text-left text-xs text-muted-foreground">
              <th className="w-20 px-3 py-2.5 font-medium">Order</th>
              <th className="px-3 py-2.5 font-medium">Google Column</th>
              <th className="px-3 py-2.5 font-medium">eBay Field</th>
              <th className="px-3 py-2.5 font-medium">Transformation</th>
              <th className="px-3 py-2.5 font-medium">Preview</th>
              <th className="w-20 px-3 py-2.5 font-medium">Enabled</th>
              <th className="w-12 px-3 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center">
                  <p className="text-sm font-medium text-foreground">
                    No mappings yet
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Add a mapping manually, or let the app suggest one per
                    detected column.
                  </p>
                </td>
              </tr>
            ) : (
              rows.map((row, index) => {
                const transformation = getTransformation(row.transformation);
                const field = getEbayField(row.sourceField);
                const preview = previewContext
                  ? resolveCell(
                      {
                        targetColumn: row.targetColumn,
                        sourceField: row.sourceField,
                        transformation: row.transformation,
                        transformArgsJson: JSON.stringify(row.transformArgs),
                        fallbackValue: row.fallbackValue || null,
                        staticValue: row.staticValue || null,
                        enabled: row.enabled,
                        position: index,
                      },
                      previewContext,
                    )
                  : "";

                return (
                  <tr
                    key={row.key}
                    className={`border-b border-border align-top last:border-0 ${
                      row.enabled ? "" : "bg-muted/60"
                    }`}
                  >
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-1">
                        <span className="w-4 text-xs tabular-nums text-muted-foreground">
                          {index + 1}
                        </span>
                        <button
                          type="button"
                          aria-label="Move up"
                          disabled={index === 0}
                          onClick={() => move(index, -1)}
                          className="rounded border border-border p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"
                        >
                          <ArrowUp className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          aria-label="Move down"
                          disabled={index === rows.length - 1}
                          onClick={() => move(index, 1)}
                          className="rounded border border-border p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"
                        >
                          <ArrowDown className="h-3 w-3" />
                        </button>
                      </div>
                    </td>

                    <td className="px-3 py-3">
                      <input
                        list="sheet-columns"
                        value={row.targetColumn}
                        onChange={(event) =>
                          update(row.key, { targetColumn: event.target.value })
                        }
                        placeholder="Column header"
                        className={inputClass}
                        aria-label={`Destination column for mapping ${index + 1}`}
                      />
                      {row.targetColumn &&
                      sheetColumns.length > 0 &&
                      !sheetColumns.includes(row.targetColumn) ? (
                        <p className="mt-1 text-[11px] text-warning">
                          Not in the detected header row — it will be created.
                        </p>
                      ) : null}
                    </td>

                    <td className="px-3 py-3">
                      <select
                        value={row.sourceField}
                        onChange={(event) =>
                          update(row.key, { sourceField: event.target.value })
                        }
                        className={selectClass}
                        aria-label={`eBay field for mapping ${index + 1}`}
                      >
                        {EBAY_FIELD_GROUPS.map((group) => (
                          <optgroup key={group} label={group}>
                            {EBAY_FIELD_CATALOG.filter(
                              (f) => f.group === group,
                            ).map((f) => (
                              <option key={f.key} value={f.key}>
                                {f.label}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                      {row.sourceField === "static" ? (
                        <input
                          value={row.staticValue}
                          onChange={(event) =>
                            update(row.key, { staticValue: event.target.value })
                          }
                          placeholder="Literal value"
                          className={`${inputClass} mt-1.5`}
                          aria-label="Static value"
                        />
                      ) : (
                        <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                          {field?.key ?? row.sourceField}
                        </p>
                      )}
                    </td>

                    <td className="px-3 py-3">
                      <select
                        value={row.transformation}
                        onChange={(event) => {
                          const id = event.target.value;
                          update(row.key, {
                            transformation: id,
                            transformArgs: defaultArgsFor(id),
                          });
                        }}
                        className={selectClass}
                        aria-label={`Transformation for mapping ${index + 1}`}
                      >
                        {TRANSFORMATION_GROUPS.map((group) => (
                          <optgroup key={group} label={group}>
                            {TRANSFORMATIONS.filter(
                              (t) => t.group === group,
                            ).map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.label}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                      {transformation && transformation.id !== "none" ? (
                        <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                          {transformation.description}
                        </p>
                      ) : null}

                      {transformation && transformation.args.length > 0 ? (
                        <div className="mt-1.5 space-y-1.5">
                          {transformation.args.map((arg) =>
                            arg.type === "select" ? (
                              <select
                                key={arg.name}
                                value={
                                  row.transformArgs[arg.name] ??
                                  arg.defaultValue ??
                                  ""
                                }
                                onChange={(event) =>
                                  update(row.key, {
                                    transformArgs: {
                                      ...row.transformArgs,
                                      [arg.name]: event.target.value,
                                    },
                                  })
                                }
                                className={`${selectClass} h-8 text-xs`}
                                aria-label={arg.label}
                              >
                                {arg.options?.map((option) => (
                                  <option key={option.value} value={option.value}>
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <div key={arg.name}>
                                <input
                                  type={arg.type === "number" ? "number" : "text"}
                                  value={row.transformArgs[arg.name] ?? ""}
                                  placeholder={arg.placeholder ?? arg.label}
                                  onChange={(event) =>
                                    update(row.key, {
                                      transformArgs: {
                                        ...row.transformArgs,
                                        [arg.name]: event.target.value,
                                      },
                                    })
                                  }
                                  className={`${inputClass} h-8 text-xs`}
                                  aria-label={arg.label}
                                />
                                {arg.hint ? (
                                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                                    {arg.hint}
                                  </p>
                                ) : null}
                              </div>
                            ),
                          )}
                        </div>
                      ) : null}

                      <input
                        value={row.fallbackValue}
                        onChange={(event) =>
                          update(row.key, { fallbackValue: event.target.value })
                        }
                        placeholder="Fallback when empty"
                        className={`${inputClass} mt-1.5 h-8 text-xs`}
                        aria-label="Fallback value"
                      />
                    </td>

                    <td className="px-3 py-3">
                      {previewContext ? (
                        <code className="block max-w-[220px] truncate rounded bg-muted px-2 py-1 font-mono text-xs text-foreground">
                          {preview || <span className="text-muted-foreground">empty</span>}
                        </code>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          No sample order
                        </span>
                      )}
                    </td>

                    <td className="px-3 py-3">
                      <label className="inline-flex cursor-pointer items-center gap-2">
                        <input
                          type="checkbox"
                          checked={row.enabled}
                          onChange={(event) =>
                            update(row.key, { enabled: event.target.checked })
                          }
                          className="h-4 w-4 rounded border-input accent-[var(--primary)]"
                          aria-label={`Enable mapping ${index + 1}`}
                        />
                        <span className="text-xs text-muted-foreground">
                          {row.enabled ? "On" : "Off"}
                        </span>
                      </label>
                    </td>

                    <td className="px-3 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => removeRow(row.key)}
                        aria-label={`Delete mapping ${index + 1}`}
                        className="rounded border border-border p-1.5 text-muted-foreground hover:border-danger-border hover:bg-danger-bg hover:text-danger"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {previewContext ? (
        <p className="text-xs text-muted-foreground">
          Preview values are computed from one sample order using the same
          transformation code the sync engine runs.
        </p>
      ) : null}
    </div>
  );
}
