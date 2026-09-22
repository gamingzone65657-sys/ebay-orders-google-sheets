/**
 * Access-token lifecycle: storage, expiry checks, and refresh.
 *
 * Every eBay request goes through `getValidAccessToken`, so there is exactly
 * one place that decides whether a token is usable and exactly one place that
 * refreshes it.
 */

import type { EbayConnection } from "@prisma/client";

import { CONNECTION_STATUS } from "@/lib/constants";
import { encryptSecret, tryDecryptSecret } from "@/lib/crypto";
import { prisma } from "@/lib/db";

import { getEbayCredentials, resolveEnvironment } from "./config";
import { EBAY_ERROR_CODES, EbayApiError } from "./errors";
import { refreshAccessToken, type EbayTokenSet } from "./oauth";

/** Refresh this long before the token actually expires. */
const REFRESH_SKEW_MS = 120_000;

/** Collapses concurrent refreshes of the same connection into one call. */
const inFlightRefreshes = new Map<string, Promise<string>>();

export type TokenHealth =
  | "VALID"
  | "EXPIRING_SOON"
  | "EXPIRED"
  | "REFRESH_EXPIRED"
  | "MISSING";

export interface TokenStatus {
  health: TokenHealth;
  label: string;
  expiresAt: Date | null;
  refreshExpiresAt: Date | null;
  /** Seconds until the access token expires; negative once it has. */
  expiresInSeconds: number | null;
}

/** Read-only view for the UI. Never returns token material. */
export function describeTokenStatus(
  connection: Pick<
    EbayConnection,
    "accessToken" | "refreshToken" | "tokenExpiresAt" | "refreshExpiresAt" | "status"
  > | null,
): TokenStatus {
  if (!connection || !connection.accessToken) {
    return {
      health: "MISSING",
      label: "No token stored",
      expiresAt: null,
      refreshExpiresAt: null,
      expiresInSeconds: null,
    };
  }

  const now = Date.now();
  const expiresAt = connection.tokenExpiresAt ?? null;
  const refreshExpiresAt = connection.refreshExpiresAt ?? null;
  const expiresInSeconds = expiresAt
    ? Math.round((expiresAt.getTime() - now) / 1000)
    : null;

  if (refreshExpiresAt && refreshExpiresAt.getTime() <= now) {
    return {
      health: "REFRESH_EXPIRED",
      label: "Authorization expired — reconnect required",
      expiresAt,
      refreshExpiresAt,
      expiresInSeconds,
    };
  }

  if (!expiresAt || expiresAt.getTime() <= now) {
    return {
      health: connection.refreshToken ? "EXPIRED" : "REFRESH_EXPIRED",
      label: connection.refreshToken
        ? "Access token expired — refreshes on next request"
        : "Access token expired — reconnect required",
      expiresAt,
      refreshExpiresAt,
      expiresInSeconds,
    };
  }

  if (expiresAt.getTime() - now <= REFRESH_SKEW_MS) {
    return {
      health: "EXPIRING_SOON",
      label: "Access token expiring — refreshes on next request",
      expiresAt,
      refreshExpiresAt,
      expiresInSeconds,
    };
  }

  return {
    health: "VALID",
    label: "Access token valid",
    expiresAt,
    refreshExpiresAt,
    expiresInSeconds,
  };
}

export function encryptTokenSet(tokens: EbayTokenSet) {
  return {
    accessToken: encryptSecret(tokens.accessToken),
    refreshToken: tokens.refreshToken
      ? encryptSecret(tokens.refreshToken)
      : undefined,
    tokenType: tokens.tokenType,
    tokenExpiresAt: tokens.expiresAt,
    refreshExpiresAt: tokens.refreshExpiresAt,
  };
}

async function markReconnectRequired(
  connectionId: string,
  message: string,
): Promise<never> {
  await prisma.ebayConnection.update({
    where: { id: connectionId },
    data: {
      status: CONNECTION_STATUS.EXPIRED,
      lastError: message,
      lastErrorCode: EBAY_ERROR_CODES.AUTH_EXPIRED,
      lastErrorAt: new Date(),
    },
  });
  throw new EbayApiError(EBAY_ERROR_CODES.AUTH_EXPIRED, message);
}

