/**
 * Passwords and server-side sessions.
 *
 * Deliberately built on node:crypto rather than a dependency: scrypt is in
 * the standard library, is memory-hard, and adding bcrypt would mean a native
 * build step on a platform that does not need one.
 *
 * Nothing here trusts anything the browser sends except an opaque token. The
 * token is random, never derived from the user, and only its SHA-256 reaches
 * the database — a dump of the Session table cannot be replayed as a login,
 * exactly as with OAuthState.
 */

import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import type { Session, User } from "@prisma/client";

import { prisma } from "./db";

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

/* -------------------------------------------------------------------------- */
/* Passwords                                                                   */
/* -------------------------------------------------------------------------- */

const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

/**
 * The shortest password this application will store.
 *
 * Twelve rather than eight: this single credential controls a seller's eBay
 * and Google accounts, and there is no second factor behind it.
 */
export const MIN_PASSWORD_LENGTH = 12;

/** `scrypt:<salt-hex>:<derived-hex>`, versioned by its own prefix. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN);
  return `scrypt:${salt.toString("hex")}:${derived.toString("hex")}`;
}

/**
 * Constant-time password check.
 *
 * Returns false for a malformed or absent hash rather than throwing, so an
 * account that has never had a password set simply cannot be signed in to —
 * which is the correct outcome, not an error.
 */
export async function verifyPassword(
  password: string,
  stored: string | null,
): Promise<boolean> {
  if (!stored) return false;
  const [scheme, saltHex, digestHex] = stored.split(":");
  if (scheme !== "scrypt" || !saltHex || !digestHex) return false;

  let expected: Buffer;
  try {
    expected = Buffer.from(digestHex, "hex");
  } catch {
    return false;
  }
  if (expected.length !== SCRYPT_KEYLEN) return false;

  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), SCRYPT_KEYLEN);
  return timingSafeEqual(actual, expected);
}

/** Why a password was refused, phrased for the person typing it. */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters. This password protects the eBay and Google accounts connected to this workspace.`;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Sessions                                                                    */
/* -------------------------------------------------------------------------- */

export const SESSION_COOKIE = "ebs_session";

/**
 * How long a session lasts without being used.
 *
 * Sliding rather than absolute: lastActiveAt and expiresAt are pushed forward
 * on each authenticated request, so an active seller is not signed out
 * mid-sync, while an abandoned browser stops working after a week.
 */
export const SESSION_TTL_DAYS = 7;

/** Only refresh the expiry when it has meaningfully moved, to avoid a write per request. */
const SESSION_REFRESH_AFTER_MS = 60 * 60 * 1000;

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function sessionExpiry(): Date {
  return new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export interface IssuedSession {
  token: string;
  expiresAt: Date;
}

/**
 * Starts a session for one user in one browser.
 *
 * Each call mints an independent token, so two browsers signed in to the same
 * account get two rows and revoking one leaves the other alone.
 */
export async function createSession(
  userId: string,
  context: { userAgent?: string | null; ipAddress?: string | null } = {},
): Promise<IssuedSession> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = sessionExpiry();

  await prisma.session.create({
    data: {
      userId,
      tokenHash: hashSessionToken(token),
      userAgent: context.userAgent?.slice(0, 255) ?? null,
      ipAddress: context.ipAddress?.slice(0, 64) ?? null,
      expiresAt,
    },
  });

  await prisma.user.update({
    where: { id: userId },
    data: { lastLoginAt: new Date() },
  });

  // Opportunistic sweep; a stale row is inert but the table should not grow
  // without bound on a long-lived deployment.
  await prisma.session
    .deleteMany({ where: { expiresAt: { lt: new Date() } } })
    .catch(() => undefined);

  return { token, expiresAt };
}

export type ResolvedSession = Session & { user: User };

/**
 * Looks up a session token, returning null for anything not currently valid.
 *
 * An expired row is deleted on sight rather than left to the sweep: it is the
 * cheapest moment to notice, and it keeps a revoked-by-expiry session from
 * lingering in the table where it reads as active.
 */
export async function resolveSession(
  token: string,
): Promise<ResolvedSession | null> {
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    include: { user: true },
  });
  if (!session) return null;

  if (session.expiresAt.getTime() <= Date.now()) {
    await prisma.session
      .delete({ where: { id: session.id } })
      .catch(() => undefined);
    return null;
  }

  const sinceSeen = Date.now() - session.lastActiveAt.getTime();
  if (sinceSeen > SESSION_REFRESH_AFTER_MS) {
    await prisma.session
      .update({
        where: { id: session.id },
        data: { lastActiveAt: new Date(), expiresAt: sessionExpiry() },
      })
      .catch(() => undefined);
  }

  return session;
}

/** Ends one session — the one this browser holds. */
export async function destroySession(token: string): Promise<void> {
  await prisma.session
    .deleteMany({ where: { tokenHash: hashSessionToken(token) } })
    .catch(() => undefined);
}

/** Ends every session a user holds, for a password change or a forced logout. */
export async function destroyAllSessions(userId: string): Promise<number> {
  const { count } = await prisma.session.deleteMany({ where: { userId } });
  return count;
}

/* -------------------------------------------------------------------------- */
/* Cookie                                                                      */
/* -------------------------------------------------------------------------- */

export interface SessionCookieOptions {
  name: string;
  value: string;
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: string;
  expires?: Date;
  maxAge?: number;
}

/**
 * The cookie the session token travels in.
 *
 * SameSite=Lax, not Strict: eBay and Google return the seller to this
 * application by a top-level cross-site redirect, and Strict would withhold
 * the cookie on exactly that request — the OAuth callback would then look
 * unauthenticated and refuse to attach the connection to anyone. Lax sends it
 * on top-level GET navigations, which is what a callback is, and withholds it
 * from the cross-site POST that CSRF needs.
 */
export function sessionCookie(
  token: string,
  expiresAt: Date,
  secure: boolean,
): SessionCookieOptions {
  return {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    expires: expiresAt,
  };
}

/** The same cookie, emptied, to clear it on sign-out. */
export function clearedSessionCookie(secure: boolean): SessionCookieOptions {
  return {
    name: SESSION_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 0,
  };
}
