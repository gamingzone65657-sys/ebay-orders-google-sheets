/**
 * Integration tests for the eBay layer.
 *
 * These exercise the real client, pagination walker, token manager and import
 * pipeline against an isolated SQLite database, with the HTTP transport
 * stubbed. Everything below the network boundary is production code.
 */

import assert from "node:assert/strict";
import { afterEach, before, beforeEach, describe, it } from "node:test";
import type { PrismaClient } from "@prisma/client";

// These modules are safe to import statically: none of them touches the
// database, so none constructs a Prisma client before the test DB env is set.
import { encryptSecret } from "@/lib/crypto";
import { EBAY_ERROR_CODES, EbayApiError } from "@/lib/ebay/errors";
import { resetRateLimitState } from "@/lib/ebay/rate-limit";

import {
  fullOrder,
  makeOrderPage,
  sparseOrder,
  unusableOrder,
} from "./fixtures/ebay-payloads";
import { setupTestDatabase } from "./helpers/test-db";

/**
 * Anything that reaches @/lib/db has to be imported *after*
 * `setupTestDatabase()` has pointed DATABASE_URL at the test database, and
 * static imports are hoisted above the module body — hence the dynamic
 * imports in `before`.
 */
let prisma: PrismaClient;
let ebayRequest: typeof import("@/lib/ebay/client").ebayRequest;
let setEbayTransport: typeof import("@/lib/ebay/client").setEbayTransport;
let fetchOrders: typeof import("@/lib/ebay/orders").fetchOrders;
let importOrders: typeof import("@/lib/ebay/import-orders").importOrders;
let getValidAccessToken: typeof import("@/lib/ebay/tokens").getValidAccessToken;
let describeTokenStatus: typeof import("@/lib/ebay/tokens").describeTokenStatus;

type EbayConnectionRow = Awaited<
  ReturnType<PrismaClient["ebayConnection"]["findFirstOrThrow"]>
>;

const HOUR = 60 * 60 * 1000;

let userId: string;

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function createConnection(
  overrides: Partial<{
    status: string;
    accessToken: string | null;
    refreshToken: string | null;
    tokenExpiresAt: Date | null;
    refreshExpiresAt: Date | null;
    marketplaceId: string;
  }> = {},
): Promise<EbayConnectionRow> {
  await prisma.ebayConnection.deleteMany({ where: { userId } });
  return prisma.ebayConnection.create({
    data: {
      userId,
      environment: "SANDBOX",
      status: overrides.status ?? "CONNECTED",
      marketplaceId: overrides.marketplaceId ?? "EBAY_US",
      accessToken:
        overrides.accessToken === undefined
          ? encryptSecret("test-access-token")
          : overrides.accessToken,
      refreshToken:
        overrides.refreshToken === undefined
          ? encryptSecret("test-refresh-token")
          : overrides.refreshToken,
      tokenExpiresAt:
        overrides.tokenExpiresAt === undefined
          ? new Date(Date.now() + HOUR)
          : overrides.tokenExpiresAt,
      refreshExpiresAt:
        overrides.refreshExpiresAt === undefined
          ? new Date(Date.now() + 400 * 24 * HOUR)
          : overrides.refreshExpiresAt,
      connectedAt: new Date(),
    },
  });
}

before(async () => {
  setupTestDatabase("ebay");

  ({ prisma } = await import("@/lib/db"));
  ({ ebayRequest, setEbayTransport } = await import("@/lib/ebay/client"));
  ({ fetchOrders } = await import("@/lib/ebay/orders"));
  ({ importOrders } = await import("@/lib/ebay/import-orders"));
  ({ getValidAccessToken, describeTokenStatus } = await import(
    "@/lib/ebay/tokens"
  ));

  const user = await prisma.user.create({
    data: { email: "integration@test.local", name: "Test Seller" },
  });
  userId = user.id;
});

beforeEach(async () => {
  resetRateLimitState();
  await prisma.importedOrder.deleteMany({ where: { userId } });
  await prisma.syncJob.deleteMany({ where: { userId } });
});

afterEach(() => {
  setEbayTransport(null);
  resetRateLimitState();
});

/* -------------------------------------------------------------------------- */
/* HTTP client                                                                 */
/* -------------------------------------------------------------------------- */

