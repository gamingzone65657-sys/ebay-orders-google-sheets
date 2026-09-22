/**
 * eBay Marketplace Account Deletion / Closure notifications.
 *
 * ── How eBay's challenge verification works ─────────────────────────────────
 *
 * Before eBay will send you any deletion notifications, it has to prove that
 * the URL you registered is really yours and really under your control. It
 * does that with a challenge:
 *
 *   1. You register two things in the eBay developer portal:
 *        • the endpoint URL  (e.g. https://sync.example.com/api/ebay/...)
 *        • a verification token you invent (32–80 chars, [A-Za-z0-9_-])
 *
 *   2. eBay calls your endpoint:
 *        GET <your-endpoint>?challenge_code=<random-per-call-value>
 *
 *   3. You must reply, within a few seconds, with:
 *        200 OK
 *        Content-Type: application/json
 *        { "challengeResponse": "<hex sha256>" }
 *
 *      where the hash is SHA-256 over the concatenation, **in this exact
 *      order**, of three UTF-8 strings with no separators and no whitespace:
 *
 *        challengeCode + verificationToken + endpointUrl
 *
 *      and the digest is lowercase hexadecimal.
 *
 *   4. eBay computes the same hash itself. It knows all three values — it
 *      generated the challenge code, you gave it the token and the URL — so a
 *      matching answer proves that whatever is serving that URL also holds
 *      the shared token. That is the whole point: the challenge code stops a
 *      replayed answer, and the token is the secret that cannot be guessed by
 *      someone who merely discovered your URL.
 *
 * Three consequences worth knowing, because each one produces a mismatch that
 * looks identical from the outside — eBay just says validation failed:
 *
 *   • `endpointUrl` must be the URL **exactly as registered with eBay**,
 *     character for character. A trailing slash, http vs https, or a
 *     different host all change the hash. This is why it comes from its own
 *     environment variable rather than being derived from the request: what
 *     the server sees can differ from what was registered once a proxy,
 *     load balancer or tunnel is in front of it.
 *
 *   • The token is hashed, never sent. It must never be logged either.
 *
 *   • The order of concatenation is fixed. Any other order hashes cleanly and
 *     fails verification with no useful error.
 */

import { createHash } from "node:crypto";

/** eBay's stated constraints on the verification token. */
export const VERIFICATION_TOKEN_MIN_LENGTH = 32;
export const VERIFICATION_TOKEN_MAX_LENGTH = 80;
const VERIFICATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface DeletionConfig {
  verificationToken: string;
  endpointUrl: string;
}

export type ConfigProblem =
  | { code: "TOKEN_MISSING"; message: string }
  | { code: "TOKEN_INVALID"; message: string }
  | { code: "ENDPOINT_MISSING"; message: string }
  | { code: "ENDPOINT_INVALID"; message: string };

/**
 * Reads and validates the two environment variables.
 *
 * Returns the problem rather than throwing, so the route can answer with a
 * precise status and a message that says which variable is wrong — a silent
 * misconfiguration here means eBay quietly stops sending notifications.
 */
export function readDeletionConfig(
  env: Record<string, string | undefined> = process.env,
): { config: DeletionConfig; problem: null } | { config: null; problem: ConfigProblem } {
  const verificationToken =
    env.EBAY_MARKETPLACE_DELETION_VERIFICATION_TOKEN?.trim() ?? "";
  const endpointUrl = env.EBAY_MARKETPLACE_DELETION_ENDPOINT?.trim() ?? "";

  if (!verificationToken) {
    return {
      config: null,
      problem: {
        code: "TOKEN_MISSING",
        message:
          "EBAY_MARKETPLACE_DELETION_VERIFICATION_TOKEN is not set. It must match the verification token entered in the eBay developer portal.",
      },
    };
  }

  if (
    verificationToken.length < VERIFICATION_TOKEN_MIN_LENGTH ||
    verificationToken.length > VERIFICATION_TOKEN_MAX_LENGTH ||
    !VERIFICATION_TOKEN_PATTERN.test(verificationToken)
  ) {
    return {
      config: null,
      problem: {
        code: "TOKEN_INVALID",
        message: `EBAY_MARKETPLACE_DELETION_VERIFICATION_TOKEN must be ${VERIFICATION_TOKEN_MIN_LENGTH}–${VERIFICATION_TOKEN_MAX_LENGTH} characters of letters, digits, underscore or hyphen. eBay rejects anything else.`,
      },
    };
  }

  if (!endpointUrl) {
    return {
      config: null,
      problem: {
        code: "ENDPOINT_MISSING",
        message:
          "EBAY_MARKETPLACE_DELETION_ENDPOINT is not set. It must be the full public URL of this endpoint, exactly as registered with eBay.",
      },
    };
  }

  const endpointProblem = describeEndpointProblem(endpointUrl);
  if (endpointProblem) {
    return {
      config: null,
      problem: { code: "ENDPOINT_INVALID", message: endpointProblem },
    };
  }

  return { config: { verificationToken, endpointUrl }, problem: null };
}

