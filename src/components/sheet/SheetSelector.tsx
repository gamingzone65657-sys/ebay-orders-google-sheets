"use client";

import { useState } from "react";

import { FeedbackBanner } from "@/components/FeedbackBanner";
import { Button } from "@/components/ui/Button";
import { Field, selectClass } from "@/components/ui/primitives";
import { useApiAction } from "@/components/useApiAction";

export interface SpreadsheetOption {
  spreadsheetId: string;
  name: string;
  ownerEmail: string;
  tabs: { sheetName: string; rowCount: number; columnCount: number }[];
}

export function SheetSelector({
  spreadsheets,
  currentSpreadsheetId,
  currentSheetName,
  googleConnected,
}: {
  spreadsheets: SpreadsheetOption[];
  currentSpreadsheetId: string | null;
  currentSheetName: string | null;
  googleConnected: boolean;
}) {
  const { run, pending, feedback } = useApiAction();
  const [spreadsheetId, setSpreadsheetId] = useState(
    currentSpreadsheetId ?? spreadsheets[0]?.spreadsheetId ?? "",
  );
  const selected = spreadsheets.find((s) => s.spreadsheetId === spreadsheetId);
  const [sheetName, setSheetName] = useState(
    currentSheetName ?? selected?.tabs[0]?.sheetName ?? "",
  );

  const isCurrent =
    spreadsheetId === currentSpreadsheetId && sheetName === currentSheetName;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Spreadsheet" htmlFor="spreadsheet">
          <select
            id="spreadsheet"
            value={spreadsheetId}
            disabled={!googleConnected}
            onChange={(event) => {
              const next = event.target.value;
              setSpreadsheetId(next);
              const tabs =
                spreadsheets.find((s) => s.spreadsheetId === next)?.tabs ?? [];
              setSheetName(tabs[0]?.sheetName ?? "");
            }}
            className={selectClass}
          >
            {spreadsheets.map((sheet) => (
              <option key={sheet.spreadsheetId} value={sheet.spreadsheetId}>
                {sheet.name}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Tab"
          htmlFor="sheet-tab"
          hint={
            selected?.tabs.find((t) => t.sheetName === sheetName)
              ? `${
                  selected.tabs.find((t) => t.sheetName === sheetName)!.rowCount
                } existing rows, ${
                  selected.tabs.find((t) => t.sheetName === sheetName)!
                    .columnCount
                } columns`
              : undefined
          }
        >
          <select
            id="sheet-tab"
            value={sheetName}
            disabled={!googleConnected || !selected}
            onChange={(event) => setSheetName(event.target.value)}
            className={selectClass}
          >
            {(selected?.tabs ?? []).map((tab) => (
              <option key={tab.sheetName} value={tab.sheetName}>
                {tab.sheetName}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          disabled={!googleConnected || !spreadsheetId || !sheetName || pending !== null}
          onClick={() =>
            run(
              "select",
              {
                url: "/api/sheet-config",
                body: { spreadsheetId, sheetName },
              },
              {
                successMessage: (data) => {
                  const count = (data as { columns?: number })?.columns ?? 0;
                  return `Destination saved. ${count} column${
                    count === 1 ? "" : "s"
                  } detected from the header row.`;
                },
              },
            )
          }
        >
          {pending === "select"
            ? "Saving…"
            : isCurrent
              ? "Re-detect columns"
              : "Use this sheet"}
        </Button>
        {isCurrent ? (
          <span className="text-sm text-muted-foreground">
            This is the current destination.
          </span>
        ) : null}
      </div>

      {!googleConnected ? (
        <p className="text-sm text-muted-foreground">
          Connect Google first — the spreadsheet list comes from the connected
          account.
        </p>
      ) : null}

      <FeedbackBanner feedback={feedback} />
    </div>
  );
}
