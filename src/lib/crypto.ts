import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * AES-256-GCM encryption for OAuth tokens at rest.
 *
 * Stored format: `v1:<iv-b64>:<authTag-b64>:<ciphertext-b64>`. The version
 * prefix means a future key rotation can decrypt old rows while writing new
 * ones in a newer format.
 *
 * The key is derived from AUTH_SECRET. A weak or missing secret is a hard
 * failure in production and a loud warning in development, because the
 * alternative — silently storing tokens in plaintext — is worse.
 */

const VERSION = "v1";
const IV_BYTES = 12;
const MIN_SECRET_LENGTH = 32;

let cachedKey: Buffer | null = null;
let warnedAboutSecret = false;

function resolveKey(): Buffer {
  if (cachedKey) return cachedKey;

  const secret = process.env.AUTH_SECRET ?? "";

  if (secret.length < MIN_SECRET_LENGTH) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        `AUTH_SECRET must be at least ${MIN_SECRET_LENGTH} characters to encrypt stored eBay tokens.`,
      );
    }
    if (!warnedAboutSecret) {
      warnedAboutSecret = true;
      console.warn(
        `[crypto] AUTH_SECRET is shorter than ${MIN_SECRET_LENGTH} characters. ` +
          "Tokens are still encrypted, but set a long random value before deploying.",
      );
    }
  }

  // SHA-256 gives a fixed 32-byte key from a variable-length secret.
  cachedKey = createHash("sha256").update(secret || "insecure-dev-secret").digest();
  return cachedKey;
}

/** Test seam: clears the memoised key after changing AUTH_SECRET. */
export function resetEncryptionKeyCache() {
  cachedKey = null;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", resolveKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64"),
    authTag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

export function decryptSecret(stored: string): string {
  const parts = stored.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Stored secret is not in the expected encrypted format.");
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    resolveKey(),
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** Never throws — returns null when a row is missing, corrupt, or key-rotated. */
export function tryDecryptSecret(stored: string | null | undefined): string | null {
  if (!stored) return null;
  try {
    return decryptSecret(stored);
  } catch {
    return null;
  }
}

/** Constant-time compare for the OAuth `state` parameter. */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
