/**
 * Google OAuth + API configuration.
 *
 * Server-only. The `assertServer()` guard makes an accidental import from a
 * client component fail loudly rather than leaking the client secret into a
 * browser bundle.
 */

export interface GoogleEndpoints {
  authorize: string;
  token: string;
  revoke: string;
  userinfo: string;
  drive: string;
  sheets: string;
}

export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  authorize: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  revoke: "https://oauth2.googleapis.com/revoke",
  userinfo: "https://openidconnect.googleapis.com/v1/userinfo",
  drive: "https://www.googleapis.com",
  sheets: "https://sheets.googleapis.com",
};

/* -------------------------------------------------------------------------- */
/* Scopes                                                                      */
/* -------------------------------------------------------------------------- */

/** Who the connected account is, for the settings panel. */
export const SCOPE_IDENTITY = ["openid", "email", "profile"];

/**
 * Lists the user's spreadsheets. `drive.metadata.readonly` can read file
 * names and ids but *not* file contents, and cannot modify or delete
 * anything — deliberately the narrowest scope that supports a picker.
 */
export const SCOPE_DRIVE_LIST =
  "https://www.googleapis.com/auth/drive.metadata.readonly";

/** Read cell values (header rows) without any write capability. */
export const SCOPE_SHEETS_READ =
  "https://www.googleapis.com/auth/spreadsheets.readonly";

/**
 * Read + write cell values. Phase 4 needs this to append order rows.
 *
 * It is requested now, by default, so the user consents once rather than
 * being sent back through the consent screen next phase. Set
 * GOOGLE_REQUEST_WRITE_SCOPE=false to request read-only instead — everything
 * in Phase 3 works either way, because nothing in this phase writes.
 */
export const SCOPE_SHEETS_WRITE =
  "https://www.googleapis.com/auth/spreadsheets";

export function writeScopeRequested(): boolean {
  return (
    (process.env.GOOGLE_REQUEST_WRITE_SCOPE ?? "true").toLowerCase() !== "false"
  );
}

export function getGoogleScopes(): string[] {
  return [
    ...SCOPE_IDENTITY,
    SCOPE_DRIVE_LIST,
    writeScopeRequested() ? SCOPE_SHEETS_WRITE : SCOPE_SHEETS_READ,
  ];
}

/** Does a granted scope string cover reading spreadsheet values? */
export function grantsSheetsRead(granted: string | null | undefined): boolean {
  if (!granted) return false;
  const scopes = granted.split(/\s+/);
  return (
    scopes.includes(SCOPE_SHEETS_WRITE) || scopes.includes(SCOPE_SHEETS_READ)
  );
}

/** Does a granted scope string allow writing? Phase 4 will require this. */
export function grantsSheetsWrite(granted: string | null | undefined): boolean {
  if (!granted) return false;
  return granted.split(/\s+/).includes(SCOPE_SHEETS_WRITE);
}

export function grantsDriveList(granted: string | null | undefined): boolean {
  if (!granted) return false;
  const scopes = granted.split(/\s+/);
  return (
    scopes.includes(SCOPE_DRIVE_LIST) ||
    scopes.includes("https://www.googleapis.com/auth/drive.readonly") ||
    scopes.includes("https://www.googleapis.com/auth/drive")
  );
}

/* -------------------------------------------------------------------------- */
/* Credentials                                                                 */
/* -------------------------------------------------------------------------- */

export interface GoogleCredentials {
  clientId: string;
  clientSecret: string;
  /** Must exactly match an Authorized redirect URI in the Cloud console. */
  redirectUri: string;
  endpoints: GoogleEndpoints;
}

function assertServer() {
  if (typeof window !== "undefined") {
    throw new Error(
      "src/lib/google/config.ts was imported into client code. Google credentials must never reach the browser.",
    );
  }
}

function defaultRedirectUri(): string {
  const base = (process.env.APP_URL ?? "http://localhost:3000").replace(
    /\/+$/,
    "",
  );
  return `${base}/api/auth/google/callback`;
}

/** Returns null (rather than throwing) when the app is not configured. */
export function getGoogleCredentials(): GoogleCredentials | null {
  assertServer();

  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;

  return {
    clientId,
    clientSecret,
    redirectUri: process.env.GOOGLE_REDIRECT_URI?.trim() || defaultRedirectUri(),
    endpoints: GOOGLE_ENDPOINTS,
  };
}

export function isGoogleConfigured(): boolean {
  return getGoogleCredentials() !== null;
}

export function missingGoogleCredentials(): string[] {
  const missing: string[] = [];
  if (!process.env.GOOGLE_CLIENT_ID?.trim()) missing.push("GOOGLE_CLIENT_ID");
  if (!process.env.GOOGLE_CLIENT_SECRET?.trim()) {
    missing.push("GOOGLE_CLIENT_SECRET");
  }
  return missing;
}

/** Shown on the settings page so the console entry can be copied exactly. */
export function expectedRedirectUri(): string {
  return process.env.GOOGLE_REDIRECT_URI?.trim() || defaultRedirectUri();
}
