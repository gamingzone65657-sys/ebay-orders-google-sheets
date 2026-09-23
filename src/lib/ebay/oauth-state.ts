/**
 * Shared between the OAuth start and callback routes.
 *
 * It lives here rather than in either route because a Next.js route module
 * may only export request handlers and route config.
 */

export const OAUTH_STATE_COOKIE = "ebay_oauth_state";

/**
 * What the start route records alongside the state, in OAuthState.payload.
 *
 * It travels with the state row rather than the query string because the
 * callback needs it before it decides anything, and eBay returns only the
 * parameters it was given — a query parameter added to the start URL never
 * survives the round trip.
 */
export interface OAuthStatePayload {
  marketplaceId: string;
  environment: "SANDBOX" | "PRODUCTION";
  /** True when consent was opened in a separate window. */
  popup?: boolean;
}

/** Where the callback lands a popup so it can report back and close itself. */
export const OAUTH_POPUP_DONE_PATH = "/oauth/ebay/done";

/**
 * Identifies the message the popup posts to the page that opened it, so the
 * listener ignores the unrelated postMessage traffic every page receives.
 */
export const OAUTH_POPUP_MESSAGE = "ebay-oauth-complete";

/**
 * Where a finished or failed consent sends the browser.
 *
 * In a popup that is the small reporting page, which tells the opener what
 * happened and closes itself. In the same tab it stays the settings page, as
 * before. The distinction matters: sending a popup to /settings would render
 * the entire application inside a 600px window and leave the tab the seller
 * actually came from showing stale state.
 */
export function oauthOutcomeUrl(
  origin: string,
  popup: boolean,
  params: Record<string, string>,
): URL {
  const target = new URL(popup ? OAUTH_POPUP_DONE_PATH : "/settings", origin);
  for (const [key, value] of Object.entries(params)) {
    target.searchParams.set(key, value);
  }
  if (!popup) target.hash = "ebay";
  return target;
}
