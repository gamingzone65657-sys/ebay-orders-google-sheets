/**
 * One error type for every Google failure mode, carrying a category the UI
 * can turn into an actionable message. Mirrors src/lib/ebay/errors.ts.
 */

export const GOOGLE_ERROR_CODES = {
  NOT_CONFIGURED: "NOT_CONFIGURED",
  NOT_CONNECTED: "NOT_CONNECTED",
  OAUTH_FAILED: "OAUTH_FAILED",
  /** Refresh token rejected or revoked — the user must reconnect. */
  AUTH_EXPIRED: "AUTH_EXPIRED",
  /** Authenticated, but the granted scopes do not cover this call. */
  INSUFFICIENT_SCOPE: "INSUFFICIENT_SCOPE",
  /** Authenticated, but this account cannot see/open the file. */
  PERMISSION_DENIED: "PERMISSION_DENIED",
  /** Spreadsheet or worksheet does not exist. */
  NOT_FOUND: "NOT_FOUND",
  RATE_LIMITED: "RATE_LIMITED",
  SERVER_ERROR: "SERVER_ERROR",
  BAD_REQUEST: "BAD_REQUEST",
  INVALID_RESPONSE: "INVALID_RESPONSE",
  NETWORK_ERROR: "NETWORK_ERROR",
} as const;

export type GoogleErrorCode =
  (typeof GOOGLE_ERROR_CODES)[keyof typeof GOOGLE_ERROR_CODES];

export interface GoogleErrorOptions {
  status?: number;
  /** Google's machine-readable reason, e.g. "rateLimitExceeded". */
  reason?: string;
  retryAfterSeconds?: number;
  detail?: string;
  cause?: unknown;
}

export class GoogleApiError extends Error {
  readonly code: GoogleErrorCode;
  readonly status?: number;
  readonly reason?: string;
  readonly retryAfterSeconds?: number;
  readonly detail?: string;

  constructor(
    code: GoogleErrorCode,
    message: string,
    options: GoogleErrorOptions = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "GoogleApiError";
    this.code = code;
    this.status = options.status;
    this.reason = options.reason;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.detail = options.detail;
  }

  get retryable(): boolean {
    return (
      this.code === GOOGLE_ERROR_CODES.RATE_LIMITED ||
      this.code === GOOGLE_ERROR_CODES.SERVER_ERROR ||
      this.code === GOOGLE_ERROR_CODES.NETWORK_ERROR
    );
  }

  get requiresReconnect(): boolean {
    return (
      this.code === GOOGLE_ERROR_CODES.AUTH_EXPIRED ||
      this.code === GOOGLE_ERROR_CODES.NOT_CONNECTED ||
      this.code === GOOGLE_ERROR_CODES.INSUFFICIENT_SCOPE
    );
  }
}

export const GOOGLE_ERROR_MESSAGES: Record<GoogleErrorCode, string> = {
  NOT_CONFIGURED:
    "Google credentials are not configured on the server. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then restart the app.",
  NOT_CONNECTED: "No Google account is connected. Connect Google to continue.",
  OAUTH_FAILED:
    "Google did not complete the authorization. Nothing was changed — try connecting again.",
  AUTH_EXPIRED:
    "The Google authorization has expired or was revoked. Reconnect the account to restore access.",
  INSUFFICIENT_SCOPE:
    "The Google account is connected but did not grant the permissions this needs. Reconnect and leave all the requested checkboxes ticked.",
  PERMISSION_DENIED:
    "This Google account does not have access to that file. Check that it is shared with the connected account.",
  NOT_FOUND:
    "That spreadsheet or worksheet could not be found. It may have been deleted, renamed, or the ID may be wrong.",
  RATE_LIMITED:
    "Google is rate limiting this application. The request backed off automatically; try again shortly.",
  SERVER_ERROR:
    "Google returned a server error. This is usually temporary — try again in a few minutes.",
  BAD_REQUEST:
    "Google rejected the request as invalid. If this persists, check the header row and worksheet name.",
  INVALID_RESPONSE:
    "Google returned a response this app could not read. Nothing was changed.",
  NETWORK_ERROR:
    "Could not reach Google. Check the server's network connection and try again.",
};

