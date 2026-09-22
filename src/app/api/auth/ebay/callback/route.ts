import { NextResponse } from "next/server";

import { CONNECTION_STATUS } from "@/lib/constants";
import { safeEqual } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import {
  getEbayCredentials,
  getEbayScopes,
  identityScopeRequested,
} from "@/lib/ebay/config";
import { EBAY_ERROR_CODES, EbayApiError } from "@/lib/ebay/errors";
import { fetchIdentity } from "@/lib/ebay/identity";
import { exchangeCodeForTokens } from "@/lib/ebay/oauth";
import { OAUTH_STATE_COOKIE } from "@/lib/ebay/oauth-state";
import { encryptTokenSet } from "@/lib/ebay/tokens";
import { logError, safeMessage } from "@/lib/log";
import { redactSecretsInText } from "@/lib/mask";
import { getCurrentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

interface StatePayload {
  state?: string;
  marketplaceId?: string;
  environment?: string;
}

function redirectWithError(
  origin: string,
  code: string,
  detail?: string,
): NextResponse {
  const target = new URL("/settings", origin);
  target.searchParams.set("ebay_error", code);
  if (detail) target.searchParams.set("detail", detail.slice(0, 300));
  target.hash = "ebay";
  const response = NextResponse.redirect(target);
  response.cookies.delete(OAUTH_STATE_COOKIE);
  return response;
}

/**
 * Handles eBay's redirect back after consent.
 *
 * Order of business: reject anything that fails the CSRF check *before*
 * spending the authorization code, exchange the code server-side, encrypt
 * both tokens, then store them. The code and tokens never leave this
 * function except as ciphertext.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const origin = url.origin;

  // eBay reports a declined or failed consent as query parameters.
  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    const description =
      url.searchParams.get("error_description") ?? undefined;
    return redirectWithError(
      origin,
      EBAY_ERROR_CODES.OAUTH_FAILED,
      description ?? oauthError,
    );
  }

  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  if (!code || !returnedState) {
    return redirectWithError(
      origin,
      EBAY_ERROR_CODES.OAUTH_FAILED,
      "eBay did not return an authorization code.",
    );
  }

  // --- CSRF -----------------------------------------------------------------
  const rawCookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${OAUTH_STATE_COOKIE}=`))
    ?.slice(OAUTH_STATE_COOKIE.length + 1);

  if (!rawCookie) {
    return redirectWithError(
      origin,
      EBAY_ERROR_CODES.OAUTH_FAILED,
      "The authorization session expired before eBay redirected back. Start the connection again.",
    );
  }

  let statePayload: StatePayload;
  try {
    statePayload = JSON.parse(decodeURIComponent(rawCookie)) as StatePayload;
  } catch {
    return redirectWithError(
      origin,
      EBAY_ERROR_CODES.OAUTH_FAILED,
      "The authorization session could not be read. Start the connection again.",
    );
  }

  if (!statePayload.state || !safeEqual(statePayload.state, returnedState)) {
    return redirectWithError(
      origin,
      EBAY_ERROR_CODES.OAUTH_FAILED,
      "The authorization state did not match. The request was rejected.",
    );
  }

  const environment = statePayload.environment === "PRODUCTION" ? "PRODUCTION" : "SANDBOX";
  const marketplaceId = statePayload.marketplaceId ?? "EBAY_US";

  const credentials = getEbayCredentials(environment);
  if (!credentials) {
    return redirectWithError(origin, EBAY_ERROR_CODES.NOT_CONFIGURED);
  }

  // --- Token exchange -------------------------------------------------------
  let connectionId: string;
  try {
    const user = await getCurrentUser();
    const tokens = await exchangeCodeForTokens(credentials, code);
    const encrypted = encryptTokenSet(tokens);
    const now = new Date();

    const payload = {
      environment,
      marketplaceId,
      status: CONNECTION_STATUS.CONNECTED,
      isActive: true,
      accessToken: encrypted.accessToken,
      refreshToken: encrypted.refreshToken ?? null,
      tokenType: encrypted.tokenType,
      tokenExpiresAt: encrypted.tokenExpiresAt,
      refreshExpiresAt: encrypted.refreshExpiresAt ?? null,
      scopes: getEbayScopes().join(" "),
      connectedAt: now,
      lastCheckedAt: now,
      lastRefreshedAt: now,
      lastError: null,
      lastErrorCode: null,
      lastErrorAt: null,
      rateLimitedUntil: null,
    };

    const existing = await prisma.ebayConnection.findFirst({
      where: { userId: user.id, isActive: true },
    });

    const connection = existing
      ? await prisma.ebayConnection.update({
          where: { id: existing.id },
          data: payload,
        })
      : await prisma.ebayConnection.create({
          data: { ...payload, userId: user.id },
        });

    connectionId = connection.id;

    // Best-effort: needs commerce.identity.readonly, never fatal.
    if (identityScopeRequested()) {
      const identity = await fetchIdentity(connection).catch(() => null);
      if (identity) {
        await prisma.ebayConnection.update({
          where: { id: connection.id },
          data: {
            ebayUserId: identity.userId ?? connection.ebayUserId,
            ebayUsername: identity.username ?? connection.ebayUsername,
            marketplaceId:
              identity.registrationMarketplaceId ?? connection.marketplaceId,
          },
        });
      }
    }
  } catch (error) {
    if (error instanceof EbayApiError) {
      const hint =
        error.detail?.includes("invalid_scope") && identityScopeRequested()
          ? `${error.detail} — set EBAY_REQUEST_IDENTITY_SCOPE=false if this keyset does not have the identity scope enabled.`
          : error.detail;
      return redirectWithError(
        origin,
        error.code,
        redactSecretsInText(hint ?? error.message),
      );
    }
    logError("ebay/callback", error);
    return redirectWithError(
      origin,
      EBAY_ERROR_CODES.OAUTH_FAILED,
      safeMessage(error, "The authorization could not be completed."),
    );
  }

  const target = new URL("/settings", origin);
  target.searchParams.set("ebay", "connected");
  target.hash = "ebay";
  const response = NextResponse.redirect(target);
  response.cookies.delete(OAUTH_STATE_COOKIE);
  void connectionId;
  return response;
}
