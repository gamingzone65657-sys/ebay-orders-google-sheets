/**
 * Sets an account's password, against whatever DATABASE_URL points at.
 *
 *   npm run auth:set-password -- --email you@example.com --password '…'
 *   npm run auth:set-password -- --email you@example.com --generate
 *
 * This exists instead of a web-exposed "claim the owner account" flow.
 * The deployment already had a user row — the one holding the connected eBay
 * account — created before any sign-in screen existed, so it has no password.
 * Letting a visitor set one over HTTP would hand that workspace, and the
 * seller's eBay tokens, to whoever loaded the page first. Requiring the
 * database URL means only someone who already has it can do this.
 *
 * It never creates an account and never touches connections, orders or
 * tokens: one column on one existing row, plus the sessions that column
 * invalidates.
 */

import { randomBytes } from "node:crypto";

import { PrismaClient } from "@prisma/client";

import { MIN_PASSWORD_LENGTH, hashPassword, passwordProblem } from "@/lib/auth";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** Readable, and comfortably past the minimum. */
function generatePassword(): string {
  return randomBytes(18).toString("base64url");
}

async function main() {
  const email = arg("email")?.trim().toLowerCase();
  if (!email) {
    console.error(
      "\n  Usage: npm run auth:set-password -- --email you@example.com --password '…'\n" +
        "         npm run auth:set-password -- --email you@example.com --generate\n",
    );
    process.exit(1);
  }

  const generated = has("generate");
  const password = generated ? generatePassword() : arg("password");
  if (!password) {
    console.error("\n  Pass --password '…' or --generate.\n");
    process.exit(1);
  }

  const problem = passwordProblem(password);
  if (problem) {
    console.error(`\n  ${problem}\n`);
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      const known = await prisma.user.findMany({ select: { email: true } });
      console.error(
        `\n  No account with the email ${email}.\n\n  Accounts in this database:\n` +
          known.map((row) => `    ${row.email}`).join("\n") +
          "\n\n  This script only sets a password on an account that already\n" +
          "  exists — it will not create one.\n",
      );
      process.exit(1);
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(password) },
    });

    // A password change ends every existing session. Anyone still holding one
    // from before this ran — which, on a deployment that was serving one
    // shared workspace, is the whole point — is signed out.
    const { count } = await prisma.session.deleteMany({
      where: { userId: user.id },
    });

    console.log(`\n  Password set for ${user.email}`);
    console.log(`  Existing sessions ended: ${count}`);
    if (generated) {
      console.log(`\n  Password: ${password}`);
      console.log("  Store it somewhere safe. It is not recoverable.\n");
    } else {
      console.log("");
    }
    console.log(
      `  Passwords must be at least ${MIN_PASSWORD_LENGTH} characters.\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
