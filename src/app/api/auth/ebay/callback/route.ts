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
import { OAUTH_STATE_COOKIE, oauthOutcomeUrl } from "@/lib/ebay/oauth-state";
import {
  OAUTH_PROVIDERS,
  consumeOAuthState,
  describeStateRejection,
  discardOAuthState,
} from "@/lib/oauth-store";
import { encryptTokenSet } from "@/lib/ebay/tokens";
import { logError, safeMessage } from "@/lib/log";
import { redactSecretsInText } from "@/lib/mask";

export const dynamic = "force-dynamic";

interface StatePayload {
  marketplaceId?: string;
  environment?: string;
  popup?: boolean;
}

/**
 * Reads the popup flag before the cookie has been validated.
 *
 * It only decides *which page* reports the outcome, never whether the
 * connection is accepted, so trusting it early is safe — and it has to be
 * read early, because the errors raised before the CSRF check still need
 * somewhere to land.
 */
function redirectWithError(
  origin: string,
  code: string,
  detail?: string,
  popup = false,
): NextResponse {
  const params: Record<string, string> = { ebay_error: code };
  if (detail) params.detail = detail.slice(0, 300);
  const response = NextResponse.redirect(oauthOutcomeUrl(origin, popup, params));
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
/** The raw state cookie, or undefined when the browser did not send one. */
function readStateCookie(request: Request): string | undefined {
  return request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${OAUTH_STATE_COOKIE}=`))
    ?.slice(OAUTH_STATE_COOKIE.length + 1);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const origin = url.origin;

  const cookieState = readStateCookie(request);

  // Whether this is reporting into a popup is known only from the state row,
  // which cannot be read until the state has been returned. Until then,
  // assume the seller's own tab — the worst case is a full page instead of a
  // small one, never a wrong workspace.
  let popup = false;

  // eBay reports a declined or failed consent as query parameters.
  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    const description =
      url.searchParams.get("error_description") ?? undefined;
    return redirectWithError(
      origin,
      EBAY_ERROR_CODES.OAUTH_FAILED,
      description ?? oauthError,
      popup,
    );
  }

  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  if (!code || !returnedState) {
    return redirectWithError(
      origin,
      EBAY_ERROR_CODES.OAUTH_FAILED,
      "eBay did not return an authorization code.",
      popup,
    );
  }

  // --- CSRF and workspace ---------------------------------------------------
  // The cookie is a second factor: when the browser sends one it must agree
  // with what eBay returned. The state row is the record, and it carries the
  // userId of whoever started the flow — which is how this connection gets
  // attached to the right workspace rather than to whoever happens to be
  // resolvable from the request.
  if (cookieState && !safeEqual(decodeURIComponent(cookieState), returnedState)) {
    return redirectWithError(
      origin,
      EBAY_ERROR_CODES.OAUTH_FAILED,
      "The authorization state did not match. The request was rejected.",
      popup,
    );
  }

  const claim = await consumeOAuthState(OAUTH_PROVIDERS.EBAY, returnedState);
  if (!claim.ok) {
    return redirectWithError(
      origin,
      EBAY_ERROR_CODES.OAUTH_FAILED,
      describeStateRejection(claim.reason),
      popup,
    );
  }

  const statePayload = (claim.payload ?? {}) as StatePayload;
  popup = statePayload.popup === true;
  const environment = statePayload.environment === "PRODUCTION" ? "PRODUCTION" : "SANDBOX";
  const marketplaceId = statePayload.marketplaceId ?? "EBAY_US";

  const credentials = getEbayCredentials(environment);
  if (!credentials) {
    await discardOAuthState(returnedState);
    return redirectWithError(
      origin,
      EBAY_ERROR_CODES.NOT_CONFIGURED,
      undefined,
      popup,
    );
  }

  // --- Token exchange -------------------------------------------------------
  let connectionId: string;
  try {
    // The workspace that started the flow, not whoever the current request
    // happens to resolve to.
    const user = { id: claim.userId };
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
    // Spent either way: the authorization code has been offered to eBay.
    await discardOAuthState(returnedState);
    if (error instanceof EbayApiError) {
      const hint =
        error.detail?.includes("invalid_scope") && identityScopeRequested()
          ? `${error.detail} — set EBAY_REQUEST_IDENTITY_SCOPE=false if this keyset does not have the identity scope enabled.`
          : error.detail;
      return redirectWithError(
        origin,
        error.code,
        redactSecretsInText(hint ?? error.message),
        popup,
      );
    }
    logError("ebay/callback", error);
    return redirectWithError(
      origin,
      EBAY_ERROR_CODES.OAUTH_FAILED,
      safeMessage(error, "The authorization could not be completed."),
      popup,
    );
  }

  await discardOAuthState(returnedState);

  const response = NextResponse.redirect(
    oauthOutcomeUrl(origin, popup, { ebay: "connected" }),
  );
  response.cookies.delete(OAUTH_STATE_COOKIE);
  void connectionId;
  return response;
}
