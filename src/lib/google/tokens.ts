/**
 * Google access-token lifecycle: storage, expiry checks, and refresh.
 *
 * Every Google request goes through `getValidAccessToken`, so there is one
 * place that decides whether a token is usable and one place that refreshes.
 */

import type { GoogleConnection } from "@prisma/client";

import { CONNECTION_STATUS } from "@/lib/constants";
import { encryptSecret, tryDecryptSecret } from "@/lib/crypto";
import { prisma } from "@/lib/db";

import { getGoogleCredentials } from "./config";
import { GOOGLE_ERROR_CODES, GoogleApiError } from "./errors";
import { refreshAccessToken, type GoogleTokenSet } from "./oauth";

/** Refresh this long before the token actually expires. */
const REFRESH_SKEW_MS = 120_000;

/** Collapses concurrent refreshes of the same connection into one call. */
const inFlightRefreshes = new Map<string, Promise<string>>();

export type GoogleTokenHealth =
  | "VALID"
  | "EXPIRING_SOON"
  | "EXPIRED"
  | "NO_REFRESH_TOKEN"
  | "MISSING";

export interface GoogleTokenStatus {
  health: GoogleTokenHealth;
  label: string;
  expiresAt: Date | null;
  expiresInSeconds: number | null;
  hasRefreshToken: boolean;
}

/** Read-only view for the UI. Never returns token material. */
export function describeTokenStatus(
  connection: Pick<
    GoogleConnection,
    "accessToken" | "refreshToken" | "tokenExpiresAt" | "status"
  > | null,
): GoogleTokenStatus {
  if (!connection || !connection.accessToken) {
    return {
      health: "MISSING",
      label: "No token stored",
      expiresAt: null,
      expiresInSeconds: null,
      hasRefreshToken: false,
    };
  }

  const now = Date.now();
  const expiresAt = connection.tokenExpiresAt ?? null;
  const hasRefreshToken = Boolean(connection.refreshToken);
  const expiresInSeconds = expiresAt
    ? Math.round((expiresAt.getTime() - now) / 1000)
    : null;

  if (!expiresAt || expiresAt.getTime() <= now) {
    return {
      health: hasRefreshToken ? "EXPIRED" : "NO_REFRESH_TOKEN",
      label: hasRefreshToken
        ? "Access token expired — refreshes on next request"
        : "Access token expired and no refresh token stored — reconnect required",
      expiresAt,
      expiresInSeconds,
      hasRefreshToken,
    };
  }

  if (!hasRefreshToken) {
    return {
      health: "NO_REFRESH_TOKEN",
      label: "Valid, but no refresh token — reconnect to obtain one",
      expiresAt,
      expiresInSeconds,
      hasRefreshToken,
    };
  }

  if (expiresAt.getTime() - now <= REFRESH_SKEW_MS) {
    return {
      health: "EXPIRING_SOON",
      label: "Access token expiring — refreshes on next request",
      expiresAt,
      expiresInSeconds,
      hasRefreshToken,
    };
  }

  return {
    health: "VALID",
    label: "Access token valid",
    expiresAt,
    expiresInSeconds,
    hasRefreshToken,
  };
}

export function encryptTokenSet(tokens: GoogleTokenSet) {
  return {
    accessToken: encryptSecret(tokens.accessToken),
    refreshToken: tokens.refreshToken
      ? encryptSecret(tokens.refreshToken)
      : undefined,
    tokenType: tokens.tokenType,
    tokenExpiresAt: tokens.expiresAt,
    grantedScopes: tokens.grantedScopes,
  };
}

async function markReconnectRequired(
  connectionId: string,
  message: string,
): Promise<never> {
  await prisma.googleConnection.update({
    where: { id: connectionId },
    data: {
      status: CONNECTION_STATUS.EXPIRED,
      lastError: message,
      lastErrorCode: GOOGLE_ERROR_CODES.AUTH_EXPIRED,
      lastErrorAt: new Date(),
    },
  });
  throw new GoogleApiError(GOOGLE_ERROR_CODES.AUTH_EXPIRED, message);
}

async function performRefresh(connection: GoogleConnection): Promise<string> {
  const credentials = getGoogleCredentials();
  if (!credentials) {
    throw new GoogleApiError(
      GOOGLE_ERROR_CODES.NOT_CONFIGURED,
      "Google credentials are not configured on the server.",
    );
  }

  const refreshToken = tryDecryptSecret(connection.refreshToken);
  if (!refreshToken) {
    return markReconnectRequired(
      connection.id,
      "No usable refresh token is stored for this connection.",
    );
  }

  let tokens: GoogleTokenSet;
  try {
    tokens = await refreshAccessToken(credentials, refreshToken);
  } catch (error) {
    if (
      error instanceof GoogleApiError &&
      error.code === GOOGLE_ERROR_CODES.AUTH_EXPIRED
    ) {
      return markReconnectRequired(
        connection.id,
        "Google rejected the refresh token. Reconnect the account.",
      );
    }
    throw error;
  }

  const encrypted = encryptTokenSet(tokens);
  await prisma.googleConnection.update({
    where: { id: connection.id },
    data: {
      accessToken: encrypted.accessToken,
      // Google does not rotate the refresh token; keep the existing one.
      ...(encrypted.refreshToken ? { refreshToken: encrypted.refreshToken } : {}),
      tokenType: encrypted.tokenType,
      tokenExpiresAt: encrypted.tokenExpiresAt,
      // `scope` is not returned on every refresh; keep the stored value then.
      ...(encrypted.grantedScopes ? { scopes: encrypted.grantedScopes } : {}),
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
 * Throws GoogleApiError(AUTH_EXPIRED) when the user has to reconnect.
 */
export async function getValidAccessToken(
  connection: GoogleConnection,
): Promise<string> {
  if (connection.status === CONNECTION_STATUS.DISCONNECTED) {
    throw new GoogleApiError(
      GOOGLE_ERROR_CODES.NOT_CONNECTED,
      "This Google connection has been disconnected.",
    );
  }

  const expiresAt = connection.tokenExpiresAt?.getTime() ?? 0;
  if (expiresAt - Date.now() > REFRESH_SKEW_MS) {
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

export async function getActiveGoogleConnection(
  userId: string,
): Promise<GoogleConnection | null> {
  return prisma.googleConnection.findFirst({
    where: { userId, isActive: true },
    orderBy: { updatedAt: "desc" },
  });
}

/** Asserts a connected account exists, for API-backed operations. */
export async function requireLiveConnection(
  userId: string,
): Promise<GoogleConnection> {
  const connection = await getActiveGoogleConnection(userId);
  if (!connection || connection.status === CONNECTION_STATUS.DISCONNECTED) {
    throw new GoogleApiError(
      GOOGLE_ERROR_CODES.NOT_CONNECTED,
      "No Google account is connected.",
    );
  }
  if (!getGoogleCredentials()) {
    throw new GoogleApiError(
      GOOGLE_ERROR_CODES.NOT_CONFIGURED,
      "Google credentials are not configured on the server.",
    );
  }
  return connection;
}
