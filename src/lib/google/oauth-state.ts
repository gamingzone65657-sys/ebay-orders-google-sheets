/**
 * Shared between the Google OAuth start and callback routes.
 *
 * It lives here rather than in either route because a Next.js route module
 * may only export request handlers and route config.
 */

export const GOOGLE_OAUTH_STATE_COOKIE = "google_oauth_state";

export const GOOGLE_OAUTH_STATE_TTL_SECONDS = 600;

export interface GoogleOAuthStatePayload {
  state: string;
  /** Where to send the user after a successful connection. */
  returnTo: string;
}
