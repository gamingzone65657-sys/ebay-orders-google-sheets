import { z } from "zod";

import { apiError, fail, handle, ok, parseBody } from "@/lib/api";
import {
  CONNECTION_STATUS,
  ROW_MODES,
  SYNC_MODES,
  WRITE_MODES,
} from "@/lib/constants";
import { prisma } from "@/lib/db";
import { columnLetter } from "@/lib/format";
import { describeGoogleError } from "@/lib/google/errors";
import {
  extractSpreadsheetId,
  getSpreadsheetMetadata,
  readHeaderRow,
  type HeaderReadResult,
  type SpreadsheetMetadata,
} from "@/lib/google/sheets";
import { getActiveGoogleConnection } from "@/lib/google/tokens";
import { guessColumnType } from "@/lib/sheets/column-type";
import { getCurrentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

const selectSchema = z.object({
  /** Bare id or a pasted Google Sheets URL. */
  spreadsheetId: z.string().min(1),
  sheetName: z.string().min(1),
  headerRow: z.coerce.number().int().min(1).max(50).optional(),
  firstDataRow: z.coerce.number().int().min(1).max(100).optional(),
});

const optionsSchema = z.object({
  headerRow: z.coerce.number().int().min(1).max(50).optional(),
  firstDataRow: z.coerce.number().int().min(1).max(100).optional(),
  writeMode: z
    .enum([WRITE_MODES.APPEND, WRITE_MODES.UPSERT, WRITE_MODES.OVERWRITE])
    .optional(),
  matchColumn: z.string().max(200).nullable().optional(),
  rowMode: z.enum([ROW_MODES.ORDER, ROW_MODES.LINE_ITEM]).optional(),
  syncMode: z
    .enum([SYNC_MODES.APPEND, SYNC_MODES.UPDATE, SYNC_MODES.APPEND_UPDATE])
    .optional(),
  /** Re-read the header row from the live sheet. */
  refreshHeaders: z.boolean().optional(),
});

/** Replaces the stored SheetColumn rows with what the header row now says. */
async function persistColumns(
  sheetConfigId: string,
  headers: string[],
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.sheetColumn.deleteMany({ where: { sheetConfigId } });
    const rows = headers
      .map((header, index) => ({ header: header.trim(), index }))
      // A blank cell is not a column we can map, so it is not stored.
      .filter((entry) => entry.header !== "");
    if (rows.length > 0) {
      await tx.sheetColumn.createMany({
        data: rows.map((entry) => ({
          sheetConfigId,
          header: entry.header,
          letter: columnLetter(entry.index),
          position: entry.index,
          dataType: guessColumnType(entry.header),
        })),
      });
    }
  });
}

/**
 * Selects the destination spreadsheet + worksheet and reads its header row.
 *
 * Read-only against Google: this reads metadata and one row of values, and
 * writes nothing to the user's spreadsheet.
 */
