/**
 * Where an in-flight OAuth authorization is remembered.
 *
 * The start route and the callback are two separate requests, minutes apart,
 * and on a serverless host they are two separate invocations that may not even
 * run on the same instance. Anything held in module scope is therefore gone by
 * the time the provider redirects back, and a cookie is only *usually* there:
 * it is scoped to the hostname the start request happened to arrive on, so a
 * deployment reachable by more than one hostname — which every Vercel project
 * is — can set it on one and be redirected back to another.
 *
 * That is not a hypothetical. It is why a correctly configured Google
 * connection reported "the authorization session expired before Google
 * redirected back" on every attempt: the cookie was never expired, it was
 * never there, and the code could not tell those apart.
 *
 * So the state lives in the database, keyed to the user who started it. Only
 * the SHA-256 of it is stored, exactly as Session.tokenHash does: the value
 * that travels in the URL is the secret, and a database row on its own cannot
 * be replayed as one.
 */

import { createHash } from "node:crypto";

import { prisma } from "@/lib/db";
import { randomToken } from "@/lib/crypto";

export const OAUTH_PROVIDERS = {
  GOOGLE: "GOOGLE",
  EBAY: "EBAY",
} as const;

export type OAuthProvider =
  (typeof OAUTH_PROVIDERS)[keyof typeof OAUTH_PROVIDERS];

/**
 * How long a seller has to finish a consent screen.
 *
 * Twelve minutes: long enough to pick an account, read an unverified-app
 * warning and tick the boxes, short enough that an abandoned attempt is not
 * redeemable an hour later.
 */
export const OAUTH_STATE_TTL_MINUTES = 12;

export interface IssuedState {
  /** The opaque value to send to the provider as `state`. */
  state: string;
  expiresAt: Date;
}

function hash(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

/**
 * Creates a state for one authorization attempt.
 *
 * Expired rows are swept here rather than on a schedule: a start request is
 * the only moment this table is guaranteed to be touched, the delete is a
 * single indexed statement, and a stale row is harmless until it is cleaned
 * up anyway.
 */
export async function issueOAuthState(input: {
  provider: OAuthProvider;
  userId: string;
  returnTo: string;
  payload?: Record<string, unknown>;
}): Promise<IssuedState> {
  const state = randomToken(32);
  const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MINUTES * 60_000);

  await prisma.oAuthState.create({
    data: {
      provider: input.provider,
      stateHash: hash(state),
      userId: input.userId,
      returnTo: input.returnTo,
      payload: input.payload ? JSON.stringify(input.payload) : null,
      expiresAt,
    },
  });

  await prisma.oAuthState
    .deleteMany({ where: { expiresAt: { lt: new Date() } } })
    .catch(() => undefined);

  return { state, expiresAt };
}

/** Why a state was refused, so the user can be told something actionable. */
export type StateRejection = "UNKNOWN" | "EXPIRED" | "ALREADY_USED";

export type ConsumeResult =
  | {
      ok: true;
      userId: string;
      returnTo: string;
      payload: Record<string, unknown> | null;
    }
  | { ok: false; reason: StateRejection };

/**
 * Redeems a state exactly once.
 *
 * The three refusals are kept apart deliberately. "Never issued", "took too
 * long" and "already used" need three different things from the user, and
 * collapsing them into one message is what made the original failure
 * impossible to diagnose from the screen.
 */
export async function consumeOAuthState(
  provider: OAuthProvider,
  state: string,
): Promise<ConsumeResult> {
  const record = await prisma.oAuthState.findUnique({
    where: { stateHash: hash(state) },
  });

  if (!record || record.provider !== provider) {
    return { ok: false, reason: "UNKNOWN" };
  }
  if (record.consumedAt) {
    return { ok: false, reason: "ALREADY_USED" };
  }
  if (record.expiresAt.getTime() <= Date.now()) {
    await prisma.oAuthState
      .delete({ where: { id: record.id } })
      .catch(() => undefined);
    return { ok: false, reason: "EXPIRED" };
  }

  // Marked consumed rather than deleted, and guarded on consumedAt still
  // being null, so two callbacks racing the same state cannot both win and
  // spend the authorization code twice.
  const claimed = await prisma.oAuthState.updateMany({
    where: { id: record.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (claimed.count !== 1) {
    return { ok: false, reason: "ALREADY_USED" };
  }

  let payload: Record<string, unknown> | null = null;
  if (record.payload) {
    try {
      payload = JSON.parse(record.payload) as Record<string, unknown>;
    } catch {
      payload = null;
    }
  }

  return {
    ok: true,
    userId: record.userId,
    returnTo: record.returnTo,
    payload,
  };
}

/** Removes the row once the connection is stored, successfully or not. */
export async function discardOAuthState(state: string): Promise<void> {
  await prisma.oAuthState
    .deleteMany({ where: { stateHash: hash(state) } })
    .catch(() => undefined);
}

/** What to show the user for each refusal. */
export function describeStateRejection(reason: StateRejection): string {
  switch (reason) {
    case "EXPIRED":
      return `The authorization took longer than ${OAUTH_STATE_TTL_MINUTES} minutes to complete, so it was discarded. Nothing was changed — start the connection again.`;
    case "ALREADY_USED":
      return "This authorization has already been used. If you refreshed the page after connecting, the connection is probably already saved — reload this page to check.";
    case "UNKNOWN":
    default:
      return "This authorization was not one this application started, so it was rejected. Start the connection again from this page.";
  }
}
