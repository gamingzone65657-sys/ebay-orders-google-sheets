/**
 * The write plan: exactly which spreadsheet columns this app would touch.
 *
 * The brief's safety requirements are enforceable only if the app can state,
 * before anything is written, which columns are in scope. This computes that
 * from the detected header row plus the saved field mappings:
 *
 *   - every mapped column is resolved to a real column letter,
 *   - every sheet column that is *not* mapped is listed as untouched,
 *   - mapped targets with no matching header are flagged as "would create",
 *   - duplicates and blanks are surfaced as blockers.
 *
 * Phase 4's writer must refuse to run unless `safe` is true, and must write
 * only to the letters in `mapped`. Nothing here mutates anything.
 */

import { columnLetter } from "@/lib/format";

export interface PlanSheetColumn {
  header: string;
  position: number;
  letter: string | null;
}

export interface PlanMapping {
  targetColumn: string;
  sourceField: string;
  enabled: boolean;
  position: number;
}

export interface MappedColumn {
  header: string;
  letter: string;
  position: number;
  sourceField: string;
}

export interface WritePlan {
  /** Columns that would be written, with their resolved letters. */
  mapped: MappedColumn[];
  /** Existing sheet columns no mapping targets. Left completely alone. */
  untouched: PlanSheetColumn[];
  /** Enabled mappings whose target is not in the header row. */
  wouldCreate: string[];
  /** Enabled mappings sharing a target column. */
  duplicateTargets: string[];
  /** Blank cells inside the header row, which cannot be mapped reliably. */
  blankHeaderPositions: number[];
  /** True when writing would be unambiguous and non-destructive. */
  safe: boolean;
  /** Human-readable reasons `safe` is false. */
  blockers: string[];
  /** Non-blocking things the user should still see. */
  warnings: string[];
}

/** How many new columns we are willing to propose before objecting. */
const MAX_NEW_COLUMNS = 5;

export function buildWritePlan(
  sheetColumns: PlanSheetColumn[],
  mappings: PlanMapping[],
): WritePlan {
  const enabled = mappings
    .filter((mapping) => mapping.enabled && mapping.targetColumn.trim() !== "")
    .slice()
    .sort((a, b) => a.position - b.position);

  const byHeader = new Map<string, PlanSheetColumn>();
  for (const column of sheetColumns) {
    if (column.header.trim() === "") continue;
    byHeader.set(column.header.trim().toLowerCase(), column);
  }

  const mapped: MappedColumn[] = [];
  const wouldCreate: string[] = [];
  const seenTargets = new Set<string>();
  const duplicateTargets = new Set<string>();
  const mappedHeaderKeys = new Set<string>();

  for (const mapping of enabled) {
    const target = mapping.targetColumn.trim();
    const key = target.toLowerCase();

    if (seenTargets.has(key)) duplicateTargets.add(target);
    seenTargets.add(key);

    const column = byHeader.get(key);
    if (!column) {
      if (!wouldCreate.includes(target)) wouldCreate.push(target);
      continue;
    }

    mappedHeaderKeys.add(key);
    mapped.push({
      header: column.header,
      letter: column.letter ?? columnLetter(column.position),
      position: column.position,
      sourceField: mapping.sourceField,
    });
  }

  const untouched = sheetColumns
    .filter((column) => {
      const key = column.header.trim().toLowerCase();
      return key !== "" && !mappedHeaderKeys.has(key);
    })
    .sort((a, b) => a.position - b.position);

  const blankHeaderPositions = sheetColumns
    .filter((column) => column.header.trim() === "")
    .map((column) => column.position);

  const blockers: string[] = [];
  const warnings: string[] = [];

  if (enabled.length === 0) {
    blockers.push("No field mappings are enabled, so there is nothing to write.");
  }
  if (duplicateTargets.size > 0) {
    blockers.push(
      `More than one mapping targets the same column: ${[...duplicateTargets].join(", ")}. Each column may be written by exactly one mapping.`,
    );
  }
  if (wouldCreate.length > MAX_NEW_COLUMNS) {
    blockers.push(
      `${wouldCreate.length} mapped columns do not exist in the header row. Refusing to add that many at once — add them to the sheet yourself, or reduce the mappings.`,
    );
  } else if (wouldCreate.length > 0) {
    warnings.push(
      `${wouldCreate.length} mapped column${
        wouldCreate.length === 1 ? " does" : "s do"
      } not exist yet: ${wouldCreate.join(", ")}. These would need to be added to the header row before syncing.`,
    );
  }
  if (blankHeaderPositions.length > 0) {
    warnings.push(
      `The header row has ${blankHeaderPositions.length} blank cell${
        blankHeaderPositions.length === 1 ? "" : "s"
      }. Blank columns cannot be mapped and will be skipped.`,
    );
  }
  if (untouched.length > 0) {
    warnings.push(
      `${untouched.length} existing column${
        untouched.length === 1 ? "" : "s"
      } will never be written to: ${untouched
        .slice(0, 8)
        .map((column) => column.header)
        .join(", ")}${untouched.length > 8 ? ", …" : ""}.`,
    );
  }

  return {
    mapped,
    untouched,
    wouldCreate,
    duplicateTargets: [...duplicateTargets],
    blankHeaderPositions,
    safe: blockers.length === 0,
    blockers,
    warnings,
  };
}
