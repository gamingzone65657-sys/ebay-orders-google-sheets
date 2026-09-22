/**
 * eBay OAuth 2.0 authorization-code flow.
 *
 * Server-only. The client id, client secret, authorization code, and both
 * tokens exist only inside these functions and the encrypted database
 * columns — none of them is ever serialised into a page or an API response.
 */

import {
  basicAuthHeader,
  getEbayScopes,
  type EbayCredentials,
} from "./config";
import { EBAY_ERROR_CODES, EbayApiError } from "./errors";

export interface EbayTokenSet {
  accessToken: string;
  /** Absent on a refresh response — eBay only issues it at consent time. */
  refreshToken?: string;
  tokenType: string;
  expiresAt: Date;
  refreshExpiresAt?: Date;
}

interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
}

/** Builds the URL the seller is redirected to in order to grant consent. */
export function buildAuthorizationUrl(
  credentials: EbayCredentials,
  state: string,
): string {
  const url = new URL(credentials.endpoints.authorize);
  url.searchParams.set("client_id", credentials.clientId);
  url.searchParams.set("response_type", "code");
  // For eBay this is the RuName, not a literal URL. See config.ts.
  url.searchParams.set("redirect_uri", credentials.redirectUri);
  url.searchParams.set("scope", getEbayScopes().join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "login");
  return url.toString();
}

async function postToken(
  credentials: EbayCredentials,
  body: URLSearchParams,
  context: "exchange" | "refresh",
): Promise<EbayTokenSet> {
  let response: Response;
  try {
    response = await fetch(credentials.endpoints.token, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: basicAuthHeader(credentials),
        Accept: "application/json",
      },
      body: body.toString(),
      cache: "no-store",
    });
  } catch (cause) {
    throw new EbayApiError(
      EBAY_ERROR_CODES.NETWORK_ERROR,
      "Could not reach the eBay token endpoint.",
      { cause, detail: context },
    );
  }

  let payload: RawTokenResponse;
  try {
    payload = (await response.json()) as RawTokenResponse;
  } catch (cause) {
    throw new EbayApiError(
      EBAY_ERROR_CODES.INVALID_RESPONSE,
      "The eBay token endpoint returned a non-JSON response.",
      { cause, status: response.status, detail: context },
    );
  }

  if (!response.ok || payload.error) {
    // invalid_grant means the code or refresh token is spent, revoked, or
    // expired. Either way the seller must go through consent again.
    const expired =
      payload.error === "invalid_grant" ||
      payload.error === "invalid_token" ||
      response.status === 401;

    throw new EbayApiError(
      expired
        ? context === "refresh"
          ? EBAY_ERROR_CODES.AUTH_EXPIRED
          : EBAY_ERROR_CODES.OAUTH_FAILED
        : response.status === 429
          ? EBAY_ERROR_CODES.RATE_LIMITED
          : response.status >= 500
            ? EBAY_ERROR_CODES.SERVER_ERROR
            : EBAY_ERROR_CODES.OAUTH_FAILED,
      payload.error_description ??
        payload.error ??
        `eBay token ${context} failed with status ${response.status}.`,
      {
        status: response.status,
        // error_description can be long but never contains a secret.
        detail: payload.error ? `${payload.error}: ${payload.error_description ?? ""}` : undefined,
      },
    );
  }

  if (!payload.access_token || !payload.expires_in) {
    throw new EbayApiError(
      EBAY_ERROR_CODES.INVALID_RESPONSE,
      "The eBay token response was missing an access token.",
      { status: response.status, detail: context },
    );
  }

  const now = Date.now();
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    tokenType: payload.token_type ?? "User Access Token",
    expiresAt: new Date(now + payload.expires_in * 1000),
    refreshExpiresAt: payload.refresh_token_expires_in
      ? new Date(now + payload.refresh_token_expires_in * 1000)
      : undefined,
  };
}

/** Exchanges the one-time authorization code for an access + refresh token. */
export function exchangeCodeForTokens(
  credentials: EbayCredentials,
  code: string,
): Promise<EbayTokenSet> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: credentials.redirectUri,
  });
  return postToken(credentials, body, "exchange");
}

/**
 * Trades the refresh token for a fresh access token.
 *
 * eBay requires the scope list on refresh and does not return a new refresh
 * token; the original stays valid until `refresh_token_expires_in` elapses
 * (18 months) or the seller revokes it.
 */
export function refreshAccessToken(
  credentials: EbayCredentials,
  refreshToken: string,
): Promise<EbayTokenSet> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: getEbayScopes().join(" "),
  });
  return postToken(credentials, body, "refresh");
}
