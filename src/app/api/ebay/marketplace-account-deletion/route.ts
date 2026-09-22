import { NextResponse } from "next/server";

import {
  computeChallengeResponse,
  readDeletionConfig,
  summarizeNotification,
} from "@/lib/ebay/account-deletion";
import { logError, logInfo } from "@/lib/log";

/**
 * eBay Marketplace Account Deletion / Closure endpoint.
 *
 * GET  — eBay's ownership challenge. See src/lib/ebay/account-deletion.ts for
 *        the full explanation of how the hash proves control of this URL.
 * POST — an actual deletion notification, which must be acknowledged fast.
 *
 * Deliberately unauthenticated: eBay calls it with no session and no cookie,
 * so it must not go through `getCurrentUser()`. Nothing here reads or writes
 * a user's data, so there is no authorization decision to make — the secret
 * that protects it is the verification token, which is never transmitted.
 *
 * Note that this route does NOT use the shared `handle()` wrapper. That
 * wrapper answers failures with this application's `{ ok, success, error }`
 * envelope, and eBay expects either `{ "challengeResponse": … }` or nothing
 * at all. Error handling is therefore explicit and local.
 */

export const dynamic = "force-dynamic";

/** eBay retries on failure; a slow answer is treated as a failure. */
export const maxDuration = 15;

const JSON_HEADERS = { "content-type": "application/json" } as const;

function jsonResponse(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: JSON_HEADERS });
}

/* -------------------------------------------------------------------------- */
/* GET — challenge verification                                                */
/* -------------------------------------------------------------------------- */

export async function GET(request: Request) {
  try {
    const challengeCode = new URL(request.url).searchParams.get("challenge_code");

    // eBay always sends this. Its absence means someone else called the URL,
    // or the endpoint was registered with a query string of its own.
    if (!challengeCode) {
      return jsonResponse(
        {
          error: "MISSING_CHALLENGE_CODE",
          message:
            "Expected a challenge_code query parameter. eBay calls this endpoint as GET ?challenge_code=…",
        },
        400,
      );
    }

    const { config, problem } = readDeletionConfig();
    if (problem) {
      // 500, not 400: the request was fine, this server is misconfigured.
      // Logged because nobody watches eBay's validation screen.
      logError("ebay/account-deletion", new Error(problem.message));
      return jsonResponse(
        { error: problem.code, message: problem.message },
        500,
      );
    }

    const challengeResponse = computeChallengeResponse(
      challengeCode,
      config.verificationToken,
      config.endpointUrl,
    );

    // The hash only — never the challenge code, the token, or the endpoint.
    logInfo(
      "ebay/account-deletion",
      `Answered an ownership challenge (${challengeResponse.slice(0, 8)}…).`,
    );

    return jsonResponse({ challengeResponse }, 200);
  } catch (error) {
    logError("ebay/account-deletion", error);
    return jsonResponse(
      {
        error: "INTERNAL_ERROR",
        message: "The challenge could not be answered.",
      },
      500,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* POST — deletion notification                                                */
/* -------------------------------------------------------------------------- */

export async function POST(request: Request) {
  try {
    // Read the body as text first so a malformed payload can be reported as
    // such instead of throwing, and so an empty body is distinguishable from
    // invalid JSON.
    const raw = await request.text();

    if (!raw.trim()) {
      return jsonResponse(
        {
          error: "EMPTY_BODY",
          message: "Expected a JSON notification payload.",
        },
        400,
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return jsonResponse(
        {
          error: "MALFORMED_JSON",
          message: "The request body is not valid JSON.",
        },
        400,
      );
    }

    if (payload === null || typeof payload !== "object") {
      return jsonResponse(
        {
          error: "INVALID_PAYLOAD",
          message: "The notification body must be a JSON object.",
        },
        400,
      );
    }

    const summary = summarizeNotification(payload);

    // What gets logged is a fixed, hand-built summary — not the payload and
    // not the headers. The payload carries a username and eiasToken, and the
    // headers carry eBay's signature; none of that belongs in a log file.
    // `logInfo` additionally redacts anything credential-shaped it finds.
    logInfo(
      "ebay/account-deletion",
      `Notification received: topic=${summary.topic ?? "unknown"} ` +
        `id=${summary.notificationId ?? "none"} ` +
        `userId=${summary.userId ?? "none"} ` +
        `attempt=${summary.publishAttemptCount ?? 1} ` +
        `username=${summary.hasUsername ? "present" : "absent"}`,
    );

    // ── Acknowledge immediately ──────────────────────────────────────────
    // eBay requires a prompt 2xx. It retries anything else, and an endpoint
    // that keeps failing gets marked down and eventually disabled, so the
    // acknowledgement must not wait on any work of its own.
    //
    // NOTE: acknowledging is not the same as complying. eBay's requirement is
    // that the seller's data for `summary.userId` is actually deleted. This
    // application stores buyer data under the *account holder's* workspace and
    // has no mapping from an eBay userId to a local record, so there is
    // nothing here that can be keyed off safely — doing it wrong would delete
    // the wrong seller's orders. Wire the real deletion in here once that
    // mapping exists; see the note in the README.
    return jsonResponse({ received: true }, 200);
  } catch (error) {
    logError("ebay/account-deletion", error);
    // Still a 4xx/5xx so eBay retries rather than considering it delivered.
    return jsonResponse(
      {
        error: "INTERNAL_ERROR",
        message: "The notification could not be processed.",
      },
      500,
    );
  }
}
