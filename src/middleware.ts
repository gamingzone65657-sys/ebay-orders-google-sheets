import { NextResponse, type NextRequest } from "next/server";

/**
 * Edge guards that run before any route handler.
 *
 * Two jobs, both of which have to happen here because a route handler is
 * already too late:
 *
 *  1. **CSRF.** Every mutating endpoint is authenticated by cookie (or, in
 *     single-user mode, by nothing at all). Without an origin check, any page
 *     the operator happens to visit could POST to this app and start a sync,
 *     rewrite the field mappings, or disconnect the accounts. Comparing the
 *     Origin against the host the request actually arrived on is the standard
 *     defence for a same-site application and costs nothing.
 *
 *  2. **Inbound rate limiting.** The sync endpoints each cost real eBay and
 *     Google quota, so an accidental loop in a script is expensive. This is a
 *     per-instance limiter, which is the right shape for the single-process
 *     deployment this app targets; behind several instances it becomes
 *     per-instance rather than global, and a shared store would be needed.
 *
 * Read-only requests are deliberately untouched by both.
 */

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/* -------------------------------------------------------------------------- */
/* Authentication gate                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The session cookie's name, duplicated from lib/auth.ts.
 *
 * Middleware runs on the Edge runtime, which cannot load node:crypto — and
 * lib/auth.ts imports it. Importing that module here would pull the whole
 * Prisma client into the Edge bundle and fail the build, so the one constant
 * this file needs is repeated instead. A test asserts the two agree.
 */
const SESSION_COOKIE = "ebs_session";

/**
 * Paths reachable without a session.
 *
 * Everything not listed here requires one. That direction matters: a new page
 * added later is protected by default, whereas an allow-everything list with
 * exceptions leaks every route somebody forgets to add.
 *
 * The OAuth callbacks are NOT public. They identify the workspace from the
 * signed-in session and the single-use state row issued to it, and an
 * unauthenticated callback has no workspace to attach a connection to.
 */
const PUBLIC_PREFIXES = [
  "/login",
  "/register",
  "/privacy-policy",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/register",
  // eBay posts account-deletion notifications server-to-server. It has no
  // session and must not need one; the endpoint proves itself by hashing a
  // shared verification token instead.
  "/api/ebay/marketplace-account-deletion",
  // Operator endpoint, authenticated by CRON_SECRET rather than a session.
  "/api/health",
  "/api/jobs/tick",
];

