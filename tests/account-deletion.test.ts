/**
 * eBay Marketplace Account Deletion endpoint.
 *
 * The hash is checked against an independently computed digest rather than
 * against the implementation's own output, so a change to the concatenation
 * order cannot pass by agreeing with itself.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";

import {
  computeChallengeResponse,
  describeEndpointProblem,
  readDeletionConfig,
  summarizeNotification,
  VERIFICATION_TOKEN_MAX_LENGTH,
  VERIFICATION_TOKEN_MIN_LENGTH,
} from "@/lib/ebay/account-deletion";

const TOKEN = "a".repeat(40);
const ENDPOINT = "https://sync.example.com/api/ebay/marketplace-account-deletion";
const CODE = "abc123challenge";

describe("challenge hash", () => {
  it("is sha256 of code + token + endpoint, in that order, as hex", () => {
    const independent = createHash("sha256")
      .update(CODE + TOKEN + ENDPOINT, "utf8")
      .digest("hex");

    assert.equal(computeChallengeResponse(CODE, TOKEN, ENDPOINT), independent);
  });

  it("produces 64 lowercase hex characters", () => {
    const hash = computeChallengeResponse(CODE, TOKEN, ENDPOINT);
    assert.match(hash, /^[0-9a-f]{64}$/);
  });

  it("changes when any one input changes", () => {
    const base = computeChallengeResponse(CODE, TOKEN, ENDPOINT);
    assert.notEqual(computeChallengeResponse("other", TOKEN, ENDPOINT), base);
    assert.notEqual(computeChallengeResponse(CODE, "b".repeat(40), ENDPOINT), base);
    assert.notEqual(
      computeChallengeResponse(CODE, TOKEN, `${ENDPOINT}/`),
      base,
      "a trailing slash must change the hash — this is the usual cause of a mismatch",
    );
  });

  it("is order-sensitive, which a wrong order would silently hide", () => {
    const correct = computeChallengeResponse(CODE, TOKEN, ENDPOINT);
    const swapped = createHash("sha256")
      .update(TOKEN + CODE + ENDPOINT, "utf8")
      .digest("hex");
    assert.notEqual(correct, swapped);
  });

  it("handles non-ASCII in the endpoint as UTF-8", () => {
    const unicode = "https://xn--pple-43d.example.com/hook";
    assert.doesNotThrow(() => computeChallengeResponse(CODE, TOKEN, unicode));
    assert.equal(
      computeChallengeResponse(CODE, TOKEN, unicode),
      createHash("sha256").update(CODE + TOKEN + unicode, "utf8").digest("hex"),
    );
  });
});

describe("configuration", () => {
  const base: Record<string, string | undefined> = {
    EBAY_MARKETPLACE_DELETION_VERIFICATION_TOKEN: TOKEN,
    EBAY_MARKETPLACE_DELETION_ENDPOINT: ENDPOINT,
  };

  it("accepts a well-formed pair", () => {
    const { config, problem } = readDeletionConfig(base);
    assert.equal(problem, null);
    assert.equal(config?.verificationToken, TOKEN);
    assert.equal(config?.endpointUrl, ENDPOINT);
  });

  it("reports a missing token", () => {
    const { problem } = readDeletionConfig({
      ...base,
      EBAY_MARKETPLACE_DELETION_VERIFICATION_TOKEN: undefined,
    });
    assert.equal(problem?.code, "TOKEN_MISSING");
  });

  it("reports a missing endpoint", () => {
    const { problem } = readDeletionConfig({
      ...base,
      EBAY_MARKETPLACE_DELETION_ENDPOINT: "   ",
    });
    assert.equal(problem?.code, "ENDPOINT_MISSING");
  });

  it("rejects a token eBay itself would reject", () => {
    const tooShort = "a".repeat(VERIFICATION_TOKEN_MIN_LENGTH - 1);
    const tooLong = "a".repeat(VERIFICATION_TOKEN_MAX_LENGTH + 1);
    const badChars = `${"a".repeat(39)}!`;

    for (const token of [tooShort, tooLong, badChars]) {
      const { problem } = readDeletionConfig({
        ...base,
        EBAY_MARKETPLACE_DELETION_VERIFICATION_TOKEN: token,
      });
      assert.equal(problem?.code, "TOKEN_INVALID", `expected rejection for ${token.length} chars`);
    }
  });

  it("trims surrounding whitespace rather than hashing it", () => {
    const { config } = readDeletionConfig({
      ...base,
      EBAY_MARKETPLACE_DELETION_ENDPOINT: `  ${ENDPOINT}  `,
    });
    assert.equal(config?.endpointUrl, ENDPOINT);
  });
});

describe("endpoint validation", () => {
  it("allows localhost while developing", () => {
    assert.equal(
      describeEndpointProblem("http://localhost:3000/api/x", "development"),
      null,
    );
  });

  it("refuses localhost in production", () => {
    const problem = describeEndpointProblem(
      "https://localhost:3000/api/x",
      "production",
    );
    assert.ok(problem && /localhost/.test(problem));
  });

  it("refuses plain HTTP in production", () => {
    const problem = describeEndpointProblem(
      "http://sync.example.com/api/x",
      "production",
    );
    assert.ok(problem && /HTTPS/.test(problem));
  });

  it("accepts a public HTTPS URL in production", () => {
    assert.equal(describeEndpointProblem(ENDPOINT, "production"), null);
  });

  it("rejects something that is not a URL", () => {
    assert.ok(describeEndpointProblem("not a url", "production"));
  });
});

describe("notification summary", () => {
  const payload = {
    metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION", schemaVersion: "1.0" },
    notification: {
      notificationId: "n-123",
      eventDate: "2026-09-22T10:00:00.000Z",
      publishAttemptCount: 2,
      data: {
        username: "a_seller",
        userId: "ebay-user-987",
        eiasToken: "secret-eias",
      },
    },
  };

  it("pulls out the fields worth recording", () => {
    const summary = summarizeNotification(payload);
    assert.equal(summary.topic, "MARKETPLACE_ACCOUNT_DELETION");
    assert.equal(summary.notificationId, "n-123");
    assert.equal(summary.userId, "ebay-user-987");
    assert.equal(summary.publishAttemptCount, 2);
  });

  it("reports only whether a username was present, never its value", () => {
    const summary = summarizeNotification(payload);
    assert.equal(summary.hasUsername, true);
    // The whole point: nothing in the summary can carry the name or the token.
    const serialized = JSON.stringify(summary);
    assert.ok(!serialized.includes("a_seller"));
    assert.ok(!serialized.includes("secret-eias"));
  });

  it("survives an empty or unexpected payload", () => {
    for (const input of [{}, null, undefined, { notification: {} }, []]) {
      const summary = summarizeNotification(input);
      assert.equal(summary.topic, null);
      assert.equal(summary.hasUsername, false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The route itself                                                            */
