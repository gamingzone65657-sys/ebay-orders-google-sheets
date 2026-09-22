/**
 * Produces prisma/schema.active.prisma — the schema every Prisma command
 * actually uses — from the committed prisma/schema.prisma.
 *
 * Why this exists
 * ---------------
 * Prisma bakes the datasource provider into the generated client and the
 * provider line cannot be an environment variable, so one project that runs on
 * Postgres in production and SQLite in tests needs two schemas.
 *
 * The obvious approach — rewriting prisma/schema.prisma in place to match
 * DATABASE_URL — is a trap, and it already caused a production outage here:
 * running the test suite left the committed file saying `sqlite`, that state
 * got deployed, and every request on Vercel died with
 *
 *     Error validating datasource `db`: the URL must start with `file:`
 *
 * because the deployed schema disagreed with the deployed database.
 *
 * So the committed file is now never modified. It is the production schema and
 * it always says postgresql. This script copies it to a gitignored working
 * file, switching the provider only when DATABASE_URL points somewhere else.
 * Nothing a developer runs locally can change what gets deployed.
 */

import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "prisma", "schema.prisma");
const ACTIVE = path.join(ROOT, "prisma", "schema.active.prisma");

function providerFor(url) {
  if (!url) return null;
  const value = url.trim().replace(/^["']|["']$/g, "");
  if (value.startsWith("postgres://") || value.startsWith("postgresql://")) {
    return "postgresql";
  }
  if (value.startsWith("file:")) return "sqlite";
  if (value.startsWith("mysql://")) return "mysql";
  if (value.startsWith("sqlserver://")) return "sqlserver";
  return null;
}

/**
 * DATABASE_URL is often only in an env file when a script runs outside Next,
 * so fall back to reading them in Next's own precedence order.
 */
function databaseUrlFromEnvFiles() {
  for (const name of [".env.local", ".env.production", ".env"]) {
    try {
      const text = readFileSync(path.join(ROOT, name), "utf8");
      const match = text.match(/^\s*DATABASE_URL\s*=\s*(.+)$/m);
      if (match) return match[1].trim();
    } catch {
      // Absent on a hosting platform, where the variable is in the process env.
    }
  }
  return null;
}

const source = readFileSync(SOURCE, "utf8");
const committed = source.match(
  /datasource\s+db\s*\{[^}]*?provider\s*=\s*"([^"]+)"/s,
)?.[1];

const url = process.env.DATABASE_URL ?? databaseUrlFromEnvFiles();
const wanted = providerFor(url);

if (!wanted || wanted === committed) {
  // Nothing to change: copy verbatim so the active file always exists and is
  // always a faithful copy of what is committed.
  copyFileSync(SOURCE, ACTIVE);
  console.log(
    `[schema] using committed provider "${committed}"` +
      (wanted ? "" : " (DATABASE_URL missing or unrecognised)"),
  );
} else {
  const rewritten = source.replace(
    /(datasource\s+db\s*\{[^}]*?provider\s*=\s*)"[^"]+"/s,
    `$1"${wanted}"`,
  );
  if (rewritten === source) {
    console.error("[schema] could not find the datasource provider to switch.");
    process.exit(1);
  }
  writeFileSync(ACTIVE, rewritten);
  console.log(
    `[schema] committed schema is "${committed}"; this DATABASE_URL needs "${wanted}" — written to schema.active.prisma (committed file untouched).`,
  );
}
