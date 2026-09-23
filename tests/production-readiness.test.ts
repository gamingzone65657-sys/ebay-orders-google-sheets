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
      // Closed by default here so "fully configured" means one seller's
      // deployment. The open-registration warning is asserted on its own.
      ALLOW_REGISTRATION: "false",
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

  it("tells an operator that SINGLE_USER_MODE is now inert", () => {
    // It used to make every visitor the workspace owner. It no longer does
    // anything in production, and an operator who set it back when it was
    // load-bearing needs to hear that rather than assume either way.
    const findings = production({ SINGLE_USER_MODE: "true" });
    assert.ok(
      findings.some((f) => /ignored in production/i.test(f.title)),
      JSON.stringify(findings),
    );
  });

  it("warns when anyone can create an account", () => {
    const findings = production({ ALLOW_REGISTRATION: undefined });
    assert.ok(
      findings.some((f) => /create an account/i.test(f.title)),
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
    init: {
      method?: string;
      origin?: string;
      host?: string;
      ip?: string;
      /**
       * Whether the browser carries a session cookie. Defaults to true: the
       * CSRF and rate-limit cases are about an *authenticated* request being
       * abused, and without a cookie they would all stop at the auth gate
       * before reaching the guard under test.
       */
      session?: boolean;
    } = {},
  ) {
    const headers = new Headers();
    if (init.origin) headers.set("origin", init.origin);
    headers.set("host", init.host ?? "sync.example.com");
    // A distinct IP per test keeps the rate limiter from bleeding across cases.
    headers.set("x-forwarded-for", init.ip ?? Math.random().toString(36));
    if (init.session !== false) {
      headers.set("cookie", "ebs_session=a-token-shaped-value");
    }
    return new NextRequest(url, { method: init.method ?? "GET", headers });
  }

  /* --- Authentication gate ------------------------------------------------ */

  it("redirects an unauthenticated page request to the sign-in screen", () => {
    const response = middleware(
      request("https://sync.example.com/dashboard", { session: false }),
    );
    assert.equal(response.status, 307);
    const location = new URL(response.headers.get("location") ?? "");
    assert.equal(location.pathname, "/login");
    assert.equal(location.searchParams.get("next"), "/dashboard");
  });

  it("answers an unauthenticated API request with 401 and no data", async () => {
    const response = middleware(
      request("https://sync.example.com/api/settings", { session: false }),
    );
    assert.equal(response.status, 401);
    const body = (await response.json()) as {
      code: string;
      success: boolean;
      data?: unknown;
    };
    assert.equal(body.code, "AUTH_REQUIRED");
    assert.equal(body.success, false);
    assert.equal(body.data, undefined);
  });

  it("protects mutations as well as reads", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = middleware(
        request("https://sync.example.com/api/sync", {
          method,
          origin: "https://sync.example.com",
          session: false,
        }),
      );
      assert.equal(response.status, 401, method);
    }
  });

  it("protects a route nobody remembered to list", () => {
    // The gate denies by default: a page added later is covered without
    // anyone editing the middleware.
    const response = middleware(
      request("https://sync.example.com/some/future/page", { session: false }),
    );
    assert.equal(response.status, 307);
  });

  it("leaves the pages that must work without a session alone", () => {
    for (const path of [
      "/login",
      "/register",
      "/privacy-policy",
      "/api/auth/login",
      "/api/auth/register",
      // eBay calls this server-to-server with no session at all.
      "/api/ebay/marketplace-account-deletion",
      // Operator endpoints, authenticated by CRON_SECRET instead.
      "/api/health",
      "/api/jobs/tick",
    ]) {
      const response = middleware(
        request(`https://sync.example.com${path}`, { session: false }),
      );
      assert.notEqual(response.status, 401, path);
      assert.notEqual(response.status, 307, path);
    }
  });

  it("does not treat the OAuth routes as public", () => {
    // They attach a seller's connected account to a workspace, so they need
    // to know which. A browser is navigating, so they get the redirect a page
    // gets rather than a raw 401 JSON body on screen mid-connect.
    for (const path of [
      "/api/auth/ebay/callback",
      "/api/auth/google/callback",
      "/api/auth/ebay/start",
      "/api/auth/google/start",
    ]) {
      const response = middleware(
        request(`https://sync.example.com${path}`, { session: false }),
      );
      assert.equal(response.status, 307, path);
      const location = new URL(response.headers.get("location") ?? "");
      assert.equal(location.pathname, "/login", path);
      // The authorization code is single-use and stale by the time anyone
      // signs in, so there is nothing to resume.
      assert.equal(location.searchParams.get("next"), null, path);
    }
  });

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

  it("still refuses when SINGLE_USER_MODE is set", async () => {
    // This used to be the opt-in that made production usable, and it is
    // exactly how one workspace came to be served to every browser that
    // reached the URL. No value may bring it back.
    Object.defineProperty(process.env, "NODE_ENV", {
      value: "production",
      configurable: true,
    });

    for (const value of ["true", "TRUE", '"true"', "1", "yes", "on"]) {
      process.env.SINGLE_USER_MODE = value;
      await assert.rejects(
        () => session.getCurrentUser(),
        (error: unknown) => error instanceof session.AuthRequiredError,
        `SINGLE_USER_MODE=${JSON.stringify(value)} must not admit an anonymous request`,
      );
    }
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

/* -------------------------------------------------------------------------- */
/* Flag parsing                                                                */
/* -------------------------------------------------------------------------- */

describe("environment flag reading", () => {
  let env: typeof import("@/lib/env");

  before(async () => {
    env = await import("@/lib/env");
  });

  const read = (value: string | undefined) => env.readFlag("FLAG", { FLAG: value });

  it("accepts the documented spelling", () => {
    assert.equal(read("true").enabled, true);
  });

  it("accepts the spellings a hosting dashboard actually produces", () => {
    // Quotes are the one that bites: a value pasted as "true" in Vercel keeps
    // the quote characters, and an exact === "true" comparison rejects it.
    for (const raw of ['"true"', "'true'", " true ", "TRUE", "True", "true\n", "1", "yes", "on"]) {
      assert.equal(
        read(raw).enabled,
        true,
        `expected ${JSON.stringify(raw)} to enable the flag`,
      );
    }
  });

  it("treats explicit negatives as disabled, not unrecognised", () => {
    for (const raw of ["false", '"false"', "0", "no", "off", "FALSE"]) {
      const reading = read(raw);
      assert.equal(reading.enabled, false, raw);
      assert.equal(reading.verdict, "disabled", raw);
    }
  });

  it("never enables on an unrecognised value", () => {
    for (const raw of ["maybe", "y", "enable", "tru", "2"]) {
      assert.equal(read(raw).enabled, false, raw);
    }
  });

  it("distinguishes absent from unrecognised, which are different faults", () => {
    assert.equal(read(undefined).verdict, "absent");
    assert.equal(read("").verdict, "absent");
    assert.equal(read("   ").verdict, "absent");
    assert.equal(read("banana").verdict, "unrecognised");
  });

  it("explains an absent variable in terms of redeploying", () => {
    const message = env.describeFlag("SINGLE_USER_MODE", read(undefined));
    assert.match(message, /not set in this running process/);
    assert.match(message, /redeploy/i);
  });

  it("quotes back an unrecognised value so the typo is visible", () => {
    const message = env.describeFlag("SINGLE_USER_MODE", read("ture"));
    assert.match(message, /"ture"/);
  });

  it("recognises a managed host from the marker the platform injects", () => {
    for (const marker of ["VERCEL", "RENDER", "RAILWAY_ENVIRONMENT", "FLY_APP_NAME", "NETLIFY"]) {
      assert.equal(
        env.isHostedDeployment({ [marker]: "1" }),
        true,
        `expected ${marker} to mark a hosted deployment`,
      );
    }
  });

  it("does not call a self-hosted production server hosted", () => {
    // There, "set it in .env and restart" is the correct instruction, so
    // NODE_ENV alone must not flip the advice.
    assert.equal(env.isHostedDeployment({ NODE_ENV: "production" }), false);
    assert.equal(env.isHostedDeployment({}), false);
    assert.equal(env.isHostedDeployment({ VERCEL: "" }), false);
  });
});

describe("single-user mode gate", () => {
  let session: typeof import("@/lib/session");
  const saved = { ...process.env };

  before(async () => {
    setupTestDatabase("readiness");
    session = await import("@/lib/session");
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  function withEnv(nodeEnv: string, value: string | undefined) {
    Object.defineProperty(process.env, "NODE_ENV", {
      value: nodeEnv,
      configurable: true,
    });
    if (value === undefined) delete process.env.SINGLE_USER_MODE;
    else process.env.SINGLE_USER_MODE = value;
  }

  it("admits nobody in production, whatever it is set to", async () => {
    // Every spelling a hosting dashboard produces. None of them may work:
    // this variable used to be the only thing standing between a visitor and
    // the seller's connected eBay account, and now it is not consulted at all.
    for (const raw of ["true", '"true"', " true ", "TRUE", "1", "yes", undefined, "false"]) {
      withEnv("production", raw);
      await assert.rejects(
        () => session.getCurrentUser(),
        (error: unknown) => error instanceof session.AuthRequiredError,
        `SINGLE_USER_MODE=${JSON.stringify(raw)} must not admit an anonymous request`,
      );
    }
  });

  it("still resolves the owner in development, where there is no login", async () => {
    withEnv("development", undefined);
    const user = await session.getCurrentUser();
    assert.ok(user.id);
  });

  it("can be switched off in development too", async () => {
    withEnv("development", "false");
    await assert.rejects(
      () => session.getCurrentUser(),
      (error: unknown) => error instanceof session.AuthRequiredError,
    );
  });
});
