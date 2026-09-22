"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, RefreshCw, Search } from "lucide-react";

import { FeedbackBanner } from "@/components/FeedbackBanner";
import { Button } from "@/components/ui/Button";
import { Badge, inputClass, selectClass } from "@/components/ui/primitives";
import { useApiAction } from "@/components/useApiAction";
import { fetchJson, type ApiFailure } from "@/lib/fetch-json";
import { formatDateTime } from "@/lib/format";

interface Spreadsheet {
  id: string;
  name: string;
  modifiedTime: string | null;
  ownerEmail: string | null;
  ownerName: string | null;
  webViewLink: string | null;
  shared: boolean;
}

interface Worksheet {
  sheetId: number;
  title: string;
  index: number;
  sheetType: string;
  rowCount: number | null;
  columnCount: number | null;
  frozenRowCount: number | null;
  hidden: boolean;
}

type ApiError = ApiFailure;

export function SpreadsheetPicker({
  connected,
  currentSpreadsheetId,
  currentSheetName,
  currentHeaderRow,
  currentFirstDataRow,
}: {
  connected: boolean;
  currentSpreadsheetId: string | null;
  currentSheetName: string | null;
  currentHeaderRow: number;
  currentFirstDataRow: number;
}) {
  const { run, pending, feedback, setFeedback } = useApiAction();

  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<ApiError | null>(null);
  const [spreadsheets, setSpreadsheets] = useState<Spreadsheet[]>([]);

  const [selectedId, setSelectedId] = useState(currentSpreadsheetId ?? "");
  const [manualId, setManualId] = useState("");
  const [showManual, setShowManual] = useState(false);

  const [worksheets, setWorksheets] = useState<Worksheet[] | null>(null);
  const [worksheetsFor, setWorksheetsFor] = useState<string | null>(null);
  const [loadingWorksheets, setLoadingWorksheets] = useState(false);
  const [worksheetError, setWorksheetError] = useState<ApiError | null>(null);
  const [sheetName, setSheetName] = useState(currentSheetName ?? "");

  const [headerRow, setHeaderRow] = useState(String(currentHeaderRow));
  const [firstDataRow, setFirstDataRow] = useState(String(currentFirstDataRow));

  // Guards against an older in-flight list response overwriting a newer one.
  const listRequestId = useRef(0);

  const loadSpreadsheets = useCallback(
    async (query: string) => {
      if (!connected) return;
      const requestId = ++listRequestId.current;
      setLoading(true);
      setListError(null);

      const result = await fetchJson<{ spreadsheets?: Spreadsheet[] }>(
        `/api/google/spreadsheets?q=${encodeURIComponent(query)}`,
      );

      // A stale response must not overwrite a newer one.
      if (requestId !== listRequestId.current) return;

      if (result.ok) {
        setSpreadsheets(
          Array.isArray(result.data.spreadsheets) ? result.data.spreadsheets : [],
        );
      } else {
        setSpreadsheets([]);
        setListError(result.error);
      }
      setLoading(false);
    },
    [connected],
  );

  useEffect(() => {
    void loadSpreadsheets("");
  }, [loadSpreadsheets]);

  const loadWorksheets = useCallback(async (spreadsheetId: string) => {
    if (!spreadsheetId) return;
    setLoadingWorksheets(true);
    setWorksheetError(null);
    setWorksheets(null);

    const result = await fetchJson<{
      spreadsheet?: { worksheets?: Worksheet[] };
    }>(`/api/google/spreadsheets/${encodeURIComponent(spreadsheetId)}`);

    if (!result.ok) {
      setWorksheetError(result.error);
      setLoadingWorksheets(false);
      return;
    }

    const tabs: Worksheet[] = result.data.spreadsheet?.worksheets ?? [];
    setWorksheets(tabs);
    setWorksheetsFor(spreadsheetId);
    // Keep the current selection if it still exists, else take the first.
    setSheetName((previous) =>
      tabs.some((tab) => tab.title === previous)
        ? previous
        : (tabs.find((tab) => tab.sheetType === "GRID" && !tab.hidden)?.title ??
          tabs[0]?.title ??
          ""),
    );
    setLoadingWorksheets(false);
  }, []);

  // Load tabs for whatever is already configured, so the page is usable on
  // arrival without another click.
  useEffect(() => {
    if (currentSpreadsheetId) void loadWorksheets(currentSpreadsheetId);
  }, [currentSpreadsheetId, loadWorksheets]);

  const chooseSpreadsheet = (id: string) => {
    setSelectedId(id);
    setSheetName("");
    void loadWorksheets(id);
  };

  const selectedWorksheet = worksheets?.find((tab) => tab.title === sheetName);
  const canSave =
    connected &&
    Boolean(selectedId) &&
    Boolean(sheetName) &&
    worksheetsFor === selectedId &&
    pending === null;

  return (
    <div className="space-y-5">
      {/* --- 1. Spreadsheet ------------------------------------------- */}
      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-foreground">
            1. Choose a spreadsheet
          </h3>
          <Button
            size="sm"
            disabled={!connected || loading}
            onClick={() => void loadSpreadsheets(search)}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {loading ? "Refreshing…" : "Refresh list"}
          </Button>
        </div>

        <form
          className="relative mb-2"
          onSubmit={(event) => {
            event.preventDefault();
            void loadSpreadsheets(search);
          }}
        >
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={search}
            disabled={!connected}
            placeholder="Search your spreadsheets by name"
            onChange={(event) => setSearch(event.target.value)}
            className={`${inputClass} pl-8`}
            aria-label="Search spreadsheets"
          />
        </form>

        {listError ? (
          <div className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger">
            {listError.message}
            <span className="mt-1 block font-mono text-xs break-words">
              {listError.code}
              {listError.status ? ` · HTTP ${listError.status}` : ""}
              {listError.detail ? ` · ${listError.detail}` : ""}
            </span>
          </div>
        ) : null}

        <div className="scroll-area max-h-72 overflow-y-auto rounded-md border border-border">
          {loading && spreadsheets.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              Loading spreadsheets…
            </p>
          ) : spreadsheets.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              {connected
                ? "No spreadsheets matched."
                : "Connect Google to list your spreadsheets."}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {spreadsheets.map((sheet) => {
                const active = sheet.id === selectedId;
                return (
                  <li key={sheet.id}>
                    <button
                      type="button"
                      onClick={() => chooseSpreadsheet(sheet.id)}
                      className={`flex w-full items-start gap-2 px-3 py-2.5 text-left hover:bg-muted ${
                        active ? "bg-info-bg" : ""
                      }`}
                    >
                      <span className="mt-0.5 w-4 shrink-0">
                        {active ? (
                          <Check className="h-4 w-4 text-link" />
                        ) : null}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-foreground">
                          {sheet.name}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {sheet.ownerEmail ?? "—"}
                          {sheet.modifiedTime
                            ? ` · modified ${formatDateTime(sheet.modifiedTime)}`
                            : ""}
                        </span>
                        <span className="block truncate font-mono text-[11px] text-muted-foreground">
                          {sheet.id}
                        </span>
                      </span>
                      {sheet.shared ? <Badge tone="neutral">Shared</Badge> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowManual((value) => !value)}
            className="text-xs text-link hover:underline"
          >
            {showManual ? "Hide" : "Advanced:"} enter a Spreadsheet ID manually
          </button>
          {showManual ? (
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <div className="min-w-[260px] flex-1">
                <input
                  value={manualId}
                  onChange={(event) => setManualId(event.target.value)}
                  placeholder="Spreadsheet ID or full Google Sheets URL"
                  className={inputClass}
                  aria-label="Spreadsheet ID"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Useful when a sheet is shared with you but does not appear in
                  the list. A full URL works too.
                </p>
              </div>
              <Button
                disabled={!connected || !manualId.trim() || loadingWorksheets}
                onClick={() => chooseSpreadsheet(manualId.trim())}
              >
                Open
              </Button>
            </div>
          ) : null}
        </div>
      </section>

      {/* --- 2. Worksheet --------------------------------------------- */}
      <section className="border-t border-border pt-4">
        <h3 className="mb-2 text-sm font-medium text-foreground">
          2. Choose a worksheet
        </h3>

        {worksheetError ? (
          <div className="mb-2 rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger">
            {worksheetError.message}
            <span className="mt-1 block font-mono text-xs break-words">
              {worksheetError.code}
              {worksheetError.status ? ` · HTTP ${worksheetError.status}` : ""}
              {worksheetError.detail ? ` · ${worksheetError.detail}` : ""}
            </span>
          </div>
        ) : null}

        {!selectedId ? (
          <p className="text-sm text-muted-foreground">
            Pick a spreadsheet first.
          </p>
        ) : loadingWorksheets ? (
          <p className="text-sm text-muted-foreground">Loading worksheets…</p>
        ) : worksheets && worksheets.length > 0 ? (
          <>
            <select
              value={sheetName}
              onChange={(event) => setSheetName(event.target.value)}
              className={`${selectClass} max-w-md`}
              aria-label="Worksheet"
            >
              {worksheets.map((tab) => (
                <option key={tab.sheetId} value={tab.title}>
                  {tab.title}
                  {tab.hidden ? " (hidden)" : ""}
                  {tab.sheetType !== "GRID" ? ` — ${tab.sheetType}` : ""}
                </option>
              ))}
            </select>

            {selectedWorksheet ? (
              <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
                <div>
                  <dt className="text-xs text-muted-foreground">Worksheet name</dt>
                  <dd className="text-sm text-foreground">
                    {selectedWorksheet.title}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Worksheet ID</dt>
                  <dd className="font-mono text-sm text-foreground">
                    {selectedWorksheet.sheetId}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Dimensions</dt>
                  <dd className="text-sm text-foreground">
                    {selectedWorksheet.rowCount !== null &&
                    selectedWorksheet.columnCount !== null
                      ? `${selectedWorksheet.rowCount} × ${selectedWorksheet.columnCount}`
                      : "Not reported"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Frozen rows</dt>
                  <dd className="text-sm text-foreground">
                    {selectedWorksheet.frozenRowCount ?? 0}
                  </dd>
                </div>
              </dl>
            ) : null}

            {selectedWorksheet && selectedWorksheet.sheetType !== "GRID" ? (
              <p className="mt-2 text-sm text-warning">
                This tab is a {selectedWorksheet.sheetType.toLowerCase()} sheet
                and cannot hold order rows. Pick a normal grid worksheet.
              </p>
            ) : null}
          </>
        ) : worksheets ? (
          <p className="text-sm text-muted-foreground">
            This spreadsheet has no worksheets.
          </p>
        ) : null}
      </section>

      {/* --- 3. Header rows ------------------------------------------- */}
      <section className="border-t border-border pt-4">
        <h3 className="mb-2 text-sm font-medium text-foreground">
          3. Header configuration
        </h3>
        <div className="flex flex-wrap gap-4">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">
              Header row number
            </span>
            <input
              type="number"
              min={1}
              max={50}
              value={headerRow}
              onChange={(event) => setHeaderRow(event.target.value)}
              className={`${inputClass} w-32`}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">
              First data row
            </span>
            <input
              type="number"
              min={1}
              max={100}
              value={firstDataRow}
              onChange={(event) => setFirstDataRow(event.target.value)}
              className={`${inputClass} w-32`}
            />
          </label>
        </div>
        {Number(firstDataRow) <= Number(headerRow) ? (
          <p className="mt-2 text-sm text-danger">
            The first data row must come after the header row.
          </p>
        ) : null}
      </section>

      <FeedbackBanner feedback={feedback} />

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <Button
          variant="primary"
          disabled={!canSave || Number(firstDataRow) <= Number(headerRow)}
          onClick={async () => {
            const result = await run(
              "select",
              {
                url: "/api/sheet-config",
                body: {
                  spreadsheetId: selectedId,
                  sheetName,
                  headerRow: Number(headerRow),
                  firstDataRow: Number(firstDataRow),
                },
              },
              { refresh: true },
            );
            if (!result.ok) return;
            const data = (result.data ?? {}) as {
              columns?: number;
              duplicates?: string[];
              blankPositions?: number[];
            };
            const notes: string[] = [];
            if (data.duplicates?.length) {
              notes.push(`duplicate headers: ${data.duplicates.join(", ")}`);
            }
            if (data.blankPositions?.length) {
              notes.push(`${data.blankPositions.length} blank cell(s)`);
            }
            setFeedback({
              tone: notes.length > 0 ? "error" : "success",
              message: `Saved. Read ${data.columns ?? 0} header(s) from row ${headerRow}${
                notes.length > 0 ? ` — ${notes.join("; ")}` : ""
              }.`,
            });
          }}
        >
          {pending === "select"
            ? "Reading headers…"
            : "Save destination and read headers"}
        </Button>
      </div>
    </div>
  );
}
