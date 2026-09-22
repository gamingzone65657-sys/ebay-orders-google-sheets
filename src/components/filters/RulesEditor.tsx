"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";

import { FeedbackBanner } from "@/components/FeedbackBanner";
import { Button } from "@/components/ui/Button";
import { Badge, inputClass, selectClass } from "@/components/ui/primitives";
import { useApiAction } from "@/components/useApiAction";
import {
  RULE_ACTIONS,
  RULE_FIELDS,
  RULE_OPERATORS,
} from "@/lib/sync/rules";

export interface RuleRow {
  key: string;
  name: string;
  enabled: boolean;
  match: "ALL" | "ANY";
  conditions: { field: string; operator: string; value: string }[];
  action: string;
  args: { column?: string; value?: string; savedConfigId?: string };
  lastMatchCount: number | null;
}

const VALUELESS = new Set(["is_empty", "is_not_empty"]);

function newKey() {
  return `rule-${Math.random().toString(36).slice(2, 10)}`;
}

function serialise(rules: RuleRow[]) {
  return JSON.stringify(rules.map(({ key: _key, lastMatchCount: _c, ...rest }) => rest));
}

export function RulesEditor({
  initialRules,
  sheetColumns,
  savedConfigurations,
}: {
  initialRules: RuleRow[];
  sheetColumns: string[];
  savedConfigurations: { id: string; name: string }[];
}) {
  const { run, pending, feedback, setFeedback } = useApiAction();
  const [rules, setRules] = useState<RuleRow[]>(initialRules);
  const [baseline, setBaseline] = useState(() => serialise(initialRules));

  const dirty = serialise(rules) !== baseline;

  const update = (key: string, patch: Partial<RuleRow>) =>
    setRules((current) =>
      current.map((rule) => (rule.key === key ? { ...rule, ...patch } : rule)),
    );

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= rules.length) return;
    setRules((current) => {
      const next = current.slice();
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const addRule = () =>
    setRules((current) => [
      ...current,
      {
        key: newKey(),
        name: `Rule ${current.length + 1}`,
        enabled: true,
        match: "ALL",
        conditions: [{ field: "lineItem.sku", operator: "contains", value: "" }],
        action: "EXCLUDE",
        args: {},
        lastMatchCount: null,
      },
    ]);

  const save = async () => {
    const result = await run(
      "rules",
      {
        url: "/api/rules",
        method: "PUT",
        body: {
          rules: rules.map((rule) => ({
            name: rule.name,
            enabled: rule.enabled,
            match: rule.match,
            conditions: rule.conditions,
            action: rule.action,
            args: rule.args,
          })),
        },
      },
      { successMessage: `Saved ${rules.length} rule(s).` },
    );
    if (result.ok) setBaseline(serialise(rules));
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>
            {rules.length} rule{rules.length === 1 ? "" : "s"} ·{" "}
            {rules.filter((rule) => rule.enabled).length} enabled
          </span>
          {dirty ? <Badge tone="warning">Unsaved changes</Badge> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={addRule} disabled={pending !== null}>
            <Plus className="h-4 w-4" />
            Add rule
          </Button>
          <Button
            variant="secondary"
            disabled={!dirty || pending !== null}
            onClick={() => {
              setRules(initialRules);
              setBaseline(serialise(initialRules));
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
            {pending === "rules" ? "Saving…" : "Save rules"}
          </Button>
        </div>
      </div>

      <FeedbackBanner feedback={feedback} />

      {rules.length === 0 ? (
        <div className="rounded-md border border-dashed border-input px-4 py-8 text-center">
          <p className="text-sm font-medium text-foreground">No rules yet</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Rules run in order on every row, after filters and before writing.
            For example: <em>if SKU contains &ldquo;ABC&rdquo;, then import
            it</em>, or <em>if marketplace is EBAY_GB, then use a saved
            configuration</em>.
          </p>
        </div>
      ) : null}

      <ol className="space-y-3">
        {rules.map((rule, index) => {
          const action = RULE_ACTIONS.find((entry) => entry.id === rule.action);
          return (
            <li
              key={rule.key}
              className={`rounded-lg border p-4 ${
                rule.enabled
                  ? "border-border bg-card"
                  : "border-border bg-muted"
              }`}
            >
              {/* Header --------------------------------------------- */}
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs tabular-nums text-muted-foreground">
                  {index + 1}
                </span>
                <input
                  value={rule.name}
                  onChange={(event) =>
                    update(rule.key, { name: event.target.value })
                  }
                  placeholder="Rule name"
                  className={`${inputClass} max-w-xs flex-1`}
                  aria-label={`Name for rule ${index + 1}`}
                />

                {rule.lastMatchCount !== null ? (
                  <Badge tone={rule.lastMatchCount > 0 ? "info" : "neutral"}>
                    matched {rule.lastMatchCount} last run
                  </Badge>
                ) : null}

                <div className="ml-auto flex items-center gap-1">
                  <label className="mr-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={(event) =>
                        update(rule.key, { enabled: event.target.checked })
                      }
                      className="h-4 w-4 rounded border-input accent-[var(--primary)]"
                    />
                    Enabled
                  </label>
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
                    disabled={index === rules.length - 1}
                    onClick={() => move(index, 1)}
                    className="rounded border border-border p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"
                  >
                    <ArrowDown className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete rule ${index + 1}`}
                    onClick={() =>
                      setRules((current) =>
                        current.filter((entry) => entry.key !== rule.key),
                      )
                    }
                    className="rounded border border-border p-1.5 text-muted-foreground hover:border-danger-border hover:bg-danger-bg hover:text-danger"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              {/* Conditions ----------------------------------------- */}
              <div className="mt-3 rounded-md bg-muted p-3">
                <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-semibold text-foreground">IF</span>
                  <select
                    value={rule.match}
                    onChange={(event) =>
                      update(rule.key, {
                        match: event.target.value as "ALL" | "ANY",
                      })
                    }
                    className={`${selectClass} h-7 w-36 text-xs`}
                    aria-label="Match mode"
                  >
                    <option value="ALL">all conditions match</option>
                    <option value="ANY">any condition matches</option>
                  </select>
                </div>

                <div className="space-y-2">
                  {rule.conditions.map((condition, conditionIndex) => (
                    <div
                      key={conditionIndex}
                      className="flex flex-wrap items-center gap-2"
                    >
                      <select
                        value={condition.field}
                        onChange={(event) => {
                          const next = rule.conditions.slice();
                          next[conditionIndex] = {
                            ...condition,
                            field: event.target.value,
                          };
                          update(rule.key, { conditions: next });
                        }}
                        className={`${selectClass} w-52`}
                        aria-label="Field"
                      >
                        {RULE_FIELDS.map((field) => (
                          <option key={field.key} value={field.key}>
                            {field.label}
                          </option>
                        ))}
                      </select>

                      <select
                        value={condition.operator}
                        onChange={(event) => {
                          const next = rule.conditions.slice();
                          next[conditionIndex] = {
                            ...condition,
                            operator: event.target.value,
                          };
                          update(rule.key, { conditions: next });
                        }}
                        className={`${selectClass} w-44`}
                        aria-label="Test"
                      >
                        {RULE_OPERATORS.map((operator) => (
                          <option key={operator.value} value={operator.value}>
                            {operator.label}
                          </option>
                        ))}
                      </select>

                      {VALUELESS.has(condition.operator) ? (
                        <span className="text-xs text-muted-foreground">
                          (no value needed)
                        </span>
                      ) : (
                        <input
                          value={condition.value}
                          onChange={(event) => {
                            const next = rule.conditions.slice();
                            next[conditionIndex] = {
                              ...condition,
                              value: event.target.value,
                            };
                            update(rule.key, { conditions: next });
                          }}
                          placeholder="value"
                          className={`${inputClass} w-44`}
                          aria-label="Value"
                        />
                      )}

                      {rule.conditions.length > 1 ? (
                        <button
                          type="button"
                          onClick={() =>
                            update(rule.key, {
                              conditions: rule.conditions.filter(
                                (_, i) => i !== conditionIndex,
                              ),
                            })
                          }
                          className="rounded border border-border p-1.5 text-muted-foreground hover:bg-card"
                          aria-label="Remove condition"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>

                <button
                  type="button"
                  onClick={() =>
                    update(rule.key, {
                      conditions: [
                        ...rule.conditions,
                        { field: "lineItem.sku", operator: "contains", value: "" },
                      ],
                    })
                  }
                  className="mt-2 text-xs text-link hover:underline"
                >
                  + Add condition
                </button>
              </div>

              {/* Action --------------------------------------------- */}
              <div className="mt-3 flex flex-wrap items-start gap-2">
                <span className="mt-2 text-xs font-semibold text-foreground">
                  THEN
                </span>
                <div className="min-w-[220px]">
                  <select
                    value={rule.action}
                    onChange={(event) =>
                      update(rule.key, { action: event.target.value, args: {} })
                    }
                    className={selectClass}
                    aria-label="Action"
                  >
                    {RULE_ACTIONS.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.label}
                      </option>
                    ))}
                  </select>
                  {action ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {action.description}
                    </p>
                  ) : null}
                </div>

                {action?.needsColumn ? (
                  <select
                    value={rule.args.column ?? ""}
                    onChange={(event) =>
                      update(rule.key, {
                        args: { ...rule.args, column: event.target.value },
                      })
                    }
                    className={`${selectClass} w-48`}
                    aria-label="Target column"
                  >
                    <option value="">Choose a column…</option>
                    {sheetColumns.map((column) => (
                      <option key={column} value={column}>
                        {column}
                      </option>
                    ))}
                  </select>
                ) : null}

                {action?.needsValue ? (
                  <input
                    value={rule.args.value ?? ""}
                    onChange={(event) =>
                      update(rule.key, {
                        args: { ...rule.args, value: event.target.value },
                      })
                    }
                    placeholder="value to write"
                    className={`${inputClass} w-48`}
                    aria-label="Value to write"
                  />
                ) : null}

                {action?.needsMappingSet ? (
                  <select
                    value={rule.args.savedConfigId ?? ""}
                    onChange={(event) =>
                      update(rule.key, {
                        args: {
                          ...rule.args,
                          savedConfigId: event.target.value,
                        },
                      })
                    }
                    className={`${selectClass} w-56`}
                    aria-label="Saved configuration"
                  >
                    <option value="">Choose a configuration…</option>
                    {savedConfigurations.map((config) => (
                      <option key={config.id} value={config.id}>
                        {config.name}
                      </option>
                    ))}
                  </select>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>

      {rules.some((rule) => rule.action === "INCLUDE_ONLY") ? (
        <p className="rounded-md border border-warning-border bg-warning-bg px-4 py-3 text-sm text-warning">
          One or more rules use <strong>Import only matching rows</strong>.
          While any of those exist, a row must match at least one of them to be
          written — everything else is skipped.
        </p>
      ) : null}
    </div>
  );
}
