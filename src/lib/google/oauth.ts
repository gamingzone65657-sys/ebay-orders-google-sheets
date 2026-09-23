/**
 * Google OAuth 2.0 authorization-code flow.
 *
 * Server-only. The client secret, authorization code and both tokens exist
 * only inside these functions and the encrypted database columns.
 */

import {
  getGoogleScopes,
  type GoogleCredentials,
} from "./config";
import { googleTransport } from "./client";
import { GOOGLE_ERROR_CODES, GoogleApiError } from "./errors";

export interface GoogleTokenSet {
  accessToken: string;
  /** Google only returns this on the first consent, not on refresh. */
  refreshToken?: string;
  tokenType: string;
  expiresAt: Date;
  /** Scopes Google actually granted, which may be narrower than requested. */
  grantedScopes?: string;
}

interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

/**
 * Builds the consent URL.
 *
 * `access_type=offline` + `prompt=consent` are both required to reliably get
 * a refresh token: without them Google returns one only on the very first
 * authorization for an account, so a reconnect would silently leave the app
 * unable to refresh.
 */
export function buildAuthorizationUrl(
  credentials: GoogleCredentials,
  state: string,
): string {
  const url = new URL(credentials.endpoints.authorize);
  url.searchParams.set("client_id", credentials.clientId);
  url.searchParams.set("redirect_uri", credentials.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", getGoogleScopes().join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  return url.toString();
}

async function postToken(
  credentials: GoogleCredentials,
  body: URLSearchParams,
  context: "exchange" | "refresh",
): Promise<GoogleTokenSet> {
  let response: Response;
  try {
    response = await googleTransport()(credentials.endpoints.token, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
      cache: "no-store",
    });
  } catch (cause) {
    throw new GoogleApiError(
      GOOGLE_ERROR_CODES.NETWORK_ERROR,
      "Could not reach the Google token endpoint.",
      { cause, detail: context },
    );
  }

  let payload: RawTokenResponse;
  try {
    payload = (await response.json()) as RawTokenResponse;
  } catch (cause) {
    throw new GoogleApiError(
      GOOGLE_ERROR_CODES.INVALID_RESPONSE,
      "The Google token endpoint returned a non-JSON response.",
      { cause, status: response.status, detail: context },
    );
  }

  if (!response.ok || payload.error) {
    // invalid_grant means the code or refresh token is spent, revoked or
    // expired. Either way the user must consent again.
    const expired = payload.error === "invalid_grant" || response.status === 401;

    // invalid_client is a different animal entirely, and reading it as
    // "try connecting again" wastes an afternoon: the consent succeeded, and
    // no number of retries will help, because Google rejected the
    // application's own credentials. Say which variable is wrong.
    if (payload.error === "invalid_client") {
      throw new GoogleApiError(
        GOOGLE_ERROR_CODES.NOT_CONFIGURED,
        "Google rejected this application's own credentials, so consent could not be completed. " +
          "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must both come from the same OAuth client, " +
          "and the secret must be a current one — Google shows a secret in full only when it is created, " +
          "and rotating it invalidates the old value immediately. Create a new client secret in the Google " +
          "Cloud console, set it wherever this deployment reads its environment, and redeploy.",
        {
          status: response.status,
          detail: `${payload.error}: ${payload.error_description ?? ""}`.trim(),
        },
      );
    }

    throw new GoogleApiError(
      expired
        ? context === "refresh"
          ? GOOGLE_ERROR_CODES.AUTH_EXPIRED
          : GOOGLE_ERROR_CODES.OAUTH_FAILED
        : response.status === 429
          ? GOOGLE_ERROR_CODES.RATE_LIMITED
          : response.status >= 500
            ? GOOGLE_ERROR_CODES.SERVER_ERROR
            : GOOGLE_ERROR_CODES.OAUTH_FAILED,
      payload.error_description ??
        payload.error ??
        `Google token ${context} failed with status ${response.status}.`,
      {
        status: response.status,
        detail: payload.error
          ? `${payload.error}: ${payload.error_description ?? ""}`.trim()
          : undefined,
      },
    );
  }

  if (!payload.access_token || !payload.expires_in) {
    throw new GoogleApiError(
      GOOGLE_ERROR_CODES.INVALID_RESPONSE,
      "The Google token response was missing an access token.",
      { status: response.status, detail: context },
    );
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    tokenType: payload.token_type ?? "Bearer",
    expiresAt: new Date(Date.now() + payload.expires_in * 1000),
    grantedScopes: payload.scope,
  };
}

export function exchangeCodeForTokens(
  credentials: GoogleCredentials,
  code: string,
): Promise<GoogleTokenSet> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    redirect_uri: credentials.redirectUri,
  });
  return postToken(credentials, body, "exchange");
}

/**
 * Trades the refresh token for a fresh access token.
 *
 * Google does not rotate the refresh token, and does not return `scope` on
 * every refresh, so callers keep the previously stored values for both.
 */
export function refreshAccessToken(
  credentials: GoogleCredentials,
  refreshToken: string,
): Promise<GoogleTokenSet> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
  });
  return postToken(credentials, body, "refresh");
}

/**
 * Best-effort revocation at Google's end, so disconnecting actually withdraws
 * the grant rather than only forgetting it locally. Failure is not fatal —
 * the local tokens are deleted regardless.
 */
export async function revokeToken(
  credentials: GoogleCredentials,
  token: string,
): Promise<boolean> {
  try {
    const response = await fetch(credentials.endpoints.revoke, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
      cache: "no-store",
    });
    return response.ok;
  } catch {
    return false;
  }
}
