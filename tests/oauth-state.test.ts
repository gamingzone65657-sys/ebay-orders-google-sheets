/**
 * The database-backed OAuth state store.
 *
 * This replaced a cookie that could not survive a serverless round trip: the
 * start request and the callback are separate invocations, and a cookie set
 * on one hostname is simply absent when the provider redirects back to
 * another. The callback could not tell "absent" from "expired", so every
 * attempt reported "the authorization session expired before Google
 * redirected back" — on a configuration that was entirely correct.
 */

import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

import { setupTestDatabase } from "./helpers/test-db";

let prisma: PrismaClient;
let store: typeof import("@/lib/oauth-store");

let userId: string;

before(async () => {
  setupTestDatabase("oauth-state");
  ({ prisma } = await import("@/lib/db"));
  store = await import("@/lib/oauth-store");
});

beforeEach(async () => {
  await prisma.oAuthState.deleteMany();
  await prisma.user.deleteMany();
  const user = await prisma.user.create({
    data: { email: "owner@example.test", name: "Owner" },
  });
  userId = user.id;
});

describe("OAuth state store", () => {
  it("issues a state that redeems once, for the user who started it", async () => {
    const { state } = await store.issueOAuthState({
      provider: store.OAUTH_PROVIDERS.GOOGLE,
      userId,
      returnTo: "/settings",
    });

    const first = await store.consumeOAuthState(
      store.OAUTH_PROVIDERS.GOOGLE,
      state,
    );
    assert.equal(first.ok, true);
    assert.equal(first.ok && first.userId, userId);
    assert.equal(first.ok && first.returnTo, "/settings");

    // Replaying the same callback must not spend a second authorization code.
    const second = await store.consumeOAuthState(
      store.OAUTH_PROVIDERS.GOOGLE,
      state,
    );
    assert.equal(second.ok, false);
    assert.equal(!second.ok && second.reason, "ALREADY_USED");
  });

  it("stores only a hash, never the state itself", async () => {
    const { state } = await store.issueOAuthState({
      provider: store.OAUTH_PROVIDERS.GOOGLE,
      userId,
      returnTo: "/settings",
    });

    const rows = await prisma.oAuthState.findMany();
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].stateHash, state);
    assert.equal(
      rows[0].stateHash,
      createHash("sha256").update(state, "utf8").digest("hex"),
    );
    // Nothing in the row can be replayed as a state.
    assert.ok(!JSON.stringify(rows[0]).includes(state));
  });

  it("rejects a state it never issued", async () => {
    const result = await store.consumeOAuthState(
      store.OAUTH_PROVIDERS.GOOGLE,
      "a-state-nobody-issued",
    );
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, "UNKNOWN");
  });

  it("rejects a state issued for a different provider", async () => {
    const { state } = await store.issueOAuthState({
      provider: store.OAUTH_PROVIDERS.EBAY,
      userId,
      returnTo: "/settings",
    });
    const result = await store.consumeOAuthState(
      store.OAUTH_PROVIDERS.GOOGLE,
      state,
    );
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, "UNKNOWN");
  });

  it("rejects an expired state and says so distinctly", async () => {
    const { state } = await store.issueOAuthState({
      provider: store.OAUTH_PROVIDERS.GOOGLE,
      userId,
      returnTo: "/settings",
    });
    await prisma.oAuthState.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const result = await store.consumeOAuthState(
      store.OAUTH_PROVIDERS.GOOGLE,
      state,
    );
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, "EXPIRED");
    // The three refusals must not collapse into one message again.
    const messages = new Set(
      (["UNKNOWN", "EXPIRED", "ALREADY_USED"] as const).map((reason) =>
        store.describeStateRejection(reason),
      ),
    );
    assert.equal(messages.size, 3);
  });

  it("gives a state a usable window rather than the old ten minutes", () => {
    assert.ok(store.OAUTH_STATE_TTL_MINUTES >= 10);
    assert.ok(store.OAUTH_STATE_TTL_MINUTES <= 15);
  });

  it("round-trips provider extras", async () => {
    const { state } = await store.issueOAuthState({
      provider: store.OAUTH_PROVIDERS.EBAY,
      userId,
      returnTo: "/settings",
      payload: { marketplaceId: "EBAY_GB", popup: true },
    });
    const result = await store.consumeOAuthState(
      store.OAUTH_PROVIDERS.EBAY,
      state,
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.payload, {
      marketplaceId: "EBAY_GB",
      popup: true,
    });
  });

  it("sweeps states that expired, without touching live ones", async () => {
    const stale = await store.issueOAuthState({
      provider: store.OAUTH_PROVIDERS.GOOGLE,
      userId,
      returnTo: "/settings",
    });
    await prisma.oAuthState.updateMany({
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    // Issuing sweeps; the fresh row created by this call must survive it.
    const fresh = await store.issueOAuthState({
      provider: store.OAUTH_PROVIDERS.GOOGLE,
      userId,
      returnTo: "/settings",
    });

    assert.equal(
      (await store.consumeOAuthState(store.OAUTH_PROVIDERS.GOOGLE, stale.state))
        .ok,
      false,
    );
    assert.equal(
      (await store.consumeOAuthState(store.OAUTH_PROVIDERS.GOOGLE, fresh.state))
        .ok,
      true,
    );
  });

  it("discards a state so a failed attempt cannot be retried", async () => {
    const { state } = await store.issueOAuthState({
      provider: store.OAUTH_PROVIDERS.GOOGLE,
      userId,
      returnTo: "/settings",
    });
    await store.discardOAuthState(state);
    assert.equal(await prisma.oAuthState.count(), 0);
  });

  it("removes a user's states with the user", async () => {
    await store.issueOAuthState({
      provider: store.OAUTH_PROVIDERS.GOOGLE,
      userId,
      returnTo: "/settings",
    });
    await prisma.user.delete({ where: { id: userId } });
    assert.equal(await prisma.oAuthState.count(), 0);
  });
});
