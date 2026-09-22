/**
 * The single outbound path to the eBay REST APIs.
 *
 * Responsibilities, in order:
 *   1. refuse to run while a 429 cooldown is active
 *   2. pace requests per connection (rate-limit.ts)
 *   3. attach a freshly-validated bearer token (tokens.ts)
 *   4. classify failures into EbayApiError categories (errors.ts)
 *   5. retry 429/5xx/network with backoff, honouring Retry-After
 *   6. record every attempt in EbayApiCall and update the connection's
 *      last-request/last-success columns
 *
 * Nothing else in the codebase calls `fetch` against eBay.
 */

import type { EbayConnection } from "@prisma/client";

import { logError } from "@/lib/log";
import { redactSecretsInText } from "@/lib/mask";
import { prisma } from "@/lib/db";

import { getEbayCredentials, getEndpoints, resolveEnvironment } from "./config";
import {
  EBAY_ERROR_CODES,
  EbayApiError,
  classifyHttpError,
} from "./errors";
import {
  acquireSlot,
  backoffDelayMs,
  clearCooldown,
  cooldownRemaining,
  startCooldown,
} from "./rate-limit";
import { getValidAccessToken } from "./tokens";

/** Keep the API call log bounded. */
const API_LOG_RETENTION = 500;

// Read per request rather than at module load, so the values are picked up
// without a restart and can be varied in tests.
function maxAttempts(): number {
  const value = Number(process.env.EBAY_MAX_ATTEMPTS ?? 4);
  return Number.isFinite(value) && value >= 1 ? Math.trunc(value) : 4;
}

function requestTimeoutMs(): number {
  const value = Number(process.env.EBAY_REQUEST_TIMEOUT_MS ?? 30_000);
  return Number.isFinite(value) && value > 0 ? value : 30_000;
}

export interface EbayRequestOptions {
  /** Path beginning with a slash, e.g. "/sell/fulfillment/v1/order". */
  path: string;
  method?: "GET" | "POST";
  query?: Record<string, string | number | undefined>;
  /**
   * Marketplace for the X-EBAY-C-MARKETPLACE-ID header. Defaults to the
   * connection's marketplace, so a caller cannot accidentally omit it and
   * get another marketplace's localization back.
   */
  marketplaceId?: string | null;
  /** Counts attempts into the caller's job totals. */
  onAttempt?: (info: { attempt: number; status?: number }) => void;
  signal?: AbortSignal;
}

export interface EbayResponse<T> {
  data: T;
  status: number;
  /** Total HTTP attempts, including retries. */
  attempts: number;
}

/**
 * Injectable transport, so tests can exercise pagination, retries and error
 * classification without network access. Production always uses global fetch.
 */
export type FetchLike = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

let transport: FetchLike = (input, init) => fetch(input, init);

