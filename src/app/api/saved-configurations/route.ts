import { z } from "zod";

import { fail, handle, ok, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { fromJsonColumn, toJsonColumn } from "@/lib/json";
import { getCurrentUser } from "@/lib/session";

const schema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(400).optional(),
});

/** Snapshots the active sheet config + its mappings under a name. */
export async function POST(request: Request) {
  return handle(async () => {
    const { data, error } = await parseBody(request, schema);
    if (error) return error;

    const user = await getCurrentUser();
    const config = await prisma.googleSheetConfig.findFirst({
      where: { userId: user.id, isActive: true },
      include: {
        fieldMappings: {
          where: { savedConfigId: null },
          orderBy: { position: "asc" },
        },
      },
    });
    if (!config) return fail("Select a destination spreadsheet first.", 409);

    const payload = {
      sheet: {
        spreadsheetId: config.spreadsheetId,
        spreadsheetName: config.spreadsheetName,
        sheetName: config.sheetName,
        writeMode: config.writeMode,
        matchColumn: config.matchColumn,
        headerRow: config.headerRow,
        firstDataRow: config.firstDataRow,
      },
      mappings: config.fieldMappings.map((mapping) => ({
        targetColumn: mapping.targetColumn,
        sourceField: mapping.sourceField,
        transformation: mapping.transformation,
        transformArgs: fromJsonColumn<Record<string, string>>(
          mapping.transformArgsJson,
          {},
        ),
        fallbackValue: mapping.fallbackValue,
        staticValue: mapping.staticValue,
        enabled: mapping.enabled,
      })),
    };

    const existing = await prisma.savedConfiguration.findFirst({
      where: { userId: user.id, name: data.name },
    });

    const saved = existing
      ? await prisma.savedConfiguration.update({
          where: { id: existing.id },
          data: {
            description: data.description ?? existing.description,
            payloadJson: toJsonColumn(payload)!,
          },
        })
      : await prisma.savedConfiguration.create({
          data: {
            userId: user.id,
            name: data.name,
            description: data.description ?? null,
            payloadJson: toJsonColumn(payload)!,
          },
        });

    return ok({ id: saved.id, name: saved.name, replaced: Boolean(existing) });
  });
}
