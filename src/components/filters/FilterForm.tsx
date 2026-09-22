"use client";

import { useState } from "react";

import { FeedbackBanner } from "@/components/FeedbackBanner";
import { Button } from "@/components/ui/Button";
import { Field, inputClass, selectClass } from "@/components/ui/primitives";
import { useApiAction } from "@/components/useApiAction";
import {
  FULFILLMENT_FILTERS,
  ORDER_STATE_FILTERS,
  SKU_FILTER_MODES,
} from "@/lib/constants";

export interface FilterFormValues {
  orderStates: string[];
  fulfillmentStates: string[];
  marketplaces: string[];
  skuMode: string;
  skuValues: string;
  skuCaseSensitive: boolean;
  dateFrom: string;
  dateTo: string;
}

function CheckboxGrid({
  options,
  selected,
  onToggle,
  disabled,
}: {
  options: readonly { id: string; label: string; description: string }[];
  selected: string[];
  onToggle: (id: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {options.map((option) => (
        <label
          key={option.id}
          className="flex items-start gap-2 rounded-md border border-border px-3 py-2 hover:bg-muted"
        >
          <input
            type="checkbox"
            checked={selected.includes(option.id)}
            onChange={() => onToggle(option.id)}
            disabled={disabled}
            className="mt-0.5 h-4 w-4 rounded border-input accent-[var(--primary)]"
          />
          <span className="min-w-0">
            <span className="block text-sm text-foreground">{option.label}</span>
            <span className="block text-xs text-muted-foreground">
              {option.description}
            </span>
          </span>
        </label>
      ))}
    </div>
  );
}

export function FilterForm({
  initial,
  marketplaces,
}: {
  initial: FilterFormValues;
  /** Marketplaces seen in this workspace's orders, plus any already selected. */
  marketplaces: string[];
}) {
  const { run, pending, feedback } = useApiAction();
  const [form, setForm] = useState(initial);

  const toggle = (key: "orderStates" | "fulfillmentStates" | "marketplaces") =>
    (id: string) =>
      setForm((current) => ({
        ...current,
        [key]: current[key].includes(id)
          ? current[key].filter((entry) => entry !== id)
          : [...current[key], id],
      }));

  const skuMode = SKU_FILTER_MODES.find((mode) => mode.id === form.skuMode);
  const busy = pending !== null;

  const valuesLabel =
    form.skuMode === "INCLUDE" || form.skuMode === "EXCLUDE"
      ? "SKUs (one per line, or comma-separated)"
      : "Fragments to match (one per line, or comma-separated)";

  return (
    <form
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault();
        run(
          "filters",
          {
            url: "/api/filters",
            method: "PUT",
            body: {
              orderStates: form.orderStates,
              fulfillmentStates: form.fulfillmentStates,
              marketplaces: form.marketplaces,
              skuMode: form.skuMode,
              skuValues: form.skuValues,
              skuCaseSensitive: form.skuCaseSensitive,
              dateFrom: form.dateFrom
                ? new Date(`${form.dateFrom}T00:00:00.000Z`).toISOString()
                : null,
              dateTo: form.dateTo
                ? new Date(`${form.dateTo}T23:59:59.999Z`).toISOString()
                : null,
            },
          },
          { successMessage: "Filters saved." },
        );
      }}
    >
      <section>
        <h3 className="text-sm font-semibold text-foreground">Order status</h3>
        <p className="mt-0.5 mb-2 text-xs text-muted-foreground">
          Selecting nothing means all orders. Selections are combined with
          &ldquo;or&rdquo;, because an order can be both paid and shipped.
        </p>
        <CheckboxGrid
          options={ORDER_STATE_FILTERS}
          selected={form.orderStates}
          onToggle={toggle("orderStates")}
          disabled={busy}
        />
      </section>

      <section className="border-t border-border pt-5">
        <h3 className="text-sm font-semibold text-foreground">Fulfillment</h3>
        <p className="mt-0.5 mb-2 text-xs text-muted-foreground">
          Selecting nothing means any fulfillment state.
        </p>
        <CheckboxGrid
          options={FULFILLMENT_FILTERS}
          selected={form.fulfillmentStates}
          onToggle={toggle("fulfillmentStates")}
          disabled={busy}
        />
      </section>

      <section className="border-t border-border pt-5">
        <h3 className="text-sm font-semibold text-foreground">Marketplace</h3>
        <p className="mt-0.5 mb-2 text-xs text-muted-foreground">
          {marketplaces.length > 0
            ? "Selecting nothing means every marketplace."
            : "No marketplaces seen yet — import some orders first."}
        </p>
        <div className="flex flex-wrap gap-2">
          {marketplaces.map((marketplace) => {
            const active = form.marketplaces.includes(marketplace);
            return (
              <button
                key={marketplace}
                type="button"
                disabled={busy}
                onClick={() => toggle("marketplaces")(marketplace)}
                className={`rounded-full px-3 py-1 text-xs font-medium ${
                  active
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-muted"
                }`}
              >
                {marketplace}
              </button>
            );
          })}
        </div>
      </section>

      <section className="border-t border-border pt-5">
        <h3 className="text-sm font-semibold text-foreground">SKU</h3>
        <div className="mt-2 grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Field label="Mode" htmlFor="sku-mode">
            <select
              id="sku-mode"
              value={form.skuMode}
              onChange={(event) =>
                setForm({ ...form, skuMode: event.target.value })
              }
              className={selectClass}
              disabled={busy}
            >
              {SKU_FILTER_MODES.map((mode) => (
                <option key={mode.id} value={mode.id}>
                  {mode.label}
                </option>
              ))}
            </select>
          </Field>

          {skuMode?.needsValues ? (
            <>
              <Field
                label={valuesLabel}
                htmlFor="sku-values"
                className="lg:col-span-2"
              >
                <textarea
                  id="sku-values"
                  value={form.skuValues}
                  onChange={(event) =>
                    setForm({ ...form, skuValues: event.target.value })
                  }
                  rows={4}
                  placeholder={"One SKU per line"}
                  className="w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted-foreground"
                  disabled={busy}
                />
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.skuCaseSensitive}
                  onChange={(event) =>
                    setForm({ ...form, skuCaseSensitive: event.target.checked })
                  }
                  className="h-4 w-4 rounded border-input accent-[var(--primary)]"
                  disabled={busy}
                />
                <span className="text-foreground">Case sensitive</span>
              </label>
            </>
          ) : null}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          In one-row-per-order mode an order is kept if any of its items
          matches, so a multi-item order is never partly lost. In
          one-row-per-line-item mode each row is filtered on its own SKU.
        </p>
      </section>

      <section className="border-t border-border pt-5">
        <h3 className="text-sm font-semibold text-foreground">Date bounds</h3>
        <p className="mt-0.5 mb-2 text-xs text-muted-foreground">
          Optional hard limits. These narrow whatever range is chosen at sync
          time; they never widen it.
        </p>
        <div className="flex flex-wrap gap-4">
          <Field label="Not before" htmlFor="filter-from">
            <input
              id="filter-from"
              type="date"
              value={form.dateFrom}
              onChange={(event) =>
                setForm({ ...form, dateFrom: event.target.value })
              }
              className={`${inputClass} w-44`}
              disabled={busy}
            />
          </Field>
          <Field label="Not after" htmlFor="filter-to">
            <input
              id="filter-to"
              type="date"
              value={form.dateTo}
              onChange={(event) =>
                setForm({ ...form, dateTo: event.target.value })
              }
              className={`${inputClass} w-44`}
              disabled={busy}
            />
          </Field>
        </div>
      </section>

      <FeedbackBanner feedback={feedback} />

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <Button type="submit" variant="primary" disabled={busy}>
          {pending === "filters" ? "Saving…" : "Save filters"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={() =>
            setForm({
              orderStates: [],
              fulfillmentStates: [],
              marketplaces: [],
              skuMode: "ALL",
              skuValues: "",
              skuCaseSensitive: false,
              dateFrom: "",
              dateTo: "",
            })
          }
        >
          Clear all filters
        </Button>
      </div>
    </form>
  );
}
