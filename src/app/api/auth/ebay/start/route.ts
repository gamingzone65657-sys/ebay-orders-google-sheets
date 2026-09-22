import { NextResponse } from "next/server";

import { randomToken } from "@/lib/crypto";
import {
  EBAY_MARKETPLACE_OPTIONS,
  getEbayCredentials,
  missingEbayCredentials,
  resolveEnvironment,
} from "@/lib/ebay/config";
import { buildAuthorizationUrl } from "@/lib/ebay/oauth";
import {
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_TTL_SECONDS,
} from "@/lib/ebay/oauth-state";
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

  // A browser navigation, so a failure comes back as a redirect the seller
  // can read rather than an unhandled throw and a blank 500 page.
  try {
    const credentials = getEbayCredentials(environment);
    if (!credentials) {
      const missing = missingEbayCredentials().join(", ");
      return NextResponse.redirect(
        new URL(
          `/settings?ebay_error=NOT_CONFIGURED&detail=${encodeURIComponent(missing)}#ebay`,
          url.origin,
        ),
      );
    }

    // Ensures a workspace exists before we send the seller to eBay.
    await getCurrentUser();

    const state = randomToken(32);
    const authorizationUrl = buildAuthorizationUrl(credentials, state);

    const response = NextResponse.redirect(authorizationUrl);
    response.cookies.set({
      name: OAUTH_STATE_COOKIE,
      value: JSON.stringify({ state, marketplaceId, environment }),
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: OAUTH_STATE_TTL_SECONDS,
    });
    return response;
  } catch (error) {
    logError("ebay/start", error);
    const detail = safeMessage(error, "Could not start the authorization.");
    return NextResponse.redirect(
      new URL(
        `/settings?ebay_error=OAUTH_FAILED&detail=${encodeURIComponent(
          detail.slice(0, 300),
        )}#ebay`,
        url.origin,
      ),
    );
  }
}
