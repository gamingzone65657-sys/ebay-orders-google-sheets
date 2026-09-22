/**
 * The single outbound path to the Google APIs.
 *
 * Same responsibilities as the eBay client: cooldown check, per-connection
 * pacing, a freshly-validated bearer token, error classification, retries
 * with backoff, and a row in GoogleApiCall for every attempt.
 *
 * Nothing else in the codebase calls `fetch` against Google, apart from the
 * token endpoint in oauth.ts (which cannot use this, since it is what
 * produces the token).
 */

import type { GoogleConnection } from "@prisma/client";

import { logError } from "@/lib/log";
import { redactSecretsInText } from "@/lib/mask";
import { prisma } from "@/lib/db";
import {
  acquireSlot,
  backoffDelayMs,
  clearCooldown,
  cooldownRemaining,
  startCooldown,
} from "@/lib/http/rate-limit";

import { GOOGLE_ERROR_CODES, GoogleApiError, classifyGoogleError } from "./errors";
import { getValidAccessToken } from "./tokens";

const API_LOG_RETENTION = 300;

function maxAttempts(): number {
  const value = Number(process.env.GOOGLE_MAX_ATTEMPTS ?? 4);
  return Number.isFinite(value) && value >= 1 ? Math.trunc(value) : 4;
}

function requestTimeoutMs(): number {
  const value = Number(process.env.GOOGLE_REQUEST_TIMEOUT_MS ?? 30_000);
  return Number.isFinite(value) && value > 0 ? value : 30_000;
}

function minIntervalMs(): number {
  const value = Number(process.env.GOOGLE_MIN_REQUEST_INTERVAL_MS ?? 80);
  return Number.isFinite(value) && value >= 0 ? value : 80;
}

const rateKey = (connectionId: string) => `google:${connectionId}`;

export interface GoogleRequestOptions {
  /** Absolute URL. Google spans several hosts, so no base is assumed. */
  url: string;
  /** Short label used for logging, e.g. "drive.files.list". */
  label: string;
  method?: "GET" | "POST" | "PUT";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  signal?: AbortSignal;
}

export interface GoogleResponse<T> {
  data: T;
  status: number;
  attempts: number;
}

/** Injectable transport, so tests exercise this file without network access. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

let transport: FetchLike = (input, init) => fetch(input, init);

/**
 * The current transport, for callers outside this module.
 *
 * The OAuth token endpoint is not a Sheets/Drive API call and does not go
 * through `googleRequest` — it has no bearer token, different error shapes and
 * no retry policy. It must still honour the injected transport, or the token
 * exchange and refresh escape to the real network in tests, which both makes
 * that path untestable and lets a test suite talk to Google by accident.
 */
export function googleTransport(): FetchLike {
  return transport;
}

export function setGoogleTransport(next: FetchLike | null): void {
  transport = next ?? ((input, init) => fetch(input, init));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildUrl(
  base: string,
  query?: GoogleRequestOptions["query"],
): string {
  const url = new URL(base);
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
    googleReason?: string;
  },
): Promise<void> {
  // Observability must never break the request it is observing.
  try {
    await prisma.googleApiCall.create({
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
        googleReason: entry.googleReason ?? null,
      },
    });

    const now = new Date();
    await prisma.googleConnection.update({
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

    if (Math.random() < 0.05) {
      const stale = await prisma.googleApiCall.findMany({
        where: { connectionId },
        orderBy: { createdAt: "desc" },
        skip: API_LOG_RETENTION,
        select: { id: true },
        take: 200,
      });
      if (stale.length > 0) {
        await prisma.googleApiCall.deleteMany({
          where: { id: { in: stale.map((row) => row.id) } },
        });
      }
    }
  } catch (error) {
    logError("google", error);
  }
}

/**
 * Performs a request against a Google API with retries and logging.
 *
 * @throws GoogleApiError on every failure path.
 */
export async function googleRequest<T>(
  connection: GoogleConnection,
  options: GoogleRequestOptions,
): Promise<GoogleResponse<T>> {
  const method = options.method ?? "GET";

  const cooling = cooldownRemaining(rateKey(connection.id));
  if (cooling > 0) {
    throw new GoogleApiError(
      GOOGLE_ERROR_CODES.RATE_LIMITED,
      `Google rate limit cooldown active for another ${cooling}s.`,
      { retryAfterSeconds: cooling },
    );
  }

  const url = buildUrl(options.url, options.query);
  const attemptLimit = maxAttempts();
  let lastError: GoogleApiError | null = null;

  for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
    // Re-read the connection each retry so a refresh performed by a
    // concurrent request is picked up.
    const current =
      attempt === 1
        ? connection
        : ((await prisma.googleConnection.findUnique({
            where: { id: connection.id },
          })) ?? connection);

    const accessToken = await getValidAccessToken(current);

    await acquireSlot(rateKey(connection.id), minIntervalMs());

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
          ...(options.body ? { "Content-Type": "application/json" } : {}),
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        signal,
        cache: "no-store",
      });
    } catch (cause) {
      const durationMs = Date.now() - startedAt;
      lastError = new GoogleApiError(
        GOOGLE_ERROR_CODES.NETWORK_ERROR,
        "The request to Google failed before a response was received.",
        { cause, detail: cause instanceof Error ? cause.message : undefined },
      );
      await recordCall(connection.id, {
        method,
        path: options.label,
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

    if (response.ok) {
      if (rawBody.length > 0 && body === null) {
        lastError = new GoogleApiError(
          GOOGLE_ERROR_CODES.INVALID_RESPONSE,
          "Google returned a success status with a body that is not valid JSON.",
          { status: response.status },
        );
        await recordCall(connection.id, {
          method,
          path: options.label,
          status: response.status,
          ok: false,
          durationMs,
          attempt,
          errorCode: lastError.code,
          errorMessage: lastError.message,
        });
        throw lastError;
      }

      clearCooldown(rateKey(connection.id));
      await recordCall(connection.id, {
        method,
        path: options.label,
        status: response.status,
        ok: true,
        durationMs,
        attempt,
      });
      return {
        data: (body ?? {}) as T,
        status: response.status,
        attempts: attempt,
      };
    }

    const classified = classifyGoogleError(response.status, body);
    const retryAfterSeconds = parseRetryAfter(response);

    lastError = new GoogleApiError(
      classified.code,
      classified.detail ?? response.statusText,
      {
        status: response.status,
        reason: classified.reason,
        retryAfterSeconds,
        detail: classified.detail,
      },
    );

    await recordCall(connection.id, {
      method,
      path: options.label,
      status: response.status,
      ok: false,
      durationMs,
      attempt,
      errorCode: lastError.code,
      errorMessage: lastError.detail ?? lastError.message,
      googleReason: classified.reason,
    });

    if (classified.code === GOOGLE_ERROR_CODES.RATE_LIMITED) {
      const until = startCooldown(
        rateKey(connection.id),
        retryAfterSeconds ?? 60,
      );
      await prisma.googleConnection
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
    new GoogleApiError(
      GOOGLE_ERROR_CODES.SERVER_ERROR,
      "The Google request failed after exhausting all retries.",
    )
  );
}
