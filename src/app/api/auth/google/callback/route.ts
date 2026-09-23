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
import {
  OAUTH_PROVIDERS,
  consumeOAuthState,
  describeStateRejection,
  discardOAuthState,
} from "@/lib/oauth-store";

export const dynamic = "force-dynamic";

/** The raw state cookie, or undefined when the browser did not send one. */
function readStateCookie(request: Request): string | undefined {
  return request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${GOOGLE_OAUTH_STATE_COOKIE}=`))
    ?.slice(GOOGLE_OAUTH_STATE_COOKIE.length + 1);
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
  // The cookie is a second factor, not the record. When the browser sends one
  // it has to agree with the state Google returned — a disagreement is the
  // attack this guard exists for. When it sends none, which is the normal
  // outcome whenever the callback arrives on a different hostname from the
  // one that started the flow, the database row is authoritative: it is bound
  // to a user, single-use, and expires on its own.
  const cookieState = readStateCookie(request);
  if (cookieState && !safeEqual(decodeURIComponent(cookieState), returnedState)) {
    return redirectWithError(
      origin,
      GOOGLE_ERROR_CODES.OAUTH_FAILED,
      "The authorization state did not match. The request was rejected.",
    );
  }

  const claim = await consumeOAuthState(OAUTH_PROVIDERS.GOOGLE, returnedState);
  if (!claim.ok) {
    return redirectWithError(
      origin,
      GOOGLE_ERROR_CODES.OAUTH_FAILED,
      describeStateRejection(claim.reason),
    );
  }

  const credentials = getGoogleCredentials();
  if (!credentials) {
    await discardOAuthState(returnedState);
    return redirectWithError(origin, GOOGLE_ERROR_CODES.NOT_CONFIGURED);
  }

  // --- Token exchange -------------------------------------------------------
  try {
    // The workspace that started the flow, not whoever the current request
    // happens to resolve to — the state row is what ties the two together.
    const user = { id: claim.userId };
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
      await discardOAuthState(returnedState);
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
    // The state is spent either way: the authorization code has been offered
    // to Google and cannot be offered again.
    await discardOAuthState(returnedState);
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

  await discardOAuthState(returnedState);

  const target = new URL(claim.returnTo || "/google-sheet", origin);
  target.searchParams.set("google", "connected");
  const response = NextResponse.redirect(target);
  response.cookies.delete(GOOGLE_OAUTH_STATE_COOKIE);
  return response;
}
