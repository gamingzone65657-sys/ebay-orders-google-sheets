/**
 * The single place the browser talks to this app's /api routes.
 *
 * `response.json()` on its own is the wrong call: when the server answers
 * with an HTML error page — which Next.js does for a build failure in a
 * route's module graph, before any handler runs — it throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`, which describes
 * the parser's disappointment rather than what went wrong. So: check the
 * content type first, and when it is not JSON, report the status and what
 * the server actually said.
 */

export interface ApiFailure {
  code: string;
  message: string;
  detail?: string;
  /** HTTP status, or 0 when the request never reached the server. */
  status: number;
}

export type JsonResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ApiFailure };

/** Pulls something readable out of an HTML error page. */
function describeHtml(body: string): string | undefined {
  const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
  if (title) return title;
  const text = body
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, 300) : undefined;
}

export async function fetchJson<T = unknown>(
  input: string,
  init?: RequestInit,
): Promise<JsonResult<T>> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "NETWORK_ERROR",
        message:
          "Could not reach the server. Check that the application is still running.",
        detail: error instanceof Error ? error.message : String(error),
        status: 0,
      },
    };
  }

  const contentType = response.headers.get("content-type") ?? "";
  const isJson = /\bapplication\/(\w+\+)?json\b/i.test(contentType);

  if (!isJson) {
    const body = await response.text().catch(() => "");
    const isHtml = /^\s*<(!doctype|html)/i.test(body);
    const detail = isHtml
      ? describeHtml(body)
      : body.trim().slice(0, 300) || undefined;

    return {
      ok: false,
      error: {
        code: isHtml ? "SERVER_ERROR_PAGE" : "NON_JSON_RESPONSE",
        message: isHtml
          ? `The server returned an error page instead of data (HTTP ${response.status}). ` +
            "This usually means the API route failed to build — check the terminal running the app for the compile error."
          : `The server returned ${contentType || "an unknown content type"} instead of JSON (HTTP ${response.status}).`,
        detail,
        status: response.status,
      },
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "MALFORMED_JSON",
        message: `The server sent a malformed JSON response (HTTP ${response.status}).`,
        detail: error instanceof Error ? error.message : undefined,
        status: response.status,
      },
    };
  }

  const envelope = (payload ?? {}) as {
    ok?: boolean;
    success?: boolean;
    data?: unknown;
    error?: string;
    code?: string;
    detail?: string;
  };

  const failed =
    !response.ok || envelope.ok === false || envelope.success === false;

  if (failed) {
    return {
      ok: false,
      error: {
        code: envelope.code ?? "REQUEST_FAILED",
        message: envelope.error ?? `Request failed (HTTP ${response.status}).`,
        detail: envelope.detail,
        status: response.status,
      },
    };
  }

  return { ok: true, data: (envelope.data ?? payload) as T };
}
