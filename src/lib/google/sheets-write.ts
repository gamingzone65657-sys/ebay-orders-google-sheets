/**
 * The **only** module in this codebase that modifies a Google Sheet.
 *
 * Its contract, which the sync engine depends on:
 *
 *   1. It writes cells by explicit A1 range, never whole rows. A range is
 *      only ever built from a contiguous run of *mapped* columns, so an
 *      unmapped column can never appear inside a written range — not even as
 *      a blank. This is what makes "never overwrite unrelated columns" true
 *      rather than merely intended.
 *   2. It never clears, deletes, sorts or resizes anything. There is no call
 *      to `values.clear`, `batchUpdate` (the structural one), or any delete
 *      endpoint here or anywhere else.
 *   3. It never invents columns. Writing a header that does not exist is
 *      refused upstream by the write plan.
 */

import type { GoogleConnection } from "@prisma/client";

import { columnLetter } from "@/lib/format";

import { googleRequest } from "./client";
import { GOOGLE_ENDPOINTS } from "./config";
import { GOOGLE_ERROR_CODES, GoogleApiError } from "./errors";
import { quoteSheetTitle } from "./sheets";

/** One cell to write: 0-based column index plus its value. */
export interface CellWrite {
  columnIndex: number;
  value: string;
}

export interface RowWrite {
  rowNumber: number;
  cells: CellWrite[];
}

interface ValueRange {
  range: string;
  majorDimension: "ROWS";
  values: string[][];
}

/**
 * Groups a row's cells into the fewest contiguous ranges.
 *
 * Mapped columns A, B, D, E become two ranges (A:B and D:E) rather than one
 * A:E — otherwise column C, which the user never mapped, would be inside a
 * written range and get blanked.
 */
export function buildRowRanges(
  sheetTitle: string,
  row: RowWrite,
): ValueRange[] {
  const cells = row.cells
    .slice()
    .sort((a, b) => a.columnIndex - b.columnIndex);
  if (cells.length === 0) return [];

  const ranges: ValueRange[] = [];
  let runStart = 0;

  const flush = (startIndex: number, endIndex: number) => {
    const run = cells.slice(startIndex, endIndex + 1);
    const first = run[0].columnIndex;
    const last = run[run.length - 1].columnIndex;
    ranges.push({
      range: `${quoteSheetTitle(sheetTitle)}!${columnLetter(first)}${row.rowNumber}:${columnLetter(last)}${row.rowNumber}`,
      majorDimension: "ROWS",
      values: [run.map((cell) => cell.value)],
    });
  };

  for (let index = 1; index <= cells.length; index += 1) {
    const previous = cells[index - 1];
    const current = cells[index];
    const contiguous =
      current !== undefined && current.columnIndex === previous.columnIndex + 1;
    if (!contiguous) {
      flush(runStart, index - 1);
      runStart = index;
    }
  }

  return ranges;
}

export interface WriteRowsResult {
  updatedCells: number;
  updatedRanges: number;
  apiCalls: number;
}

/**
 * Writes the given rows via `values:batchUpdate`.
 *
 * Used for both new and existing rows: an append is just a write to a row
 * number past the current data, which keeps one code path and one set of
 * safety guarantees.
 */
export async function writeRows(
  connection: GoogleConnection,
  spreadsheetId: string,
  sheetTitle: string,
  rows: RowWrite[],
  options: { chunkSize?: number; signal?: AbortSignal } = {},
): Promise<WriteRowsResult> {
  const ranges = rows.flatMap((row) => buildRowRanges(sheetTitle, row));
  if (ranges.length === 0) {
    return { updatedCells: 0, updatedRanges: 0, apiCalls: 0 };
  }

  // Sheets accepts large batches, but keeping them bounded means a transient
  // failure loses one chunk rather than the whole run.
  const chunkSize = Math.max(1, options.chunkSize ?? 200);
  let updatedCells = 0;
  let updatedRanges = 0;
  let apiCalls = 0;

  for (let offset = 0; offset < ranges.length; offset += chunkSize) {
    const chunk = ranges.slice(offset, offset + chunkSize);

    const response = await googleRequest<{
      totalUpdatedCells?: number;
      totalUpdatedRanges?: number;
    }>(connection, {
      url: `${GOOGLE_ENDPOINTS.sheets}/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId,
      )}/values:batchUpdate`,
      label: "sheets.values.batchUpdate",
      method: "POST",
      body: {
        // RAW would write "=SUM(..)" as text and force everything to string.
        // USER_ENTERED makes Sheets parse dates and numbers the same way it
        // would if the value had been typed in.
        valueInputOption: "USER_ENTERED",
        data: chunk,
      },
      signal: options.signal,
    });

    apiCalls += response.attempts;
    updatedCells += response.data?.totalUpdatedCells ?? 0;
    updatedRanges += response.data?.totalUpdatedRanges ?? chunk.length;
  }

  return { updatedCells, updatedRanges, apiCalls };
}

export interface KeyColumnIndex {
  /** Trimmed key value -> 1-based row number. First occurrence wins. */
  byKey: Map<string, number>;
  /** Highest row number that had any value in the key column. */
  lastPopulatedRow: number;
  /** Keys seen more than once in the sheet. */
  duplicateKeys: string[];
  apiCalls: number;
}

export interface UsedRangeProbe {
  /** Highest row holding a value in ANY column up to `throughColumnIndex`. */
  lastPopulatedRow: number;
  /** The rows themselves, so the caller can tell what kind of data is there. */
  rows: string[][];
  /** 1-based row number of the first returned row. */
  firstRow: number;
  apiCalls: number;
}

