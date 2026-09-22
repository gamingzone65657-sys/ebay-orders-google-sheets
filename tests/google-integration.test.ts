/**
 * Integration tests for the Google layer.
 *
 * Exercises the real client, token manager, Drive listing and Sheets reads
 * against an isolated SQLite database, with the HTTP transport stubbed.
 * Everything below the network boundary is production code.
 */

import assert from "node:assert/strict";
import { afterEach, before, beforeEach, describe, it } from "node:test";
import type { PrismaClient } from "@prisma/client";

import { encryptSecret } from "@/lib/crypto";
import { GOOGLE_ERROR_CODES, GoogleApiError } from "@/lib/google/errors";
import { resetRateLimitState } from "@/lib/http/rate-limit";

import { setupTestDatabase } from "./helpers/test-db";

let prisma: PrismaClient;
let googleRequest: typeof import("@/lib/google/client").googleRequest;
let setGoogleTransport: typeof import("@/lib/google/client").setGoogleTransport;
let listSpreadsheets: typeof import("@/lib/google/drive").listSpreadsheets;
let getSpreadsheetMetadata: typeof import("@/lib/google/sheets").getSpreadsheetMetadata;
let readHeaderRow: typeof import("@/lib/google/sheets").readHeaderRow;
let getValidAccessToken: typeof import("@/lib/google/tokens").getValidAccessToken;
let describeTokenStatus: typeof import("@/lib/google/tokens").describeTokenStatus;

type GoogleConnectionRow = Awaited<
  ReturnType<PrismaClient["googleConnection"]["findFirstOrThrow"]>
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
    scopes: string;
  }> = {},
): Promise<GoogleConnectionRow> {
  await prisma.googleConnection.deleteMany({ where: { userId } });
  return prisma.googleConnection.create({
    data: {
      userId,
      status: overrides.status ?? "CONNECTED",
      email: "seller@example.com",
      accessToken:
        overrides.accessToken === undefined
          ? encryptSecret("test-google-access-token")
          : overrides.accessToken,
      refreshToken:
        overrides.refreshToken === undefined
          ? encryptSecret("test-google-refresh-token")
          : overrides.refreshToken,
      tokenExpiresAt:
        overrides.tokenExpiresAt === undefined
          ? new Date(Date.now() + HOUR)
          : overrides.tokenExpiresAt,
      scopes:
        overrides.scopes ??
        "openid email profile https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/spreadsheets",
      connectedAt: new Date(),
    },
  });
}

before(async () => {
  setupTestDatabase("google");
  process.env.GOOGLE_CLIENT_ID = "test-google-client";
  process.env.GOOGLE_CLIENT_SECRET = "test-google-secret";
  process.env.GOOGLE_MIN_REQUEST_INTERVAL_MS = "0";

  ({ prisma } = await import("@/lib/db"));
  ({ googleRequest, setGoogleTransport } = await import("@/lib/google/client"));
  ({ listSpreadsheets } = await import("@/lib/google/drive"));
  ({ getSpreadsheetMetadata, readHeaderRow } = await import(
    "@/lib/google/sheets"
  ));
  ({ getValidAccessToken, describeTokenStatus } = await import(
    "@/lib/google/tokens"
  ));

  const user = await prisma.user.upsert({
    where: { email: "google-integration@test.local" },
    create: { email: "google-integration@test.local", name: "Test Seller" },
    update: {},
  });
  userId = user.id;
});

beforeEach(() => resetRateLimitState());

afterEach(() => {
  setGoogleTransport(null);
  resetRateLimitState();
});

/* -------------------------------------------------------------------------- */
/* Client                                                                      */
/* -------------------------------------------------------------------------- */

