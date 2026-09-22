/**
 * What has to be true before this application faces the internet.
 *
 * Each check is something that is safe in development and dangerous in
 * production, so they are evaluated against NODE_ENV rather than being
 * unconditional. Reported at boot (src/instrumentation.ts) so a bad deploy is
 * visible immediately, not at the first OAuth callback.
 */

import { readFlag } from "./env";

const MIN_SECRET_LENGTH = 32;

export type Severity = "blocker" | "warning";

export interface ReadinessFinding {
  severity: Severity;
  title: string;
  detail: string;
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

// Uses the shared reader so the readiness report, the health endpoint and the
// authentication gate can never disagree about what a flag means.
function isTrue(value: string | undefined): boolean {
  return readFlag("flag", { flag: value }).enabled;
}

export function checkProductionReadiness(): ReadinessFinding[] {
  const findings: ReadinessFinding[] = [];
  if (!isProduction()) return findings;

  // --- Authentication ------------------------------------------------------
  if (isTrue(process.env.SINGLE_USER_MODE)) {
    findings.push({
      severity: "warning",
      title: "Running without authentication (SINGLE_USER_MODE)",
      detail:
        "Every request resolves to the workspace owner. Only safe on a host that is not reachable by anyone else — behind a VPN, a reverse proxy that authenticates, or bound to localhost.",
    });
  }

  // --- Secrets -------------------------------------------------------------
  const authSecret = process.env.AUTH_SECRET ?? "";
  if (authSecret.length < MIN_SECRET_LENGTH) {
    findings.push({
      severity: "blocker",
      title: "AUTH_SECRET is missing or too short",
      detail: `Stored eBay and Google tokens are encrypted with a key derived from it. It must be at least ${MIN_SECRET_LENGTH} random characters. Token encryption will refuse to run until it is set.`,
    });
  }

  if (!process.env.APP_URL?.trim()) {
    findings.push({
      severity: "blocker",
      title: "APP_URL is not set",
      detail:
        "OAuth redirect URIs are built from it. Without it they default to http://localhost:3000 and Google will reject the callback.",
    });
  } else if (!/^https:\/\//i.test(process.env.APP_URL.trim())) {
    findings.push({
      severity: "blocker",
      title: "APP_URL is not HTTPS",
      detail:
        "OAuth codes and the session cookie travel over this origin. The session cookie is only marked Secure in production, which requires HTTPS to be sent at all.",
    });
  }

  // --- Integrations --------------------------------------------------------
  const googleConfigured =
    process.env.GOOGLE_CLIENT_ID?.trim() &&
    process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!googleConfigured) {
    findings.push({
      severity: "blocker",
      title: "Google credentials are not configured",
      detail:
        "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are unset. There is no fallback — no spreadsheet can be listed, read or written.",
    });
  }

  // The redirect URI is compared character for character by Google, and a
  // localhost value in production means every consent attempt is rejected.
  const redirectUri = process.env.GOOGLE_REDIRECT_URI?.trim() ?? "";
  if (redirectUri && /localhost|127\.0\.0\.1/i.test(redirectUri)) {
    findings.push({
      severity: "blocker",
      title: "GOOGLE_REDIRECT_URI points at localhost",
      detail:
        "Google rejects a consent request whose redirect_uri it cannot reach. Set it to the production callback URL registered in Google Cloud.",
    });
  }

  const ebayConfigured =
    process.env.EBAY_CLIENT_ID?.trim() && process.env.EBAY_CLIENT_SECRET?.trim();
  if (!ebayConfigured) {
    findings.push({
      severity: "blocker",
      title: "eBay credentials are not configured",
      detail:
        "EBAY_CLIENT_ID / EBAY_CLIENT_SECRET are unset. There is no fallback — without them the application cannot retrieve any orders at all.",
    });
  } else if (
    (process.env.EBAY_ENVIRONMENT ?? "SANDBOX").toUpperCase() !== "PRODUCTION"
  ) {
    findings.push({
      severity: "blocker",
      title: "eBay is pointed at the sandbox",
      detail:
        "EBAY_ENVIRONMENT is not PRODUCTION. Sandbox orders are eBay test records: they would be written into the seller's real spreadsheet as though they were sales.",
    });
  }

  // The authorization-code flow cannot start without it — eBay takes an opaque
  // RuName as the redirect target, not a URL.
  if (ebayConfigured && !process.env.EBAY_RU_NAME?.trim()) {
    findings.push({
      severity: "blocker",
      title: "EBAY_RU_NAME is not set",
      detail:
        "eBay's OAuth flow redirects to a RuName, not a URL. Without it the Connect eBay button has nowhere to send the seller and no account can ever be linked.",
    });
  }

  // --- Background work -----------------------------------------------------
  if (!process.env.CRON_SECRET?.trim()) {
    findings.push({
      severity: "warning",
      title: "CRON_SECRET is not set",
      detail:
        "The /api/jobs/tick endpoint stays disabled. Scheduled syncs will only run if the long-running worker (npm run worker) is running instead.",
    });
  }

  // --- Database ------------------------------------------------------------
  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (databaseUrl.startsWith("file:")) {
    findings.push({
      severity: "warning",
      title: "Running on SQLite",
      detail:
        "Fine for a single instance on a persistent disk. It will not survive a platform with an ephemeral filesystem, and it cannot be shared across instances — the sync mutex assumes one database.",
    });
  }

  return findings;
}

/** Prints the findings; returns true when a blocker was present. */
export function reportProductionReadiness(): boolean {
  const findings = checkProductionReadiness();
  if (findings.length === 0) return false;

  const blockers = findings.filter((f) => f.severity === "blocker");

  for (const finding of findings) {
    const label = finding.severity === "blocker" ? "BLOCKER" : "warning";
    console.warn(`[readiness] ${label}: ${finding.title}\n            ${finding.detail}`);
  }

  if (blockers.length > 0) {
    console.error(
      `[readiness] ${blockers.length} blocker(s) must be fixed before this deployment is safe to use.`,
    );
  }

  return blockers.length > 0;
}
