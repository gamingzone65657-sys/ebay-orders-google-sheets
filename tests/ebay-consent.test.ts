/**
 * The consent URL and where a finished consent lands.
 *
 * Both of these were bugs a seller reported rather than something a test
 * caught: the marketplace selector was recorded against the connection but
 * never reached the consent URL, so every seller — British, Australian,
 * German — was sent to auth.ebay.com to sign in on the wrong site.
 *
 * Pure functions only. Nothing here touches the database or the network.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  authorizeEndpoint,
  EBAY_CONSENT_HOSTS,
  EBAY_MARKETPLACE_OPTIONS,
  getEndpoints,
  type EbayCredentials,
} from "@/lib/ebay/config";
import { buildAuthorizationUrl } from "@/lib/ebay/oauth";
import {
  OAUTH_POPUP_DONE_PATH,
  oauthOutcomeUrl,
} from "@/lib/ebay/oauth-state";

function credentials(
  environment: "SANDBOX" | "PRODUCTION" = "PRODUCTION",
): EbayCredentials {
  return {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "Some-RuName-abcdef",
    environment,
    endpoints: getEndpoints(environment),
  };
}

const ORIGIN = "https://example.test";

describe("consent host per marketplace", () => {
  it("sends each marketplace to its own eBay site", () => {
    // The three the seller named explicitly, spelled out rather than derived
    // from the same table the implementation reads.
    assert.equal(
      authorizeEndpoint("PRODUCTION", "EBAY_US"),
      "https://auth.ebay.com/oauth2/authorize",
    );
    assert.equal(
      authorizeEndpoint("PRODUCTION", "EBAY_GB"),
      "https://auth.ebay.co.uk/oauth2/authorize",
    );
    assert.equal(
      authorizeEndpoint("PRODUCTION", "EBAY_AU"),
      "https://auth.ebay.com.au/oauth2/authorize",
    );
    assert.equal(
      authorizeEndpoint("PRODUCTION", "EBAY_DE"),
      "https://auth.ebay.de/oauth2/authorize",
    );
    assert.equal(
      authorizeEndpoint("PRODUCTION", "EBAY_BE"),
      "https://auth.befr.ebay.be/oauth2/authorize",
    );
  });

  it("offers no marketplace it cannot route", () => {
    // The regression guard: adding a country to the dropdown without adding
    // its consent host would silently send that seller to auth.ebay.com.
    for (const option of EBAY_MARKETPLACE_OPTIONS) {
      assert.ok(
        EBAY_CONSENT_HOSTS[option.id],
        `${option.id} is offered on the connect screen but has no consent host`,
      );
    }
  });

  it("gives every marketplace a distinct host", () => {
    const hosts = Object.values(EBAY_CONSENT_HOSTS);
    assert.equal(
      new Set(hosts).size,
      hosts.length,
      "two marketplaces share a consent host, which is almost certainly a typo",
    );
  });

  it("falls back to eBay's main site rather than failing", () => {
    // Better a working sign-in on the wrong site than a 500 on the button.
    assert.equal(
      authorizeEndpoint("PRODUCTION", "EBAY_ATLANTIS"),
      "https://auth.ebay.com/oauth2/authorize",
    );
    assert.equal(
      authorizeEndpoint("PRODUCTION", null),
      "https://auth.ebay.com/oauth2/authorize",
    );
  });

  it("keeps sandbox on one host, because the others do not exist", () => {
    // auth.sandbox.ebay.co.uk and auth.sandbox.ebay.de do not resolve.
    for (const id of ["EBAY_US", "EBAY_GB", "EBAY_AU", "EBAY_DE"]) {
      assert.equal(
        authorizeEndpoint("SANDBOX", id),
        "https://auth.sandbox.ebay.com/oauth2/authorize",
        id,
      );
    }
  });

  it("carries the marketplace through to the built authorization URL", () => {
    const url = new URL(
      buildAuthorizationUrl(credentials(), "state-value", "EBAY_GB"),
    );
    assert.equal(url.host, "auth.ebay.co.uk");
    assert.equal(url.searchParams.get("state"), "state-value");
    assert.equal(url.searchParams.get("response_type"), "code");
    // eBay takes the RuName here, not a URL. See config.ts.
    assert.equal(url.searchParams.get("redirect_uri"), "Some-RuName-abcdef");
  });

  it("still builds a usable URL when no marketplace is given", () => {
    const url = new URL(buildAuthorizationUrl(credentials(), "state-value"));
    assert.equal(url.host, "auth.ebay.com");
  });
});

describe("where a consent outcome lands", () => {
  it("sends a popup to the page that closes itself", () => {
    const url = oauthOutcomeUrl(ORIGIN, true, { ebay: "connected" });
    assert.equal(url.pathname, OAUTH_POPUP_DONE_PATH);
    assert.equal(url.searchParams.get("ebay"), "connected");
    // The popup never shows the app shell, so there is nothing to anchor to.
    assert.equal(url.hash, "");
  });

  it("sends a same-tab consent back to settings, as before", () => {
    const url = oauthOutcomeUrl(ORIGIN, false, { ebay: "connected" });
    assert.equal(url.pathname, "/settings");
    assert.equal(url.hash, "#ebay");
  });

  it("carries an error and its detail either way", () => {
    for (const popup of [true, false]) {
      const url = oauthOutcomeUrl(ORIGIN, popup, {
        ebay_error: "OAUTH_FAILED",
        detail: "eBay did not return an authorization code.",
      });
      assert.equal(url.searchParams.get("ebay_error"), "OAUTH_FAILED");
      assert.match(url.searchParams.get("detail") ?? "", /authorization code/);
      assert.equal(url.origin, ORIGIN);
    }
  });
});
