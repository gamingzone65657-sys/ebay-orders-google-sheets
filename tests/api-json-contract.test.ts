/**
 * The contract that broke: an /api route answered a request with an HTML
 * error page, and the browser reported `Unexpected token '<'` instead of
 * anything about the actual failure.
 *
 * These cover both halves of the fix — the server envelope and status codes,
 * and the client's refusal to parse a non-JSON body as JSON.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { apiError, fail, handle, ok } from "@/lib/api";
import { fetchJson } from "@/lib/fetch-json";
import { googleErrorHttpStatus, GOOGLE_ERROR_CODES } from "@/lib/google/errors";


async function body(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

describe("api envelope", () => {
  it("marks success under both ok and success", async () => {
    const response = ok({ value: 1 });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    assert.deepEqual(await body(response), {
      ok: true,
      success: true,
      data: { value: 1 },
    });
  });

  it("returns the documented failure shape with a real status", async () => {
    const response = apiError({
      code: "SPREADSHEET_NOT_FOUND",
      message: "Spreadsheet not found",
      status: 404,
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await body(response), {
      ok: false,
      success: false,
      error: "Spreadsheet not found",
      code: "SPREADSHEET_NOT_FOUND",
    });
  });

  it("gives fail() a code so every failure is classifiable", async () => {
    const parsed = await body(fail("nope", 422));
    assert.equal(parsed.code, "REQUEST_FAILED");
    assert.equal(parsed.success, false);
  });
});

describe("handle", () => {
  it("turns a throw into JSON rather than letting it reach the framework", async () => {
    const response = await handle(async () => {
      throw new Error("boom");
    });
    assert.equal(response.status, 500);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    const parsed = await body(response);
    assert.equal(parsed.success, false);
    assert.equal(parsed.code, "INTERNAL_ERROR");
    assert.equal(parsed.error, "boom");
  });

  it("handles a non-Error throw", async () => {
    const response = await handle(async () => {
      throw "a string";
    });
    assert.equal(response.status, 500);
    assert.equal((await body(response)).code, "INTERNAL_ERROR");
  });

  it("handles a handler that returns nothing", async () => {
    const response = await handle(
      (() => Promise.resolve(undefined)) as unknown as () => Promise<Response>,
    );
    assert.equal(response.status, 500);
    assert.equal((await body(response)).success, false);
  });

  it("passes a successful response through untouched", async () => {
    const response = await handle(async () => ok({ a: 1 }));
    assert.equal(response.status, 200);
  });
});

describe("google error status mapping", () => {
  it("maps each category to a status that matches its cause", () => {
    assert.equal(googleErrorHttpStatus(GOOGLE_ERROR_CODES.NOT_FOUND), 404);
    assert.equal(googleErrorHttpStatus(GOOGLE_ERROR_CODES.PERMISSION_DENIED), 403);
    assert.equal(googleErrorHttpStatus(GOOGLE_ERROR_CODES.AUTH_EXPIRED), 401);
    assert.equal(googleErrorHttpStatus(GOOGLE_ERROR_CODES.NOT_CONNECTED), 409);
    assert.equal(googleErrorHttpStatus(GOOGLE_ERROR_CODES.RATE_LIMITED), 429);
    assert.equal(googleErrorHttpStatus(GOOGLE_ERROR_CODES.BAD_REQUEST), 400);
    assert.equal(googleErrorHttpStatus("UNKNOWN"), 500);
  });

  it("never reports an upstream fault as a 500 from this app", () => {
    // A Google outage or an unreachable network is not this server failing.
    assert.equal(googleErrorHttpStatus(GOOGLE_ERROR_CODES.SERVER_ERROR), 502);
    assert.equal(googleErrorHttpStatus(GOOGLE_ERROR_CODES.NETWORK_ERROR), 504);
  });
});

describe("fetchJson", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function stub(body: string, init: ResponseInit) {
    globalThis.fetch = (async () =>
      new Response(body, init)) as typeof globalThis.fetch;
  }

  it("reports the real status for an HTML error page, not a parse error", async () => {
    // This is the exact failure that produced `Unexpected token '<'`.
    stub(
      "<!DOCTYPE html><html><head><title>Internal Server Error</title></head><body>oops</body></html>",
      { status: 500, headers: { "content-type": "text/html; charset=utf-8" } },
    );

    const result = await fetchJson("/api/google/spreadsheets/abc");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "SERVER_ERROR_PAGE");
    assert.equal(result.error.status, 500);
    assert.match(result.error.message, /error page instead of data/);
    assert.match(result.error.message, /HTTP 500/);
    assert.equal(result.error.detail, "Internal Server Error");
    // The old symptom must not be what the user sees.
    assert.doesNotMatch(result.error.message, /Unexpected token/);
  });

  it("surfaces a plain-text body when the server sends one", async () => {
    stub("upstream timeout", {
      status: 504,
      headers: { "content-type": "text/plain" },
    });
    const result = await fetchJson("/api/whatever");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "NON_JSON_RESPONSE");
    assert.equal(result.error.detail, "upstream timeout");
  });

  it("passes through a JSON failure's code and message", async () => {
    stub(
      JSON.stringify({
        ok: false,
        success: false,
        error: "Spreadsheet not found",
        code: "SPREADSHEET_NOT_FOUND",
        detail: "Demo fixture id: x",
      }),
      { status: 404, headers: { "content-type": "application/json" } },
    );

    const result = await fetchJson("/api/google/spreadsheets/x");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "SPREADSHEET_NOT_FOUND");
    assert.equal(result.error.message, "Spreadsheet not found");
    assert.equal(result.error.status, 404);
  });

  it("unwraps the data envelope on success", async () => {
    stub(JSON.stringify({ ok: true, success: true, data: { worksheets: [] } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const result = await fetchJson<{ worksheets: unknown[] }>("/api/x");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.data.worksheets, []);
  });

  it("reports an empty 500 body as a status, not as malformed JSON noise", async () => {
    // Next answers an uncaught route throw with a bodyless 500.
    stub("", { status: 500 });
    const result = await fetchJson("/api/x");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.status, 500);
    assert.equal(result.error.code, "NON_JSON_RESPONSE");
  });

  it("does not throw when the server is unreachable", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof globalThis.fetch;

    const result = await fetchJson("/api/x");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "NETWORK_ERROR");
    assert.equal(result.error.status, 0);
  });
});
