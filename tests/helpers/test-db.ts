/**
 * Isolated SQLite database for integration tests.
 *
 * Must be called (and its env applied) before anything imports `@/lib/db`,
 * because the Prisma client reads DATABASE_URL when it is constructed.
 *
 * Each test *file* passes its own `name`: `node --test` runs files in
 * parallel processes, so a shared database file would have them racing to
 * drop and recreate the same schema.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const ACTIVE_SCHEMA = path.join(ROOT, "prisma", "schema.active.prisma");

let preparedName: string | null = null;

/** Sets the env the app reads, then creates a fresh schema for this file. */
export function setupTestDatabase(name = "default"): void {
  if (preparedName === name) return;

  const dbPath = path.join(ROOT, "prisma", `test-${name}.db`);

  process.env.DATABASE_URL = `file:${dbPath.replace(/\\/g, "/")}`;
  process.env.AUTH_SECRET =
    "test-secret-that-is-comfortably-longer-than-32-chars";
  process.env.EBAY_CLIENT_ID = "test-client-id";
  process.env.EBAY_CLIENT_SECRET = "test-client-secret";
  process.env.EBAY_RU_NAME = "Test-RuName-PRD-abcdef123-456789";
  process.env.EBAY_ENVIRONMENT = "SANDBOX";
  // Keep tests fast: no artificial pacing, minimal retry sleeps.
  process.env.EBAY_MIN_REQUEST_INTERVAL_MS = "0";

  // Tests run on SQLite while the committed schema is Postgres, so they use
  // the generated working copy. `npm test` produces it via the pretest hook;
  // running a test file directly with `node --test` skips that, so say so
  // rather than failing inside Prisma with a confusing provider mismatch.
  if (!existsSync(ACTIVE_SCHEMA)) {
    throw new Error(
      "prisma/schema.active.prisma is missing. Run `npm test` (its pretest " +
        "hook generates it), or `node scripts/prepare-schema.mjs && npx prisma " +
        "generate --schema prisma/schema.active.prisma` before running a test " +
        "file directly.",
    );
  }

  const provider = readFileSync(ACTIVE_SCHEMA, "utf8")
    .match(/datasource\s+db\s*\{[^}]*?provider\s*=\s*"([^"]+)"/s)?.[1];
  if (provider !== "sqlite") {
    throw new Error(
      `Tests run on SQLite, but schema.active.prisma says "${provider}". ` +
        "That means DATABASE_URL pointed at a non-SQLite database when the " +
        "schema was prepared — check .env.",
    );
  }

  // A fresh file per run keeps runs independent of each other.
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const file = `${dbPath}${suffix}`;
    if (existsSync(file)) rmSync(file, { force: true });
  }

  // execSync (not execFileSync): Node on Windows refuses to spawn npx.cmd
  // directly, and execSync goes through a shell.
  execSync("npx prisma db push --schema prisma/schema.active.prisma --skip-generate", {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
    stdio: "pipe",
  });

  preparedName = name;
}
