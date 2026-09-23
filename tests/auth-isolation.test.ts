/**
 * Authentication and tenant isolation.
 *
 * The bug these exist for: getCurrentUser() fell back to "the oldest user in
 * the database" whenever no session cookie was present, and production had
 * SINGLE_USER_MODE turned on to make the app reachable at all. Two browsers
 * on two machines, neither holding any credential, both resolved to the same
 * workspace and both saw the seller's connected eBay account.
 *
 * The tests below are written against that scenario rather than against the
 * implementation: a second browser must see nothing, and no environment
 * variable may bring the fallback back in production.
 */

import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import type { PrismaClient } from "@prisma/client";

import { setupTestDatabase } from "./helpers/test-db";

let prisma: PrismaClient;
let auth: typeof import("@/lib/auth");
let session: typeof import("@/lib/session");
let store: typeof import("@/lib/oauth-store");

before(async () => {
  setupTestDatabase("auth-isolation");
  ({ prisma } = await import("@/lib/db"));
  auth = await import("@/lib/auth");
  session = await import("@/lib/session");
  store = await import("@/lib/oauth-store");
});

beforeEach(async () => {
  await prisma.ebayConnection.deleteMany();
  await prisma.oAuthState.deleteMany();
  await prisma.session.deleteMany();
  await prisma.user.deleteMany();
});

async function makeUser(email: string, password = "a-long-enough-password") {
  return prisma.user.create({
    data: { email, passwordHash: await auth.hashPassword(password) },
  });
}

/* -------------------------------------------------------------------------- */

describe("the anonymous fallback", () => {
  it("is off in production regardless of SINGLE_USER_MODE", () => {
    // The whole bug in one assertion. No spelling of the variable, and no
    // other variable, may re-enable shared-identity access.
    for (const value of ["true", "TRUE", '"true"', "1", "yes", "on", " true "]) {
      assert.equal(
        session.anonymousFallbackAllowed({
          NODE_ENV: "production",
          SINGLE_USER_MODE: value,
        } as NodeJS.ProcessEnv),
        false,
        `SINGLE_USER_MODE=${JSON.stringify(value)} must not enable the fallback in production`,
      );
    }
    assert.equal(
      session.anonymousFallbackAllowed({
        NODE_ENV: "production",
      } as NodeJS.ProcessEnv),
      false,
    );
  });

  it("stays available for local development", () => {
    assert.equal(
      session.anonymousFallbackAllowed({
        NODE_ENV: "development",
      } as NodeJS.ProcessEnv),
      true,
    );
    // …and can still be switched off there.
    assert.equal(
      session.anonymousFallbackAllowed({
        NODE_ENV: "development",
        SINGLE_USER_MODE: "false",
      } as NodeJS.ProcessEnv),
      false,
    );
  });
});

describe("passwords", () => {
  it("never stores the password itself", async () => {
    const user = await makeUser("owner@test.local", "correct-horse-battery");
    assert.ok(user.passwordHash);
    assert.ok(!user.passwordHash.includes("correct-horse-battery"));
    assert.ok(user.passwordHash.startsWith("scrypt:"));
  });

  it("accepts the right password and rejects everything else", async () => {
    const user = await makeUser("owner@test.local", "correct-horse-battery");
    assert.equal(
      await auth.verifyPassword("correct-horse-battery", user.passwordHash),
      true,
    );
    assert.equal(
      await auth.verifyPassword("correct-horse-batterY", user.passwordHash),
      false,
    );
    assert.equal(await auth.verifyPassword("", user.passwordHash), false);
  });

  it("cannot sign in to an account that has no password", async () => {
    // Exactly the state the production owner row was in.
    const legacy = await prisma.user.create({
      data: { email: "legacy@test.local" },
    });
    assert.equal(legacy.passwordHash, null);
    assert.equal(await auth.verifyPassword("anything", null), false);
    assert.equal(await auth.verifyPassword("", null), false);
  });

  it("refuses a password too short to protect an eBay account", () => {
    assert.ok(auth.passwordProblem("short"));
    assert.equal(auth.passwordProblem("a-long-enough-password"), null);
  });
});

