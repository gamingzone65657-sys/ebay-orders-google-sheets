import { apiError, handle, ok } from "@/lib/api";
import { CONNECTION_STATUS } from "@/lib/constants";
import { listSpreadsheets } from "@/lib/google/drive";
import {
  describeGoogleError,
  googleErrorHttpStatus,
  type GoogleErrorCode,
} from "@/lib/google/errors";
import { getActiveGoogleConnection } from "@/lib/google/tokens";
import { logError } from "@/lib/log";
import { getCurrentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

const PUBLIC_CODE: Record<GoogleErrorCode | "UNKNOWN", string> = {
  NOT_CONFIGURED: "GOOGLE_NOT_CONFIGURED",
  NOT_CONNECTED: "GOOGLE_NOT_CONNECTED",
  OAUTH_FAILED: "GOOGLE_AUTH_FAILED",
  AUTH_EXPIRED: "GOOGLE_AUTH_EXPIRED",
  INSUFFICIENT_SCOPE: "GOOGLE_INSUFFICIENT_SCOPE",
  PERMISSION_DENIED: "DRIVE_ACCESS_DENIED",
  NOT_FOUND: "DRIVE_NOT_FOUND",
  RATE_LIMITED: "GOOGLE_RATE_LIMITED",
  SERVER_ERROR: "GOOGLE_SERVER_ERROR",
  BAD_REQUEST: "GOOGLE_BAD_REQUEST",
  INVALID_RESPONSE: "GOOGLE_INVALID_RESPONSE",
  NETWORK_ERROR: "GOOGLE_NETWORK_ERROR",
  UNKNOWN: "GOOGLE_UNKNOWN_ERROR",
};

/**
 * Lists spreadsheets the connected account can see.
 *
 * Always JSON; a failure carries the HTTP status matching its cause rather
 * than a 200 with an error tucked inside the body.
 */
export async function GET(request: Request) {
  return handle(async () => {
    const url = new URL(request.url);
    const search = url.searchParams.get("q")?.trim() ?? "";
    const pageToken = url.searchParams.get("pageToken") ?? undefined;

    const user = await getCurrentUser();
    const connection = await getActiveGoogleConnection(user.id);

    if (!connection || connection.status === CONNECTION_STATUS.DISCONNECTED) {
      return apiError({
        code: "GOOGLE_NOT_CONNECTED",
        message: "Connect Google to list your spreadsheets.",
        status: 409,
      });
    }


    try {
      const result = await listSpreadsheets(connection, {
        search: search || undefined,
        pageToken,
      });
      return ok({
        source: "GOOGLE",
        spreadsheets: result.spreadsheets,
        nextPageToken: result.nextPageToken,
        incompleteSearch: result.incompleteSearch,
      });
    } catch (error) {
      const described = describeGoogleError(error);
      if (described.code === "UNKNOWN") logError("google/spreadsheets", error);
      return apiError({
        code: PUBLIC_CODE[described.code],
        message: described.message,
        status: googleErrorHttpStatus(described.code),
        detail: described.detail,
      });
    }
  });
}
