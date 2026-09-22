/**
 * Reading boolean configuration from the environment.
 *
 * Hosting dashboards are free-text fields. A value typed into Vercel, Railway
 * or a systemd unit arrives as whatever the operator pasted, and the three
 * things that actually happen in practice are:
 *
 *   SINGLE_USER_MODE="true"   → the quotes are part of the value
 *   SINGLE_USER_MODE=true␠    → a trailing space or newline
 *   SINGLE_USER_MODE=TRUE     → different case
 *
 * An exact `=== "true"` comparison rejects the first and third of those, and
 * the operator is then looking at a dashboard that plainly says `true` while
 * the application insists it is unset. That is a bad way to spend an evening,
 * so the reader is deliberately tolerant about *spelling* while staying strict
 * about *intent*: only affirmative values enable a flag, and anything
 * unrecognised is false rather than assumed.
 */

const TRUE_VALUES = new Set(["true", "1", "yes", "on", "enabled"]);
const FALSE_VALUES = new Set(["false", "0", "no", "off", "disabled", ""]);

/** Strips surrounding quotes and whitespace. */
function normalize(raw: string | undefined): string {
  if (raw === undefined) return "";
  return raw
    .trim()
    .replace(/^(['"])(.*)\1$/s, "$2")
    .trim()
    .toLowerCase();
}

export type FlagVerdict = "enabled" | "disabled" | "absent" | "unrecognised";

export interface FlagReading {
  enabled: boolean;
  verdict: FlagVerdict;
  /** The value after quote/whitespace stripping, for diagnostics. */
  normalized: string;
  /** Whether the variable existed at all, however it was spelled. */
  present: boolean;
}

/**
 * Reads a boolean flag and reports *why* it came out the way it did.
 *
 * The verdict matters: "absent" and "unrecognised" are different operator
 * problems — one is a variable that never reached the runtime, the other is a
 * variable that arrived with a value nobody meant.
 */
export function readFlag(
  name: string,
  env: Record<string, string | undefined> = process.env,
): FlagReading {
  const raw = env[name];
  const normalized = normalize(raw);
  const present = raw !== undefined && raw.trim() !== "";

  if (!present) {
    return { enabled: false, verdict: "absent", normalized, present: false };
  }
  if (TRUE_VALUES.has(normalized)) {
    return { enabled: true, verdict: "enabled", normalized, present: true };
  }
  if (FALSE_VALUES.has(normalized)) {
    return { enabled: false, verdict: "disabled", normalized, present: true };
  }
  return { enabled: false, verdict: "unrecognised", normalized, present: true };
}

/** Convenience for the common case where only the boolean matters. */
export function envFlag(
  name: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return readFlag(name, env).enabled;
}

/**
 * One sentence describing what the runtime actually saw, for an error the
 * operator has to act on.
 *
 * These flags are configuration switches, not credentials, so echoing the
 * value back is the fastest way to end a "but I set it" argument. Never use
 * this for a secret.
 */
export function describeFlag(name: string, reading: FlagReading): string {
  switch (reading.verdict) {
    case "enabled":
      return `${name} is enabled.`;
    case "disabled":
      return `${name} is present but set to "${reading.normalized}".`;
    case "unrecognised":
      return `${name} is set to "${reading.normalized}", which is not a recognised yes/no value. Use true or false.`;
    case "absent":
    default:
      return `${name} is not set in this running process. If you added it to your hosting provider after the last deploy, redeploy — environment variables are applied to a deployment when it is created, not retroactively.`;
  }
}
