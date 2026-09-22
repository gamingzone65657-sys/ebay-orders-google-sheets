import { z } from "zod";

import { fail, handle, ok, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { fromJsonColumn, toJsonColumn } from "@/lib/json";
import { getCurrentUser } from "@/lib/session";

const actionSchema = z.object({ action: z.literal("apply") });

interface SavedPayload {
  sheet?: { matchColumn?: string | null; writeMode?: string };
  mappings?: {
    targetColumn: string;
    sourceField: string;
    transformation?: string;
    transformArgs?: Record<string, string>;
    fallbackValue?: string | null;
    staticValue?: string | null;
    enabled?: boolean;
  }[];
}

type RouteContext = { params: Promise<{ id: string }> };

/** Applies a saved mapping set to the active destination sheet. */
export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    const { data, error } = await parseBody(request, actionSchema);
    if (error) return error;
    void data;

    const { id } = await context.params;
    const user = await getCurrentUser();

    const saved = await prisma.savedConfiguration.findFirst({
      where: { id, userId: user.id },
    });
    if (!saved) return fail("Saved configuration not found.", 404);

    const config = await prisma.googleSheetConfig.findFirst({
      where: { userId: user.id, isActive: true },
    });
    if (!config) return fail("Select a destination spreadsheet first.", 409);

    const payload = fromJsonColumn<SavedPayload>(saved.payloadJson, {});
    const mappings = payload.mappings ?? [];

    await prisma.$transaction(async (tx) => {
      await tx.fieldMapping.deleteMany({
        where: { sheetConfigId: config.id, savedConfigId: null },
      });
      if (mappings.length > 0) {
        await tx.fieldMapping.createMany({
          data: mappings.map((mapping, index) => ({
            sheetConfigId: config.id,
            targetColumn: mapping.targetColumn,
            sourceField: mapping.sourceField,
            transformation: mapping.transformation ?? "none",
            transformArgsJson:
              mapping.transformArgs && Object.keys(mapping.transformArgs).length
                ? toJsonColumn(mapping.transformArgs)
                : null,
            fallbackValue: mapping.fallbackValue ?? null,
            staticValue: mapping.staticValue ?? null,
            enabled: mapping.enabled ?? true,
            position: index,
          })),
        });
      }
      if (payload.sheet?.matchColumn !== undefined) {
        await tx.googleSheetConfig.update({
          where: { id: config.id },
          data: { matchColumn: payload.sheet.matchColumn },
        });
      }
    });

    return ok({ applied: mappings.length });
  });
}

export async function DELETE(_request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    const user = await getCurrentUser();

    const saved = await prisma.savedConfiguration.findFirst({
      where: { id, userId: user.id },
    });
    if (!saved) return fail("Saved configuration not found.", 404);

    await prisma.savedConfiguration.delete({ where: { id: saved.id } });
    return ok({ deleted: saved.id });
  });
}