function isPublic(pathname: string): boolean {
  if (pathname === "/") return true;
  return PUBLIC_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Protected routes under /api that a *browser* navigates to rather than
 * fetches.
 *
 * They still require a session — they attach a seller's connected account to
 * a workspace, so they have to know which — but refusing them with 401 JSON
 * would put a raw error object on screen in the middle of connecting. They
 * get the same redirect a page does, and the seller signs in and starts the
 * connection again.
 */
const BROWSER_NAVIGATED_API = ["/api/auth/ebay/", "/api/auth/google/"];

function isBrowserNavigation(pathname: string): boolean {
  return (
    !pathname.startsWith("/api/") ||
    BROWSER_NAVIGATED_API.some((prefix) => pathname.startsWith(prefix))
  );
}

/**
 * Whether the middleware should refuse this request outright.
 *
 * It only checks that a session cookie is *present*. Whether the token is
 * valid is decided by getCurrentUser() against the database, which the Edge
 * runtime cannot reach — so this is a cheap first gate that turns the common
 * case (no cookie at all) into a redirect or a 401 without running the page,
 * and never the only check. Every route still resolves its data through
 * getCurrentUser(), which throws AuthRequiredError for a forged or expired
 * token even though the cookie was present here.
 */
function hasSessionCookie(request: NextRequest): boolean {
  const value = request.cookies.get(SESSION_COOKIE)?.value;
  return typeof value === "string" && value.length > 0;
}

/** Mutating routes a browser is *expected* to reach cross-origin. */
const CSRF_EXEMPT = [
  // Platform cron calls this server-to-server with no Origin, and it carries
  // its own bearer secret (see api/jobs/tick).
  "/api/jobs/tick",
  // eBay posts deletion notifications server-to-server. It is not a browser,
  // so the CSRF threat this guard addresses does not apply to it.
  "/api/ebay/marketplace-account-deletion",
];

/**
 * Paths that must never be rate limited.
 *
 * eBay treats a 429 as a failed delivery: it retries, and an endpoint that
 * keeps failing is marked down and eventually unsubscribed. Throttling eBay's
 * own compliance callbacks would therefore cost the integration, and the
 * endpoint does no work worth protecting — it hashes a string, or logs a line.
 */
const RATE_LIMIT_EXEMPT = ["/api/ebay/marketplace-account-deletion"];

/* -------------------------------------------------------------------------- */
/* Rate limiting                                                               */
/* -------------------------------------------------------------------------- */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

const WINDOW_MS = 60_000;

/** Endpoints that spend upstream quota get a tighter budget than the rest. */
const EXPENSIVE = [/^\/api\/sync/, /^\/api\/ebay\/import/, /^\/api\/google\//];
const EXPENSIVE_LIMIT = 30;
const DEFAULT_LIMIT = 240;

function limitFor(pathname: string): number {
  return EXPENSIVE.some((pattern) => pattern.test(pathname))
    ? EXPENSIVE_LIMIT
    : DEFAULT_LIMIT;
}

function clientKey(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip") || "local";
}

/** Keeps the map from growing without bound on a long-lived process. */
function sweep(now: number) {
  if (buckets.size < 2048) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

function rateLimited(request: NextRequest, pathname: string): number | null {
  const now = Date.now();
  sweep(now);

  const key = `${clientKey(request)}:${limitFor(pathname)}`;
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return null;
  }

  bucket.count += 1;
  if (bucket.count > limitFor(pathname)) {
    return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  }
  return null;
}

/* -------------------------------------------------------------------------- */

function json(body: unknown, status: number, headers?: HeadersInit) {
  return NextResponse.json(body, { status, headers });
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const exemptFromLimit = RATE_LIMIT_EXEMPT.some((prefix) =>
    pathname.startsWith(prefix),
  );

  const retryAfter = exemptFromLimit ? null : rateLimited(request, pathname);
  if (retryAfter !== null) {
    return json(
      {
        ok: false,
        success: false,
        error:
          "Too many requests to this application. Wait a moment and try again.",
        code: "RATE_LIMITED",
      },
      429,
      { "retry-after": String(retryAfter) },
    );
  }

  // --- Authentication -------------------------------------------------------
  if (!isPublic(pathname) && !hasSessionCookie(request)) {
    if (!isBrowserNavigation(pathname)) {
      return json(
        {
          ok: false,
          success: false,
          error: "Sign in to continue.",
          code: "AUTH_REQUIRED",
        },
        401,
      );
    }
    // Carry the destination so signing in resumes where the user was headed,
    // as a path only — an absolute URL here would be an open redirect. An
    // OAuth callback is not worth resuming: its authorization code is
    // single-use and will have expired by the time anyone signs in.
    const login = new URL("/login", request.url);
    const target = pathname + (request.nextUrl.search || "");
    if (target !== "/" && !pathname.startsWith("/api/")) {
      login.searchParams.set("next", target);
    }
    return NextResponse.redirect(login);
  }

  if (!MUTATING.has(request.method)) return NextResponse.next();
  if (CSRF_EXEMPT.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.next();
  }

  // `origin` is set by browsers on every cross-origin request and on all
  // same-origin non-GETs. A request without one is not a browser form post,
  // so it cannot be the CSRF case this guard exists for.
  const origin = request.headers.get("origin");
  if (!origin) return NextResponse.next();

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return json(
      {
        ok: false,
        success: false,
        error: "Request origin could not be read.",
        code: "BAD_ORIGIN",
      },
      403,
    );
  }

  // Compare against the host the request actually arrived on, so this keeps
  // working behind a proxy and on any port without a configured allowlist.
  const expected =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");

  if (expected && originHost !== expected) {
    return json(
      {
        ok: false,
        success: false,
        error:
          "This request came from another site and was rejected. Use the application directly.",
        code: "CSRF_ORIGIN_MISMATCH",
      },
      403,
    );
  }

  return NextResponse.next();
}

export const config = {
  // Everything except Next's own assets and the favicon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
