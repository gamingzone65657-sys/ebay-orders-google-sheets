/**
 * Sheets API reads: worksheet metadata and header rows.
 *
 * **This module is read-only by construction.** Phase 3 must not modify a
 * user's spreadsheet, so nothing here calls `values.update`,
 * `values.append`, `values.clear` or `batchUpdate`. The write path arrives in
 * Phase 4 and will live in a separate module, so "does this file write?" is
 * answerable by looking at the imports.
 */

import type { GoogleConnection } from "@prisma/client";

import { GOOGLE_ENDPOINTS } from "./config";
import { googleRequest } from "./client";
import { GOOGLE_ERROR_CODES, GoogleApiError } from "./errors";

export interface Worksheet {
  /** Numeric sheetId from the API; 0 for the first tab of a new sheet. */
  sheetId: number;
  title: string;
  index: number;
  /** GRID | OBJECT — only GRID tabs can hold cell values. */
  sheetType: string;
  rowCount: number | null;
  columnCount: number | null;
  frozenRowCount: number | null;
  hidden: boolean;
}

export interface SpreadsheetMetadata {
  spreadsheetId: string;
  title: string;
  spreadsheetUrl: string | null;
  locale: string | null;
  timeZone: string | null;
  worksheets: Worksheet[];
}

interface RawSheetProperties {
  sheetId?: number;
  title?: string;
  index?: number;
  sheetType?: string;
  hidden?: boolean;
  gridProperties?: {
    rowCount?: number;
    columnCount?: number;
    frozenRowCount?: number;
  };
}

interface RawSpreadsheet {
  spreadsheetId?: string;
  spreadsheetUrl?: string;
  properties?: { title?: string; locale?: string; timeZone?: string };
  sheets?: { properties?: RawSheetProperties }[];
}

/**
 * A spreadsheet id can be pasted as a bare id or a full URL. Accept both.
 * Ids are 20+ chars of [A-Za-z0-9_-].
 */
export function extractSpreadsheetId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const fromUrl = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (fromUrl) return fromUrl[1];

  if (/^[a-zA-Z0-9-_]{20,}$/.test(trimmed)) return trimmed;

  return null;
}

export async function getSpreadsheetMetadata(
  connection: GoogleConnection,
  spreadsheetId: string,
  signal?: AbortSignal,
): Promise<SpreadsheetMetadata> {
  const response = await googleRequest<RawSpreadsheet>(connection, {
    url: `${GOOGLE_ENDPOINTS.sheets}/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId,
    )}`,
    label: "sheets.spreadsheets.get",
    query: {
      // Metadata only — deliberately no `includeGridData`, so no cell values
      // are transferred here.
      fields:
        "spreadsheetId,spreadsheetUrl,properties(title,locale,timeZone),sheets(properties(sheetId,title,index,sheetType,hidden,gridProperties(rowCount,columnCount,frozenRowCount)))",
    },
    signal,
  });

  const data = response.data ?? {};
  if (!data.spreadsheetId) {
    throw new GoogleApiError(
      GOOGLE_ERROR_CODES.INVALID_RESPONSE,
      "Sheets returned a spreadsheet without an id.",
    );
  }

  const sheets = Array.isArray(data.sheets) ? data.sheets : [];

  return {
    spreadsheetId: data.spreadsheetId,
    title: data.properties?.title?.trim() || "(untitled spreadsheet)",
    spreadsheetUrl: data.spreadsheetUrl ?? null,
    locale: data.properties?.locale ?? null,
    timeZone: data.properties?.timeZone ?? null,
    worksheets: sheets
      .map((sheet) => sheet?.properties)
      .filter((properties): properties is RawSheetProperties =>
        Boolean(properties && typeof properties.sheetId === "number"),
      )
      .map((properties, position) => ({
        sheetId: properties.sheetId as number,
        title: properties.title?.trim() || `Sheet${position + 1}`,
        index: properties.index ?? position,
        sheetType: properties.sheetType ?? "GRID",
        rowCount: properties.gridProperties?.rowCount ?? null,
        columnCount: properties.gridProperties?.columnCount ?? null,
        frozenRowCount: properties.gridProperties?.frozenRowCount ?? null,
        hidden: Boolean(properties.hidden),
      }))
      .sort((a, b) => a.index - b.index),
  };
}

/**
 * A1 notation escapes a single quote by doubling it. Getting this wrong on a
 * tab named e.g. "Dan's orders" produces a confusing 400 from Sheets.
 */
export function quoteSheetTitle(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

export function headerRange(title: string, headerRow: number): string {
  const row = Math.max(1, Math.trunc(headerRow));
  return `${quoteSheetTitle(title)}!${row}:${row}`;
}

export interface HeaderReadResult {
  headers: string[];
  /** Headers exactly as returned, before blanks are trimmed from the end. */
  rawValues: string[];
  range: string;
  /** Positions (0-based) whose cell was empty but sits before a filled one. */
  blankPositions: number[];
  /** True when two columns share a header, which breaks unique mapping. */
  hasDuplicates: boolean;
  duplicates: string[];
}

/**
 * Reads one row and returns it as header strings.
 *
 * Trailing empty cells are dropped — Sheets reports a grid width of 1000 for
 * a new spreadsheet, and treating those as columns would be wrong. Interior
 * blanks are kept and reported, because they are usually a real mistake the
 * user needs to see.
 */
export async function readHeaderRow(
  connection: GoogleConnection,
  spreadsheetId: string,
  worksheetTitle: string,
  headerRow: number,
  signal?: AbortSignal,
): Promise<HeaderReadResult> {
  const range = headerRange(worksheetTitle, headerRow);

  const response = await googleRequest<{
    range?: string;
    values?: unknown[][];
  }>(connection, {
    url: `${GOOGLE_ENDPOINTS.sheets}/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId,
    )}/values/${encodeURIComponent(range)}`,
    label: "sheets.values.get",
    query: {
      majorDimension: "ROWS",
      // Render exactly what the user sees, so a header formatted as a date
      // or number still matches the text in their sheet.
      valueRenderOption: "FORMATTED_VALUE",
    },
    signal,
  });

  const row = Array.isArray(response.data?.values?.[0])
    ? (response.data.values[0] as unknown[])
    : [];

  const rawValues = row.map((cell) =>
    cell === null || cell === undefined ? "" : String(cell).trim(),
  );

  // Drop trailing blanks only.
  let end = rawValues.length;
  while (end > 0 && rawValues[end - 1] === "") end -= 1;
  const headers = rawValues.slice(0, end);

  const blankPositions = headers
    .map((header, index) => (header === "" ? index : -1))
    .filter((index) => index >= 0);

  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const header of headers) {
    if (header === "") continue;
    const key = header.toLowerCase();
    if (seen.has(key)) duplicates.add(header);
    seen.add(key);
  }

  return {
    headers,
    rawValues,
    range: response.data?.range ?? range,
    blankPositions,
    hasDuplicates: duplicates.size > 0,
    duplicates: [...duplicates],
  };
}