export function describeGoogleError(error: unknown): {
  code: GoogleErrorCode | "UNKNOWN";
  message: string;
  detail?: string;
  retryAfterSeconds?: number;
} {
  if (error instanceof GoogleApiError) {
    return {
      code: error.code,
      message: GOOGLE_ERROR_MESSAGES[error.code],
      detail: error.detail ?? error.message,
      retryAfterSeconds: error.retryAfterSeconds,
    };
  }
  return {
    code: "UNKNOWN",
    message: "An unexpected error occurred while talking to Google.",
    detail: error instanceof Error ? error.message : String(error),
  };
}

/**
 * The HTTP status an /api route returns for each category.
 *
 * Upstream failures map to 502/504 rather than 500, because 500 would claim
 * the fault is in this application when it is in Google or the network.
 */
export const GOOGLE_ERROR_HTTP_STATUS: Record<
  GoogleErrorCode | "UNKNOWN",
  number
> = {
  NOT_CONFIGURED: 503,
  NOT_CONNECTED: 409,
  OAUTH_FAILED: 401,
  AUTH_EXPIRED: 401,
  INSUFFICIENT_SCOPE: 403,
  PERMISSION_DENIED: 403,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  SERVER_ERROR: 502,
  BAD_REQUEST: 400,
  INVALID_RESPONSE: 502,
  NETWORK_ERROR: 504,
  UNKNOWN: 500,
};

export function googleErrorHttpStatus(code: GoogleErrorCode | "UNKNOWN"): number {
  return GOOGLE_ERROR_HTTP_STATUS[code] ?? 500;
}

interface GoogleErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: { reason?: string; message?: string }[];
  };
}

/**
 * Maps an HTTP status + Google error body onto a category.
 *
 * Google overloads 403 heavily: it covers quota exhaustion, missing scopes,
 * and plain permission failures, distinguished only by the `reason` field —
 * so that is read before falling back to the status code.
 */
export function classifyGoogleError(
  status: number,
  body: unknown,
): { code: GoogleErrorCode; reason?: string; detail?: string } {
  const parsed = (body ?? {}) as GoogleErrorBody;
  const reason = parsed.error?.errors?.[0]?.reason;
  const detail = parsed.error?.message;

  if (status === 401) {
    return { code: GOOGLE_ERROR_CODES.AUTH_EXPIRED, reason, detail };
  }

  if (status === 403) {
    const quotaReasons = new Set([
      "rateLimitExceeded",
      "userRateLimitExceeded",
      "quotaExceeded",
      "dailyLimitExceeded",
    ]);
    if (reason && quotaReasons.has(reason)) {
      return { code: GOOGLE_ERROR_CODES.RATE_LIMITED, reason, detail };
    }
    if (
      reason === "insufficientPermissions" ||
      reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT" ||
      parsed.error?.status === "PERMISSION_DENIED" &&
        /scope/i.test(detail ?? "")
    ) {
      return { code: GOOGLE_ERROR_CODES.INSUFFICIENT_SCOPE, reason, detail };
    }
    return { code: GOOGLE_ERROR_CODES.PERMISSION_DENIED, reason, detail };
  }

  if (status === 404) {
    return { code: GOOGLE_ERROR_CODES.NOT_FOUND, reason, detail };
  }
  if (status === 429) {
    return { code: GOOGLE_ERROR_CODES.RATE_LIMITED, reason, detail };
  }
  if (status >= 500) {
    return { code: GOOGLE_ERROR_CODES.SERVER_ERROR, reason, detail };
  }
  return { code: GOOGLE_ERROR_CODES.BAD_REQUEST, reason, detail };
}
