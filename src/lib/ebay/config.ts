/**
 * eBay environment configuration.
 *
 * Credentials are read from the server environment only. Nothing in this file
 * is importable from a client component — the `assertServer()` guard below
 * makes an accidental import fail loudly rather than leaking a secret into a
 * browser bundle.
 */

import { envValue } from "@/lib/env";

export type EbayEnvironment = "SANDBOX" | "PRODUCTION";

export interface EbayEndpoints {
  /** Where the seller is sent to grant consent. */
  authorize: string;
  /** Token exchange + refresh. */
  token: string;
  /** REST API base: Sell APIs, Fulfillment, everything order-related. */
  api: string;
  /**
   * The *other* REST base, for the Commerce Identity API.
   *
   * eBay serves getUser from apiz.ebay.com, not api.ebay.com, and does not
   * redirect between them — api.ebay.com answers /commerce/identity/v1/user/
   * with a bare 404, which reads as "this endpoint was removed" rather than
   * "you asked the wrong host". Checked on 23 September 2026: the same path
   * returns 401 on apiz (route exists, token rejected) and 404 on api, in
   * both production and sandbox.
   */
  apiz: string;
}

const ENDPOINTS: Record<EbayEnvironment, EbayEndpoints> = {
  SANDBOX: {
    authorize: "https://auth.sandbox.ebay.com/oauth2/authorize",
    token: "https://api.sandbox.ebay.com/identity/v1/oauth2/token",
    api: "https://api.sandbox.ebay.com",
    apiz: "https://apiz.sandbox.ebay.com",
  },
  PRODUCTION: {
    authorize: "https://auth.ebay.com/oauth2/authorize",
    token: "https://api.ebay.com/identity/v1/oauth2/token",
    api: "https://api.ebay.com",
    apiz: "https://apiz.ebay.com",
  },
};

/**
 * Where a seller grants consent, per marketplace.
 *
 * eBay does not run one consent page. A British seller signs in on
 * ebay.co.uk, an Australian seller on ebay.com.au, and sending either to
 * auth.ebay.com lands them on the wrong sign-in form — the marketplace
 * selector on the connect screen looked broken for exactly this reason: it
 * was recorded against the connection but never reached the consent URL.
 *
 * The token endpoint is NOT per-marketplace. api.ebay.com issues tokens for
 * every site, so only the authorize host varies.
 *
 * Every hostname here was checked on 23 September 2026 and answered with a
 * 302 to its sign-in page. Sandbox deliberately has no per-marketplace entry:
 * auth.sandbox.ebay.co.uk and auth.sandbox.ebay.de do not resolve at all, so
 * every sandbox consent goes to auth.sandbox.ebay.com.
 */
const PRODUCTION_CONSENT_HOSTS: Record<string, string> = {
  EBAY_US: "auth.ebay.com",
  EBAY_GB: "auth.ebay.co.uk",
  EBAY_DE: "auth.ebay.de",
  EBAY_AU: "auth.ebay.com.au",
  EBAY_CA: "auth.ebay.ca",
  EBAY_FR: "auth.ebay.fr",
  EBAY_IT: "auth.ebay.it",
  EBAY_ES: "auth.ebay.es",
  EBAY_IE: "auth.ebay.ie",
  EBAY_AT: "auth.ebay.at",
  EBAY_CH: "auth.ebay.ch",
  EBAY_BE: "auth.befr.ebay.be",
  EBAY_NL: "auth.ebay.nl",
  EBAY_PL: "auth.ebay.pl",
  EBAY_HK: "auth.ebay.com.hk",
  EBAY_SG: "auth.ebay.com.sg",
  EBAY_MY: "auth.ebay.com.my",
  EBAY_PH: "auth.ebay.ph",
  EBAY_IN: "auth.ebay.in",
};

/**
 * The consent URL for one marketplace, falling back to the environment's
 * default host when the marketplace is unknown.
 *
 * Falling back rather than throwing is deliberate: an unrecognised
 * marketplace id should still let the seller connect on eBay's main site,
 * which is strictly better than a 500 on the connect button.
 */
export function authorizeEndpoint(
  environment: EbayEnvironment,
  marketplaceId?: string | null,
): string {
  if (environment === "SANDBOX") return ENDPOINTS.SANDBOX.authorize;
  const host = PRODUCTION_CONSENT_HOSTS[(marketplaceId ?? "").toUpperCase()];
  return host ? `https://${host}/oauth2/authorize` : ENDPOINTS.PRODUCTION.authorize;
}

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
  // Read through envValue, which strips the quotes a hosting dashboard leaves
  // on a pasted value. eBay answers a quoted Cert ID with invalid_client,
  // which reads exactly like a wrong credential.
  const clientId = envValue("EBAY_CLIENT_ID");
  const clientSecret = envValue("EBAY_CLIENT_SECRET");
  // EBAY_RU_NAME is the correct variable; EBAY_REDIRECT_URI is accepted as a
  // fallback so an existing .env keeps working.
  const redirectUri = envValue("EBAY_RU_NAME") ?? envValue("EBAY_REDIRECT_URI");

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
  if (!envValue("EBAY_CLIENT_ID")) missing.push("EBAY_CLIENT_ID");
  if (!envValue("EBAY_CLIENT_SECRET")) missing.push("EBAY_CLIENT_SECRET");
  if (!envValue("EBAY_RU_NAME") && !envValue("EBAY_REDIRECT_URI")) {
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

/**
 * Marketplaces the connect screen offers.
 *
 * This list is exactly the set with a consent host in
 * PRODUCTION_CONSENT_HOSTS above. Offering a marketplace with no consent host
 * would silently send the seller to auth.ebay.com — the very bug this pairing
 * exists to prevent — so the two are kept in step by the test suite.
 */
export const EBAY_MARKETPLACE_OPTIONS = [
  { id: "EBAY_US", label: "United States (ebay.com)" },
  { id: "EBAY_GB", label: "United Kingdom (ebay.co.uk)" },
  { id: "EBAY_DE", label: "Germany (ebay.de)" },
  { id: "EBAY_AU", label: "Australia (ebay.com.au)" },
  { id: "EBAY_CA", label: "Canada (ebay.ca)" },
  { id: "EBAY_FR", label: "France (ebay.fr)" },
  { id: "EBAY_IT", label: "Italy (ebay.it)" },
  { id: "EBAY_ES", label: "Spain (ebay.es)" },
  { id: "EBAY_IE", label: "Ireland (ebay.ie)" },
  { id: "EBAY_AT", label: "Austria (ebay.at)" },
  { id: "EBAY_CH", label: "Switzerland (ebay.ch)" },
  { id: "EBAY_BE", label: "Belgium (befr.ebay.be)" },
  { id: "EBAY_NL", label: "Netherlands (ebay.nl)" },
  { id: "EBAY_PL", label: "Poland (ebay.pl)" },
  { id: "EBAY_IN", label: "India (ebay.in)" },
  { id: "EBAY_HK", label: "Hong Kong (ebay.com.hk)" },
  { id: "EBAY_SG", label: "Singapore (ebay.com.sg)" },
  { id: "EBAY_MY", label: "Malaysia (ebay.com.my)" },
  { id: "EBAY_PH", label: "Philippines (ebay.ph)" },
] as const;

/** Exported for the test that keeps the two lists in step. */
export const EBAY_CONSENT_HOSTS = PRODUCTION_CONSENT_HOSTS;
