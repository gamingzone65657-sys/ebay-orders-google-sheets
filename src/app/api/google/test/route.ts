import { z } from "zod";

import { handle, ok, parseBody } from "@/lib/api";
import { CONNECTION_STATUS } from "@/lib/constants";
import { prisma } from "@/lib/db";
import {
  grantsDriveList,
  grantsSheetsRead,
  grantsSheetsWrite,
} from "@/lib/google/config";
import { fetchIdentity, pingDrive } from "@/lib/google/drive";
import { describeGoogleError } from "@/lib/google/errors";
import {
  getSpreadsheetMetadata,
  readHeaderRow,
} from "@/lib/google/sheets";
import { getActiveGoogleConnection } from "@/lib/google/tokens";
import { getCurrentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

const schema = z.object({
  target: z.enum(["connection", "spreadsheet", "worksheet"]),
});

interface TestResult {
  target: string;
  ok: boolean;
  message: string;
  detail?: string;
  code?: string;
  facts?: Record<string, string | number | boolean | null>;
}

/**
 * The three "Test …" buttons.
 *
 * Each returns a definite pass/fail with the specific reason, rather than a
 * generic error: "connected but the sheet is not shared with this account"
 * and "connected but the tab was renamed" need different fixes.
 *
 * All three are read-only.
 */
export async function POST(request: Request) {
  return handle(async () => {
    const { data, error } = await parseBody(request, schema);
    if (error) return error;

    const user = await getCurrentUser();
    const connection = await getActiveGoogleConnection(user.id);

    const fail = (message: string, code?: string, detail?: string): TestResult => ({
      target: data.target,
      ok: false,
      message,
      code,
      detail,
    });

    if (!connection || connection.status === CONNECTION_STATUS.DISCONNECTED) {
      return ok(fail("No Google account is connected.", "NOT_CONNECTED"));
    }

    const config = await prisma.googleSheetConfig.findFirst({
      where: { userId: user.id, isActive: true },
      include: { columns: { orderBy: { position: "asc" } } },
    });

    /* --- Connection ------------------------------------------------------ */
    if (data.target === "connection") {

      try {
        const ping = await pingDrive(connection);
        const identity = await fetchIdentity(connection).catch(() => null);

        if (identity?.email && identity.email !== connection.email) {
          await prisma.googleConnection.update({
            where: { id: connection.id },
            data: {
              email: identity.email,
              displayName: identity.name ?? connection.displayName,
            },
          });
        }

        return ok({
          target: "connection",
          ok: true,
          message: `Google responded successfully as ${
            identity?.email ?? ping.user ?? "the connected account"
          }.`,
          facts: {
            account: identity?.email ?? ping.user,
            "can list spreadsheets": grantsDriveList(connection.scopes),
            "can read sheet values": grantsSheetsRead(connection.scopes),
            "can write sheet values": grantsSheetsWrite(connection.scopes),
          },
        } satisfies TestResult);
      } catch (caught) {
        const described = describeGoogleError(caught);
        return ok(fail(described.message, described.code, described.detail));
      }
    }

    /* --- Spreadsheet ----------------------------------------------------- */
    if (!config) {
      return ok(
        fail(
          "No spreadsheet has been selected yet.",
          "NOT_CONFIGURED",
        ),
      );
    }

    if (data.target === "spreadsheet") {

      try {
        const metadata = await getSpreadsheetMetadata(
          connection,
          config.spreadsheetId,
        );
        return ok({
          target: "spreadsheet",
          ok: true,
          message: `Opened "${metadata.title}" — ${metadata.worksheets.length} worksheet(s) visible.`,
          facts: {
            title: metadata.title,
            worksheets: metadata.worksheets.length,
            timeZone: metadata.timeZone,
            locale: metadata.locale,
          },
        } satisfies TestResult);
      } catch (caught) {
        const described = describeGoogleError(caught);
        return ok(fail(described.message, described.code, described.detail));
      }
    }

    /* --- Worksheet ------------------------------------------------------- */

    try {
      const metadata = await getSpreadsheetMetadata(
        connection,
        config.spreadsheetId,
      );
      const tab = metadata.worksheets.find(
        (entry) => entry.title === config.sheetName,
      );

      if (!tab) {
        const result = await prisma.googleSheetConfig.update({
          where: { id: config.id },
          data: {
            lastTestAt: new Date(),
            lastTestOk: false,
            lastTestMessage: `Worksheet "${config.sheetName}" no longer exists.`,
          },
        });
        void result;
        return ok(
          fail(
            `The worksheet "${config.sheetName}" no longer exists in this spreadsheet. Available: ${metadata.worksheets
              .map((entry) => entry.title)
              .join(", ")}.`,
            "NOT_FOUND",
          ),
        );
      }

      const header = await readHeaderRow(
        connection,
        config.spreadsheetId,
        config.sheetName,
        config.headerRow,
      );

      const populated = header.headers.filter((value) => value.trim() !== "");
      const problems: string[] = [];
      if (populated.length === 0) {
        problems.push(`row ${config.headerRow} is empty`);
      }
      if (header.duplicates.length > 0) {
        problems.push(`duplicate headers: ${header.duplicates.join(", ")}`);
      }
      if (header.blankPositions.length > 0) {
        problems.push(`${header.blankPositions.length} blank cell(s)`);
      }

      const passed = populated.length > 0 && header.duplicates.length === 0;
      const message = passed
        ? `Read ${populated.length} header(s) from row ${config.headerRow} of "${config.sheetName}"${
            problems.length > 0 ? ` (${problems.join("; ")})` : ""
          }.`
        : `Could not use row ${config.headerRow} of "${config.sheetName}": ${problems.join("; ")}.`;

      await prisma.googleSheetConfig.update({
        where: { id: config.id },
        data: {
          lastTestAt: new Date(),
          lastTestOk: passed,
          lastTestMessage: message.slice(0, 500),
          gridRowCount: tab.rowCount,
          gridColumnCount: tab.columnCount,
          frozenRowCount: tab.frozenRowCount,
        },
      });

      return ok({
        target: "worksheet",
        ok: passed,
        message,
        facts: {
          worksheet: tab.title,
          sheetId: tab.sheetId,
          rows: tab.rowCount,
          columns: tab.columnCount,
          "headers read": populated.length,
          "header row": config.headerRow,
        },
      } satisfies TestResult);
    } catch (caught) {
      const described = describeGoogleError(caught);
      await prisma.googleSheetConfig
        .update({
          where: { id: config.id },
          data: {
            lastTestAt: new Date(),
            lastTestOk: false,
            lastTestMessage: described.message.slice(0, 500),
          },
        })
        .catch(() => undefined);
      return ok(fail(described.message, described.code, described.detail));
    }
  });
}
