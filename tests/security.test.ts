import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

describe("token encryption", () => {
  let crypto: typeof import("@/lib/crypto");

  before(async () => {
    process.env.AUTH_SECRET = "a-long-enough-test-secret-value-1234567890";
    crypto = await import("@/lib/crypto");
    crypto.resetEncryptionKeyCache();
  });

  it("round-trips a token", () => {
    const token = "v^1.1#i^1#f^0#r^0#I^3#p^3#t^Ul4xMF8w";
    const stored = crypto.encryptSecret(token);
    assert.notEqual(stored, token, "ciphertext must not contain the token");
    assert.ok(!stored.includes(token));
    assert.equal(crypto.decryptSecret(stored), token);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const a = crypto.encryptSecret("same-token");
    const b = crypto.encryptSecret("same-token");
    assert.notEqual(a, b);
    assert.equal(crypto.decryptSecret(a), crypto.decryptSecret(b));
  });

  it("is versioned so the format can be migrated", () => {
    assert.ok(crypto.encryptSecret("x").startsWith("v1:"));
  });

  it("rejects tampered ciphertext instead of returning garbage", () => {
    const stored = crypto.encryptSecret("sensitive");
    const parts = stored.split(":");
    const flipped = Buffer.from(parts[3], "base64");
    flipped[0] ^= 0xff;
    parts[3] = flipped.toString("base64");
    assert.throws(() => crypto.decryptSecret(parts.join(":")));
    assert.equal(crypto.tryDecryptSecret(parts.join(":")), null);
  });

  it("tryDecryptSecret never throws", () => {
    assert.equal(crypto.tryDecryptSecret(null), null);
    assert.equal(crypto.tryDecryptSecret(""), null);
    assert.equal(crypto.tryDecryptSecret("plain-text"), null);
    assert.equal(crypto.tryDecryptSecret("v9:a:b:c"), null);
  });

  it("cannot decrypt with a different key", () => {
    const stored = crypto.encryptSecret("secret");
    process.env.AUTH_SECRET = "a-completely-different-secret-value-0987654";
    crypto.resetEncryptionKeyCache();
    assert.equal(crypto.tryDecryptSecret(stored), null);
    process.env.AUTH_SECRET = "a-long-enough-test-secret-value-1234567890";
    crypto.resetEncryptionKeyCache();
    assert.equal(crypto.decryptSecret(stored), "secret");
  });

  it("compares OAuth state in constant time and rejects mismatches", () => {
    assert.equal(crypto.safeEqual("abc", "abc"), true);
    assert.equal(crypto.safeEqual("abc", "abd"), false);
    assert.equal(crypto.safeEqual("abc", "abcd"), false);
    assert.equal(crypto.safeEqual("", ""), true);
  });

  it("generates distinct URL-safe state tokens", () => {
    const tokens = new Set(
      Array.from({ length: 200 }, () => crypto.randomToken(32)),
    );
    assert.equal(tokens.size, 200);
    for (const token of tokens) assert.match(token, /^[A-Za-z0-9_-]+$/);
  });
});

describe("PII masking", () => {
  let mask: typeof import("@/lib/mask");

  before(async () => {
    mask = await import("@/lib/mask");
  });

  it("masks emails but keeps them recognisable", () => {
    const masked = mask.maskEmail("dana.whitfield@example.com");
    assert.ok(masked);
    assert.ok(!masked!.includes("whitfield"));
    assert.ok(masked!.endsWith(".com"));
    assert.ok(masked!.startsWith("da"));
  });

  it("masks phones to the last four digits", () => {
    assert.equal(mask.maskPhone("+1 503 555 1234"), "••• ••• 1234");
    assert.equal(mask.maskPhone(null), null);
  });

  it("keeps the street number but hides the street", () => {
    const masked = mask.maskAddressLine("418 Bayview Ave");
    assert.ok(masked!.startsWith("418 "));
    assert.ok(!masked!.includes("Bayview"));
  });

  it("abbreviates surnames", () => {
    assert.equal(mask.maskName("Dana Whitfield"), "Dana W.");
    assert.equal(mask.maskName("Robin de Castellanos"), "Robin D. C.");
  });

  it("masks tracking numbers to the last four", () => {
    const masked = mask.maskTrackingNumber("9405511899223197428490");
    assert.ok(masked!.endsWith("8490"));
    assert.ok(!masked!.includes("94055"));
  });

  it("returns null for absent values rather than the string 'null'", () => {
    assert.equal(mask.maskEmail(null), null);
    assert.equal(mask.maskAddressLine(undefined), null);
    assert.equal(mask.maskPostal(null), null);
  });

  it("masks sensitive keys anywhere in a raw payload", () => {
    const payload = {
      buyer: {
        username: "coastal_finds",
        registration: {
          email: "dana.whitfield@example.com",
          primaryPhone: { phoneNumber: "+15035551234" },
          contactAddress: {
            addressLine1: "418 Bayview Ave",
            city: "Portland",
            postalCode: "97203",
          },
        },
      },
      lineItems: [{ title: "Tee", fullName: "Dana Whitfield" }],
    };

    const masked = JSON.stringify(mask.maskRawPayload(payload, false));
    assert.ok(!masked.includes("dana.whitfield@example.com"));
    assert.ok(!masked.includes("15035551234"));
    assert.ok(!masked.includes("Bayview"));
    assert.ok(!masked.includes("97203"));
    assert.ok(masked.includes("coastal_finds"), "username is not PII here");
    assert.ok(masked.includes("Portland"), "city is left readable");
  });

  it("passes the payload through untouched when revealing", () => {
    const payload = { email: "a@b.com" };
    assert.deepEqual(mask.maskRawPayload(payload, true), payload);
  });
});