describe("ebayRequest", () => {
  it("sends a bearer token and the marketplace header", async () => {
    const connection = await createConnection();
    let seen: RequestInit | null = null;

    setEbayTransport(async (_url, init) => {
      seen = init;
      return json({ ok: true });
    });

    await ebayRequest(connection, { path: "/sell/fulfillment/v1/order" });

    const headers = (seen as RequestInit | null)?.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer test-access-token");
    assert.equal(headers["X-EBAY-C-MARKETPLACE-ID"], "EBAY_US");
  });

  it("builds the sandbox URL with query parameters", async () => {
    const connection = await createConnection();
    let seenUrl = "";
    setEbayTransport(async (url) => {
      seenUrl = url;
      return json({});
    });

    await ebayRequest(connection, {
      path: "/sell/fulfillment/v1/order",
      query: { limit: 200, offset: 0, filter: "creationdate:[a..b]" },
    });

    assert.ok(seenUrl.startsWith("https://api.sandbox.ebay.com/sell/fulfillment/v1/order"));
    assert.ok(seenUrl.includes("limit=200"));
    assert.ok(seenUrl.includes("offset=0"));
    assert.ok(seenUrl.includes("filter=creationdate"));
  });

  it("retries a 429 and succeeds", async () => {
    const connection = await createConnection();
    let calls = 0;
    setEbayTransport(async () => {
      calls += 1;
      if (calls === 1) {
        return json({ errors: [{ errorId: 2001 }] }, 429, { "retry-after": "0" });
      }
      return json({ recovered: true });
    });

    const result = await ebayRequest<{ recovered: boolean }>(connection, {
      path: "/sell/fulfillment/v1/order",
    });

    assert.equal(calls, 2);
    assert.equal(result.attempts, 2);
    assert.equal(result.data.recovered, true);
  });

  it("retries a 500 and succeeds", async () => {
    const connection = await createConnection();
    let calls = 0;
    setEbayTransport(async () => {
      calls += 1;
      return calls < 3 ? json({}, 503) : json({ ok: true });
    });

    const result = await ebayRequest(connection, { path: "/x" });
    assert.equal(calls, 3);
    assert.equal(result.attempts, 3);
  });

  it("retries a network failure", async () => {
    const connection = await createConnection();
    let calls = 0;
    setEbayTransport(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return json({ ok: true });
    });

    await ebayRequest(connection, { path: "/x" });
    assert.equal(calls, 2);
  });

  it("gives up after the attempt limit and starts a cooldown", async () => {
    process.env.EBAY_MAX_ATTEMPTS = "2";
    const connection = await createConnection();
    let calls = 0;
    setEbayTransport(async () => {
      calls += 1;
      return json({}, 429, { "retry-after": "0" });
    });

    await assert.rejects(
      () => ebayRequest(connection, { path: "/x" }),
      (error: unknown) =>
        error instanceof EbayApiError &&
        error.code === EBAY_ERROR_CODES.RATE_LIMITED,
    );
    assert.equal(calls, 2, "stops at EBAY_MAX_ATTEMPTS");

    // The cooldown now short-circuits without touching the network.
    const before = calls;
    await assert.rejects(
      () => ebayRequest(connection, { path: "/x" }),
      (error: unknown) =>
        error instanceof EbayApiError &&
        error.code === EBAY_ERROR_CODES.RATE_LIMITED,
    );
    assert.equal(calls, before, "no request is sent while cooling down");

    const stored = await prisma.ebayConnection.findUniqueOrThrow({
      where: { id: connection.id },
    });
    assert.ok(stored.rateLimitedUntil, "cooldown is persisted for the UI");

    delete process.env.EBAY_MAX_ATTEMPTS;
  });

  it("does not retry a 401 and reports an expired authorization", async () => {
    const connection = await createConnection();
    let calls = 0;
    setEbayTransport(async () => {
      calls += 1;
      return json({ errors: [{ errorId: 1001, message: "Invalid token" }] }, 401);
    });

    await assert.rejects(
      () => ebayRequest(connection, { path: "/x" }),
      (error: unknown) =>
        error instanceof EbayApiError &&
        error.code === EBAY_ERROR_CODES.AUTH_EXPIRED,
    );
    assert.equal(calls, 1);
  });

  it("does not retry a 403 and reports missing permissions", async () => {
    const connection = await createConnection();
    let calls = 0;
    setEbayTransport(async () => {
      calls += 1;
      return json({ errors: [{ errorId: 1100, message: "Insufficient scope" }] }, 403);
    });

    await assert.rejects(
      () => ebayRequest(connection, { path: "/x" }),
      (error: unknown) =>
        error instanceof EbayApiError &&
        error.code === EBAY_ERROR_CODES.PERMISSION_DENIED,
    );
    assert.equal(calls, 1);
  });

  it("rejects a 200 whose body is not JSON", async () => {
    const connection = await createConnection();
    setEbayTransport(
      async () => new Response("<html>gateway</html>", { status: 200 }),
    );

    await assert.rejects(
      () => ebayRequest(connection, { path: "/x" }),
      (error: unknown) =>
        error instanceof EbayApiError &&
        error.code === EBAY_ERROR_CODES.INVALID_RESPONSE,
    );
  });

  it("records every attempt and updates the connection's API timestamps", async () => {
    const connection = await createConnection();
    await prisma.ebayApiCall.deleteMany({ where: { connectionId: connection.id } });

    let calls = 0;
    setEbayTransport(async () => {
      calls += 1;
      return calls === 1 ? json({}, 503) : json({ ok: true });
    });

    await ebayRequest(connection, { path: "/sell/fulfillment/v1/order" });

    const logged = await prisma.ebayApiCall.findMany({
      where: { connectionId: connection.id },
      orderBy: { createdAt: "asc" },
    });
    assert.equal(logged.length, 2);
    assert.equal(logged[0].ok, false);
    assert.equal(logged[0].status, 503);
    assert.equal(logged[1].ok, true);

    const stored = await prisma.ebayConnection.findUniqueOrThrow({
      where: { id: connection.id },
    });
    assert.ok(stored.lastApiSuccessAt);
    assert.equal(stored.lastApiPath, "/sell/fulfillment/v1/order");
    assert.equal(stored.lastError, null, "success clears the previous error");
  });
});