describe("googleRequest", () => {
  it("sends a bearer token", async () => {
    const connection = await createConnection();
    let seen: RequestInit | null = null;
    setGoogleTransport(async (_url, init) => {
      seen = init;
      return json({ ok: true });
    });

    await googleRequest(connection, {
      url: "https://sheets.googleapis.com/v4/spreadsheets/abc",
      label: "sheets.spreadsheets.get",
    });

    const headers = (seen as RequestInit | null)?.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer test-google-access-token");
  });

  it("retries a 429 and succeeds", async () => {
    const connection = await createConnection();
    let calls = 0;
    setGoogleTransport(async () => {
      calls += 1;
      return calls === 1
        ? json({ error: { errors: [{ reason: "rateLimitExceeded" }] } }, 429, {
            "retry-after": "0",
          })
        : json({ recovered: true });
    });

    const result = await googleRequest<{ recovered: boolean }>(connection, {
      url: "https://sheets.googleapis.com/v4/spreadsheets/abc",
      label: "sheets.spreadsheets.get",
    });
    assert.equal(calls, 2);
    assert.equal(result.data.recovered, true);
  });

  it("treats a quota 403 as retryable rate limiting", async () => {
    const connection = await createConnection();
    let calls = 0;
    setGoogleTransport(async () => {
      calls += 1;
      return calls === 1
        ? json(
            { error: { errors: [{ reason: "userRateLimitExceeded" }] } },
            403,
          )
        : json({ ok: true });
    });

    await googleRequest(connection, {
      url: "https://www.googleapis.com/drive/v3/files",
      label: "drive.files.list",
    });
    assert.equal(calls, 2, "quota 403 is retried, unlike a permission 403");
  });

  it("does not retry a permission 403", async () => {
    const connection = await createConnection();
    let calls = 0;
    setGoogleTransport(async () => {
      calls += 1;
      return json({ error: { errors: [{ reason: "forbidden" }] } }, 403);
    });

    await assert.rejects(
      () =>
        googleRequest(connection, {
          url: "https://sheets.googleapis.com/v4/spreadsheets/abc",
          label: "sheets.spreadsheets.get",
        }),
      (error: unknown) =>
        error instanceof GoogleApiError &&
        error.code === GOOGLE_ERROR_CODES.PERMISSION_DENIED,
    );
    assert.equal(calls, 1);
  });

  it("does not retry a 404", async () => {
    const connection = await createConnection();
    let calls = 0;
    setGoogleTransport(async () => {
      calls += 1;
      return json({ error: { message: "Requested entity was not found." } }, 404);
    });

    await assert.rejects(
      () =>
        googleRequest(connection, {
          url: "https://sheets.googleapis.com/v4/spreadsheets/missing",
          label: "sheets.spreadsheets.get",
        }),
      (error: unknown) =>
        error instanceof GoogleApiError &&
        error.code === GOOGLE_ERROR_CODES.NOT_FOUND,
    );
    assert.equal(calls, 1);
  });

  it("rejects a 200 whose body is not JSON", async () => {
    const connection = await createConnection();
    setGoogleTransport(
      async () => new Response("<html>proxy</html>", { status: 200 }),
    );
    await assert.rejects(
      () =>
        googleRequest(connection, {
          url: "https://sheets.googleapis.com/v4/spreadsheets/abc",
          label: "sheets.spreadsheets.get",
        }),
      (error: unknown) =>
        error instanceof GoogleApiError &&
        error.code === GOOGLE_ERROR_CODES.INVALID_RESPONSE,
    );
  });

  it("logs every attempt and updates the connection", async () => {
    const connection = await createConnection();
    await prisma.googleApiCall.deleteMany({
      where: { connectionId: connection.id },
    });

    let calls = 0;
    setGoogleTransport(async () => {
      calls += 1;
      return calls === 1 ? json({}, 503) : json({ ok: true });
    });

    await googleRequest(connection, {
      url: "https://www.googleapis.com/drive/v3/about",
      label: "drive.about.get",
    });

    const logged = await prisma.googleApiCall.findMany({
      where: { connectionId: connection.id },
      orderBy: { createdAt: "asc" },
    });
    assert.equal(logged.length, 2);
    assert.equal(logged[0].ok, false);
    assert.equal(logged[1].ok, true);

    const stored = await prisma.googleConnection.findUniqueOrThrow({
      where: { id: connection.id },
    });
    assert.ok(stored.lastApiSuccessAt);
    assert.equal(stored.lastApiPath, "drive.about.get");
    assert.equal(stored.lastError, null);
  });

  it("short-circuits while a cooldown is active", async () => {
    process.env.GOOGLE_MAX_ATTEMPTS = "1";
    const connection = await createConnection();
    let calls = 0;
    setGoogleTransport(async () => {
      calls += 1;
      return json({}, 429, { "retry-after": "0" });
    });

    await assert.rejects(() =>
      googleRequest(connection, {
        url: "https://www.googleapis.com/drive/v3/files",
        label: "drive.files.list",
      }),
    );
    const after = calls;
    await assert.rejects(() =>
      googleRequest(connection, {
        url: "https://www.googleapis.com/drive/v3/files",
        label: "drive.files.list",
      }),
    );
    assert.equal(calls, after, "no request while cooling down");

    delete process.env.GOOGLE_MAX_ATTEMPTS;
  });
});

/* -------------------------------------------------------------------------- */
/* Tokens                                                                      */
/* -------------------------------------------------------------------------- */