/* -------------------------------------------------------------------------- */

describe("GET /api/ebay/marketplace-account-deletion", () => {
  let route: typeof import("@/app/api/ebay/marketplace-account-deletion/route");
  const saved = { ...process.env };

  before(async () => {
    process.env.EBAY_MARKETPLACE_DELETION_VERIFICATION_TOKEN = TOKEN;
    process.env.EBAY_MARKETPLACE_DELETION_ENDPOINT = ENDPOINT;
    route = await import("@/app/api/ebay/marketplace-account-deletion/route");
  });

  const call = (query: string) =>
    route.GET(new Request(`https://sync.example.com/api/ebay/marketplace-account-deletion${query}`));

  it("answers the challenge with 200, JSON, and the right hash", async () => {
    process.env.EBAY_MARKETPLACE_DELETION_VERIFICATION_TOKEN = TOKEN;
    process.env.EBAY_MARKETPLACE_DELETION_ENDPOINT = ENDPOINT;

    const response = await call(`?challenge_code=${CODE}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);

    const body = (await response.json()) as { challengeResponse: string };
    assert.equal(
      body.challengeResponse,
      createHash("sha256").update(CODE + TOKEN + ENDPOINT, "utf8").digest("hex"),
    );
  });

  it("returns exactly the one documented field", async () => {
    const response = await call(`?challenge_code=${CODE}`);
    assert.deepEqual(Object.keys(await response.json()), ["challengeResponse"]);
  });

  it("rejects a missing challenge_code with 400", async () => {
    const response = await call("");
    assert.equal(response.status, 400);
    assert.equal(
      ((await response.json()) as { error: string }).error,
      "MISSING_CHALLENGE_CODE",
    );
  });

  it("rejects an empty challenge_code", async () => {
    const response = await call("?challenge_code=");
    assert.equal(response.status, 400);
  });

  it("reports missing configuration as 500, not as a bad request", async () => {
    delete process.env.EBAY_MARKETPLACE_DELETION_VERIFICATION_TOKEN;
    const response = await call(`?challenge_code=${CODE}`);
    assert.equal(response.status, 500);
    assert.equal(
      ((await response.json()) as { error: string }).error,
      "TOKEN_MISSING",
    );
    process.env.EBAY_MARKETPLACE_DELETION_VERIFICATION_TOKEN = TOKEN;
  });

  it("never puts the token in the response", async () => {
    const response = await call(`?challenge_code=${CODE}`);
    const text = await response.text();
    assert.ok(!text.includes(TOKEN));
  });

  after(() => {
    process.env = { ...saved };
  });
});

describe("POST /api/ebay/marketplace-account-deletion", () => {
  let route: typeof import("@/app/api/ebay/marketplace-account-deletion/route");

  before(async () => {
    route = await import("@/app/api/ebay/marketplace-account-deletion/route");
  });

  const post = (body: string) =>
    route.POST(
      new Request("https://sync.example.com/api/ebay/marketplace-account-deletion", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );

  it("acknowledges a valid notification with 200", async () => {
    const response = await post(
      JSON.stringify({
        metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION" },
        notification: {
          notificationId: "n-1",
          data: { username: "seller", userId: "u-1", eiasToken: "t" },
        },
      }),
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  });

  it("acknowledges a payload with unexpected extra fields", async () => {
    // eBay adding a field must not turn into a retry loop.
    const response = await post(
      JSON.stringify({ metadata: { topic: "X" }, somethingNew: { a: 1 } }),
    );
    assert.equal(response.status, 200);
  });

  it("rejects malformed JSON with 400", async () => {
    const response = await post("{ not json");
    assert.equal(response.status, 400);
    assert.equal(
      ((await response.json()) as { error: string }).error,
      "MALFORMED_JSON",
    );
  });

  it("rejects an empty body with 400", async () => {
    const response = await post("");
    assert.equal(response.status, 400);
    assert.equal(
      ((await response.json()) as { error: string }).error,
      "EMPTY_BODY",
    );
  });

  it("rejects a JSON scalar, which is valid JSON but not a notification", async () => {
    const response = await post('"just a string"');
    assert.equal(response.status, 400);
    assert.equal(
      ((await response.json()) as { error: string }).error,
      "INVALID_PAYLOAD",
    );
  });
});
