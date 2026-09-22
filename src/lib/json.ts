/**
 * Helpers for the `...Json` String columns.
 *
 * SQLite cannot store a native JSON type through Prisma, so structured values
 * are serialised here. Moving the datasource to Postgres later only requires
 * changing the column type; every call site already goes through these two
 * functions.
 */

export function toJsonColumn(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

export function fromJsonColumn<T = unknown>(
  value: string | null | undefined,
  fallback: T,
): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** Reads a dot path ("order.buyer.username") out of a plain object. */
export function getByPath(source: unknown, path: string): unknown {
  if (!path) return undefined;
  return path.split(".").reduce<unknown>((acc, segment) => {
    if (acc === null || acc === undefined) return undefined;
    if (Array.isArray(acc)) {
      const index = Number(segment);
      return Number.isInteger(index) ? acc[index] : undefined;
    }
    if (typeof acc === "object") {
      return (acc as Record<string, unknown>)[segment];
    }
    return undefined;
  }, source);
}
