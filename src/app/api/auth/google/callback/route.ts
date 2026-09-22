import { NextResponse } from "next/server";

import { CONNECTION_STATUS } from "@/lib/constants";
import { safeEqual } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import {
  getGoogleCredentials,
  getGoogleScopes,
  grantsDriveList,
  grantsSheetsRead,
} from "@/lib/google/config";
import { fetchIdentity } from "@/lib/google/drive";
import { GOOGLE_ERROR_CODES, GoogleApiError } from "@/lib/google/errors";
import { exchangeCodeForTokens } from "@/lib/google/oauth";
import { GOOGLE_OAUTH_STATE_COOKIE } from "@/lib/google/oauth-state";
import { encryptTokenSet } from "@/lib/google/tokens";
import { logError, safeMessage } from "@/lib/log";
import { redactSecretsInText } from "@/lib/mask";
import { getCurrentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

interface StatePayload {
  state?: string;
  returnTo?: string;
}

function redirectWithError(
  origin: string,
  code: string,
  detail?: string,
): NextResponse {
  const target = new URL("/settings", origin);
  target.searchParams.set("google_error", code);
  if (detail) target.searchParams.set("detail", detail.slice(0, 300));
  target.hash = "google";
  const response = NextResponse.redirect(target);
  response.cookies.delete(GOOGLE_OAUTH_STATE_COOKIE);
  return response;
}

/**
 * Handles Google's redirect back after consent.
 *
 * Rejects anything failing the CSRF check *before* spending the code,
 * exchanges it server-side, then stores both tokens encrypted. The code and
 * tokens never leave this function except as ciphertext.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const origin = url.origin;

  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    // access_denied means the user pressed Cancel — not a fault condition.
    return redirectWithError(
      origin,
      GOOGLE_ERROR_CODES.OAUTH_FAILED,
      oauthError === "access_denied"
        ? "You declined the Google authorization. Nothing was changed."
        : oauthError,
    );
  }

  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  if (!code || !returnedState) {
    return redirectWithError(
      origin,
      GOOGLE_ERROR_CODES.OAUTH_FAILED,
      "Google did not return an authorization code.",
    );
  }

  // --- CSRF -----------------------------------------------------------------
  const rawCookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${GOOGLE_OAUTH_STATE_COOKIE}=`))
    ?.slice(GOOGLE_OAUTH_STATE_COOKIE.length + 1);

  if (!rawCookie) {
    return redirectWithError(
      origin,
      GOOGLE_ERROR_CODES.OAUTH_FAILED,
      "The authorization session expired before Google redirected back. Start the connection again.",
    );
  }

  let statePayload: StatePayload;
  try {
    statePayload = JSON.parse(decodeURIComponent(rawCookie)) as StatePayload;
  } catch {
    return redirectWithError(
      origin,
      GOOGLE_ERROR_CODES.OAUTH_FAILED,
      "The authorization session could not be read. Start the connection again.",
    );
  }

  if (!statePayload.state || !safeEqual(statePayload.state, returnedState)) {
    return redirectWithError(
      origin,
      GOOGLE_ERROR_CODES.OAUTH_FAILED,
      "The authorization state did not match. The request was rejected.",
    );
  }

  const credentials = getGoogleCredentials();
  if (!credentials) {
    return redirectWithError(origin, GOOGLE_ERROR_CODES.NOT_CONFIGURED);
  }

  // --- Token exchange -------------------------------------------------------
  try {
    const user = await getCurrentUser();
    const tokens = await exchangeCodeForTokens(credentials, code);
    const encrypted = encryptTokenSet(tokens);
    const now = new Date();

    const granted = tokens.grantedScopes ?? getGoogleScopes().join(" ");

    // Google lets the user untick individual permissions on the consent
    // screen, so check what was actually granted rather than what we asked
    // for. Connecting without these scopes would fail confusingly later.
    if (!grantsSheetsRead(granted) || !grantsDriveList(granted)) {
      const missing = [
        grantsDriveList(granted) ? null : "see your spreadsheet list",
        grantsSheetsRead(granted) ? null : "read spreadsheet contents",
      ].filter(Boolean);
      return redirectWithError(
        origin,
        GOOGLE_ERROR_CODES.INSUFFICIENT_SCOPE,
        `The connection was not saved because permission to ${missing.join(
          " and ",
        )} was not granted. Reconnect and leave every checkbox ticked.`,
      );
    }

    const existing = await prisma.googleConnection.findFirst({
      where: { userId: user.id, isActive: true },
    });

    const payload = {
      status: CONNECTION_STATUS.CONNECTED,
      isActive: true,
      accessToken: encrypted.accessToken,
      // Google omits refresh_token when it has already issued one for this
      // client+account. Keep the stored one rather than nulling it.
      ...(encrypted.refreshToken
        ? { refreshToken: encrypted.refreshToken }
        : {}),
      tokenType: encrypted.tokenType,
      tokenExpiresAt: encrypted.tokenExpiresAt,
      scopes: granted,
      connectedAt: now,
      lastCheckedAt: now,
      lastRefreshedAt: now,
      lastError: null,
      lastErrorCode: null,
      lastErrorAt: null,
      rateLimitedUntil: null,
    };

    const connection = existing
      ? await prisma.googleConnection.update({
          where: { id: existing.id },
          data: payload,
        })
      : await prisma.googleConnection.create({
          data: { ...payload, userId: user.id },
        });


    const identity = await fetchIdentity(connection).catch(() => null);
    if (identity) {
      await prisma.googleConnection.update({
        where: { id: connection.id },
        data: {
          googleUserId: identity.sub ?? connection.googleUserId,
          email: identity.email ?? connection.email,
          displayName: identity.name ?? connection.displayName,
          avatarUrl: identity.picture ?? connection.avatarUrl,
        },
      });
    }
  } catch (error) {
    if (error instanceof GoogleApiError) {
      return redirectWithError(
        origin,
        error.code,
        redactSecretsInText(error.detail ?? error.message),
      );
    }
    logError("google/callback", error);
    return redirectWithError(
      origin,
      GOOGLE_ERROR_CODES.OAUTH_FAILED,
      safeMessage(error, "The authorization could not be completed."),
    );
  }

  const target = new URL(statePayload.returnTo ?? "/google-sheet", origin);
  target.searchParams.set("google", "connected");
  const response = NextResponse.redirect(target);
  response.cookies.delete(GOOGLE_OAUTH_STATE_COOKIE);
  return response;
}
