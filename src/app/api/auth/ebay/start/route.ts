import { NextResponse } from "next/server";

import {
  OAUTH_PROVIDERS,
  OAUTH_STATE_TTL_MINUTES,
  issueOAuthState,
} from "@/lib/oauth-store";
import {
  EBAY_MARKETPLACE_OPTIONS,
  getEbayCredentials,
  missingEbayCredentials,
  resolveEnvironment,
} from "@/lib/ebay/config";
import { buildAuthorizationUrl } from "@/lib/ebay/oauth";
import { OAUTH_STATE_COOKIE, oauthOutcomeUrl } from "@/lib/ebay/oauth-state";
import { logError, safeMessage } from "@/lib/log";
import { getCurrentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

const VALID_MARKETPLACES = new Set(
  EBAY_MARKETPLACE_OPTIONS.map((option) => option.id as string),
);

/**
 * Starts the eBay authorization-code flow.
 *
 * The CSRF `state` is generated here, kept in an httpOnly cookie, and
 * compared on the callback. The cookie also carries the chosen marketplace
 * and environment so the callback does not have to trust query parameters.
 *
 * This is a GET because it is a top-level browser navigation — the seller
 * has to land on eBay's own consent page.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const environment = resolveEnvironment(url.searchParams.get("environment"));
  const requestedMarketplace = url.searchParams.get("marketplaceId");
  const marketplaceId =
    requestedMarketplace && VALID_MARKETPLACES.has(requestedMarketplace)
      ? requestedMarketplace
      : "EBAY_US";
  // Set by the connect button when it opened consent in its own window.
  const popup = url.searchParams.get("popup") === "1";

  // A browser navigation, so a failure comes back as a redirect the seller
  // can read rather than an unhandled throw and a blank 500 page.
  try {
    const credentials = getEbayCredentials(environment);
    if (!credentials) {
      return NextResponse.redirect(
        oauthOutcomeUrl(url.origin, popup, {
          ebay_error: "NOT_CONFIGURED",
          detail: missingEbayCredentials().join(", "),
        }),
      );
    }

    // The consent belongs to whoever is signed in right now. Recording that
    // against the state is what stops a callback attaching one seller's eBay
    // account to a different workspace.
    const user = await getCurrentUser();
    const { state } = await issueOAuthState({
      provider: OAUTH_PROVIDERS.EBAY,
      userId: user.id,
      returnTo: "/settings",
      payload: { marketplaceId, environment, popup },
    });

    // The marketplace decides which eBay site hosts the consent page.
    const authorizationUrl = buildAuthorizationUrl(
      credentials,
      state,
      marketplaceId,
    );

    const response = NextResponse.redirect(authorizationUrl);
    // A second factor only. The state row above is the record; this cookie
    // lets the callback reject a state that disagrees with what this browser
    // started, and its absence is not itself a failure — see oauth-store.ts.
    response.cookies.set({
      name: OAUTH_STATE_COOKIE,
      value: state,
      httpOnly: true,
      sameSite: "lax",
      secure: url.protocol === "https:",
      path: "/",
      maxAge: OAUTH_STATE_TTL_MINUTES * 60,
    });
    return response;
  } catch (error) {
    logError("ebay/start", error);
    const detail = safeMessage(error, "Could not start the authorization.");
    return NextResponse.redirect(
      oauthOutcomeUrl(url.origin, popup, {
        ebay_error: "OAUTH_FAILED",
        detail: detail.slice(0, 300),
      }),
    );
  }
}
