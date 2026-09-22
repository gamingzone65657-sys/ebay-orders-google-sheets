/**
 * Masking for buyer personal data.
 *
 * The seller is entitled to see this data — it is their own order — so the
 * goal is not secrecy but exposure control: a support screen, a shared
 * display, or a screenshot should not leak a buyer's full address, phone, or
 * email by default. Values are masked server-side and only rendered in full
 * when the page is explicitly opened with `?reveal=1`.
 *
 * Masking happens at render time; the database keeps the real values because
 * Phase 3 has to write them into the seller's own spreadsheet.
 */

function keepEdges(value: string, lead: number, trail: number): string {
  if (value.length <= lead + trail) return "•".repeat(Math.max(value.length, 3));
  return `${value.slice(0, lead)}${"•".repeat(
    Math.max(3, Math.min(8, value.length - lead - trail)),
  )}${trail > 0 ? value.slice(-trail) : ""}`;
}

export function maskEmail(value: string | null | undefined): string | null {
  if (!value) return null;
  const at = value.lastIndexOf("@");
  if (at <= 0) return keepEdges(value, 2, 0);
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const tld = dot > 0 ? domain.slice(dot) : "";
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  return `${keepEdges(local, 2, 0)}@${keepEdges(host, 1, 0)}${tld}`;
}

export function maskPhone(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  if (digits.length < 4) return "•".repeat(Math.max(value.length, 3));
  return `••• ••• ${digits.slice(-4)}`;
}

/** Street lines leak the most; keep only the leading number. */
export function maskAddressLine(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = value.match(/^(\d+[A-Za-z]?)\s+(.*)$/);
  if (match) return `${match[1]} ${"•".repeat(Math.min(12, match[2].length))}`;
  return "•".repeat(Math.min(14, Math.max(value.length, 4)));
}

export function maskName(value: string | null | undefined): string | null {
  if (!value) return null;
  return value
    .split(/\s+/)
    .map((part, index) =>
      index === 0 ? part : `${part.charAt(0).toUpperCase()}.`,
    )
    .join(" ");
}

export function maskPostal(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length <= 3) return "•".repeat(value.length);
  return `${value.slice(0, value.length > 5 ? 3 : 2)}${"•".repeat(
    value.length - (value.length > 5 ? 3 : 2),
  )}`;
}

export function maskTrackingNumber(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  if (value.length <= 6) return "•".repeat(value.length);
  return `${"•".repeat(value.length - 4)}${value.slice(-4)}`;
}

export interface MaskOptions {
  reveal: boolean;
}

/** Applies `fn` unless the caller has explicitly asked to reveal. */
export function maybeMask<T extends string | null | undefined>(
  value: T,
  fn: (input: T) => string | null,
  options: MaskOptions,
): string | null {
  if (options.reveal) return value ?? null;
  return fn(value);
}

/**
 * Walks a raw eBay payload and masks the fields known to carry personal
 * data, so the "raw API data" panel is safe to show by default.
 */
const SENSITIVE_KEYS = new Set([
  "email",
  "phonenumber",
  "addressline1",
  "addressline2",
  "postalcode",
  "taxpayerid",
  "fullname",
  "companyname",
]);

export const REDACTED = "[redacted]";

/**
 * Key fragments that mean "this value is a credential".
 *
 * Matched as substrings because payloads and error bodies spell them a dozen
 * ways (`access_token`, `accessToken`, `Authorization`, `client_secret`).
 * Over-matching here costs a redacted field in a debug view; under-matching
 * puts a live token on screen or in a log file, so the trade is not close.
 */
const SECRET_KEY_FRAGMENTS = [
  "token",
  "secret",
  "password",
  "passwd",
  "authorization",
  "credential",
  "apikey",
  "api_key",
  "privatekey",
  "private_key",
  "clientid",
  "client_id",
  "refresh",
  "signature",
  "cookie",
  "sessionid",
  "session_id",
];

export function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z_]/g, "");
  return SECRET_KEY_FRAGMENTS.some((fragment) =>
    normalized.includes(fragment.replace(/[^a-z_]/g, "")),
  );
}

/**
 * Strips credentials from any structure before it is displayed or logged.
 *
 * Unconditional: unlike buyer data, which the seller owns and may reveal,
 * a token is never something a debug screen or a log line needs to contain.
 */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 12) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecrets(entry, depth + 1));
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[key] = isSecretKey(key) ? REDACTED : redactSecrets(entry, depth + 1);
    }
    return output;
  }
  return value;
}

/**
 * Catches credentials that arrive inside a string rather than under a
 * telltale key — a URL with `?access_token=…`, or a bearer header echoed
 * into an error message.
 */
export function redactSecretsInText(text: string): string {
  // The value class is "everything that is not a delimiter" rather than a
  // list of expected characters: real tokens are percent-encoded, contain
  // `^`, `#` and `%` (eBay) or dots (JWT), and a class that misses one of
  // those leaves the credential on screen. Stopping at &, quotes, brackets
  // and whitespace keeps the rest of the line intact.
  const VALUE = `[^\\s&"'<>,;)\\]}]{6,}`;
  return text
    .replace(new RegExp(`\\b(bearer)\\s+${VALUE}`, "gi"), `$1 ${REDACTED}`)
    .replace(
      new RegExp(
        `\\b([\\w-]*(?:token|secret|password|api[_-]?key|signature|credential)[\\w-]*)(\\s*[=:]\\s*)("?)${VALUE}`,
        "gi",
      ),
      `$1=${REDACTED}`,
    );
}

export function maskRawPayload(value: unknown, reveal: boolean): unknown {
  // Credentials go first and are not subject to `reveal`.
  const safe = redactSecrets(value);
  return reveal ? safe : maskPersonalData(safe);
}

function maskPersonalData(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => maskPersonalData(entry));
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (typeof entry === "string" && SENSITIVE_KEYS.has(key.toLowerCase())) {
        const lower = key.toLowerCase();
        output[key] =
          lower === "email"
            ? maskEmail(entry)
            : lower === "phonenumber"
              ? maskPhone(entry)
              : lower === "postalcode"
                ? maskPostal(entry)
                : lower === "fullname" || lower === "companyname"
                  ? maskName(entry)
                  : maskAddressLine(entry);
      } else {
        output[key] = maskPersonalData(entry);
      }
    }
    return output;
  }
  return value;
}
