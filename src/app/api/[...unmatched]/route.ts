import { apiError } from "@/lib/api";

/**
 * Anything under /api that no route matches.
 *
 * Without this, Next renders the application's HTML not-found page for an
 * unknown API path, so a caller doing `response.json()` gets
 * `Unexpected token '<'` instead of a 404 it can act on. A static segment
 * always beats a catch-all in App Router precedence, so every real route
 * above still wins.
 */
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ unmatched: string[] }> };

async function notFound(request: Request, context: RouteContext) {
  const { unmatched } = await context.params;
  return apiError({
    code: "ROUTE_NOT_FOUND",
    message: "No API route matches this path.",
    status: 404,
    detail: `${request.method} /api/${unmatched.join("/")}`,
  });
}

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
export const HEAD = notFound;
export const OPTIONS = notFound;
