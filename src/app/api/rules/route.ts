import { z } from "zod";

import { fail, handle, ok, parseBody } from "@/lib/api";
import { prisma } from "@/lib/db";
import { toJsonColumn } from "@/lib/json";
import { RULE_ACTIONS, validateRule } from "@/lib/sync/rules";
import { getCurrentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

const ACTIONS = RULE_ACTIONS.map((entry) => entry.id);

const conditionSchema = z.object({
  field: z.string().trim().min(1).max(200),
  operator: z.string().trim().min(1).max(40),
  value: z.string().max(500).default(""),
});

const ruleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true),
  match: z.enum(["ALL", "ANY"]).default("ALL"),
  conditions: z.array(conditionSchema).max(10).default([]),
  action: z.enum(ACTIONS as [string, ...string[]]),
  args: z
    .object({
      column: z.string().max(200).optional(),
      value: z.string().max(500).optional(),
      savedConfigId: z.string().max(60).optional(),
    })
    .default({}),
});

const putSchema = z.object({ rules: z.array(ruleSchema).max(50) });

/**
 * Replaces the whole rule set for the active destination, in order.
 *
 * Rules are validated here as well as in the UI, because the validity of a
 * rule ("a rule with no conditions never runs") is a property of the engine,
 * not of the form.
 */
export async function PUT(request: Request) {
  return handle(async () => {
    const { data, error } = await parseBody(request, putSchema);
    if (error) return error;

    const user = await getCurrentUser();
    const sheetConfig = await prisma.googleSheetConfig.findFirst({
      where: { userId: user.id, isActive: true },
      select: { id: true },
    });
    if (!sheetConfig) {
      return fail("Select a destination spreadsheet first.", 409);
    }

    const problems: string[] = [];
    data.rules.forEach((rule, index) => {
      for (const problem of validateRule(rule)) {
        problems.push(`Rule ${index + 1} (${rule.name || "unnamed"}): ${problem}`);
      }
    });
    if (problems.length > 0) {
      return fail(problems[0], 422, { problems });
    }

    // A rule pointing at a deleted saved configuration would silently fall
    // back to the default mappings, so reject it at save time instead.
    const referencedIds = [
      ...new Set(
        data.rules
          .filter((rule) => rule.action === "USE_MAPPING_SET")
          .map((rule) => rule.args.savedConfigId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    if (referencedIds.length > 0) {
      const found = await prisma.savedConfiguration.findMany({
        where: { id: { in: referencedIds }, userId: user.id },
        select: { id: true },
      });
      const missing = referencedIds.filter(
        (id) => !found.some((entry) => entry.id === id),
      );
      if (missing.length > 0) {
        return fail(
          "A rule points at a saved configuration that does not exist.",
          422,
        );
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.syncRule.deleteMany({ where: { sheetConfigId: sheetConfig.id } });
      if (data.rules.length > 0) {
        await tx.syncRule.createMany({
          data: data.rules.map((rule, index) => ({
            sheetConfigId: sheetConfig.id,
            name: rule.name,
            enabled: rule.enabled,
            position: index,
            match: rule.match,
            conditionsJson: toJsonColumn(rule.conditions) ?? "[]",
            action: rule.action,
            actionArgsJson: toJsonColumn(rule.args),
          })),
        });
      }
    });

    return ok({ count: data.rules.length });
  });
}
