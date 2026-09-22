/**
 * Shared between the OAuth start and callback routes.
 *
 * It lives here rather than in either route because a Next.js route module
 * may only export request handlers and route config.
 */

export const OAUTH_STATE_COOKIE = "ebay_oauth_state";

/** The consent round trip should complete well inside this. */
export const OAUTH_STATE_TTL_SECONDS = 600;

export interface OAuthStatePayload {
  state: string;
  marketplaceId: string;
  environment: "SANDBOX" | "PRODUCTION";
}
