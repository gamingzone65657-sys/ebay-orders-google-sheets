import { apiError, handle, ok } from "@/lib/api";
import { CONNECTION_STATUS } from "@/lib/constants";
import {
  describeGoogleError,
  googleErrorHttpStatus,
  type GoogleErrorCode,
} from "@/lib/google/errors";
import {
  extractSpreadsheetId,
  getSpreadsheetMetadata,
} from "@/lib/google/sheets";
import { getActiveGoogleConnection } from "@/lib/google/tokens";

import { logError } from "@/lib/log";
import { getCurrentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Google's categories, renamed to codes that say what failed *here*. The
 * caller sees SPREADSHEET_NOT_FOUND rather than a bare NOT_FOUND it would
 * have to interpret against the endpoint it happened to call.
 */
const PUBLIC_CODE: Record<GoogleErrorCode | "UNKNOWN", string> = {
  NOT_CONFIGURED: "GOOGLE_NOT_CONFIGURED",
  NOT_CONNECTED: "GOOGLE_NOT_CONNECTED",
  OAUTH_FAILED: "GOOGLE_AUTH_FAILED",
  AUTH_EXPIRED: "GOOGLE_AUTH_EXPIRED",
  INSUFFICIENT_SCOPE: "GOOGLE_INSUFFICIENT_SCOPE",
  PERMISSION_DENIED: "SPREADSHEET_ACCESS_DENIED",
  NOT_FOUND: "SPREADSHEET_NOT_FOUND",
  RATE_LIMITED: "GOOGLE_RATE_LIMITED",
  SERVER_ERROR: "GOOGLE_SERVER_ERROR",
  BAD_REQUEST: "GOOGLE_BAD_REQUEST",
  INVALID_RESPONSE: "GOOGLE_INVALID_RESPONSE",
  NETWORK_ERROR: "GOOGLE_NETWORK_ERROR",
  UNKNOWN: "GOOGLE_UNKNOWN_ERROR",
};

/**
 * Worksheets (tabs) of one spreadsheet, with their ids and grid dimensions.
 *
 * Accepts either a bare spreadsheet id or a pasted Google Sheets URL, which
 * is what the "enter an ID manually" field sends.
 *
 * Every outcome is JSON. Failures carry the matching HTTP status — 404 for a
 * spreadsheet that is not there, 403 for one this account cannot open, 401
 * for an expired authorization, 409 when no account is connected at all —
 * so a caller can branch on `response.status` alone.
 */
export async function GET(_request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;

    let decoded: string;
    try {
      decoded = decodeURIComponent(id);
    } catch {
      // A stray "%" in the path makes decodeURIComponent throw.
      decoded = id;
    }

    const spreadsheetId = extractSpreadsheetId(decoded);
    if (!spreadsheetId) {
      return apiError({
        code: "INVALID_SPREADSHEET_ID",
        message:
          "That does not look like a spreadsheet ID or a Google Sheets URL.",
        status: 400,
        detail: `Received: ${decoded.slice(0, 120)}`,
      });
    }

    const user = await getCurrentUser();
    const connection = await getActiveGoogleConnection(user.id);

    if (!connection || connection.status === CONNECTION_STATUS.DISCONNECTED) {
      return apiError({
        code: "GOOGLE_NOT_CONNECTED",
        message: "Connect Google to read this spreadsheet.",
        status: 409,
      });
    }


    try {
      const metadata = await getSpreadsheetMetadata(connection, spreadsheetId);
      return ok({ source: "GOOGLE", spreadsheet: metadata });
    } catch (error) {
      // Covers token retrieval, refresh, the Sheets call, and a malformed
      // response: getValidAccessToken and googleRequest both raise
      // GoogleApiError, and anything else falls through as UNKNOWN/500.
      const described = describeGoogleError(error);
      if (described.code === "UNKNOWN") logError("google/spreadsheets/:id", error);
      return apiError({
        code: PUBLIC_CODE[described.code],
        message: described.message,
        status: googleErrorHttpStatus(described.code),
        detail: described.detail,
      });
    }
  });
}
