import type { Metadata } from "next";

import { PageHeader } from "@/components/layout/PageHeader";
import {
  MappingEditor,
  type MappingRow,
} from "@/components/mapping/MappingEditor";
import {
  SavedConfigurations,
  type SavedConfigSummary,
} from "@/components/mapping/SavedConfigurations";
import { ButtonLink } from "@/components/ui/Button";
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Notice,
} from "@/components/ui/primitives";
import { prisma } from "@/lib/db";
import { fromJsonColumn } from "@/lib/json";
import type { EbayOrderPayload } from "@/lib/ebay/order-payload";
import { getMappingWorkspace } from "@/lib/queries";
import { getCurrentUser } from "@/lib/session";

export const metadata: Metadata = { title: "Field Mapping" };

interface SavedPayload {
  sheet?: { spreadsheetName?: string };
  mappings?: unknown[];
}

export default async function FieldMappingPage() {
  const user = await getCurrentUser();
  const { sheetConfig, savedConfigurations } = await getMappingWorkspace(user.id);

  // The live preview is driven by the most recent real order this workspace
  // has imported. There is no fallback: a generated stand-in would show the
  // user a mapping working against data that does not exist, and the first
  // real sync would be where they found out. With no orders the editor shows
  // an empty preview and says why.
  const latestOrder = await prisma.importedOrder.findFirst({
    where: { userId: user.id, rawPayloadJson: { not: null } },
    orderBy: { orderDate: "desc" },
  });

  const previewOrder: EbayOrderPayload | null = latestOrder?.rawPayloadJson
    ? fromJsonColumn<EbayOrderPayload | null>(latestOrder.rawPayloadJson, null)
    : null;

  const initialMappings: MappingRow[] = (sheetConfig?.fieldMappings ?? []).map(
    (mapping) => ({
      key: mapping.id,
      targetColumn: mapping.targetColumn,
      sourceField: mapping.sourceField,
      transformation: mapping.transformation,
      transformArgs: fromJsonColumn<Record<string, string>>(
        mapping.transformArgsJson,
        {},
      ),
      fallbackValue: mapping.fallbackValue ?? "",
      staticValue: mapping.staticValue ?? "",
      enabled: mapping.enabled,
    }),
  );

  const savedSummaries: SavedConfigSummary[] = savedConfigurations.map(
    (config) => {
      const payload = fromJsonColumn<SavedPayload>(config.payloadJson, {});
      return {
        id: config.id,
        name: config.name,
        description: config.description,
        isDefault: config.isDefault,
        mappingCount: payload.mappings?.length ?? 0,
        spreadsheetName: payload.sheet?.spreadsheetName ?? null,
        updatedAt: config.updatedAt.toISOString(),
      };
    },
  );

  return (
    <>
      <PageHeader
        title="Field Mapping"
        description={
          sheetConfig
            ? `Each row writes one column of "${sheetConfig.spreadsheetName} / ${sheetConfig.sheetName}".`
            : "Decide which eBay field fills each spreadsheet column."
        }
        actions={<ButtonLink href="/google-sheet">Sheet settings</ButtonLink>}
      />

      <Notice tone="info" title="How mappings are stored">
        Columns and eBay fields are saved as plain text keys, not as database
        columns. Adding an eBay field or renaming a sheet header later needs no
        schema change, and mappings you save now keep working.
      </Notice>

      <div className="mt-5">
        {sheetConfig ? (
          <MappingEditor
            sheetColumns={sheetConfig.columns.map((column) => column.header)}
            initialMappings={initialMappings}
            previewOrder={previewOrder}
          />
        ) : (
          <Card>
            <EmptyState
              title="No destination sheet selected"
              description="Choose a spreadsheet and tab first — the mapping editor lists that sheet's detected columns as mapping targets."
              action={
                <ButtonLink href="/google-sheet" variant="primary">
                  Select a spreadsheet
                </ButtonLink>
              }
            />
          </Card>
        )}
      </div>

      <Card className="mt-8">
        <CardHeader
          title="Saved configurations"
          description="Reusable mapping sets. Applying one replaces the mappings on the active sheet."
        />
        <CardBody>
          <SavedConfigurations
            configurations={savedSummaries}
            canSave={Boolean(sheetConfig)}
          />
        </CardBody>
      </Card>
    </>
  );
}
