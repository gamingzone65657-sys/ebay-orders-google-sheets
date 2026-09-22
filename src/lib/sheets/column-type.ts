/**
 * Guesses a column's data type from its header text.
 *
 * Only a UI hint: it decides which formatting transformations the mapping
 * editor suggests first for a column. Nothing reads it to decide how a value
 * is written, so a wrong guess costs a suggestion, not a cell.
 *
 * (Previously lived alongside the demo spreadsheet fixtures. It is real
 * production logic and has nothing to do with them.)
 */
export function guessColumnType(header: string): string {
  const h = header.toLowerCase();
  if (/(date|at|time)$/.test(h) || h.includes("date")) return "date";
  if (
    h.includes("total") ||
    h.includes("price") ||
    h.includes("gross") ||
    h.includes("tax") ||
    h.includes("refund")
  ) {
    return "currency";
  }
  if (
    h.includes("qty") ||
    h.includes("quantity") ||
    h.includes("units") ||
    h.includes("count")
  ) {
    return "number";
  }
  if (h.includes("picked") || h.includes("closed") || h.includes("enabled")) {
    return "boolean";
  }
  return "text";
}
