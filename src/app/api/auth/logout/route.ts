import { handle, ok } from "@/lib/api";
import {
  SESSION_COOKIE,
  clearedSessionCookie,
  destroyAllSessions,
  destroySession,
  resolveSession,
} from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Ends the session this browser holds.
 *
 * The row is deleted server-side, not just the cookie cleared: a token that
 * was copied before sign-out has to stop working, and a cookie-only logout
 * leaves it valid. `{ everywhere: true }` ends the user's other sessions too,
 * which is what the settings page offers after a password change.
 *
 * Answers 200 with no session as well. Signing out of nothing is the state
 * the caller wanted; making it an error only produces a confusing screen.
 */
export async function POST(request: Request) {
  return handle(async () => {
    const token = request.headers
      .get("cookie")
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
      ?.slice(SESSION_COOKIE.length + 1);

    let everywhere = false;
    try {
      const body = (await request.json()) as { everywhere?: boolean } | null;
      everywhere = body?.everywhere === true;
    } catch {
      // No body is the ordinary case.
    }

    let endedElsewhere = 0;
    if (token) {
      if (everywhere) {
        const session = await resolveSession(token);
        if (session) {
          endedElsewhere = Math.max(
            0,
            (await destroyAllSessions(session.userId)) - 1,
          );
        }
      }
      await destroySession(token);
    }

    const response = ok({ signedOut: true, otherSessionsEnded: endedElsewhere });
    response.cookies.set(
      clearedSessionCookie(new URL(request.url).protocol === "https:"),
    );
    return response;
  });
}
