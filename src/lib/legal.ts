/**
 * Details the public legal pages need.
 *
 * Kept in configuration rather than written into the page, because a privacy
 * policy names a real operator and a real contact address. Whoever deploys
 * this is the data controller, not whoever wrote the code, so the values
 * cannot be hard-coded here — and an invented address on a privacy policy is
 * worse than none, since it promises a route for data requests that nobody
 * reads.
 */

export interface LegalContact {
  /** Who operates this deployment, as shown to a visitor. */
  operator: string;
  /** Where privacy and data requests go. Null when not configured. */
  email: string | null;
  /** Public origin, used for the canonical URL shown on the page. */
  appUrl: string;
}

export function legalContact(
  env: Record<string, string | undefined> = process.env,
): LegalContact {
  const email = env.PRIVACY_CONTACT_EMAIL?.trim();
  const operator = env.PRIVACY_OPERATOR_NAME?.trim();
  const appUrl = env.APP_URL?.trim().replace(/\/+$/, "");

  return {
    operator: operator && operator.length > 0 ? operator : "The operator of this application",
    email: email && email.length > 0 ? email : null,
    appUrl: appUrl && appUrl.length > 0 ? appUrl : "",
  };
}

/** Last substantive revision. Update when the policy's meaning changes. */
export const PRIVACY_POLICY_LAST_UPDATED = "23 September 2026";
