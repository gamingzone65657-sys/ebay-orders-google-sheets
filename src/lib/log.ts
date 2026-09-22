/**
 * Server-side logging that cannot print a credential.
 *
 * Errors thrown by HTTP clients routinely carry the request that produced
 * them, and that request carries an `Authorization` header or a
 * `?access_token=` query string. `console.error(error)` would put it in the
 * terminal and in whatever collects the terminal. Everything logged here goes
 * through the redaction in src/lib/mask.ts first.
 *
 * Nothing in this file decides *what* is worth logging — it only decides that
 * whatever is logged is safe to read.
 */

import { redactSecrets, redactSecretsInText } from "./mask";

interface SafeError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  cause?: unknown;
}

/** Flattens an unknown throw into a printable, redacted shape. */
export function describeForLog(error: unknown): SafeError {
  if (error instanceof Error) {
    const withCode = error as Error & { code?: unknown; cause?: unknown };
    return {
      name: error.name,
      message: redactSecretsInText(error.message),
      // Stack frames contain file paths and, for template-built URLs,
      // sometimes the URL itself.
      stack: error.stack ? redactSecretsInText(error.stack) : undefined,
      code: typeof withCode.code === "string" ? withCode.code : undefined,
      cause:
        withCode.cause === undefined
          ? undefined
          : withCode.cause instanceof Error
            ? describeForLog(withCode.cause)
            : redactSecrets(withCode.cause),
    };
  }

  if (typeof error === "string") {
    return { name: "Error", message: redactSecretsInText(error) };
  }

  return {
    name: "Error",
    message: "Non-error value thrown.",
    cause: redactSecrets(error),
  };
}

export function logError(scope: string, error: unknown): void {
  console.error(`[${scope}]`, describeForLog(error));
}

export function logWarn(scope: string, message: string): void {
  console.warn(`[${scope}] ${redactSecretsInText(message)}`);
}

export function logInfo(scope: string, message: string): void {
  console.log(`[${scope}] ${redactSecretsInText(message)}`);
}

/**
 * The operator-facing text for an error, safe to put in an API response, a
 * redirect parameter, or a stored `errorMessage` column.
 */
export function safeMessage(error: unknown, fallback = "Unexpected error."): string {
  if (error instanceof Error && error.message) {
    return redactSecretsInText(error.message);
  }
  if (typeof error === "string" && error) return redactSecretsInText(error);
  return fallback;
}