export function setEbayTransport(next: FetchLike | null): void {
  transport = next ?? ((input, init) => fetch(input, init));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildUrl(
  base: string,
  path: string,
  query?: EbayRequestOptions["query"],
): string {
  const url = new URL(path, base);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function parseRetryAfter(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  }
  return undefined;
}

async function recordCall(
  connectionId: string,
  entry: {
    method: string;
    path: string;
    status?: number;
    ok: boolean;
    durationMs: number;
    attempt: number;
    errorCode?: string;
    errorMessage?: string;
    ebayErrorId?: number;
  },
): Promise<void> {
  // Observability must never break the request it is observing.
  try {
    await prisma.ebayApiCall.create({
      data: {
        connectionId,
        method: entry.method,
        path: entry.path,
        status: entry.status ?? null,
        ok: entry.ok,
        durationMs: entry.durationMs,
        attempt: entry.attempt,
        errorCode: entry.errorCode ?? null,
        // Redacted: an upstream error body can echo back a header or a URL.
        errorMessage: entry.errorMessage
          ? redactSecretsInText(entry.errorMessage).slice(0, 500)
          : null,
        ebayErrorId: entry.ebayErrorId ?? null,
      },
    });

    const now = new Date();
    await prisma.ebayConnection.update({
      where: { id: connectionId },
      data: {
        lastApiRequestAt: now,
        lastApiPath: entry.path,
        lastApiStatus: entry.status ?? null,
        ...(entry.ok
          ? {
              lastApiSuccessAt: now,
              lastError: null,
              lastErrorCode: null,
              rateLimitedUntil: null,
            }
          : {
              lastError: entry.errorMessage?.slice(0, 500) ?? null,
              lastErrorCode: entry.errorCode ?? null,
              lastErrorAt: now,
            }),
      },
    });

    // Trim the log occasionally rather than on every call.
    if (Math.random() < 0.05) {
      const cutoff = await prisma.ebayApiCall.findMany({
        where: { connectionId },
        orderBy: { createdAt: "desc" },
        skip: API_LOG_RETENTION,
        select: { id: true },
        take: 200,
      });
      if (cutoff.length > 0) {
        await prisma.ebayApiCall.deleteMany({
          where: { id: { in: cutoff.map((row) => row.id) } },
        });
      }
    }
  } catch (error) {
    logError("ebay", error);
  }
}

/**
 * Performs a request against the eBay REST API with retries and logging.
 *
 * @throws EbayApiError on every failure path.
 */
export async function ebayRequest<T>(
  connection: EbayConnection,
  options: EbayRequestOptions,
): Promise<EbayResponse<T>> {
  const method = options.method ?? "GET";
  const environment = resolveEnvironment(connection.environment);
  const credentials = getEbayCredentials(environment);
  if (!credentials) {
    throw new EbayApiError(
      EBAY_ERROR_CODES.NOT_CONFIGURED,
      "eBay credentials are not configured on the server.",
    );
  }

  const cooling = cooldownRemaining(connection.id);
  if (cooling > 0) {
    throw new EbayApiError(
      EBAY_ERROR_CODES.RATE_LIMITED,
      `eBay rate limit cooldown active for another ${cooling}s.`,
      { retryAfterSeconds: cooling },
    );
  }

  const url = buildUrl(
    getEndpoints(environment).api,
    options.path,
    options.query,
  );

  const marketplaceId =
    options.marketplaceId === undefined
      ? connection.marketplaceId
      : options.marketplaceId;

  const attemptLimit = maxAttempts();
  let lastError: EbayApiError | null = null;

  for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
    // Re-read the connection each attempt so a refresh performed by a
    // concurrent request is picked up.
    const current =
      attempt === 1
        ? connection
        : ((await prisma.ebayConnection.findUnique({
            where: { id: connection.id },
          })) ?? connection);

    const accessToken = await getValidAccessToken(current);

    await acquireSlot(connection.id);
    options.onAttempt?.({ attempt });

    const startedAt = Date.now();
    const timeout = AbortSignal.timeout(requestTimeoutMs());
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;

    let response: Response;
    try {
      response = await transport(url, {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(marketplaceId
            ? { "X-EBAY-C-MARKETPLACE-ID": marketplaceId }
            : {}),
        },
        signal,
        cache: "no-store",
      });
    } catch (cause) {
      const durationMs = Date.now() - startedAt;
      lastError = new EbayApiError(
        EBAY_ERROR_CODES.NETWORK_ERROR,
        "The request to eBay failed before a response was received.",
        { cause, detail: cause instanceof Error ? cause.message : undefined },
      );
      await recordCall(connection.id, {
        method,
        path: options.path,
        ok: false,
        durationMs,
        attempt,
        errorCode: lastError.code,
        errorMessage: lastError.detail ?? lastError.message,
      });
      if (attempt < attemptLimit) {
        await sleep(backoffDelayMs(attempt));
        continue;
      }
      throw lastError;
    }

    const durationMs = Date.now() - startedAt;
    const rawBody = await response.text();
    let body: unknown = null;
    if (rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = null;
      }
    }

    options.onAttempt?.({ attempt, status: response.status });

    if (response.ok) {
      if (rawBody.length > 0 && body === null) {
        lastError = new EbayApiError(
          EBAY_ERROR_CODES.INVALID_RESPONSE,
          "eBay returned a success status with a body that is not valid JSON.",
          { status: response.status },
        );
        await recordCall(connection.id, {
          method,
          path: options.path,
          status: response.status,
          ok: false,
          durationMs,
          attempt,
          errorCode: lastError.code,
          errorMessage: lastError.message,
        });
        throw lastError;
      }

      clearCooldown(connection.id);
      await recordCall(connection.id, {
        method,
        path: options.path,
        status: response.status,
        ok: true,
        durationMs,
        attempt,
      });
      return { data: (body ?? {}) as T, status: response.status, attempts: attempt };
    }

    const classified = classifyHttpError(response.status, body);
    const retryAfterSeconds = parseRetryAfter(response);

    lastError = new EbayApiError(classified.code, classified.detail ?? response.statusText, {
      status: response.status,
      ebayErrorId: classified.ebayErrorId,
      retryAfterSeconds,
      detail: classified.detail,
    });

    await recordCall(connection.id, {
      method,
      path: options.path,
      status: response.status,
      ok: false,
      durationMs,
      attempt,
      errorCode: lastError.code,
      errorMessage: lastError.detail ?? lastError.message,
      ebayErrorId: classified.ebayErrorId,
    });

    if (classified.code === EBAY_ERROR_CODES.RATE_LIMITED) {
      const until = startCooldown(connection.id, retryAfterSeconds ?? 60);
      await prisma.ebayConnection
        .update({
          where: { id: connection.id },
          data: { rateLimitedUntil: until },
        })
        .catch(() => undefined);
    }

    if (lastError.retryable && attempt < attemptLimit) {
      await sleep(backoffDelayMs(attempt, retryAfterSeconds));
      continue;
    }

    throw lastError;
  }

  throw (
    lastError ??
    new EbayApiError(
      EBAY_ERROR_CODES.SERVER_ERROR,
      "The eBay request failed after exhausting all retries.",
    )
  );
}
