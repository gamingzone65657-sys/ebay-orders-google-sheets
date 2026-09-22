import type { Metadata } from "next";

import {
  FilterForm,
  type FilterFormValues,
} from "@/components/filters/FilterForm";
import { RulesEditor, type RuleRow } from "@/components/filters/RulesEditor";
import { PageHeader } from "@/components/layout/PageHeader";
import { ButtonLink } from "@/components/ui/Button";
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Notice,
} from "@/components/ui/primitives";
import { EBAY_MARKETPLACE_OPTIONS } from "@/lib/ebay/config";
import { prisma } from "@/lib/db";
import { fromJsonColumn } from "@/lib/json";
import { describeFilter, parseList, toFilterSettings } from "@/lib/sync/filters";
import { getCurrentUser } from "@/lib/session";

export const metadata: Metadata = { title: "Filters & Rules" };

function toDateInput(value: Date | null): string {
  return value ? value.toISOString().slice(0, 10) : "";
}

export default async function FiltersPage() {
  const user = await getCurrentUser();

  const sheetConfig = await prisma.googleSheetConfig.findFirst({
    where: { userId: user.id, isActive: true },
    include: {
      columns: { orderBy: { position: "asc" } },
      filter: true,
      rules: { orderBy: { position: "asc" } },
    },
  });

  const [marketplaceRows, savedConfigurations] = await Promise.all([
    prisma.importedOrder.findMany({
      where: { userId: user.id, marketplaceId: { not: null } },
      distinct: ["marketplaceId"],
      select: { marketplaceId: true },
      orderBy: { marketplaceId: "asc" },
    }),
    prisma.savedConfiguration.findMany({
      where: { userId: user.id },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const filter = toFilterSettings(sheetConfig?.filter ?? null);

  // Offer marketplaces actually seen in this workspace, plus the standard
  // list, plus anything already selected that no longer appears in orders.
  const marketplaces = [
    ...new Set([
      ...marketplaceRows
        .map((row) => row.marketplaceId)
        .filter((value): value is string => Boolean(value)),
      ...EBAY_MARKETPLACE_OPTIONS.map((option) => option.id as string),
      ...filter.marketplaces,
    ]),
  ].sort();

  const initialFilter: FilterFormValues = {
    orderStates: filter.orderStates,
    fulfillmentStates: filter.fulfillmentStates,
    marketplaces: filter.marketplaces,
    skuMode: filter.skuMode,
    skuValues: filter.skuValues.join("\n"),
    skuCaseSensitive: filter.skuCaseSensitive,
    dateFrom: toDateInput(filter.dateFrom),
    dateTo: toDateInput(filter.dateTo),
  };

  const initialRules: RuleRow[] = (sheetConfig?.rules ?? []).map((rule) => ({
    key: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    match: rule.match === "ANY" ? "ANY" : "ALL",
    conditions: fromJsonColumn<
      { field: string; operator: string; value: string }[]
    >(rule.conditionsJson, []),
    action: rule.action,
    args: fromJsonColumn<{
      column?: string;
      value?: string;
      savedConfigId?: string;
    }>(rule.actionArgsJson, {}),
    lastMatchCount: rule.lastEvaluatedAt ? rule.lastMatchCount : null,
  }));

  const activeSummary = describeFilter(filter);

  return (
    <>
      <PageHeader
        title="Filters & Rules"
        description="Decide which eBay orders reach the sheet, and apply IF/THEN rules to the rows that do."
        actions={<ButtonLink href="/field-mapping">Field mapping</ButtonLink>}
      />

      {!sheetConfig ? (
        <Card>
          <EmptyState
            title="No destination sheet selected"
            description="Filters and rules belong to a destination. Choose a spreadsheet and worksheet first."
            action={
              <ButtonLink href="/google-sheet" variant="primary">
                Select a spreadsheet
              </ButtonLink>
            }
          />
        </Card>
      ) : (
        <>
          <Notice tone="info" title="Where these run">
            Filters narrow which orders are fetched from the database. Rules
            then run on each resulting row, in order, before anything is
            written. Both are stored as data and configured entirely here — no
            code change is needed to add a SKU, a marketplace or a rule.
          </Notice>

          {activeSummary.length > 0 ? (
            <div className="mt-4 rounded-md border border-border bg-muted px-4 py-3 text-sm">
              <span className="font-medium text-foreground">
                Currently filtering on:
              </span>{" "}
              <span className="text-muted-foreground">{activeSummary.join(" · ")}</span>
            </div>
          ) : (
            <div className="mt-4 rounded-md border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
              No filters are active — every order in the chosen date range is
              considered.
            </div>
          )}

          <Card className="mt-5">
            <CardHeader
              title="Order filters"
              description={`Applied to "${sheetConfig.spreadsheetName} / ${sheetConfig.sheetName}".`}
            />
            <CardBody>
              <FilterForm initial={initialFilter} marketplaces={marketplaces} />
            </CardBody>
          </Card>

          <Card className="mt-6">
            <CardHeader
              title="Rules"
              description="IF a row matches these conditions, THEN do this. Rules run top to bottom."
            />
            <CardBody>
              <RulesEditor
                initialRules={initialRules}
                sheetColumns={sheetConfig.columns.map((column) => column.header)}
                savedConfigurations={savedConfigurations}
              />
            </CardBody>
          </Card>

          <Card className="mt-6">
            <CardHeader
              title="How rules resolve"
              description="The order of precedence when several rules match one row."
            />
            <CardBody>
              <ol className="list-inside list-decimal space-y-1.5 text-sm text-foreground">
                <li>
                  A matching <strong>Skip this row</strong> wins immediately —
                  an explicit skip is never undone by a later rule.
                </li>
                <li>
                  If any <strong>Import only matching rows</strong> rule
                  exists, a row must match at least one of them.
                </li>
                <li>
                  <strong>Set a column</strong> overrides accumulate; on the
                  same column, the later rule wins.
                </li>
                <li>
                  The last matching <strong>Use a saved configuration</strong>{" "}
                  decides which mapping set builds the row.
                </li>
              </ol>
              <p className="mt-3 text-sm text-muted-foreground">
                A rule with no conditions never runs, so a half-finished rule
                is inert rather than destructive. Run{" "}
                <strong>Preview sync</strong> on the dashboard to see the
                effect before writing anything.
              </p>
            </CardBody>
          </Card>
        </>
      )}
    </>
  );
}