/* -------------------------------------------------------------------------- */
/* Tokens                                                                      */
/* -------------------------------------------------------------------------- */

describe("token lifecycle", () => {
  it("returns the stored token while it is fresh", async () => {
    const connection = await createConnection();
    assert.equal(await getValidAccessToken(connection), "test-access-token");
  });

  it("refuses a disconnected connection", async () => {
    const disconnected = await createConnection({ status: "DISCONNECTED" });
    await assert.rejects(
      () => getValidAccessToken(disconnected),
      (error: unknown) =>
        error instanceof EbayApiError &&
        error.code === EBAY_ERROR_CODES.NOT_CONNECTED,
    );
  });

  it("refreshes an expired access token and stores the new one", async () => {
    const connection = await createConnection({
      tokenExpiresAt: new Date(Date.now() - HOUR),
    });

    const originalFetch = globalThis.fetch;
    let tokenCalls = 0;
    let sentBody = "";
    globalThis.fetch = (async (_input: string, init: RequestInit) => {
      tokenCalls += 1;
      sentBody = String(init.body);
      return json({
        access_token: "refreshed-access-token",
        token_type: "User Access Token",
        expires_in: 7200,
      });
    }) as typeof fetch;

    try {
      const token = await getValidAccessToken(connection);
      assert.equal(token, "refreshed-access-token");
      assert.equal(tokenCalls, 1);
      assert.ok(sentBody.includes("grant_type=refresh_token"));
      assert.ok(sentBody.includes("scope="), "eBay requires scope on refresh");

      const stored = await prisma.ebayConnection.findUniqueOrThrow({
        where: { id: connection.id },
      });
      assert.notEqual(stored.accessToken, null);
      assert.ok(
        !stored.accessToken!.includes("refreshed-access-token"),
        "the refreshed token is stored encrypted",
      );
      assert.ok(stored.tokenExpiresAt!.getTime() > Date.now());
      assert.equal(stored.status, "CONNECTED");
      assert.ok(stored.lastRefreshedAt);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("marks the connection EXPIRED when eBay rejects the refresh token", async () => {
    const connection = await createConnection({
      tokenExpiresAt: new Date(Date.now() - HOUR),
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      json(
        { error: "invalid_grant", error_description: "refresh token expired" },
        400,
      )) as typeof fetch;

    try {
      await assert.rejects(
        () => getValidAccessToken(connection),
        (error: unknown) =>
          error instanceof EbayApiError &&
          error.code === EBAY_ERROR_CODES.AUTH_EXPIRED,
      );

      const stored = await prisma.ebayConnection.findUniqueOrThrow({
        where: { id: connection.id },
      });
      assert.equal(stored.status, "EXPIRED");
      assert.equal(stored.lastErrorCode, EBAY_ERROR_CODES.AUTH_EXPIRED);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("collapses concurrent refreshes into a single token call", async () => {
    const connection = await createConnection({
      tokenExpiresAt: new Date(Date.now() - HOUR),
    });

    const originalFetch = globalThis.fetch;
    let tokenCalls = 0;
    globalThis.fetch = (async () => {
      tokenCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return json({ access_token: "one-token", expires_in: 7200 });
    }) as typeof fetch;

    try {
      const tokens = await Promise.all([
        getValidAccessToken(connection),
        getValidAccessToken(connection),
        getValidAccessToken(connection),
      ]);
      assert.deepEqual(tokens, ["one-token", "one-token", "one-token"]);
      assert.equal(tokenCalls, 1, "three callers, one refresh");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("describes token health for the UI without exposing the token", () => {
    assert.equal(describeTokenStatus(null).health, "MISSING");
    assert.equal(
      describeTokenStatus({
        accessToken: "enc",
        refreshToken: "enc",
        tokenExpiresAt: new Date(Date.now() + HOUR),
        refreshExpiresAt: new Date(Date.now() + 400 * 24 * HOUR),
        status: "CONNECTED",
      }).health,
      "VALID",
    );
    assert.equal(
      describeTokenStatus({
        accessToken: "enc",
        refreshToken: "enc",
        tokenExpiresAt: new Date(Date.now() + 30_000),
        refreshExpiresAt: new Date(Date.now() + 400 * 24 * HOUR),
        status: "CONNECTED",
      }).health,
      "EXPIRING_SOON",
    );
    assert.equal(
      describeTokenStatus({
        accessToken: "enc",
        refreshToken: "enc",
        tokenExpiresAt: new Date(Date.now() - HOUR),
        refreshExpiresAt: new Date(Date.now() - 1000),
        status: "CONNECTED",
      }).health,
      "REFRESH_EXPIRED",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Pagination                                                                  */
/* -------------------------------------------------------------------------- */

describe("order pagination", () => {
  it("walks every page, not just the first", async () => {
    const connection = await createConnection();
    const TOTAL = 450;
    const requestedOffsets: number[] = [];

    setEbayTransport(async (url) => {
      const parsed = new URL(url);
      const limit = Number(parsed.searchParams.get("limit"));
      const offset = Number(parsed.searchParams.get("offset"));
      requestedOffsets.push(offset);
      const count = Math.max(0, Math.min(limit, TOTAL - offset));
      return json({
        total: TOTAL,
        limit,
        offset,
        orders: makeOrderPage(offset, count),
      });
    });

    const result = await fetchOrders(connection, {
      createdFrom: new Date("2026-09-01T00:00:00.000Z"),
    });

    assert.equal(result.orders.length, TOTAL);
    assert.equal(result.pages, 3);
    assert.deepEqual(requestedOffsets, [0, 200, 400]);
    assert.equal(result.reportedTotal, TOTAL);
    assert.equal(result.truncated, false);
  });

  it("stops on a short page", async () => {
    const connection = await createConnection();
    setEbayTransport(async () =>
      json({ total: 5, limit: 200, offset: 0, orders: makeOrderPage(0, 5) }),
    );

    const result = await fetchOrders(connection, {});
    assert.equal(result.pages, 1);
    assert.equal(result.orders.length, 5);
  });

  it("handles an empty result set", async () => {
    const connection = await createConnection();
    setEbayTransport(async () => json({ total: 0, orders: [] }));

    const result = await fetchOrders(connection, {});
    assert.equal(result.orders.length, 0);
    assert.equal(result.pages, 1);
  });

  it("deduplicates an order repeated across pages", async () => {
    const connection = await createConnection();
    let page = 0;
    setEbayTransport(async () => {
      page += 1;
      // Both pages are full-size and overlap on the last entry.
      const orders =
        page === 1 ? makeOrderPage(0, 200) : makeOrderPage(199, 50);
      return json({ total: 249, limit: 200, offset: (page - 1) * 200, orders });
    });

    const result = await fetchOrders(connection, {});
    const ids = new Set(result.orders.map((order) => order.ebayOrderId));
    assert.equal(ids.size, result.orders.length, "no duplicates survive");
    assert.equal(result.orders.length, 249);
  });

  it("counts orders it cannot normalize instead of dropping them silently", async () => {
    const connection = await createConnection();
    setEbayTransport(async () =>
      json({ total: 3, orders: [fullOrder, unusableOrder, sparseOrder] }),
    );

    const result = await fetchOrders(connection, {});
    assert.equal(result.orders.length, 2);
    assert.equal(result.unusable, 1);
  });

  it("respects the page guard and reports truncation", async () => {
    const connection = await createConnection();
    setEbayTransport(async (url) => {
      const offset = Number(new URL(url).searchParams.get("offset"));
      return json({
        total: 10_000,
        limit: 200,
        offset,
        orders: makeOrderPage(offset, 200),
      });
    });

    const result = await fetchOrders(connection, { maxPages: 2 });
    assert.equal(result.pages, 2);
    assert.equal(result.orders.length, 400);
    assert.equal(result.truncated, true);
  });

  it("respects a maxOrders cap", async () => {
    const connection = await createConnection();
    setEbayTransport(async (url) => {
      const offset = Number(new URL(url).searchParams.get("offset"));
      return json({
        total: 1000,
        limit: 200,
        offset,
        orders: makeOrderPage(offset, 200),
      });
    });

    const result = await fetchOrders(connection, { maxOrders: 250 });
    assert.equal(result.orders.length, 250);
  });
});

/* -------------------------------------------------------------------------- */
/* Import pipeline                                                             */
/* -------------------------------------------------------------------------- */

describe("importOrders", () => {
  it("imports, normalizes, and records a job", async () => {
    const connection = await createConnection();

    setEbayTransport(async (url) => {
      if (url.includes("shipping_fulfillment")) {
        return json({
          fulfillments: [
            {
              fulfillmentId: "FUL-1",
              shipmentTrackingNumber: "9405511899223197428490",
              shippingCarrierCode: "USPS",
              shippedDate: "2026-09-15T17:30:00.000Z",
            },
          ],
        });
      }
      const offset = Number(new URL(url).searchParams.get("offset"));
      if (offset > 0) return json({ total: 2, offset, orders: [] });
      return json({ total: 2, offset: 0, orders: [fullOrder, sparseOrder] });
    });

    const result = await importOrders(userId, { lookbackDays: 30 });

    assert.equal(result.status, "SUCCESS");
    assert.equal(result.imported, 2);
    assert.equal(result.updated, 0);
    assert.equal(result.errors, 0);
    assert.ok(result.apiCalls >= 2);

    const stored = await prisma.importedOrder.findUniqueOrThrow({
      where: { userId_ebayOrderId: { userId, ebayOrderId: "17-12345-67890" } },
      include: { lineItems: true, fulfillments: true },
    });

    assert.equal(stored.source, "EBAY");
    assert.equal(stored.ebayConnectionId, connection.id);
    assert.equal(stored.orderStatus, "COMPLETED");
    assert.equal(stored.totalAmount, 143.33);
    assert.equal(stored.taxAmount, 11.88);
    assert.equal(stored.buyerUsername, "coastal_finds");
    assert.equal(stored.shipToCity, "Portland");
    assert.equal(stored.lineItems.length, 2);
    assert.equal(stored.totalQuantity, 3);
    assert.equal(stored.syncState, "PENDING", "awaiting the Phase 3 sheet write");
    assert.ok(stored.rawPayloadJson, "raw payload is retained for re-mapping");

    assert.equal(stored.fulfillments.length, 1);
    assert.equal(stored.trackingNumber, "9405511899223197428490");
    assert.equal(stored.shippingCarrier, "USPS");

    const job = await prisma.syncJob.findUniqueOrThrow({
      where: { id: result.jobId },
      include: { logs: true },
    });
    assert.equal(job.kind, "IMPORT");
    assert.equal(job.ordersImported, 2);
    assert.ok(job.pagesFetched >= 1);
    assert.ok(job.logs.length > 0);
    assert.ok(job.logs.some((entry) => entry.step === "fetch.orders"));
  });

  it("updates rather than duplicating on a second run", async () => {
    await createConnection();
    setEbayTransport(async (url) => {
      if (url.includes("shipping_fulfillment")) return json({ fulfillments: [] });
      const offset = Number(new URL(url).searchParams.get("offset"));
      if (offset > 0) return json({ total: 1, offset, orders: [] });
      return json({ total: 1, offset: 0, orders: [fullOrder] });
    });

    const first = await importOrders(userId, { lookbackDays: 30 });
    const second = await importOrders(userId, { lookbackDays: 30 });

    assert.equal(first.imported, 1);
    assert.equal(second.imported, 0);
    assert.equal(second.updated, 1);

    const count = await prisma.importedOrder.count({
      where: { userId, ebayOrderId: "17-12345-67890" },
    });
    assert.equal(count, 1);

    // Line items are replaced, not accumulated.
    const stored = await prisma.importedOrder.findUniqueOrThrow({
      where: { userId_ebayOrderId: { userId, ebayOrderId: "17-12345-67890" } },
      include: { lineItems: true },
    });
    assert.equal(stored.lineItems.length, 2);
  });

  it("records a FAILED job when eBay rejects the authorization", async () => {
    await createConnection();
    setEbayTransport(async () =>
      json({ errors: [{ errorId: 1001, message: "Invalid access token" }] }, 401),
    );

    const result = await importOrders(userId, { lookbackDays: 7 });

    assert.equal(result.status, "FAILED");
    assert.equal(result.errorCode, EBAY_ERROR_CODES.AUTH_EXPIRED);
    assert.equal(result.imported, 0);

    const job = await prisma.syncJob.findUniqueOrThrow({
      where: { id: result.jobId },
      include: { logs: true },
    });
    assert.equal(job.status, "FAILED");
    assert.ok(
      job.logs.some(
        (entry) => entry.level === "ERROR" && entry.step === "fetch.orders",
      ),
    );

    assert.equal(await prisma.importedOrder.count({ where: { userId } }), 0);
  });

  it("records a FAILED job when rate limited", async () => {
    process.env.EBAY_MAX_ATTEMPTS = "1";
    await createConnection();
    setEbayTransport(async () => json({}, 429, { "retry-after": "0" }));

    const result = await importOrders(userId, { lookbackDays: 7 });
    assert.equal(result.status, "FAILED");
    assert.equal(result.errorCode, EBAY_ERROR_CODES.RATE_LIMITED);

    delete process.env.EBAY_MAX_ATTEMPTS;
  });

  it("refuses to run without a connection", async () => {
    await prisma.ebayConnection.deleteMany({ where: { userId } });
    const result = await importOrders(userId, {});
    assert.equal(result.status, "FAILED");
    assert.equal(result.errorCode, EBAY_ERROR_CODES.NOT_CONNECTED);
  });

  it("refuses to run on a disconnected account", async () => {
    // There is no placeholder connection state any more: an account is either
    // authorized with eBay or it cannot import.
    await createConnection({ status: "DISCONNECTED" });
    const result = await importOrders(userId, {});
    assert.equal(result.status, "FAILED");
    assert.equal(result.errorCode, EBAY_ERROR_CODES.NOT_CONNECTED);
  });

  it("keeps going when one order's shipment lookup fails", async () => {
    await createConnection();
    setEbayTransport(async (url) => {
      if (url.includes("shipping_fulfillment")) return json({}, 500);
      const offset = Number(new URL(url).searchParams.get("offset"));
      if (offset > 0) return json({ total: 1, offset, orders: [] });
      return json({ total: 1, offset: 0, orders: [fullOrder] });
    });

    process.env.EBAY_MAX_ATTEMPTS = "1";
    const result = await importOrders(userId, { lookbackDays: 7 });
    delete process.env.EBAY_MAX_ATTEMPTS;

    assert.equal(result.status, "PARTIAL", "the order still imported");
    assert.equal(result.imported, 1);
    assert.equal(result.errors, 1);

    const stored = await prisma.importedOrder.findUniqueOrThrow({
      where: { userId_ebayOrderId: { userId, ebayOrderId: "17-12345-67890" } },
    });
    assert.equal(stored.trackingNumber, null);
  });

  it("can skip shipment lookups entirely", async () => {
    await createConnection();
    let fulfillmentCalls = 0;
    setEbayTransport(async (url) => {
      if (url.includes("shipping_fulfillment")) {
        fulfillmentCalls += 1;
        return json({ fulfillments: [] });
      }
      const offset = Number(new URL(url).searchParams.get("offset"));
      if (offset > 0) return json({ total: 1, offset, orders: [] });
      return json({ total: 1, offset: 0, orders: [fullOrder] });
    });

    await importOrders(userId, { lookbackDays: 7, includeFulfillments: false });
    assert.equal(fulfillmentCalls, 0);
  });
});
