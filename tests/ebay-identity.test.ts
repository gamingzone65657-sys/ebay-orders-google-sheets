/**
 * The seller identity lookup, and what its failure is allowed to affect.
 *
 * Two bugs met here in production. The call went to api.ebay.com, which does
 * not serve the Commerce Identity API and answers it with a bare 404; and
 * that 404 was then written onto the connection as its last error, so a
 * connection whose order imports were returning 200 displayed a red "Last
 * error (BAD_REQUEST) Not Found" banner.
 */

import assert from "node:assert/strict";
import { afterEach, before, beforeEach, describe, it } from "node:test";
import type { PrismaClient } from "@prisma/client";

import { encryptSecret } from "@/lib/crypto";
import { resetRateLimitState } from "@/lib/ebay/rate-limit";

import { setupTestDatabase } from "./helpers/test-db";

type EbayConnectionRow = Awaited<
  ReturnType<PrismaClient["ebayConnection"]["findFirstOrThrow"]>
>;

let prisma: PrismaClient;
let ebayRequest: typeof import("@/lib/ebay/client").ebayRequest;
let setEbayTransport: typeof import("@/lib/ebay/client").setEbayTransport;
let fetchIdentity: typeof import("@/lib/ebay/identity").fetchIdentity;

let userId: string;

const HOUR = 60 * 60 * 1000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function createConnection(): Promise<EbayConnectionRow> {
  await prisma.ebayConnection.deleteMany({ where: { userId } });
  return prisma.ebayConnection.create({
    data: {
      userId,
      environment: "SANDBOX",
      status: "CONNECTED",
      marketplaceId: "EBAY_US",
      accessToken: encryptSecret("test-access-token"),
      refreshToken: encryptSecret("test-refresh-token"),
      tokenExpiresAt: new Date(Date.now() + HOUR),
      refreshExpiresAt: new Date(Date.now() + 400 * 24 * HOUR),
      connectedAt: new Date(),
    },
  });
}

before(async () => {
  setupTestDatabase("ebay-identity");
  ({ prisma } = await import("@/lib/db"));
  ({ ebayRequest, setEbayTransport } = await import("@/lib/ebay/client"));
  ({ fetchIdentity } = await import("@/lib/ebay/identity"));

  const user = await prisma.user.create({
    data: { email: "identity@test.local", name: "Test Seller" },
  });
  userId = user.id;
});

beforeEach(() => {
  resetRateLimitState();
});

afterEach(() => {
  setEbayTransport(null);
});

describe("which host an eBay call goes to", () => {
  it("sends the identity lookup to apiz, not api", async () => {
    const connection = await createConnection();
    let seenUrl = "";
    setEbayTransport(async (url) => {
      seenUrl = url;
      return json({ userId: "seller-1", username: "testseller" });
    });

    await fetchIdentity(connection);

    // api.sandbox.ebay.com answers this path with 404; apiz serves it.
    assert.equal(
      seenUrl,
      "https://apiz.sandbox.ebay.com/commerce/identity/v1/user/",
    );
  });

  it("appends no user id to a path that takes none", async () => {
    const connection = await createConnection();
    let seenUrl = "";
    setEbayTransport(async (url) => {
      seenUrl = url;
      return json({ userId: "seller-1" });
    });

    await fetchIdentity(connection);

    const path = new URL(seenUrl).pathname;
    assert.equal(path, "/commerce/identity/v1/user/");
    assert.equal(new URL(seenUrl).search, "");
  });

  it("still sends a bearer token and the marketplace header to apiz", async () => {
    const connection = await createConnection();
    let seen: RequestInit | null = null;
    setEbayTransport(async (_url, init) => {
      seen = init;
      return json({ userId: "seller-1" });
    });

    await fetchIdentity(connection);

    const headers = (seen as RequestInit | null)?.headers as Record<
      string,
      string
    >;
    assert.equal(headers.Authorization, "Bearer test-access-token");
    assert.equal(headers["X-EBAY-C-MARKETPLACE-ID"], "EBAY_US");
  });

  it("leaves every other call on the api host", async () => {
    const connection = await createConnection();
    let seenUrl = "";
    setEbayTransport(async (url) => {
      seenUrl = url;
      return json({ orders: [] });
    });

    await ebayRequest(connection, { path: "/sell/fulfillment/v1/order" });

    assert.ok(
      seenUrl.startsWith("https://api.sandbox.ebay.com/sell/fulfillment/v1/order"),
      `orders must stay on the api host, got ${seenUrl}`,
    );
  });
});

describe("what a failed optional call is allowed to affect", () => {
  it("does not mark the connection broken when identity 404s", async () => {
    const connection = await createConnection();
    // A connection whose orders are importing fine.
    await prisma.ebayConnection.update({
      where: { id: connection.id },
      data: { lastApiSuccessAt: new Date(), lastError: null, lastErrorCode: null },
    });

    setEbayTransport(async () =>
      json({ errors: [{ errorId: 11001, message: "Not Found" }] }, 404),
    );

    const identity = await fetchIdentity(connection);
    assert.equal(identity, null, "a failed lookup returns null, not a throw");

    const after = await prisma.ebayConnection.findUniqueOrThrow({
      where: { id: connection.id },
    });
    assert.equal(after.lastError, null);
    assert.equal(after.lastErrorCode, null);
    assert.equal(after.lastErrorAt, null);
  });

  it("still records the failure in the call log, rather than hiding it", async () => {
    const connection = await createConnection();
    await prisma.ebayApiCall.deleteMany({ where: { connectionId: connection.id } });

    setEbayTransport(async () => json({ errors: [{ errorId: 11001 }] }, 404));
    await fetchIdentity(connection);

    const calls = await prisma.ebayApiCall.findMany({
      where: { connectionId: connection.id },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].ok, false);
    assert.equal(calls[0].status, 404);
    assert.equal(calls[0].path, "/commerce/identity/v1/user/");
  });

  it("does not advance lastApiSuccessAt for a call that failed", async () => {
    const connection = await createConnection();
    await prisma.ebayConnection.update({
      where: { id: connection.id },
      data: { lastApiSuccessAt: null },
    });

    setEbayTransport(async () => json({ errors: [{ errorId: 11001 }] }, 404));
    await fetchIdentity(connection);

    const after = await prisma.ebayConnection.findUniqueOrThrow({
      where: { id: connection.id },
    });
    assert.equal(after.lastApiSuccessAt, null);
    // The attempt is still visible as the last *request*.
    assert.equal(after.lastApiStatus, 404);
    assert.equal(after.lastApiPath, "/commerce/identity/v1/user/");
  });

  it("still marks the connection broken when a required call fails", async () => {
    const connection = await createConnection();
    setEbayTransport(async () =>
      json({ errors: [{ errorId: 11001, message: "Not Found" }] }, 404),
    );

    await assert.rejects(
      ebayRequest(connection, { path: "/sell/fulfillment/v1/order" }),
    );

    const after = await prisma.ebayConnection.findUniqueOrThrow({
      where: { id: connection.id },
    });
    assert.ok(
      after.lastErrorCode,
      "an order-API failure must still surface on the connection",
    );
  });
});
