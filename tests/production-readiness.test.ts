/**
 * The production-hardening behaviour added during the security review:
 * fail-closed authentication, the CSRF/rate-limit edge guards, the readiness
 * checks, and data retention.
 */

import assert from "node:assert/strict";
import { afterEach, before, beforeEach, describe, it } from "node:test";

import { setupTestDatabase } from "./helpers/test-db";

/* -------------------------------------------------------------------------- */
/* Readiness checks (pure)                                                     */
/* -------------------------------------------------------------------------- */

describe("production readiness", () => {
  let check: typeof import("@/lib/production-check").checkProductionReadiness;
  const saved = { ...process.env };

  before(async () => {
    ({ checkProductionReadiness: check } = await import(
      "@/lib/production-check"
    ));
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  function production(overrides: Record<string, string | undefined>) {
    process.env = {
      ...saved,
      NODE_ENV: "production",
      AUTH_SECRET: "a".repeat(40),
      APP_URL: "https://sync.example.com",
      GOOGLE_CLIENT_ID: "g",
      GOOGLE_CLIENT_SECRET: "gs",
      EBAY_CLIENT_ID: "e",
      EBAY_CLIENT_SECRET: "es",
      EBAY_ENVIRONMENT: "PRODUCTION",
      EBAY_RU_NAME: "Acme-AcmeApp-PRD-1a2b3c4d5-6e7f8g9h",
      CRON_SECRET: "c",
      DATABASE_URL: "postgresql://localhost/app",
      ...overrides,
    } as NodeJS.ProcessEnv;
    return check();
  }

  it("says nothing about a development environment", () => {
    process.env = { ...saved, NODE_ENV: "development" } as NodeJS.ProcessEnv;
    assert.deepEqual(check(), []);
  });

  it("passes a fully configured production deployment", () => {
    assert.deepEqual(production({}), []);
  });

  it("blocks a short or missing AUTH_SECRET", () => {
    const short = production({ AUTH_SECRET: "tooshort" });
    assert.ok(short.some((f) => f.severity === "blocker" && /AUTH_SECRET/.test(f.title)));

    const missing = production({ AUTH_SECRET: undefined });
    assert.ok(missing.some((f) => f.severity === "blocker"));
  });

  it("blocks a missing or non-HTTPS APP_URL", () => {
    assert.ok(
      production({ APP_URL: undefined }).some((f) => f.severity === "blocker"),
    );
    assert.ok(
      production({ APP_URL: "http://sync.example.com" }).some(
        (f) => f.severity === "blocker" && /HTTPS/.test(f.title),
      ),
    );
  });

  it("warns loudly when authentication is switched off", () => {
    const findings = production({ SINGLE_USER_MODE: "true" });
    assert.ok(
      findings.some((f) => /without authentication/i.test(f.title)),
      JSON.stringify(findings),
    );
  });

  it("warns about the sandbox, SQLite and a missing cron secret", () => {
    assert.ok(
      production({ EBAY_ENVIRONMENT: "SANDBOX" }).some((f) =>
        /sandbox/i.test(f.title),
      ),
    );
    assert.ok(
      production({ DATABASE_URL: "file:./dev.db" }).some((f) =>
        /SQLite/.test(f.title),
      ),
    );
    assert.ok(
      production({ CRON_SECRET: undefined }).some((f) => /CRON_SECRET/.test(f.title)),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* CSRF + rate limiting                                                        */
/* -------------------------------------------------------------------------- */

describe("edge guards", () => {
  let middleware: typeof import("@/middleware").middleware;
  let NextRequest: typeof import("next/server").NextRequest;

  before(async () => {
    ({ middleware } = await import("@/middleware"));
    ({ NextRequest } = await import("next/server"));
  });

  function request(
    url: string,
    init: { method?: string; origin?: string; host?: string; ip?: string } = {},
  ) {
    const headers = new Headers();
    if (init.origin) headers.set("origin", init.origin);
    headers.set("host", init.host ?? "sync.example.com");
    // A distinct IP per test keeps the rate limiter from bleeding across cases.
    headers.set("x-forwarded-for", init.ip ?? Math.random().toString(36));
    return new NextRequest(url, { method: init.method ?? "GET", headers });
  }

  it("lets a same-origin mutation through", () => {
    const response = middleware(
      request("https://sync.example.com/api/sync", {
        method: "POST",
        origin: "https://sync.example.com",
      }),
    );
    assert.notEqual(response.status, 403);
  });

  it("rejects a mutation from another site", async () => {
    const response = middleware(
      request("https://sync.example.com/api/sync", {
        method: "POST",
        origin: "https://evil.example.net",
      }),
    );
    assert.equal(response.status, 403);
    const body = (await response.json()) as { code: string; success: boolean };
    assert.equal(body.code, "CSRF_ORIGIN_MISMATCH");
    assert.equal(body.success, false);
  });

  it("does not block cross-origin reads", () => {
    const response = middleware(
      request("https://sync.example.com/api/sync/jobs/x", {
        method: "GET",
        origin: "https://evil.example.net",
      }),
    );
    assert.notEqual(response.status, 403);
  });

  it("allows a server-to-server call with no Origin", () => {
    // curl, a platform cron, the worker: no Origin header at all.
    const response = middleware(
      request("https://sync.example.com/api/jobs/tick", { method: "POST" }),
    );
    assert.notEqual(response.status, 403);
  });

  it("rejects an unparseable Origin rather than trusting it", async () => {
    const response = middleware(
      request("https://sync.example.com/api/sync", {
        method: "POST",
        origin: "not a url",
      }),
    );
    assert.equal(response.status, 403);
    assert.equal(((await response.json()) as { code: string }).code, "BAD_ORIGIN");
  });

  it("rate limits repeated calls to an expensive endpoint", async () => {
    const ip = "203.0.113.7";
    let limited = null as Response | null;

    for (let i = 0; i < 40; i += 1) {
      const response = middleware(
        request("https://sync.example.com/api/sync", {
          method: "POST",
          origin: "https://sync.example.com",
          ip,
        }),
      );
      if (response.status === 429) {
        limited = response as unknown as Response;
        break;
      }
    }

    assert.ok(limited, "the expensive endpoint must be rate limited");
    assert.ok(limited.headers.get("retry-after"), "a 429 must say when to retry");
    const body = (await limited.json()) as { code: string };
    assert.equal(body.code, "RATE_LIMITED");
  });

  it("keeps one client's budget separate from another's", () => {
    const hammer = "198.51.100.1";
    for (let i = 0; i < 40; i += 1) {
      middleware(
        request("https://sync.example.com/api/sync", {
          method: "POST",
          origin: "https://sync.example.com",
          ip: hammer,
        }),
      );
    }
    const other = middleware(
      request("https://sync.example.com/api/sync", {
        method: "POST",
        origin: "https://sync.example.com",
        ip: "198.51.100.2",
      }),
    );
    assert.notEqual(other.status, 429);
  });
});

/* -------------------------------------------------------------------------- */
/* Authentication fails closed                                                 */
/* -------------------------------------------------------------------------- */

describe("authentication", () => {
  let session: typeof import("@/lib/session");
  const saved = { ...process.env };

  before(async () => {
    setupTestDatabase("readiness");
    session = await import("@/lib/session");
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it("resolves the owner in development, where there is no login", async () => {
    Object.defineProperty(process.env, "NODE_ENV", {
      value: "development",
      configurable: true,
    });
    const user = await session.getCurrentUser();
    assert.ok(user.id);
  });

  it("refuses to guess a user in production", async () => {
    Object.defineProperty(process.env, "NODE_ENV", {
      value: "production",
      configurable: true,
    });
    delete process.env.SINGLE_USER_MODE;

    await assert.rejects(
      () => session.getCurrentUser(),
      (error: unknown) => {
        assert.ok(error instanceof session.AuthRequiredError);
        assert.equal((error as { code: string }).code, "AUTH_REQUIRED");
        return true;
      },
      "production without sign-in must not fall back to the workspace owner",
    );
  });

  it("allows the fallback only when explicitly opted into", async () => {
    Object.defineProperty(process.env, "NODE_ENV", {
      value: "production",
      configurable: true,
    });
    process.env.SINGLE_USER_MODE = "true";

    const user = await session.getCurrentUser();
    assert.ok(user.id);
  });

  it("answers an unauthenticated API call with 401 JSON, not a 500", async () => {
    Object.defineProperty(process.env, "NODE_ENV", {
      value: "production",
      configurable: true,
    });
    delete process.env.SINGLE_USER_MODE;

    const { handle } = await import("@/lib/api");
    const response = await handle(async () => {
      await session.getCurrentUser();
      throw new Error("unreachable");
    });

    assert.equal(response.status, 401);
    const body = (await response.json()) as { code: string; success: boolean };
    assert.equal(body.code, "AUTH_REQUIRED");
    assert.equal(body.success, false);
  });
});

/* -------------------------------------------------------------------------- */
/* Retention                                                                   */
/* -------------------------------------------------------------------------- */

describe("data retention", () => {
  let prisma: import("@prisma/client").PrismaClient;
  let applyRetention: typeof import("@/lib/retention").applyRetention;
  let userId: string;

  before(async () => {
    setupTestDatabase("readiness");
    ({ prisma } = await import("@/lib/db"));
    ({ applyRetention } = await import("@/lib/retention"));

    const user = await prisma.user.create({
      data: { email: `retention-${Date.now()}@test.local` },
    });
    userId = user.id;
  });

  beforeEach(async () => {
    await prisma.importedOrder.deleteMany({ where: { userId } });
  });

  const daysAgo = (days: number) =>
    new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  async function seed(id: string, days: number) {
    return prisma.importedOrder.create({
      data: {
        userId,
        ebayOrderId: id,
        orderDate: daysAgo(days),
        orderStatus: "ACTIVE",
        buyerUsername: "a_buyer",
        totalAmount: 10,
        rawPayloadJson: JSON.stringify({ buyer: { email: "b@example.com" } }),
      },
    });
  }

  it("keeps everything when retention is not configured", async () => {
    const order = await seed("KEEP-1", 400);
    await applyRetention(new Date(), {
      rawPayloadDays: null,
      historyDays: null,
    });
    const after = await prisma.importedOrder.findUniqueOrThrow({
      where: { id: order.id },
    });
    assert.ok(after.rawPayloadJson, "no policy means no deletion");
  });

  it("clears payloads older than the window and leaves recent ones", async () => {
    const old = await seed("OLD-1", 120);
    const recent = await seed("NEW-1", 5);

    const result = await applyRetention(new Date(), {
      rawPayloadDays: 90,
      historyDays: null,
    });

    assert.equal(result.payloadsCleared, 1);
    assert.equal(
      (await prisma.importedOrder.findUniqueOrThrow({ where: { id: old.id } }))
        .rawPayloadJson,
      null,
    );
    assert.ok(
      (await prisma.importedOrder.findUniqueOrThrow({ where: { id: recent.id } }))
        .rawPayloadJson,
    );
  });

  it("keeps the order itself, only the payload goes", async () => {
    const order = await seed("OLD-2", 200);
    await applyRetention(new Date(), { rawPayloadDays: 90, historyDays: null });

    const after = await prisma.importedOrder.findUniqueOrThrow({
      where: { id: order.id },
    });
    assert.equal(after.ebayOrderId, "OLD-2");
    assert.equal(after.buyerUsername, "a_buyer");
    assert.equal(after.totalAmount, 10);
  });

  it("is idempotent", async () => {
    await seed("OLD-3", 200);
    const first = await applyRetention(new Date(), {
      rawPayloadDays: 90,
      historyDays: null,
    });
    const second = await applyRetention(new Date(), {
      rawPayloadDays: 90,
      historyDays: null,
    });
    assert.equal(first.payloadsCleared, 1);
    assert.equal(second.payloadsCleared, 0, "a second pass must clear nothing");
  });
});
