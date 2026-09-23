import { NextResponse } from "next/server";

import {
  getGoogleCredentials,
  missingGoogleCredentials,
} from "@/lib/google/config";
import { buildAuthorizationUrl } from "@/lib/google/oauth";
import { GOOGLE_OAUTH_STATE_COOKIE } from "@/lib/google/oauth-state";
import { logError, safeMessage } from "@/lib/log";
import {
  OAUTH_PROVIDERS,
  OAUTH_STATE_TTL_MINUTES,
  issueOAuthState,
} from "@/lib/oauth-store";
import { getCurrentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Only same-origin app paths may be used as a post-connect destination. */
function safeReturnTo(value: string | null): string {
  if (!value) return "/google-sheet";
  if (!value.startsWith("/") || value.startsWith("//")) return "/google-sheet";
  return value;
}

/**
 * Starts the Google authorization-code flow.
 *
 * The CSRF `state` is generated here and recorded against the current user in
 * the database, because this request and the callback are separate serverless
 * invocations — see src/lib/oauth-store.ts for why a cookie alone was not
 * enough. A matching cookie is still set as a second factor, and the callback
 * rejects one that disagrees; it just no longer *requires* one, which is what
 * made every attempt fail with "the authorization session expired".
 *
 * A GET because it is a top-level browser navigation — the user has to land
 * on Google's own consent page.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const returnTo = safeReturnTo(url.searchParams.get("returnTo"));

  // This route is a browser navigation, so a failure has to come back as a
  // redirect the user can read — never an unhandled throw, which Next would
  // answer with a blank 500 page mid-way through connecting.
  try {
    const credentials = getGoogleCredentials();
    if (!credentials) {
      const missing = missingGoogleCredentials().join(", ");
      return NextResponse.redirect(
        new URL(
          `/settings?google_error=NOT_CONFIGURED&detail=${encodeURIComponent(missing)}#google`,
          url.origin,
        ),
      );
    }

    const user = await getCurrentUser();
    const { state } = await issueOAuthState({
      provider: OAUTH_PROVIDERS.GOOGLE,
      userId: user.id,
      returnTo,
    });

    const response = NextResponse.redirect(
      buildAuthorizationUrl(credentials, state),
    );
    response.cookies.set({
      name: GOOGLE_OAUTH_STATE_COOKIE,
      value: state,
      httpOnly: true,
      sameSite: "lax",
      secure: url.protocol === "https:",
      path: "/",
      maxAge: OAUTH_STATE_TTL_MINUTES * 60,
    });
    return response;
  } catch (error) {
    logError("google/start", error);
    const detail = safeMessage(error, "Could not start the authorization.");
    return NextResponse.redirect(
      new URL(
        `/settings?google_error=OAUTH_FAILED&detail=${encodeURIComponent(
          detail.slice(0, 300),
        )}#google`,
        url.origin,
      ),
    );
  }
}
