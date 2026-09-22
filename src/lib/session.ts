import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import type { User } from "@prisma/client";

import { prisma } from "./db";
import { describeFlag, envFlag, readFlag } from "./env";

export const SESSION_COOKIE = "ebs_session";

/**
 * There is no sign-in screen yet: no route anywhere issues a Session row, so
 * `getSessionUser` always returns null and every request would otherwise
 * resolve to the workspace owner.
 *
 * In development that is a convenience. In production it means *no
 * authentication at all* — anyone who can reach the server controls the
 * seller's eBay and Google connections. So the fallback is opt-in there:
 * an operator running this on a trusted host for one seller sets
 * SINGLE_USER_MODE=true and takes that decision knowingly; a deployment that
 * forgets gets a locked door rather than an open one.
 *
 * Everything downstream already reads `user.id` from here, so adding real
 * sign-in later means adding the routes that issue a Session row — no page or
 * query changes.
 */
export class AuthRequiredError extends Error {
  readonly code = "AUTH_REQUIRED";
  constructor(message: string) {
    super(message);
    this.name = "AuthRequiredError";
  }
}

export const SINGLE_USER_MODE_VAR = "SINGLE_USER_MODE";

function anonymousFallbackAllowed(): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  return envFlag(SINGLE_USER_MODE_VAR);
}

const DEFAULT_USER_EMAIL =
  process.env.DEFAULT_USER_EMAIL ?? "owner@example.com";

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Resolves the signed-in user, or null when there is no valid session. */
export async function getSessionUser(): Promise<User | null> {
  let token: string | undefined;
  try {
    const cookieStore = await cookies();
    token = cookieStore.get(SESSION_COOKIE)?.value;
  } catch {
    // No request scope — the background worker, a script, a test. That is not
    // an error, it just means there is no session to read. Letting this throw
    // would make the authentication decision below depend on *where* the call
    // came from rather than on whether the caller is authenticated.
    return null;
  }
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    include: { user: true },
  });

  if (!session || session.expiresAt.getTime() < Date.now()) return null;
  return session.user;
}

/**
 * The user every page and API route is scoped to. Throws only if there is
 * genuinely no workspace to fall back to, which cannot happen after seeding.
 */
export async function getCurrentUser(): Promise<User> {
  const sessionUser = await getSessionUser();
  if (sessionUser) return sessionUser;

  if (!anonymousFallbackAllowed()) {
    // Say what this process actually sees. The previous message told the
    // operator to set a variable they had very often already set, which left
    // no way to tell "it never reached the runtime" apart from "it arrived
    // with quotes around it".
    throw new AuthRequiredError(
      "This deployment has no sign-in configured, and single-user mode is not active. " +
        describeFlag(SINGLE_USER_MODE_VAR, readFlag(SINGLE_USER_MODE_VAR)),
    );
  }

  const existing = await prisma.user.findFirst({
    orderBy: { createdAt: "asc" },
  });
  if (existing) return existing;

  // First boot: create the empty workspace this deployment belongs to, so
  // the app renders instead of erroring. It holds no data until an eBay
  // account is connected and a sync is run.
  return prisma.user.create({
    data: {
      email: DEFAULT_USER_EMAIL,
      name: "Workspace Owner",
      automationSettings: { create: {} },
    },
  });
}