describe("Google token lifecycle", () => {
  it("returns the stored token while fresh", async () => {
    const connection = await createConnection();
    assert.equal(
      await getValidAccessToken(connection),
      "test-google-access-token",
    );
  });

  it("refuses a disconnected connection", async () => {
    const connection = await createConnection({ status: "DISCONNECTED" });
    await assert.rejects(
      () => getValidAccessToken(connection),
      (error: unknown) =>
        error instanceof GoogleApiError &&
        error.code === GOOGLE_ERROR_CODES.NOT_CONNECTED,
    );
  });

  it("refreshes an expired token and keeps the refresh token", async () => {
    const connection = await createConnection({
      tokenExpiresAt: new Date(Date.now() - HOUR),
    });

    const originalFetch = globalThis.fetch;
    let sentBody = "";
    globalThis.fetch = (async (_input: string, init: RequestInit) => {
      sentBody = String(init.body);
      // Google does not return a refresh_token on refresh.
      return json({
        access_token: "refreshed-google-token",
        token_type: "Bearer",
        expires_in: 3599,
      });
    }) as typeof fetch;

    try {
      assert.equal(
        await getValidAccessToken(connection),
        "refreshed-google-token",
      );
      assert.ok(sentBody.includes("grant_type=refresh_token"));
      assert.ok(sentBody.includes("client_secret="));

      const stored = await prisma.googleConnection.findUniqueOrThrow({
        where: { id: connection.id },
      });
      assert.ok(!stored.accessToken!.includes("refreshed-google-token"));
      assert.equal(
        stored.refreshToken,
        connection.refreshToken,
        "the existing refresh token is preserved",
      );
      assert.equal(stored.status, "CONNECTED");
      assert.ok(stored.lastRefreshedAt);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("marks the connection EXPIRED on invalid_grant", async () => {
    const connection = await createConnection({
      tokenExpiresAt: new Date(Date.now() - HOUR),
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      json({ error: "invalid_grant" }, 400)) as typeof fetch;

    try {
      await assert.rejects(
        () => getValidAccessToken(connection),
        (error: unknown) =>
          error instanceof GoogleApiError &&
          error.code === GOOGLE_ERROR_CODES.AUTH_EXPIRED,
      );
      const stored = await prisma.googleConnection.findUniqueOrThrow({
        where: { id: connection.id },
      });
      assert.equal(stored.status, "EXPIRED");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("flags a connection with no refresh token", () => {
    const status = describeTokenStatus({
      accessToken: "enc",
      refreshToken: null,
      tokenExpiresAt: new Date(Date.now() + HOUR),
      status: "CONNECTED",
    });
    assert.equal(status.health, "NO_REFRESH_TOKEN");
    assert.equal(status.hasRefreshToken, false);
  });
});

/* -------------------------------------------------------------------------- */
/* Drive                                                                       */
/* -------------------------------------------------------------------------- */

describe("listSpreadsheets", () => {
  it("queries only spreadsheets, excluding trashed files", async () => {
    const connection = await createConnection();
    let seenUrl = "";
    setGoogleTransport(async (url) => {
      seenUrl = url;
      return json({ files: [] });
    });

    await listSpreadsheets(connection);

    const q = new URL(seenUrl).searchParams.get("q") ?? "";
    assert.ok(q.includes("mimeType='application/vnd.google-apps.spreadsheet'"));
    assert.ok(q.includes("trashed=false"));
  });

  it("escapes an apostrophe in the search term", async () => {
    const connection = await createConnection();
    let seenUrl = "";
    setGoogleTransport(async (url) => {
      seenUrl = url;
      return json({ files: [] });
    });

    await listSpreadsheets(connection, { search: "Dan's sheet" });

    const q = new URL(seenUrl).searchParams.get("q") ?? "";
    assert.ok(
      q.includes("name contains 'Dan\\'s sheet'"),
      `unescaped query: ${q}`,
    );
  });

  it("maps files and tolerates missing fields", async () => {
    const connection = await createConnection();
    setGoogleTransport(async () =>
      json({
        files: [
          {
            id: "sheet-1",
            name: "Order Tracker",
            modifiedTime: "2026-09-19T14:02:00Z",
            owners: [{ emailAddress: "me@example.com", displayName: "Me" }],
            webViewLink: "https://docs.google.com/spreadsheets/d/sheet-1",
            shared: true,
          },
          { id: "sheet-2" },
          { name: "no id — dropped" },
        ],
        nextPageToken: "next",
      }),
    );

    const result = await listSpreadsheets(connection);
    assert.equal(result.spreadsheets.length, 2);
    assert.equal(result.spreadsheets[0].ownerEmail, "me@example.com");
    assert.equal(result.spreadsheets[1].name, "(untitled spreadsheet)");
    assert.equal(result.spreadsheets[1].ownerEmail, null);
    assert.equal(result.nextPageToken, "next");
  });
});

/* -------------------------------------------------------------------------- */
/* Sheets                                                                      */
/* -------------------------------------------------------------------------- */

describe("getSpreadsheetMetadata", () => {
  it("maps worksheets with dimensions, sorted by index", async () => {
    const connection = await createConnection();
    setGoogleTransport(async (url) => {
      // Metadata must not pull cell data.
      assert.ok(!url.includes("includeGridData"));
      return json({
        spreadsheetId: "sheet-1",
        spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-1",
        properties: { title: "Order Tracker", timeZone: "Etc/UTC" },
        sheets: [
          {
            properties: {
              sheetId: 900,
              title: "Returns",
              index: 1,
              sheetType: "GRID",
              gridProperties: { rowCount: 50, columnCount: 4 },
            },
          },
          {
            properties: {
              sheetId: 0,
              title: "Orders",
              index: 0,
              sheetType: "GRID",
              gridProperties: {
                rowCount: 1000,
                columnCount: 26,
                frozenRowCount: 1,
              },
            },
          },
        ],
      });
    });

    const metadata = await getSpreadsheetMetadata(connection, "sheet-1");
    assert.equal(metadata.title, "Order Tracker");
    assert.deepEqual(
      metadata.worksheets.map((tab) => tab.title),
      ["Orders", "Returns"],
    );
    assert.equal(metadata.worksheets[0].sheetId, 0);
    assert.equal(metadata.worksheets[0].rowCount, 1000);
    assert.equal(metadata.worksheets[0].frozenRowCount, 1);
    assert.equal(metadata.worksheets[1].frozenRowCount, null);
  });

  it("tolerates a sheet with no grid properties", async () => {
    const connection = await createConnection();
    setGoogleTransport(async () =>
      json({
        spreadsheetId: "sheet-1",
        properties: {},
        sheets: [{ properties: { sheetId: 5, title: "Chart", sheetType: "OBJECT" } }],
      }),
    );

    const metadata = await getSpreadsheetMetadata(connection, "sheet-1");
    assert.equal(metadata.title, "(untitled spreadsheet)");
    assert.equal(metadata.worksheets[0].rowCount, null);
    assert.equal(metadata.worksheets[0].sheetType, "OBJECT");
  });
});

describe("readHeaderRow", () => {
  async function readWith(values: unknown[][] | undefined, headerRow = 1) {
    const connection = await createConnection();
    setGoogleTransport(async () => json({ range: "'Orders'!1:1", values }));
    return readHeaderRow(connection, "sheet-1", "Orders", headerRow);
  }

  it("reads the requested row with the right A1 range", async () => {
    const connection = await createConnection();
    let seenUrl = "";
    setGoogleTransport(async (url) => {
      seenUrl = url;
      return json({ values: [["Order ID", "Buyer"]] });
    });

    await readHeaderRow(connection, "sheet-1", "Dan's orders", 3);
    assert.ok(
      decodeURIComponent(seenUrl).includes("'Dan''s orders'!3:3"),
      `range not escaped: ${seenUrl}`,
    );
  });

  it("returns the headers as strings", async () => {
    const result = await readWith([
      ["Order ID", "Buyer", "SKU", "Qty", "Price", "Tracking"],
    ]);
    assert.deepEqual(result.headers, [
      "Order ID",
      "Buyer",
      "SKU",
      "Qty",
      "Price",
      "Tracking",
    ]);
    assert.equal(result.hasDuplicates, false);
  });

  it("drops trailing blanks but keeps interior ones", async () => {
    const result = await readWith([["Order ID", "", "SKU", "", "", ""]]);
    assert.deepEqual(result.headers, ["Order ID", "", "SKU"]);
    assert.deepEqual(result.blankPositions, [1]);
  });

  it("trims whitespace and coerces non-strings", async () => {
    const result = await readWith([["  Order ID  ", 2026, true]]);
    assert.deepEqual(result.headers, ["Order ID", "2026", "true"]);
  });

  it("flags duplicate headers, which break unique mapping", async () => {
    const result = await readWith([["SKU", "Buyer", "sku"]]);
    assert.equal(result.hasDuplicates, true);
    assert.deepEqual(result.duplicates, ["sku"]);
  });

  it("returns nothing for an empty row rather than throwing", async () => {
    assert.deepEqual((await readWith(undefined)).headers, []);
    assert.deepEqual((await readWith([])).headers, []);
    assert.deepEqual((await readWith([[]])).headers, []);
    assert.deepEqual((await readWith([["", "", ""]])).headers, []);
  });
});
