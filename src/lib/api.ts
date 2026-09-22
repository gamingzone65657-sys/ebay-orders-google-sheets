import { NextResponse } from "next/server";
import { ZodError, type ZodType, type ZodTypeDef } from "zod";

import { describeForLog, logError, safeMessage } from "./log";
import { AuthRequiredError } from "./session";

/**
 * Every response from an /api route is JSON, in one of two shapes:
 *
 *   success  { ok: true,  success: true,  data: … }
 *   failure  { ok: false, success: false, error: "…", code: "…", detail?: "…" }
 *
 * `ok` and `success` are the same boolean under two names: `ok` is what the
 * existing callers read, `success` is the documented public field. Failures
 * carry a real HTTP status (404, 409, 502 …) so a caller can branch on the
 * status before it parses anything.
 */

export function ok<T>(data: T, status = 200) {
  return NextResponse.json({ ok: true, success: true, data }, { status });
}

export interface ApiErrorInit {
  /** Machine-readable, stable across releases, e.g. SPREADSHEET_NOT_FOUND. */
  code: string;
  /** One sentence a person can act on. */
  message: string;
  status: number;
  /** The underlying message from the upstream service, when there is one. */
  detail?: string;
  /** Field-level validation output. */
  details?: unknown;
}

export function apiError(init: ApiErrorInit) {
  return NextResponse.json(
    {
      ok: false,
      success: false,
      error: init.message,
      code: init.code,
      ...(init.detail === undefined ? {} : { detail: init.detail }),
      ...(init.details === undefined ? {} : { details: init.details }),
    },
    { status: init.status },
  );
}

export function fail(
  message: string,
  status = 400,
  details?: unknown,
  code = "REQUEST_FAILED",
) {
  return apiError({ code, message, status, details });
}

/**
 * Parses + validates a JSON body, turning failures into a 400/422 response.
 *
 * `TOut` and `TIn` are separate because `.default()` and `z.coerce` make a
 * schema's parsed output differ from its accepted input; callers always get
 * the fully-defaulted output type.
 */
export async function parseBody<TOut, TIn>(
  request: Request,
  schema: ZodType<TOut, ZodTypeDef, TIn>,
): Promise<{ data: TOut; error: null } | { data: null; error: NextResponse }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return {
      data: null,
      error: apiError({
        code: "INVALID_JSON_BODY",
        message: "Request body must be valid JSON.",
        status: 400,
      }),
    };
  }

  try {
    return { data: schema.parse(raw), error: null };
  } catch (error) {
    if (error instanceof ZodError) {
      return {
        data: null,
        error: apiError({
          code: "VALIDATION_FAILED",
          message: "Invalid request.",
          status: 422,
          details: error.flatten().fieldErrors,
        }),
      };
    }
    return {
      data: null,
      error: apiError({
        code: "VALIDATION_FAILED",
        message: "Invalid request.",
        status: 400,
      }),
    };
  }
}

/**
 * Wraps a handler so nothing it does can produce a non-JSON response.
 *
 * Without this, an uncaught throw in a route handler is answered by Next with
 * a bodyless 500 and no Content-Type, which reaches the browser as
 * "Unexpected end of JSON input" and tells nobody anything. A handler that
 * forgets to return is caught for the same reason.
 *
 * The one failure this cannot reach is a *build* error in the route's module
 * graph: the module never loads, so this function never runs, and Next serves
 * its own HTML error page. `fetchJson` on the client detects that case and
 * reports the real status instead of a JSON parse error.
 */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    const response = await fn();
    if (!(response instanceof Response)) {
      logError("api", `Handler returned ${typeof response}, not a Response.`);
      return apiError({
        code: "INTERNAL_ERROR",
        message: "The server produced no response for this request.",
        status: 500,
      });
    }
    return response;
  } catch (error) {
    // An unauthenticated request is an expected outcome, not a server fault:
    // 401 with no stack, and nothing written to the log.
    if (error instanceof AuthRequiredError) {
      return apiError({
        code: error.code,
        message: error.message,
        status: 401,
      });
    }

    logError("api", error);
    const described = describeForLog(error);
    return apiError({
      code: described.code ?? "INTERNAL_ERROR",
      message: safeMessage(error, "Unexpected server error."),
      status: 500,
      detail: described.stack?.split("\n")[1]?.trim(),
    });
  }
}
