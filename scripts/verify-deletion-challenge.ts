/**
 * Checks the eBay account-deletion challenge locally, before registering the
 * endpoint with eBay.
 *
 *   npm run ebay:verify-deletion
 *   npm run ebay:verify-deletion -- --url http://localhost:3000/api/ebay/marketplace-account-deletion
 *
 * With no --url it only computes the expected hash from your environment, so
 * you can confirm the configuration without a server running. With --url it
 * also calls that endpoint and compares the answer, which is the same check
 * eBay performs — if this passes against your public HTTPS URL, eBay's
 * validation will pass too.
 *
 * It prints the token's length, never the token.
 */

import { randomBytes } from "node:crypto";
import path from "node:path";

import { loadEnvConfig } from "@next/env";

// A standalone script does not get Next's environment for free. Use Next's
// own loader rather than reading .env by hand, so this sees exactly the same
// values the running app does — including .env.local and .env.production.
loadEnvConfig(path.resolve(import.meta.dirname, ".."), true, {
  info: () => {},
  error: console.error,
});

import {
  computeChallengeResponse,
  describeEndpointProblem,
  readDeletionConfig,
} from "../src/lib/ebay/account-deletion";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const target = arg("url");

  // Which endpoint string goes into the hash.
  //
  // It must be the URL registered with eBay, which — when checking a remote
  // deployment — is the URL being called, NOT whatever the local .env happens
  // to say. Hashing the local value while calling a remote server compares two
  // different configurations and always reports a mismatch, which is exactly
  // the false alarm this tool is supposed to prevent.
  const { config, problem } = readDeletionConfig();

  const endpointUrl =
    arg("endpoint") ?? (target ? target.split("?")[0] : config?.endpointUrl);

  // --token lets a remote deployment be checked without mirroring its token
  // locally. Falls back to the local one for checking a local server.
  const verificationToken = arg("token") ?? config?.verificationToken;

  if (!endpointUrl || !verificationToken) {
    const detail = problem
      ? `${problem.code}: ${problem.message}`
      : "No endpoint or token available.";
    console.error(
      `\n  ✗ ${detail}\n\n` +
        "    Pass --token and --endpoint to check a deployment whose\n" +
        "    configuration differs from this machine's .env.\n",
    );
    process.exitCode = 1;
    return;
  }

  // A random code per run, exactly as eBay generates one per call.
  const challengeCode = arg("challenge") ?? randomBytes(16).toString("hex");

  const expected = computeChallengeResponse(
    challengeCode,
    verificationToken,
    endpointUrl,
  );

  const endpointSource = arg("endpoint")
    ? "--endpoint"
    : target
      ? "derived from --url"
      : ".env";
  const tokenSource = arg("token") ? "--token" : ".env";

  console.log("\n  eBay account-deletion challenge\n");
  console.log(`    endpoint        ${endpointUrl}   (${endpointSource})`);
  console.log(
    `    token           ${verificationToken.length} characters, not shown   (${tokenSource})`,
  );
  console.log(`    challenge_code  ${challengeCode}`);
  console.log(`    expected hash   ${expected}`);

  // The endpoint URL is hashed, so a value eBay cannot reach still produces a
  // hash — it just never matches. Say so rather than letting it look fine.
  const endpointWarning = describeEndpointProblem(endpointUrl, "production");
  if (endpointWarning) {
    console.log(`\n    ! ${endpointWarning}`);
    console.log(
      "      (Fine while testing locally; eBay will reject it in production.)",
    );
  }

  if (!target) {
    console.log(
      "\n  Pass --url <endpoint> to call a running server and compare.\n",
    );
    return;
  }

  const callUrl = `${target}${target.includes("?") ? "&" : "?"}challenge_code=${encodeURIComponent(challengeCode)}`;
  console.log(`\n  Calling ${target} …`);

  let response: Response;
  try {
    response = await fetch(callUrl, { headers: { accept: "application/json" } });
  } catch (error) {
    console.error(
      `\n  ✗ Could not reach the endpoint: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const contentType = response.headers.get("content-type") ?? "(none)";
  const text = await response.text();

  console.log(`    status        ${response.status}`);
  console.log(`    content-type  ${contentType}`);

  if (response.status !== 200) {
    console.error(`\n  ✗ Expected 200. Body:\n    ${text.slice(0, 400)}`);

    if (text.includes("ENDPOINT_INVALID")) {
      console.error(
        "\n    The server is running in production mode, where a localhost or\n" +
          "    plain-HTTP endpoint is refused on purpose — eBay could never\n" +
          "    reach it. To test the challenge locally, either:\n" +
          "      • run the dev server (npm run dev), which allows localhost, or\n" +
          "      • point a tunnel at this app and set\n" +
          "        EBAY_MARKETPLACE_DELETION_ENDPOINT to the tunnel's HTTPS URL.",
      );
    }

    console.error("");
    process.exitCode = 1;
    return;
  }

  if (!/application\/json/i.test(contentType)) {
    console.error(
      `\n  ✗ Expected Content-Type: application/json, got ${contentType}\n`,
    );
    process.exitCode = 1;
    return;
  }

  let actual: string | undefined;
  try {
    actual = (JSON.parse(text) as { challengeResponse?: string })
      .challengeResponse;
  } catch {
    console.error(`\n  ✗ Response was not valid JSON:\n    ${text.slice(0, 400)}\n`);
    process.exitCode = 1;
    return;
  }

  if (actual === expected) {
    console.log(
      "\n  ✓ The endpoint returned the expected challengeResponse.\n" +
        "    eBay's validation will pass, provided it is calling this same URL.\n",
    );
    return;
  }

  console.error("\n  ✗ Hash mismatch.");
  console.error(`      expected  ${expected}`);
  console.error(`      received  ${actual ?? "(no challengeResponse field)"}`);
  console.error(
    "\n    The usual cause is EBAY_MARKETPLACE_DELETION_ENDPOINT not matching\n" +
      "    the URL registered with eBay character for character — check the\n" +
      "    scheme, a trailing slash, and the host.\n",
  );
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