/**
 * Finds the last row that holds data in any column this sync might write.
 *
 * The key column alone cannot answer this. A sheet whose older rows predate
 * the current key column — or that someone added rows to by hand — has
 * populated rows with an empty key cell, and a "last row" derived from the
 * key column would point at row 1. Appending from there overwrites real data,
 * which is the one outcome this application must never produce.
 *
 * Sheets omits trailing empty rows from a values response, so the length of
 * the returned array *is* the used height of the range.
 */
export async function readUsedRange(
  connection: GoogleConnection,
  spreadsheetId: string,
  sheetTitle: string,
  firstDataRow: number,
  throughColumnIndex: number,
  signal?: AbortSignal,
): Promise<UsedRangeProbe> {
  const lastLetter = columnLetter(Math.max(0, throughColumnIndex));
  const range = `${quoteSheetTitle(sheetTitle)}!A${firstDataRow}:${lastLetter}`;

  const response = await googleRequest<{ values?: unknown[][] }>(connection, {
    url: `${GOOGLE_ENDPOINTS.sheets}/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId,
    )}/values/${encodeURIComponent(range)}`,
    label: "sheets.values.get(usedRange)",
    query: {
      majorDimension: "ROWS",
      // Only the shape matters here, not the values; UNFORMATTED is cheaper
      // for Sheets to produce and the result is discarded either way.
      valueRenderOption: "UNFORMATTED_VALUE",
    },
    signal,
  });

  const raw = Array.isArray(response.data?.values) ? response.data.values : [];

  // Trailing rows can still come back as empty arrays; walk back over those.
  let height = raw.length;
  while (
    height > 0 &&
    (!Array.isArray(raw[height - 1]) ||
      (raw[height - 1] as unknown[]).every(
        (cell) => cell === null || cell === undefined || String(cell).trim() === "",
      ))
  ) {
    height -= 1;
  }

  const rows = raw
    .slice(0, height)
    .map((row) =>
      (Array.isArray(row) ? row : []).map((cell) =>
        cell === null || cell === undefined ? "" : String(cell).trim(),
      ),
    );

  return {
    lastPopulatedRow: firstDataRow - 1 + height,
    rows,
    firstRow: firstDataRow,
    apiCalls: response.attempts,
  };
}

/**
 * Reads just the key column and indexes it.
 *
 * Reading the sheet itself — rather than trusting the local SheetRowLink
 * table — is what makes the duplicate guard correct against a sheet that was
 * edited by hand, restored from a backup, or is being synced by a fresh
 * database.
 */
export async function readKeyColumn(
  connection: GoogleConnection,
  spreadsheetId: string,
  sheetTitle: string,
  keyColumnIndex: number,
  firstDataRow: number,
  signal?: AbortSignal,
): Promise<KeyColumnIndex> {
  const letter = columnLetter(keyColumnIndex);
  const range = `${quoteSheetTitle(sheetTitle)}!${letter}${firstDataRow}:${letter}`;

  const response = await googleRequest<{ values?: unknown[][] }>(connection, {
    url: `${GOOGLE_ENDPOINTS.sheets}/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId,
    )}/values/${encodeURIComponent(range)}`,
    label: "sheets.values.get(keyColumn)",
    query: {
      majorDimension: "COLUMNS",
      // Compare against what the user sees, matching how values were written.
      valueRenderOption: "FORMATTED_VALUE",
    },
    signal,
  });

  const column = Array.isArray(response.data?.values?.[0])
    ? (response.data.values[0] as unknown[])
    : [];

  const byKey = new Map<string, number>();
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  let lastPopulatedRow = firstDataRow - 1;

  column.forEach((cell, offset) => {
    const value = cell === null || cell === undefined ? "" : String(cell).trim();
    if (value === "") return;
    const rowNumber = firstDataRow + offset;
    lastPopulatedRow = Math.max(lastPopulatedRow, rowNumber);

    if (seen.has(value)) {
      duplicates.add(value);
      return; // keep the first row for a repeated key
    }
    seen.add(value);
    byKey.set(value, rowNumber);
  });

  return {
    byKey,
    lastPopulatedRow,
    duplicateKeys: [...duplicates],
    apiCalls: response.attempts,
  };
}

/**
 * Grows the grid when appending past the sheet's current row count.
 *
 * This is the one structural change the app can make, and it only ever *adds*
 * empty rows at the bottom — it cannot remove or reorder anything.
 */
export async function ensureRowCapacity(
  connection: GoogleConnection,
  spreadsheetId: string,
  sheetId: number,
  requiredRows: number,
  currentRowCount: number | null,
  signal?: AbortSignal,
): Promise<{ grown: boolean; apiCalls: number }> {
  if (currentRowCount === null || requiredRows <= currentRowCount) {
    return { grown: false, apiCalls: 0 };
  }

  const response = await googleRequest<unknown>(connection, {
    url: `${GOOGLE_ENDPOINTS.sheets}/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId,
    )}:batchUpdate`,
    label: "sheets.batchUpdate(appendDimension)",
    method: "POST",
    body: {
      requests: [
        {
          appendDimension: {
            sheetId,
            dimension: "ROWS",
            length: Math.max(requiredRows - currentRowCount, 100),
          },
        },
      ],
    },
    signal,
  });

  return { grown: true, apiCalls: response.attempts };
}

/** Guard used by the engine before it is allowed to write anything. */
export function assertWritable(scopes: string | null | undefined): void {
  const granted = (scopes ?? "").split(/\s+/);
  if (!granted.includes("https://www.googleapis.com/auth/spreadsheets")) {
    throw new GoogleApiError(
      GOOGLE_ERROR_CODES.INSUFFICIENT_SCOPE,
      "The Google connection is read-only. Reconnect with write permission to sync into the sheet.",
    );
  }
}
