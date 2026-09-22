import { z } from "zod";

import { fail, handle, ok, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { toJsonColumn } from "@/lib/json";
import { suggestMapping } from "@/lib/mapping-suggest";
import { getCurrentUser } from "@/lib/session";

/**
 * Mapping rows are stored as free-form strings on purpose: `targetColumn` is
 * whatever the sheet header says and `sourceField` is whatever dot-path the
 * caller chose. No validation against a fixed field list happens here, which
 * is what lets Phase 2 introduce new eBay fields with no API change.
 */
const mappingSchema = z.object({
  targetColumn: z.string().trim().min(1).max(200),
  sourceField: z.string().trim().min(1).max(200),
  transformation: z.string().trim().min(1).max(60).default("none"),
  transformArgs: z.record(z.string(), z.string()).default({}),
  fallbackValue: z.string().max(500).nullable().default(null),
  staticValue: z.string().max(500).nullable().default(null),
  enabled: z.boolean().default(true),
});

const putSchema = z.object({
  mappings: z.array(mappingSchema).max(200),
});

const postSchema = z.object({
  action: z.literal("auto-map"),
  /** When true, existing mappings are replaced rather than appended to. */
  replace: z.boolean().default(false),
});

async function activeSheetConfig(userId: string) {
  return prisma.googleSheetConfig.findFirst({
    where: { userId, isActive: true },
    include: { columns: { orderBy: { position: "asc" } } },
  });
}

/** Replaces the whole mapping set for the active destination, in order. */
export async function PUT(request: Request) {
  return handle(async () => {
    const { data, error } = await parseBody(request, putSchema);
    if (error) return error;

    const user = await getCurrentUser();
    const config = await activeSheetConfig(user.id);
    if (!config) {
      return fail("Select a destination spreadsheet first.", 409);
    }

    const duplicates = data.mappings
      .map((m) => m.targetColumn.toLowerCase())
      .filter((value, index, all) => all.indexOf(value) !== index);
    if (duplicates.length > 0) {
      return fail(
        `Each column can only be mapped once. Duplicated: ${[
          ...new Set(duplicates),
        ].join(", ")}`,
        422,
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.fieldMapping.deleteMany({
        where: { sheetConfigId: config.id, savedConfigId: null },
      });
      if (data.mappings.length > 0) {
        await tx.fieldMapping.createMany({
          data: data.mappings.map((mapping, index) => ({
            sheetConfigId: config.id,
            targetColumn: mapping.targetColumn,
            sourceField: mapping.sourceField,
            transformation: mapping.transformation,
            transformArgsJson:
              Object.keys(mapping.transformArgs).length > 0
                ? toJsonColumn(mapping.transformArgs)
                : null,
            fallbackValue: mapping.fallbackValue || null,
            staticValue: mapping.staticValue || null,
            enabled: mapping.enabled,
            position: index,
          })),
        });
      }
    });

    return ok({ count: data.mappings.length });
  });
}

/** Builds a starter mapping set from the detected sheet columns. */
export async function POST(request: Request) {
  return handle(async () => {
    const { data, error } = await parseBody(request, postSchema);
    if (error) return error;

    const user = await getCurrentUser();
    const config = await activeSheetConfig(user.id);
    if (!config) {
      return fail("Select a destination spreadsheet first.", 409);
    }
    if (config.columns.length === 0) {
      return fail("No columns detected for this sheet yet.", 409);
    }

    const existing = await prisma.fieldMapping.findMany({
      where: { sheetConfigId: config.id, savedConfigId: null },
      orderBy: { position: "asc" },
    });

    const alreadyMapped = new Set(
      existing.map((m) => m.targetColumn.toLowerCase()),
    );

    const candidates = data.replace
      ? config.columns
      : config.columns.filter((c) => !alreadyMapped.has(c.header.toLowerCase()));

    const created = candidates
      .map((column) => ({ column, suggestion: suggestMapping(column.header) }))
      .filter((entry) => entry.suggestion !== null);

    if (created.length === 0) {
      return ok({ added: 0, message: "No new columns to map." });
    }

    await prisma.$transaction(async (tx) => {
      if (data.replace) {
        await tx.fieldMapping.deleteMany({
          where: { sheetConfigId: config.id, savedConfigId: null },
        });
      }
      const offset = data.replace ? 0 : existing.length;
      await tx.fieldMapping.createMany({
        data: created.map((entry, index) => ({
          sheetConfigId: config.id,
          targetColumn: entry.column.header,
          sourceField: entry.suggestion!.sourceField,
          transformation: entry.suggestion!.transformation,
          transformArgsJson:
            Object.keys(entry.suggestion!.transformArgs).length > 0
              ? toJsonColumn(entry.suggestion!.transformArgs)
              : null,
          enabled: true,
          position: offset + index,
        })),
      });
    });

    return ok({ added: created.length });
  });
}
