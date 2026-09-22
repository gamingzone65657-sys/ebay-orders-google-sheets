import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  acquireSlot,
  backoffDelayMs,
  clearCooldown,
  cooldownRemaining,
  resetRateLimitState,
  startCooldown,
} from "@/lib/ebay/rate-limit";
import {
  EBAY_ERROR_CODES,
  EbayApiError,
  classifyHttpError,
  describeEbayError,
} from "@/lib/ebay/errors";

afterEach(() => resetRateLimitState());

describe("backoff", () => {
  it("grows exponentially and stays bounded", () => {
    const first = backoffDelayMs(1);
    const second = backoffDelayMs(2);
    const far = backoffDelayMs(12);
    assert.ok(first >= 500 && first < 1000);
    assert.ok(second >= 1000 && second < 1500);
    assert.ok(far <= 16_500, "capped so a retry never sleeps for minutes");
  });

  it("honours Retry-After over its own schedule", () => {
    assert.equal(backoffDelayMs(1, 5), 5000);
    assert.equal(backoffDelayMs(4, 5), 5000);
  });

  it("clamps an absurd Retry-After", () => {
    assert.equal(backoffDelayMs(1, 86_400), 60_000);
  });
});

describe("cooldown", () => {
  it("reports remaining seconds and clears", () => {
    assert.equal(cooldownRemaining("conn-1"), 0);
    startCooldown("conn-1", 30);
    const remaining = cooldownRemaining("conn-1");
    assert.ok(remaining > 25 && remaining <= 30);
    clearCooldown("conn-1");
    assert.equal(cooldownRemaining("conn-1"), 0);
  });

  it("is scoped per connection", () => {
    startCooldown("conn-a", 30);
    assert.ok(cooldownRemaining("conn-a") > 0);
    assert.equal(cooldownRemaining("conn-b"), 0);
  });

  it("expires on its own", async () => {
    startCooldown("conn-2", 1);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(cooldownRemaining("conn-2"), 0);
  });
});

describe("request pacing", () => {
  it("serialises calls for one connection", async () => {
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3].map(async (n) => {
        await acquireSlot("conn-serial");
        order.push(n);
      }),
    );
    assert.deepEqual(order, [1, 2, 3], "slots are granted in request order");
  });

  it("does not block a different connection", async () => {
    await acquireSlot("conn-x");
    // Would hang if the queues were shared.
    await acquireSlot("conn-y");
    assert.ok(true);
  });
});

describe("error classification", () => {
  it("maps 401 to an expired authorization", () => {
    const result = classifyHttpError(401, {
      errors: [{ errorId: 1001, message: "Invalid access token" }],
    });
    assert.equal(result.code, EBAY_ERROR_CODES.AUTH_EXPIRED);
    assert.equal(result.ebayErrorId, 1001);
  });

  it("maps 403 to missing permissions", () => {
    assert.equal(
      classifyHttpError(403, {}).code,
      EBAY_ERROR_CODES.PERMISSION_DENIED,
    );
  });

  it("maps 429 to rate limiting", () => {
    assert.equal(classifyHttpError(429, {}).code, EBAY_ERROR_CODES.RATE_LIMITED);
  });

  it("maps 5xx to a server error", () => {
    assert.equal(classifyHttpError(500, {}).code, EBAY_ERROR_CODES.SERVER_ERROR);
    assert.equal(classifyHttpError(503, {}).code, EBAY_ERROR_CODES.SERVER_ERROR);
  });

  it("maps other 4xx to a bad request", () => {
    assert.equal(classifyHttpError(400, {}).code, EBAY_ERROR_CODES.BAD_REQUEST);
  });

  it("survives a body that is not eBay-shaped", () => {
    assert.equal(classifyHttpError(400, null).code, EBAY_ERROR_CODES.BAD_REQUEST);
    assert.equal(
      classifyHttpError(400, "plain text").code,
      EBAY_ERROR_CODES.BAD_REQUEST,
    );
    assert.equal(
      classifyHttpError(400, { errors: [] }).code,
      EBAY_ERROR_CODES.BAD_REQUEST,
    );
  });

  it("knows which failures are worth retrying", () => {
    const retryable = [
      EBAY_ERROR_CODES.RATE_LIMITED,
      EBAY_ERROR_CODES.SERVER_ERROR,
      EBAY_ERROR_CODES.NETWORK_ERROR,
    ];
    for (const code of retryable) {
      assert.equal(new EbayApiError(code, "x").retryable, true, code);
    }
    for (const code of [
      EBAY_ERROR_CODES.AUTH_EXPIRED,
      EBAY_ERROR_CODES.PERMISSION_DENIED,
      EBAY_ERROR_CODES.BAD_REQUEST,
      EBAY_ERROR_CODES.INVALID_RESPONSE,
    ]) {
      assert.equal(new EbayApiError(code, "x").retryable, false, code);
    }
  });

  it("knows which failures need the seller to reconnect", () => {
    assert.equal(
      new EbayApiError(EBAY_ERROR_CODES.AUTH_EXPIRED, "x").requiresReconnect,
      true,
    );
    assert.equal(
      new EbayApiError(EBAY_ERROR_CODES.RATE_LIMITED, "x").requiresReconnect,
      false,
    );
  });

  it("describes errors without leaking internals", () => {
    const described = describeEbayError(
      new EbayApiError(EBAY_ERROR_CODES.RATE_LIMITED, "raw eBay text", {
        retryAfterSeconds: 30,
      }),
    );
    assert.equal(described.code, EBAY_ERROR_CODES.RATE_LIMITED);
    assert.match(described.message, /rate limiting/i);
    assert.equal(described.retryAfterSeconds, 30);
  });

  it("describes non-eBay errors as unknown", () => {
    assert.equal(describeEbayError(new Error("boom")).code, "UNKNOWN");
  });
});