async function performRefresh(connection: EbayConnection): Promise<string> {
  const credentials = getEbayCredentials(connection.environment);
  if (!credentials) {
    throw new EbayApiError(
      EBAY_ERROR_CODES.NOT_CONFIGURED,
      "eBay credentials are not configured on the server.",
    );
  }

  const refreshToken = tryDecryptSecret(connection.refreshToken);
  if (!refreshToken) {
    return markReconnectRequired(
      connection.id,
      "No usable refresh token is stored for this connection.",
    );
  }

  if (
    connection.refreshExpiresAt &&
    connection.refreshExpiresAt.getTime() <= Date.now()
  ) {
    return markReconnectRequired(
      connection.id,
      "The eBay refresh token has expired.",
    );
  }

  let tokens: EbayTokenSet;
  try {
    tokens = await refreshAccessToken(credentials, refreshToken);
  } catch (error) {
    if (
      error instanceof EbayApiError &&
      error.code === EBAY_ERROR_CODES.AUTH_EXPIRED
    ) {
      return markReconnectRequired(
        connection.id,
        "eBay rejected the refresh token. Reconnect the account.",
      );
    }
    throw error;
  }

  const encrypted = encryptTokenSet(tokens);
  await prisma.ebayConnection.update({
    where: { id: connection.id },
    data: {
      accessToken: encrypted.accessToken,
      // eBay does not rotate the refresh token; keep the existing one.
      ...(encrypted.refreshToken ? { refreshToken: encrypted.refreshToken } : {}),
      tokenType: encrypted.tokenType,
      tokenExpiresAt: encrypted.tokenExpiresAt,
      ...(encrypted.refreshExpiresAt
        ? { refreshExpiresAt: encrypted.refreshExpiresAt }
        : {}),
      status: CONNECTION_STATUS.CONNECTED,
      lastRefreshedAt: new Date(),
      lastError: null,
      lastErrorCode: null,
    },
  });

  return tokens.accessToken;
}

/**
 * Returns a usable access token, refreshing first when needed.
 *
 * Throws EbayApiError(AUTH_EXPIRED) when the seller has to reconnect, which
 * callers surface as an actionable message rather than a generic failure.
 */
export async function getValidAccessToken(
  connection: EbayConnection,
): Promise<string> {
  if (connection.status === CONNECTION_STATUS.DISCONNECTED) {
    throw new EbayApiError(
      EBAY_ERROR_CODES.NOT_CONNECTED,
      "This eBay connection has been disconnected.",
    );
  }

  const expiresAt = connection.tokenExpiresAt?.getTime() ?? 0;
  const stillFresh = expiresAt - Date.now() > REFRESH_SKEW_MS;

  if (stillFresh) {
    const token = tryDecryptSecret(connection.accessToken);
    if (token) return token;
    // Decryption failed (rotated AUTH_SECRET, corrupt row) — refresh instead.
  }

  const existing = inFlightRefreshes.get(connection.id);
  if (existing) return existing;

  const refresh = performRefresh(connection).finally(() => {
    inFlightRefreshes.delete(connection.id);
  });
  inFlightRefreshes.set(connection.id, refresh);
  return refresh;
}

/** The connection this workspace should be using, if any. */
export async function getActiveEbayConnection(
  userId: string,
): Promise<EbayConnection | null> {
  return prisma.ebayConnection.findFirst({
    where: { userId, isActive: true },
    orderBy: { updatedAt: "desc" },
  });
}

/** Asserts a connected account exists, for API-backed operations. */
export async function requireLiveConnection(
  userId: string,
): Promise<EbayConnection> {
  const connection = await getActiveEbayConnection(userId);
  if (!connection || connection.status === CONNECTION_STATUS.DISCONNECTED) {
    throw new EbayApiError(
      EBAY_ERROR_CODES.NOT_CONNECTED,
      "No eBay account is connected.",
    );
  }
  if (!getEbayCredentials(connection.environment)) {
    throw new EbayApiError(
      EBAY_ERROR_CODES.NOT_CONFIGURED,
      "eBay credentials are not configured on the server.",
    );
  }
  return connection;
}

export { resolveEnvironment };
