/**
 * Whether this deployment lets a visitor create an account.
 *
 * Default: open. This application is multi-tenant by construction — every
 * query is scoped to a user id and a new account starts with an empty
 * workspace, no eBay connection and no orders — so a new sign-up sees nothing
 * belonging to anyone else.
 *
 * A deployment run for one seller should still close it, because the smallest
 * public surface is the right one. Set ALLOW_REGISTRATION=false and /register
 * refuses; existing accounts keep working, and the owner still signs in
 * normally.
 */
export function registrationOpen(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.ALLOW_REGISTRATION?.trim()
    .replace(/^(['"])(.*)\1$/s, "$2")
    .toLowerCase();
  if (raw === undefined || raw === "") return true;
  return !["false", "0", "no", "off", "disabled"].includes(raw);
}
