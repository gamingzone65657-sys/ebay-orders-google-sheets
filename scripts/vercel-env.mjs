/**
 * Prints the exact environment variables to paste into a hosting dashboard.
 *
 *   node scripts/vercel-env.mjs https://your-app.vercel.app
 *
 * The values that must match an external system character for character — the
 * two OAuth redirect URIs and the account-deletion endpoint — are derived from
 * the domain rather than typed, because a single wrong character there fails
 * at consent time with an error that names neither the variable nor the
 * mismatch. Everything else is copied from the local .env, so the production
 * deployment gets the credentials that are already known to work.
 *
 * Secrets are printed in full: they are going straight into a secret manager,
 * and a half-shown value cannot be pasted.
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const raw = process.argv[2];
if (!raw) {
  console.error(
    "\n  Usage: node scripts/vercel-env.mjs https://your-app.vercel.app\n\n" +
      "  Use the stable Production domain from Vercel (Project -> Domains),\n" +
      "  not a per-deployment URL with a random hash in it — those change on\n" +
      "  every push and would break the OAuth redirects immediately.\n",
  );
  process.exit(1);
}

let origin;
try {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("must be https");
  origin = url.origin;
} catch {
  console.error(`\n  "${raw}" is not a valid https URL.\n`);
  process.exit(1);
}

if (/-[a-z0-9]{8,}-/.test(new URL(origin).hostname)) {
  console.warn(
    "\n  ! That hostname looks like a per-deployment URL (it contains a random\n" +
      "    hash). Those change on every deploy. Use the Production domain.\n",
  );
}

/** Reads a value out of the local .env, if it has one. */
const env = (() => {
  try {
    return readFileSync(path.join(ROOT, ".env"), "utf8");
  } catch {
    return "";
  }
})();

function local(name) {
  const match = env.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`, "m"));
  if (!match) return "";
  return match[1].trim().replace(/^["']|["']$/g, "");
}

const rows = [
  ["APP_URL", origin, "Public origin. OAuth redirects derive from it."],
  ["AUTH_SECRET", local("AUTH_SECRET") || randomBytes(48).toString("base64url"),
   "Encrypts stored tokens. Set once; changing it forces every reconnect."],
  ["DATABASE_URL", local("DATABASE_URL").startsWith("postgres") ? local("DATABASE_URL") : "<your Neon pooled URL>",
   "Pooled Postgres URL. SQLite cannot work on Vercel."],
  ["SINGLE_USER_MODE", "true",
   "No sign-in exists yet; without this every request is refused."],

  ["GOOGLE_CLIENT_ID", local("GOOGLE_CLIENT_ID"), "From Google Cloud credentials."],
  ["GOOGLE_CLIENT_SECRET", local("GOOGLE_CLIENT_SECRET"), "From Google Cloud credentials."],
  ["GOOGLE_REDIRECT_URI", `${origin}/api/auth/google/callback`,
   "MUST match an Authorized redirect URI in Google Cloud exactly."],

  ["EBAY_ENVIRONMENT", "PRODUCTION", "Sandbox in production is a startup blocker."],
  ["EBAY_CLIENT_ID", local("EBAY_CLIENT_ID"), "eBay App ID."],
  ["EBAY_CLIENT_SECRET", local("EBAY_CLIENT_SECRET"), "eBay Cert ID, copied whole from the developer portal."],
  ["EBAY_RU_NAME", local("EBAY_RU_NAME"), "eBay redirects to a RuName, not a URL. Without it consent returns no code."],

  ["EBAY_MARKETPLACE_DELETION_VERIFICATION_TOKEN",
   local("EBAY_MARKETPLACE_DELETION_VERIFICATION_TOKEN"),
   "Must match the token entered in the eBay developer portal."],
  ["EBAY_MARKETPLACE_DELETION_ENDPOINT",
   `${origin}/api/ebay/marketplace-account-deletion`,
   "Part of the challenge hash — must match eBay exactly."],

  ["CRON_SECRET", local("CRON_SECRET") || randomBytes(24).toString("base64url"),
   "Enables POST /api/jobs/tick for scheduled syncs, and GET /api/health."],

  ["PRIVACY_OPERATOR_NAME", local("PRIVACY_OPERATOR_NAME"),
   "Named as the data controller on the public /privacy-policy page."],
  ["PRIVACY_CONTACT_EMAIL", local("PRIVACY_CONTACT_EMAIL"),
   "Where privacy and deletion requests go. eBay and Google both expect one."],
];

console.log("\n  Paste these into Vercel -> Settings -> Environment Variables");
console.log("  Scope: Production (tick Preview too if you use preview deploys)\n");

const problems = [];
for (const [name, value, note] of rows) {
  const shown = value === "" ? "<<< MISSING — see below >>>" : value;
  console.log(`${name}=${shown}`);
  if (value === "") problems.push([name, note]);
}

console.log("\n  ── Notes ──────────────────────────────────────────────────\n");
for (const [name, , note] of rows) console.log(`  ${name}\n      ${note}`);

if (problems.length > 0) {
  console.log("\n  ── Still needed ───────────────────────────────────────────\n");
  for (const [name, note] of problems) console.log(`  ${name}\n      ${note}`);
}

console.log("\n  Also register these callback URLs with the providers:\n");
console.log(`    Google Cloud  -> Authorized redirect URI`);
console.log(`                     ${origin}/api/auth/google/callback`);
console.log(`    eBay RuName   -> Your auth accepted URL`);
console.log(`                     ${origin}/api/auth/ebay/callback`);
console.log(`    eBay deletion -> Marketplace Account Deletion endpoint`);
console.log(`                     ${origin}/api/ebay/marketplace-account-deletion\n`);
console.log("  After saving the variables, REDEPLOY — Vercel applies them when a");
console.log("  deployment is created, not to deployments that already exist.\n");