describe("two browsers are two sessions", () => {
  it("gives each sign-in its own token and its own row", async () => {
    const user = await makeUser("owner@test.local");

    const browserA = await auth.createSession(user.id, { userAgent: "A" });
    const browserB = await auth.createSession(user.id, { userAgent: "B" });

    assert.notEqual(browserA.token, browserB.token);
    assert.equal(await prisma.session.count({ where: { userId: user.id } }), 2);
  });

  it("signing out of one leaves the other signed in", async () => {
    const user = await makeUser("owner@test.local");
    const browserA = await auth.createSession(user.id);
    const browserB = await auth.createSession(user.id);

    await auth.destroySession(browserA.token);

    assert.equal(await auth.resolveSession(browserA.token), null);
    assert.equal((await auth.resolveSession(browserB.token))?.userId, user.id);
  });

  it("revokes server-side, so a copied token stops working", async () => {
    const user = await makeUser("owner@test.local");
    const { token } = await auth.createSession(user.id);
    await auth.destroySession(token);
    // Nothing about clearing a cookie: the row is gone.
    assert.equal(await auth.resolveSession(token), null);
    assert.equal(await prisma.session.count(), 0);
  });

  it("rejects an expired session and does not leave it lying around", async () => {
    const user = await makeUser("owner@test.local");
    const { token } = await auth.createSession(user.id);
    await prisma.session.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    assert.equal(await auth.resolveSession(token), null);
    assert.equal(await prisma.session.count(), 0);
  });

  it("rejects a token nobody issued", async () => {
    await makeUser("owner@test.local");
    assert.equal(await auth.resolveSession("not-a-real-token"), null);
  });

  it("stores only a hash, so the table cannot be replayed", async () => {
    const user = await makeUser("owner@test.local");
    const { token } = await auth.createSession(user.id);
    const rows = await prisma.session.findMany();
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].tokenHash, token);
    assert.ok(!JSON.stringify(rows[0]).includes(token));
  });

  it("ends every session for a user when asked", async () => {
    const user = await makeUser("owner@test.local");
    const other = await makeUser("someone@test.local");
    const a = await auth.createSession(user.id);
    const b = await auth.createSession(user.id);
    const untouched = await auth.createSession(other.id);

    assert.equal(await auth.destroyAllSessions(user.id), 2);
    assert.equal(await auth.resolveSession(a.token), null);
    assert.equal(await auth.resolveSession(b.token), null);
    // Another user's sessions are not collateral.
    assert.equal((await auth.resolveSession(untouched.token))?.userId, other.id);
  });
});

describe("the session cookie", () => {
  it("is httpOnly and lax, so an OAuth callback still carries it", () => {
    const cookie = auth.sessionCookie("t", new Date(Date.now() + 1000), true);
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.secure, true);
    // Strict would withhold the cookie on eBay's and Google's top-level
    // redirect back, and the callback would have no workspace to attach to.
    assert.equal(cookie.sameSite, "lax");
    assert.equal(cookie.path, "/");
  });

  it("clears by expiring, not by being left in place", () => {
    const cleared = auth.clearedSessionCookie(true);
    assert.equal(cleared.value, "");
    assert.equal(cleared.maxAge, 0);
  });

  it("matches the name the edge middleware looks for", async () => {
    // The middleware cannot import lib/auth (node:crypto is not available on
    // the Edge runtime), so it repeats the constant. This keeps them in step.
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync("src/middleware.ts", "utf8"),
    );
    const match = source.match(/const SESSION_COOKIE = "([^"]+)"/);
    assert.ok(match, "middleware must define SESSION_COOKIE");
    assert.equal(match[1], auth.SESSION_COOKIE);
  });
});

describe("OAuth connections belong to one workspace", () => {
  it("attaches a connection to the user who started the flow", async () => {
    const userA = await makeUser("a@test.local");
    const userB = await makeUser("b@test.local");

    // A starts an eBay authorization.
    const { state } = await store.issueOAuthState({
      provider: store.OAUTH_PROVIDERS.EBAY,
      userId: userA.id,
      returnTo: "/settings",
      payload: { marketplaceId: "EBAY_GB", environment: "PRODUCTION" },
    });

    // The callback resolves the workspace from the state, not from whoever
    // happens to be asking — so B completing this URL still credits A.
    const claim = await store.consumeOAuthState(
      store.OAUTH_PROVIDERS.EBAY,
      state,
    );
    assert.equal(claim.ok, true);
    assert.equal(claim.ok && claim.userId, userA.id);
    assert.notEqual(claim.ok && claim.userId, userB.id);
  });

  it("keeps one workspace's connection invisible to another", async () => {
    const userA = await makeUser("a@test.local");
    const userB = await makeUser("b@test.local");

    await prisma.ebayConnection.create({
      data: {
        userId: userA.id,
        environment: "PRODUCTION",
        status: "CONNECTED",
        marketplaceId: "EBAY_US",
        isActive: true,
        connectedAt: new Date(),
      },
    });

    // The query every page and route runs, for each user in turn.
    const seenByA = await prisma.ebayConnection.findFirst({
      where: { userId: userA.id, isActive: true },
    });
    const seenByB = await prisma.ebayConnection.findFirst({
      where: { userId: userB.id, isActive: true },
    });

    assert.ok(seenByA);
    assert.equal(seenByB, null);
  });

  it("does not let one workspace read another's resource by id", async () => {
    const userA = await makeUser("a@test.local");
    const userB = await makeUser("b@test.local");

    const connection = await prisma.ebayConnection.create({
      data: {
        userId: userA.id,
        environment: "PRODUCTION",
        status: "CONNECTED",
        marketplaceId: "EBAY_US",
        isActive: true,
        connectedAt: new Date(),
      },
    });

    // B guesses A's id and asks for it the way a route does: scoped.
    const stolen = await prisma.ebayConnection.findFirst({
      where: { id: connection.id, userId: userB.id },
    });
    assert.equal(stolen, null);
  });

  it("removes a user's sessions and OAuth states with the user", async () => {
    const user = await makeUser("a@test.local");
    await auth.createSession(user.id);
    await store.issueOAuthState({
      provider: store.OAUTH_PROVIDERS.GOOGLE,
      userId: user.id,
      returnTo: "/settings",
    });

    await prisma.user.delete({ where: { id: user.id } });

    assert.equal(await prisma.session.count(), 0);
    assert.equal(await prisma.oAuthState.count(), 0);
  });
});
