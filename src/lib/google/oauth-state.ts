/**
 * Shared between the Google OAuth start and callback routes.
 *
 * It lives here rather than in either route because a Next.js route module
 * may only export request handlers and route config.
 *
 * The state itself is no longer kept here. It is a row in OAuthState, written
 * by the start route and redeemed by the callback — see src/lib/oauth-store.ts
 * for why a cookie alone could not survive a serverless round trip. This
 * cookie carries the same opaque state value as a second factor: when the
 * browser sends it, the callback requires it to agree; when it does not, the
 * database row stands on its own.
 */

export const GOOGLE_OAUTH_STATE_COOKIE = "google_oauth_state";
