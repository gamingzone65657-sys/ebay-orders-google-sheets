/**
 * One error type for every eBay failure mode, carrying a category the UI can
 * turn into an actionable message.
 *
 * Categories exist so the app never shows a raw eBay payload to a seller, and
 * so the retry logic can decide what is worth retrying without string
 * matching.
 */

export const EBAY_ERROR_CODES = {
  /** App credentials missing or malformed. */
  NOT_CONFIGURED: "NOT_CONFIGURED",
  /** No connection row, or the seller disconnected. */
  NOT_CONNECTED: "NOT_CONNECTED",
  /** OAuth consent failed or was declined. */
  OAUTH_FAILED: "OAUTH_FAILED",
  /** Refresh token rejected — the seller must reconnect. */
  AUTH_EXPIRED: "AUTH_EXPIRED",
  /** 401/403 on an API call with an otherwise-valid token. */
  PERMISSION_DENIED: "PERMISSION_DENIED",
  /** 429, or eBay's daily call quota. */
  RATE_LIMITED: "RATE_LIMITED",
  /** 5xx from eBay. */
  SERVER_ERROR: "SERVER_ERROR",
  /** 4xx we cannot classify. */
  BAD_REQUEST: "BAD_REQUEST",
  /** 2xx whose body was not the shape we expect. */
  INVALID_RESPONSE: "INVALID_RESPONSE",
  /** DNS/TCP/TLS/timeout. */
  NETWORK_ERROR: "NETWORK_ERROR",
} as const;

export type EbayErrorCode =
  (typeof EBAY_ERROR_CODES)[keyof typeof EBAY_ERROR_CODES];

export interface EbayErrorOptions {
  status?: number;
  ebayErrorId?: number;
  /** Seconds the caller should wait before trying again. */
  retryAfterSeconds?: number;
  /** Safe-to-log detail. Never contains tokens. */
  detail?: string;
  cause?: unknown;
}

export class EbayApiError extends Error {
  readonly code: EbayErrorCode;
  readonly status?: number;
  readonly ebayErrorId?: number;
  readonly retryAfterSeconds?: number;
  readonly detail?: string;

  constructor(
    code: EbayErrorCode,
    message: string,
    options: EbayErrorOptions = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "EbayApiError";
    this.code = code;
    this.status = options.status;
    this.ebayErrorId = options.ebayErrorId;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.detail = options.detail;
  }

  /** Whether a retry of the same request could plausibly succeed. */
  get retryable(): boolean {
    return (
      this.code === EBAY_ERROR_CODES.RATE_LIMITED ||
      this.code === EBAY_ERROR_CODES.SERVER_ERROR ||
      this.code === EBAY_ERROR_CODES.NETWORK_ERROR
    );
  }

  /** Whether the seller has to go through consent again. */
  get requiresReconnect(): boolean {
    return (
      this.code === EBAY_ERROR_CODES.AUTH_EXPIRED ||
      this.code === EBAY_ERROR_CODES.NOT_CONNECTED
    );
  }
}

/** Seller-facing copy. Deliberately actionable, never a raw eBay message. */
export const EBAY_ERROR_MESSAGES: Record<EbayErrorCode, string> = {
  NOT_CONFIGURED:
    "eBay credentials are not configured on the server. Add EBAY_CLIENT_ID, EBAY_CLIENT_SECRET and EBAY_RU_NAME, then restart the app.",
  NOT_CONNECTED: "No eBay account is connected. Connect eBay to continue.",
  OAUTH_FAILED:
    "eBay did not complete the authorization. Nothing was changed — try connecting again.",
  AUTH_EXPIRED:
    "The eBay authorization has expired or was revoked. Reconnect the account to restore access.",
  PERMISSION_DENIED:
    "eBay refused this request. The connected account may lack the required selling permissions, or the granted scopes may be insufficient. Reconnecting will re-request them.",
  RATE_LIMITED:
    "eBay is rate limiting this application. The import backed off automatically; try again shortly.",
  SERVER_ERROR:
    "eBay returned a server error. This is usually temporary — try again in a few minutes.",
  BAD_REQUEST:
    "eBay rejected the request as invalid. If this persists, the date range or filter may be unsupported.",
  INVALID_RESPONSE:
    "eBay returned a response this app could not read. Nothing was imported.",
  NETWORK_ERROR:
    "Could not reach eBay. Check the server's network connection and try again.",
};

export function describeEbayError(error: unknown): {
  code: EbayErrorCode | "UNKNOWN";
  message: string;
  detail?: string;
  retryAfterSeconds?: number;
} {
  if (error instanceof EbayApiError) {
    return {
      code: error.code,
      message: EBAY_ERROR_MESSAGES[error.code],
      detail: error.detail ?? error.message,
      retryAfterSeconds: error.retryAfterSeconds,
    };
  }
  return {
    code: "UNKNOWN",
    message: "An unexpected error occurred while talking to eBay.",
    detail: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Maps an HTTP status + eBay error body onto a category.
 *
 * eBay signals expired/invalid tokens with 401 and errorId 1001/1002, and
 * insufficient scope with 403 and errorId 1100.
 */
export function classifyHttpError(
  status: number,
  body: unknown,
): { code: EbayErrorCode; ebayErrorId?: number; detail?: string } {
  const firstError = extractFirstError(body);
  const ebayErrorId = firstError?.errorId;
  const detail = firstError?.message;

  if (status === 401) {
    return { code: EBAY_ERROR_CODES.AUTH_EXPIRED, ebayErrorId, detail };
  }
  if (status === 403) {
    return { code: EBAY_ERROR_CODES.PERMISSION_DENIED, ebayErrorId, detail };
  }
  if (status === 429) {
    return { code: EBAY_ERROR_CODES.RATE_LIMITED, ebayErrorId, detail };
  }
  if (status >= 500) {
    return { code: EBAY_ERROR_CODES.SERVER_ERROR, ebayErrorId, detail };
  }
  return { code: EBAY_ERROR_CODES.BAD_REQUEST, ebayErrorId, detail };
}

interface EbayErrorEntry {
  errorId?: number;
  message?: string;
  longMessage?: string;
}

function extractFirstError(body: unknown): EbayErrorEntry | null {
  if (!body || typeof body !== "object") return null;
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const first = errors[0] as EbayErrorEntry;
  return {
    errorId: typeof first.errorId === "number" ? first.errorId : undefined,
    message: first.longMessage ?? first.message,
  };
}