describe("credential redaction", () => {
  let mask: typeof import("@/lib/mask");
  let log: typeof import("@/lib/log");

  before(async () => {
    mask = await import("@/lib/mask");
    log = await import("@/lib/log");
  });

  it("recognises credential-shaped keys in every spelling", () => {
    for (const key of [
      "access_token",
      "accessToken",
      "refresh_token",
      "Authorization",
      "client_secret",
      "clientSecret",
      "password",
      "apiKey",
      "X-Api-Key",
      "sessionId",
      "Cookie",
    ]) {
      assert.equal(mask.isSecretKey(key), true, `${key} must be treated as secret`);
    }
  });

  it("leaves ordinary payload keys alone", () => {
    for (const key of ["orderId", "buyer", "sku", "quantity", "total", "title"]) {
      assert.equal(mask.isSecretKey(key), false, `${key} must not be redacted`);
    }
  });

  it("strips credentials at any depth", () => {
    const input = {
      orderId: "17-1",
      auth: { access_token: "ya29.SECRET", nested: [{ client_secret: "abc" }] },
    };
    const output = mask.redactSecrets(input) as Record<string, never>;
    const text = JSON.stringify(output);
    assert.ok(!text.includes("ya29.SECRET"));
    assert.ok(!text.includes("abc"));
    assert.ok(text.includes("17-1"), "ordinary data must survive");
  });

  it("strips credentials embedded in free text", () => {
    const line = mask.redactSecretsInText(
      "GET /x failed: Authorization: Bearer ya29.a0AfH6SMBxxxxxxx",
    );
    assert.ok(!line.includes("ya29.a0AfH6SMBxxxxxxx"), line);

    const url = mask.redactSecretsInText(
      "https://api.ebay.com/x?access_token=v%5E1.1abcdefghij&page=2",
    );
    assert.ok(!url.includes("v%5E1.1abcdefghij"), url);
  });

  it("redacts a token even when the caller asked to reveal", () => {
    // `reveal` exists for the seller's own buyer data, never for credentials.
    const payload = { buyer: { email: "a@b.com" }, access_token: "SECRET" };
    const revealed = JSON.stringify(mask.maskRawPayload(payload, true));
    assert.ok(!revealed.includes("SECRET"));
    assert.ok(revealed.includes("a@b.com"), "reveal still shows buyer data");
  });

  it("masks buyer data by default while keeping the structure", () => {
    const masked = mask.maskRawPayload(
      { buyer: { email: "buyer@example.com" }, orderId: "17-1" },
      false,
    ) as { buyer: { email: string }; orderId: string };
    assert.notEqual(masked.buyer.email, "buyer@example.com");
    assert.equal(masked.orderId, "17-1");
  });

  it("never lets an error stack reach the log with a token in it", () => {
    const error = new Error(
      "request failed: https://x/y?access_token=abcdef123456",
    );
    const described = log.describeForLog(error);
    assert.ok(!described.message.includes("abcdef123456"), described.message);
    assert.ok(!(described.stack ?? "").includes("abcdef123456"));
  });

  it("describes a non-Error throw without crashing", () => {
    assert.equal(log.describeForLog("plain string").message, "plain string");
    assert.equal(
      log.describeForLog({ weird: true }).message,
      "Non-error value thrown.",
    );
  });

  it("stops recursing on a deeply nested structure", () => {
    let deep: Record<string, unknown> = { password: "x" };
    for (let i = 0; i < 40; i += 1) deep = { nested: deep };
    assert.doesNotThrow(() => mask.redactSecrets(deep));
  });
});

describe("sync display status", () => {
  let constants: typeof import("@/lib/constants");

  before(async () => {
    constants = await import("@/lib/constants");
  });

  it("maps a clean run to Completed", () => {
    assert.equal(
      constants.syncDisplayStatus({ status: "SUCCESS", errorCount: 0, rowsFailed: 0 }),
      "Completed",
    );
  });

  it("does not call a run with lost rows a clean Completed", () => {
    assert.equal(
      constants.syncDisplayStatus({ status: "SUCCESS", errorCount: 0, rowsFailed: 3 }),
      "Completed with warnings",
    );
    assert.equal(
      constants.syncDisplayStatus({ status: "PARTIAL" }),
      "Completed with warnings",
    );
  });

  it("maps in-flight runs to Running", () => {
    assert.equal(constants.syncDisplayStatus({ status: "QUEUED" }), "Running");
    assert.equal(constants.syncDisplayStatus({ status: "RUNNING" }), "Running");
  });

  it("keeps Failed and Cancelled distinct", () => {
    assert.equal(constants.syncDisplayStatus({ status: "FAILED" }), "Failed");
    assert.equal(constants.syncDisplayStatus({ status: "CANCELLED" }), "Cancelled");
  });
});