export async function POST(request: Request) {
  return handle(async () => {
    const { data, error } = await parseBody(request, selectSchema);
    if (error) return error;

    const spreadsheetId = extractSpreadsheetId(data.spreadsheetId);
    if (!spreadsheetId) {
      return fail(
        "That does not look like a spreadsheet ID or a Google Sheets URL.",
        422,
      );
    }

    const headerRow = data.headerRow ?? 1;
    const firstDataRow = data.firstDataRow ?? headerRow + 1;
    if (firstDataRow <= headerRow) {
      return fail("The first data row must come after the header row.", 422);
    }

    const user = await getCurrentUser();
    const connection = await getActiveGoogleConnection(user.id);
    if (!connection || connection.status === CONNECTION_STATUS.DISCONNECTED) {
      return fail("Connect Google before selecting a spreadsheet.", 409);
    }

    let metadata: Pick<SpreadsheetMetadata, "title" | "spreadsheetUrl">;
    let worksheet: { sheetId: number | null; rowCount: number | null; columnCount: number | null; frozenRowCount: number | null };
    let headerResult: Pick<HeaderReadResult, "headers" | "blankPositions" | "duplicates">;

    {
      try {
        const live = await getSpreadsheetMetadata(connection, spreadsheetId);
        const tab = live.worksheets.find(
          (entry) => entry.title === data.sheetName,
        );
        if (!tab) {
          return fail(
            `The spreadsheet "${live.title}" has no worksheet named "${data.sheetName}".`,
            404,
          );
        }
        if (tab.sheetType !== "GRID") {
          return fail(
            `"${tab.title}" is a ${tab.sheetType.toLowerCase()} sheet and cannot hold order rows.`,
            422,
          );
        }

        metadata = { title: live.title, spreadsheetUrl: live.spreadsheetUrl };
        worksheet = {
          sheetId: tab.sheetId,
          rowCount: tab.rowCount,
          columnCount: tab.columnCount,
          frozenRowCount: tab.frozenRowCount,
        };
        headerResult = await readHeaderRow(
          connection,
          spreadsheetId,
          data.sheetName,
          headerRow,
        );
      } catch (caught) {
        const described = describeGoogleError(caught);
        return fail(described.message, 502, {
          code: described.code,
          detail: described.detail,
        });
      }
    }

    const now = new Date();

    const config = await prisma.$transaction(async (tx) => {
      // Only one destination is active at a time.
      await tx.googleSheetConfig.updateMany({
        where: { userId: user.id },
        data: { isActive: false },
      });

      return tx.googleSheetConfig.upsert({
        where: {
          userId_spreadsheetId_sheetName: {
            userId: user.id,
            spreadsheetId,
            sheetName: data.sheetName,
          },
        },
        create: {
          userId: user.id,
          googleConnectionId: connection.id,
          spreadsheetId,
          spreadsheetName: metadata.title,
          spreadsheetUrl: metadata.spreadsheetUrl,
          sheetName: data.sheetName,
          sheetGid:
            worksheet.sheetId === null ? null : String(worksheet.sheetId),
          headerRow,
          firstDataRow,
          gridRowCount: worksheet.rowCount,
          gridColumnCount: worksheet.columnCount,
          frozenRowCount: worksheet.frozenRowCount,
          matchColumn: headerResult.headers[0]?.trim() || null,
          isActive: true,
          lastDetectedAt: now,
        },
        update: {
          googleConnectionId: connection.id,
          spreadsheetName: metadata.title,
          spreadsheetUrl: metadata.spreadsheetUrl,
          sheetGid:
            worksheet.sheetId === null ? null : String(worksheet.sheetId),
          headerRow,
          firstDataRow,
          gridRowCount: worksheet.rowCount,
          gridColumnCount: worksheet.columnCount,
          frozenRowCount: worksheet.frozenRowCount,
          isActive: true,
          lastDetectedAt: now,
        },
      });
    });

    await persistColumns(config.id, headerResult.headers);

    return ok({
      sheetConfigId: config.id,
      spreadsheetName: metadata.title,
      sheetName: data.sheetName,
      columns: headerResult.headers.filter((header) => header.trim() !== "")
        .length,
      headers: headerResult.headers,
      blankPositions: headerResult.blankPositions,
      duplicates: headerResult.duplicates,
    });
  });
}

/**
 * Updates header row / write mode / key column, re-reading the header row
 * when the row number changed or a refresh was requested.
 */
export async function PATCH(request: Request) {
  return handle(async () => {
    const { data, error } = await parseBody(request, optionsSchema);
    if (error) return error;

    const user = await getCurrentUser();
    const config = await prisma.googleSheetConfig.findFirst({
      where: { userId: user.id, isActive: true },
    });
    if (!config) return fail("No spreadsheet selected yet.", 404);

    const headerRow = data.headerRow ?? config.headerRow;
    const firstDataRow = data.firstDataRow ?? config.firstDataRow;
    if (firstDataRow <= headerRow) {
      return fail("The first data row must come after the header row.", 422);
    }

    const shouldReread =
      data.refreshHeaders === true || headerRow !== config.headerRow;

    let headers: string[] | null = null;
    let blankPositions: number[] = [];
    let duplicates: string[] = [];

    if (shouldReread) {
      const connection = await getActiveGoogleConnection(user.id);
      if (!connection || connection.status === CONNECTION_STATUS.DISCONNECTED) {
        return fail("Connect Google before re-reading the header row.", 409);
      }

      try {
        const result = await readHeaderRow(
          connection,
          config.spreadsheetId,
          config.sheetName,
          headerRow,
        );
        headers = result.headers;
        blankPositions = result.blankPositions;
        duplicates = result.duplicates;
      } catch (caught) {
        const described = describeGoogleError(caught);
        return fail(described.message, 502, {
          code: described.code,
          detail: described.detail,
        });
      }
    }

    const updated = await prisma.googleSheetConfig.update({
      where: { id: config.id },
      data: {
        headerRow,
        firstDataRow,
        writeMode: data.writeMode ?? config.writeMode,
        matchColumn:
          data.matchColumn === undefined ? config.matchColumn : data.matchColumn,
        rowMode: data.rowMode ?? config.rowMode,
        syncMode: data.syncMode ?? config.syncMode,
        ...(headers ? { lastDetectedAt: new Date() } : {}),
      },
    });

    if (headers) await persistColumns(updated.id, headers);

    return ok({
      sheetConfigId: updated.id,
      headersReread: headers !== null,
      columns: headers?.filter((header) => header.trim() !== "").length ?? null,
      headers,
      blankPositions,
      duplicates,
    });
  });
}
