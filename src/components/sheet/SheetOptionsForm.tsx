"use client";

import { useState } from "react";

import { FeedbackBanner } from "@/components/FeedbackBanner";
import { Button } from "@/components/ui/Button";
import { Field, inputClass, selectClass } from "@/components/ui/primitives";
import { useApiAction } from "@/components/useApiAction";
import {
  ROW_MODES,
  ROW_MODE_DESCRIPTIONS,
  SYNC_MODES,
  SYNC_MODE_DESCRIPTIONS,
  WRITE_MODES,
  WRITE_MODE_DESCRIPTIONS,
  type RowMode,
  type SyncMode,
  type WriteMode,
} from "@/lib/constants";

export function SheetOptionsForm({
  initial,
  columns,
}: {
  initial: {
    headerRow: number;
    firstDataRow: number;
    writeMode: string;
    matchColumn: string | null;
    rowMode: string;
    syncMode: string;
  };
  columns: string[];
}) {
  const { run, pending, feedback } = useApiAction();
  const [form, setForm] = useState({
    headerRow: String(initial.headerRow),
    firstDataRow: String(initial.firstDataRow),
    writeMode: initial.writeMode,
    matchColumn: initial.matchColumn ?? "",
    rowMode: initial.rowMode,
    syncMode: initial.syncMode,
  });

  const writeMode = form.writeMode as WriteMode;

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        run(
          "options",
          {
            url: "/api/sheet-config",
            method: "PATCH",
            body: {
              headerRow: Number(form.headerRow),
              firstDataRow: Number(form.firstDataRow),
              writeMode: form.writeMode,
              matchColumn: form.matchColumn || null,
              rowMode: form.rowMode,
              syncMode: form.syncMode,
            },
          },
          { successMessage: "Sheet options saved." },
        );
      }}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Header row" htmlFor="header-row" hint="Row that holds the column names.">
          <input
            id="header-row"
            type="number"
            min={1}
            max={50}
            value={form.headerRow}
            onChange={(event) =>
              setForm({ ...form, headerRow: event.target.value })
            }
            className={inputClass}
          />
        </Field>

        <Field
          label="First data row"
          htmlFor="first-data-row"
          hint="Where order rows begin."
        >
          <input
            id="first-data-row"
            type="number"
            min={1}
            max={100}
            value={form.firstDataRow}
            onChange={(event) =>
              setForm({ ...form, firstDataRow: event.target.value })
            }
            className={inputClass}
          />
        </Field>

        <Field
          label="Write mode"
          htmlFor="write-mode"
          hint={WRITE_MODE_DESCRIPTIONS[writeMode] ?? undefined}
        >
          <select
            id="write-mode"
            value={form.writeMode}
            onChange={(event) =>
              setForm({ ...form, writeMode: event.target.value })
            }
            className={selectClass}
          >
            {Object.values(WRITE_MODES).map((mode) => (
              <option key={mode} value={mode}>
                {mode.charAt(0) + mode.slice(1).toLowerCase()}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Rows"
          htmlFor="row-mode"
          hint={ROW_MODE_DESCRIPTIONS[form.rowMode as RowMode]}
        >
          <select
            id="row-mode"
            value={form.rowMode}
            onChange={(event) => setForm({ ...form, rowMode: event.target.value })}
            className={selectClass}
          >
            <option value={ROW_MODES.ORDER}>One row per order</option>
            <option value={ROW_MODES.LINE_ITEM}>One row per line item</option>
          </select>
        </Field>

        <Field
          label="Sync mode"
          htmlFor="sync-mode"
          hint={SYNC_MODE_DESCRIPTIONS[form.syncMode as SyncMode]}
        >
          <select
            id="sync-mode"
            value={form.syncMode}
            onChange={(event) =>
              setForm({ ...form, syncMode: event.target.value })
            }
            className={selectClass}
          >
            <option value={SYNC_MODES.APPEND_UPDATE}>Append + update</option>
            <option value={SYNC_MODES.APPEND}>Append new orders only</option>
            <option value={SYNC_MODES.UPDATE}>Update existing orders only</option>
          </select>
        </Field>

        <Field
          label="Key column"
          htmlFor="match-column"
          hint={
            form.rowMode === ROW_MODES.LINE_ITEM
              ? 'Must be unique per line item — map it to "Row Key (unique)" or the line item id.'
              : "Used to match an existing row so orders are updated, not duplicated."
          }
        >
          <select
            id="match-column"
            value={form.matchColumn}
            disabled={form.writeMode !== WRITE_MODES.UPSERT}
            onChange={(event) =>
              setForm({ ...form, matchColumn: event.target.value })
            }
            className={selectClass}
          >
            <option value="">Not set</option>
            {columns.map((column) => (
              <option key={column} value={column}>
                {column}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <FeedbackBanner feedback={feedback} />

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" disabled={pending !== null}>
          {pending === "options" ? "Saving…" : "Save sheet options"}
        </Button>

        <Button
          type="button"
          disabled={pending !== null}
          onClick={() =>
            run(
              "reread",
              {
                url: "/api/sheet-config",
                method: "PATCH",
                body: { refreshHeaders: true },
              },
              {
                successMessage: (data) => {
                  const result = (data ?? {}) as {
                    columns?: number;
                    duplicates?: string[];
                  };
                  const duplicates = result.duplicates?.length
                    ? ` Duplicate headers: ${result.duplicates.join(", ")}.`
                    : "";
                  return `Re-read ${result.columns ?? 0} header(s) from the sheet.${duplicates}`;
                },
              },
            )
          }
        >
          {pending === "reread" ? "Reading…" : "Re-read header row"}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        Changing the header row re-reads it from the sheet automatically.
        Nothing is written to your spreadsheet.
      </p>
    </form>
  );
}
