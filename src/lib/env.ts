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

/**
 * A non-boolean setting — a credential, a URL, an identifier — with the
 * wrapping a hosting dashboard tends to leave behind.
 *
 * Same reasoning as the boolean reader below, and the same bug: a value
 * pasted into Vercel as "GOCSPX-…" keeps its quote characters, and a
 * credential sent to Google or eBay with quotes around it is rejected with an
 * error that names neither the variable nor the quotes. Returns undefined for
 * a value that is empty once trimmed, so callers can keep using `??` and
 * truthiness checks unchanged.
 */
export function envValue(
  name: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const cleaned = raw
    .trim()
    .replace(/^(['"])(.*)\1$/s, "$2")
    .trim();
  return cleaned === "" ? undefined : cleaned;
}

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
 * Variables the major hosting platforms inject into every build and runtime.
 * None of them are ours, and none need to be set by hand — their presence is
 * the signal.
 */
const PLATFORM_MARKERS = [
  "VERCEL", // Vercel
  "RENDER", // Render
  "RAILWAY_ENVIRONMENT", // Railway
  "FLY_APP_NAME", // Fly.io
  "NETLIFY", // Netlify
  "DYNO", // Heroku
  "CF_PAGES", // Cloudflare Pages
];

/**
 * Whether this process runs on a managed hosting platform.
 *
 * It exists for one reason: telling an operator to "set X in .env and restart
 * the server" is actively wrong on Vercel, where there is no .env file, no
 * server to restart, and — the part that costs the most time — variables added
 * after a deployment was created do not reach it until the next deploy. The
 * instruction has to change with the environment or it sends people looking
 * for a file that does not exist.
 *
 * A self-hosted production box is deliberately *not* hosted by this
 * definition: there, .env and a restart is exactly right.
 */
export function isHostedDeployment(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return PLATFORM_MARKERS.some((name) => {
    const value = env[name];
    return value !== undefined && value.trim() !== "";
  });
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