/**
 * Why this URL cannot be the registered endpoint, or null if it is fine.
 *
 * Localhost is rejected outside development on purpose: eBay has to be able
 * to reach the URL from the public internet, so a localhost value means the
 * variable was copied from a dev machine and every notification will be lost.
 */
export function describeEndpointProblem(
  endpointUrl: string,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(endpointUrl);
  } catch {
    return `EBAY_MARKETPLACE_DELETION_ENDPOINT is not a valid URL: "${endpointUrl}".`;
  }

  const isLocal =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "::1" ||
    parsed.hostname.endsWith(".localhost");

  if (nodeEnv === "production") {
    if (parsed.protocol !== "https:") {
      return "EBAY_MARKETPLACE_DELETION_ENDPOINT must use HTTPS. eBay only calls HTTPS endpoints.";
    }
    if (isLocal) {
      return "EBAY_MARKETPLACE_DELETION_ENDPOINT points at localhost, which eBay cannot reach. Set it to the public HTTPS URL registered in the developer portal.";
    }
  }

  return null;
}

/**
 * The challenge response hash.
 *
 * SHA-256 over challengeCode + verificationToken + endpointUrl, concatenated
 * as UTF-8 with nothing between them, rendered as lowercase hex.
 *
 * Written as three successive `update` calls rather than one concatenated
 * string: it is the same digest, and it makes the required order explicit at
 * the point where getting it wrong would be invisible.
 */
export function computeChallengeResponse(
  challengeCode: string,
  verificationToken: string,
  endpointUrl: string,
): string {
  return createHash("sha256")
    .update(challengeCode, "utf8")
    .update(verificationToken, "utf8")
    .update(endpointUrl, "utf8")
    .digest("hex");
}

/* -------------------------------------------------------------------------- */
/* Notification payload                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The shape eBay posts. Everything is optional because the acknowledgement
 * must not depend on the payload matching an expectation — eBay needs a 200
 * even if it adds a field tomorrow.
 */
export interface DeletionNotification {
  metadata?: {
    topic?: string;
    schemaVersion?: string;
    deprecated?: boolean;
  };
  notification?: {
    notificationId?: string;
    eventDate?: string;
    publishDate?: string;
    publishAttemptCount?: number;
    data?: {
      username?: string;
      userId?: string;
      eiasToken?: string;
    };
  };
}

/** The fields worth recording, with the username treated as personal data. */
export interface DeletionSummary {
  topic: string | null;
  notificationId: string | null;
  eventDate: string | null;
  publishAttemptCount: number | null;
  /** eBay's stable user identifier — the value a deletion would key on. */
  userId: string | null;
  /** Present so the log shows whether a username came through, not what it is. */
  hasUsername: boolean;
}

export function summarizeNotification(payload: unknown): DeletionSummary {
  const body = (payload ?? {}) as DeletionNotification;
  const data = body.notification?.data ?? {};

  return {
    topic: body.metadata?.topic ?? null,
    notificationId: body.notification?.notificationId ?? null,
    eventDate: body.notification?.eventDate ?? null,
    publishAttemptCount: body.notification?.publishAttemptCount ?? null,
    userId: data.userId ?? null,
    hasUsername: typeof data.username === "string" && data.username.length > 0,
  };
}
