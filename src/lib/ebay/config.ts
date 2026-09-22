/**
 * eBay environment configuration.
 *
 * Credentials are read from the server environment only. Nothing in this file
 * is importable from a client component — the `assertServer()` guard below
 * makes an accidental import fail loudly rather than leaking a secret into a
 * browser bundle.
 */

export type EbayEnvironment = "SANDBOX" | "PRODUCTION";

export interface EbayEndpoints {
  /** Where the seller is sent to grant consent. */
  authorize: string;
  /** Token exchange + refresh. */
  token: string;
  /** REST API base. */
  api: string;
}

const ENDPOINTS: Record<EbayEnvironment, EbayEndpoints> = {
  SANDBOX: {
    authorize: "https://auth.sandbox.ebay.com/oauth2/authorize",
    token: "https://api.sandbox.ebay.com/identity/v1/oauth2/token",
    api: "https://api.sandbox.ebay.com",
  },
  PRODUCTION: {
    authorize: "https://auth.ebay.com/oauth2/authorize",
    token: "https://api.ebay.com/identity/v1/oauth2/token",
    api: "https://api.ebay.com",
  },
};

/**
 * Scopes requested at consent time.
 *
 * `sell.fulfillment.readonly` covers getOrders and getShippingFulfillments,
 * which is everything this phase needs to read orders. Read-only by design:
 * the app has no reason to be able to modify a seller's orders.
 *
 * `commerce.identity.readonly` is what lets the account panel show the
 * seller's eBay username rather than an opaque seller id. It is requested by
 * default but can be dropped with EBAY_REQUEST_IDENTITY_SCOPE=false if a
 * keyset does not have it enabled (eBay rejects the whole consent request
 * when an unavailable scope is asked for).
 */
export const EBAY_BASE_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly",
];

export const EBAY_IDENTITY_SCOPE =
  "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly";

export function identityScopeRequested(): boolean {
  return (process.env.EBAY_REQUEST_IDENTITY_SCOPE ?? "true").toLowerCase() !== "false";
}

export function getEbayScopes(): string[] {
  return identityScopeRequested()
    ? [...EBAY_BASE_SCOPES, EBAY_IDENTITY_SCOPE]
    : [...EBAY_BASE_SCOPES];
}

export interface EbayCredentials {
  clientId: string;
  clientSecret: string;
  /**
   * The value sent as the OAuth `redirect_uri` parameter.
   *
   * eBay is unusual here: for the authorization-code flow this is the
   * application's **RuName** (an opaque identifier from the developer
   * portal), not the literal callback URL. The actual callback URL is
   * configured against that RuName in eBay's portal and must point at
   * /api/auth/ebay/callback.
   */
  redirectUri: string;
  environment: EbayEnvironment;
  endpoints: EbayEndpoints;
}

function assertServer() {
  if (typeof window !== "undefined") {
    throw new Error(
      "src/lib/ebay/config.ts was imported into client code. eBay credentials must never reach the browser.",
    );
  }
}

export function resolveEnvironment(preferred?: string | null): EbayEnvironment {
  const value = (preferred ?? process.env.EBAY_ENVIRONMENT ?? "SANDBOX")
    .toString()
    .toUpperCase();
  return value === "PRODUCTION" ? "PRODUCTION" : "SANDBOX";
}

/** Returns null (rather than throwing) when the app has not been configured. */
export function getEbayCredentials(
  preferredEnvironment?: string | null,
): EbayCredentials | null {
  assertServer();

  const environment = resolveEnvironment(preferredEnvironment);
  const clientId = process.env.EBAY_CLIENT_ID?.trim();
  const clientSecret = process.env.EBAY_CLIENT_SECRET?.trim();
  // EBAY_RU_NAME is the correct variable; EBAY_REDIRECT_URI is accepted as a
  // fallback so an existing .env keeps working.
  const redirectUri = (
    process.env.EBAY_RU_NAME ?? process.env.EBAY_REDIRECT_URI
  )?.trim();

  if (!clientId || !clientSecret || !redirectUri) return null;

  return {
    clientId,
    clientSecret,
    redirectUri,
    environment,
    endpoints: ENDPOINTS[environment],
  };
}

export function getEndpoints(environment: EbayEnvironment): EbayEndpoints {
  return ENDPOINTS[environment];
}

/** True when OAuth can actually be attempted. Safe to call from a page. */
export function isEbayConfigured(): boolean {
  return getEbayCredentials() !== null;
}

/** Which credential variables are missing, for the settings page hint. */
export function missingEbayCredentials(): string[] {
  const missing: string[] = [];
  if (!process.env.EBAY_CLIENT_ID?.trim()) missing.push("EBAY_CLIENT_ID");
  if (!process.env.EBAY_CLIENT_SECRET?.trim()) missing.push("EBAY_CLIENT_SECRET");
  if (!process.env.EBAY_RU_NAME?.trim() && !process.env.EBAY_REDIRECT_URI?.trim()) {
    missing.push("EBAY_RU_NAME");
  }
  return missing;
}

export function basicAuthHeader(credentials: EbayCredentials): string {
  const encoded = Buffer.from(
    `${credentials.clientId}:${credentials.clientSecret}`,
    "utf8",
  ).toString("base64");
  return `Basic ${encoded}`;
}

/** Marketplaces the connect screen offers. eBay accepts many more. */
export const EBAY_MARKETPLACE_OPTIONS = [
  { id: "EBAY_US", label: "United States" },
  { id: "EBAY_GB", label: "United Kingdom" },
  { id: "EBAY_DE", label: "Germany" },
  { id: "EBAY_AU", label: "Australia" },
  { id: "EBAY_CA", label: "Canada" },
  { id: "EBAY_FR", label: "France" },
  { id: "EBAY_IT", label: "Italy" },
  { id: "EBAY_ES", label: "Spain" },
] as const;
