/**
 * Who is asking.
 *
 * Every page and every API route resolves its data through getCurrentUser(),
 * so this file is the whole of the application's authentication decision. It
 * has exactly one job: turn a request into the user it belongs to, or refuse.
 *
 * ## What used to be here, and why it was wrong
 *
 * There was no sign-in screen, so getCurrentUser() fell back to "the oldest
 * user in the database" whenever no session cookie was present. In
 * development that is a convenience. In production, with SINGLE_USER_MODE
 * turned on to make the app reachable at all, it meant every visitor — any
 * browser, anywhere, with no credential of any kind — resolved to the same
 * workspace and saw the seller's connected eBay account. Two browsers on two
 * machines shared one identity, because there was only ever one identity.
 *
 * That fallback is now impossible in production. Not discouraged, not
 * gated behind a flag: `anonymousFallbackAllowed()` returns false whenever
 * NODE_ENV is "production", before it looks at any environment variable, so
 * no configuration can switch it back on. SINGLE_USER_MODE survives only as a
 * local development convenience and is inert in a production build.
 */

import { cookies } from "next/headers";
import type { User } from "@prisma/client";

import { prisma } from "./db";
import { SESSION_COOKIE, resolveSession } from "./auth";

export { SESSION_COOKIE, hashSessionToken } from "./auth";

export class AuthRequiredError extends Error {
  readonly code = "AUTH_REQUIRED";
  constructor(message = "Sign in to continue.") {
    super(message);
    this.name = "AuthRequiredError";
  }
}

export const SINGLE_USER_MODE_VAR = "SINGLE_USER_MODE";

/**
 * Whether a request with no session may be treated as the workspace owner.
 *
 * Production is checked first and answers false unconditionally. This is the
 * security property the rest of the file rests on, and it is deliberately not
 * expressed as "unless some variable says otherwise" — an operator cannot
 * re-enable shared-identity access by pasting a value into a dashboard,
 * because no value is read on this path.
 */
export function anonymousFallbackAllowed(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.NODE_ENV === "production") return false;
  // Local development only. Absent means "on", because a developer running
  // `npm run dev` has not signed up for anything yet.
  const raw = env[SINGLE_USER_MODE_VAR]?.trim().replace(/^(['"])(.*)\1$/s, "$2");
  return raw === undefined || raw === "" || raw.toLowerCase() !== "false";
}

/** The token this request presented, if any. */
async function sessionToken(): Promise<string | undefined> {
  try {
    const cookieStore = await cookies();
    return cookieStore.get(SESSION_COOKIE)?.value;
  } catch {
    // No request scope — the background worker, a script, a test. That is not
    // an error; it means there is no session to read.
    return undefined;
  }
}

/** Resolves the signed-in user, or null when there is no valid session. */
export async function getSessionUser(): Promise<User | null> {
  const token = await sessionToken();
  if (!token) return null;
  const session = await resolveSession(token);
  return session?.user ?? null;
}

/**
 * The user every page and API route is scoped to.
 *
 * @throws AuthRequiredError when the request carries no valid session. Route
 * handlers turn that into a 401 (see lib/api.ts) and the middleware turns a
 * page request into a redirect to /login, so nothing downstream has to decide
 * what an unauthenticated request means.
 */
export async function getCurrentUser(): Promise<User> {
  const sessionUser = await getSessionUser();
  if (sessionUser) return sessionUser;

  if (!anonymousFallbackAllowed()) {
    throw new AuthRequiredError("Sign in to continue.");
  }

  // ---- Local development only, from here down. ----------------------------
  const existing = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
  if (existing) return existing;

  return prisma.user.create({
    data: {
      email: process.env.DEFAULT_USER_EMAIL ?? "owner@example.com",
      name: "Workspace Owner",
      automationSettings: { create: {} },
    },
  });
}

/**
 * The user, or null — for the few places that render differently rather than
 * refusing, such as deciding whether to show a sign-out button.
 */
export async function getOptionalUser(): Promise<User | null> {
  try {
    return await getCurrentUser();
  } catch (error) {
    if (error instanceof AuthRequiredError) return null;
    throw error;
  }
}
