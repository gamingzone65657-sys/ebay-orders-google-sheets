import type { Metadata } from "next";

import { PageHeader } from "@/components/layout/PageHeader";
import { GoogleConnectionPanel } from "@/components/settings/GoogleConnectionPanel";
import { GoogleTestPanel } from "@/components/sheet/GoogleTestPanel";
import { SheetOptionsForm } from "@/components/sheet/SheetOptionsForm";
import { SpreadsheetPicker } from "@/components/sheet/SpreadsheetPicker";
import { ConnectionBadge } from "@/components/StatusBadge";
import { ButtonLink } from "@/components/ui/Button";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Notice,
} from "@/components/ui/primitives";
import { CONNECTION_STATUS } from "@/lib/constants";
import { prisma } from "@/lib/db";
import {
  expectedRedirectUri,
  grantsSheetsWrite,
  isGoogleConfigured,
  missingGoogleCredentials,
} from "@/lib/google/config";
import { GOOGLE_ERROR_MESSAGES, type GoogleErrorCode } from "@/lib/google/errors";
import { describeTokenStatus } from "@/lib/google/tokens";
import { formatDateTime, formatNumber, formatRelative } from "@/lib/format";
import { buildWritePlan } from "@/lib/sheets/write-plan";
import { getCurrentUser } from "@/lib/session";

export const metadata: Metadata = { title: "Google Sheet" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function firstParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

export default async function GoogleSheetPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const user = await getCurrentUser();
  const query = await searchParams;
  const justConnected = firstParam(query.google) === "connected";
  const oauthErrorCode = firstParam(query.google_error);
  const oauthErrorDetail = firstParam(query.detail);

  const [googleConnection, sheetConfig] = await Promise.all([
    prisma.googleConnection.findFirst({
      where: { userId: user.id, isActive: true },
    }),
    prisma.googleSheetConfig.findFirst({
      where: { userId: user.id, isActive: true },
      include: {
        columns: { orderBy: { position: "asc" } },
        fieldMappings: {
          where: { savedConfigId: null },
          orderBy: { position: "asc" },
        },
      },
    }),
  ]);

  const status = googleConnection?.status ?? CONNECTION_STATUS.DISCONNECTED;
  const connected = status !== CONNECTION_STATUS.DISCONNECTED;



  const tokenStatus = describeTokenStatus(googleConnection);
  const now = new Date();

  const plan = sheetConfig
    ? buildWritePlan(
        sheetConfig.columns.map((column) => ({
          header: column.header,
          position: column.position,
          letter: column.letter,
        })),
        sheetConfig.fieldMappings.map((mapping) => ({
          targetColumn: mapping.targetColumn,
          sourceField: mapping.sourceField,
          enabled: mapping.enabled,
          position: mapping.position,
        })),
      )
    : null;

  return (
    <>
      <PageHeader
        title="Google Sheet"
        description="Connect Google, then choose the spreadsheet and worksheet that will receive eBay orders."
        actions={
          <div className="flex items-center gap-2">
            <ConnectionBadge status={status} />
            <ButtonLink href="/field-mapping">Field mapping</ButtonLink>
          </div>
        }
      />

      {justConnected ? (
        <div className="mb-4 rounded-md border border-success-border bg-success-bg px-4 py-3 text-sm text-success">
          Google connected. Pick a spreadsheet and worksheet below.
        </div>
      ) : null}

      {oauthErrorCode ? (
        <div className="mb-4 rounded-md border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger">
          <p className="font-medium">Could not connect to Google</p>
          <p className="mt-1">
            {GOOGLE_ERROR_MESSAGES[oauthErrorCode as GoogleErrorCode] ??
              "Google returned an error during authorization."}
          </p>
          {oauthErrorDetail ? (
            <p className="mt-1 font-mono text-xs break-words">
              {oauthErrorDetail}
            </p>
          ) : null}
        </div>
      ) : null}

      <Notice tone="info" title="This page never changes your spreadsheet">
        Everything on this page is read-only against Google: it lists file
        names, reads worksheet metadata, and reads a single header row. No cell
        is written, no column is created, and nothing is deleted. Syncing
        writes only the columns listed in the write plan below.
      </Notice>

      {/* --- Connection ------------------------------------------------ */}
      <Card className="mt-5">
        <CardHeader
          title="Google account"
          description="The account whose spreadsheets are listed below."
          actions={<ConnectionBadge status={status} />}
        />
        <CardBody className="space-y-4">
          {googleConnection && connected ? (
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-3">
              <div>
                <dt className="text-xs text-muted-foreground">Account</dt>
                <dd className="truncate text-sm text-foreground">
                  {googleConnection.email ?? "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Name</dt>
                <dd className="truncate text-sm text-foreground">
                  {googleConnection.displayName ?? "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Token</dt>
                <dd
                  className={`text-sm ${
                    tokenStatus.health === "VALID"
                      ? "text-success"
                      : tokenStatus.health === "MISSING"
                        ? "text-muted-foreground"
                        : "text-warning"
                  }`}
                >
                  {tokenStatus.label}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Connected</dt>
                <dd className="text-sm text-foreground">
                  {formatRelative(googleConnection.connectedAt, now)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">
                  Last successful API call
                </dt>
                <dd className="text-sm text-foreground">
                  {googleConnection.lastApiSuccessAt
                    ? formatRelative(googleConnection.lastApiSuccessAt, now)
                    : "None yet"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Write permission</dt>
                <dd className="text-sm text-foreground">
                  {grantsSheetsWrite(googleConnection.scopes)
                    ? "Granted"
                    : "Read-only"}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">
              No Google account linked yet.
            </p>
          )}

          {googleConnection?.lastError ? (
            <div className="rounded-md border border-warning-border bg-warning-bg px-4 py-3 text-sm text-warning">
              <p className="font-medium">
                Last error
                {googleConnection.lastErrorCode
                  ? ` (${googleConnection.lastErrorCode})`
                  : ""}
              </p>
              <p className="mt-1 break-words">{googleConnection.lastError}</p>
            </div>
          ) : null}

          <GoogleConnectionPanel
            configured={isGoogleConfigured()}
            missingVars={missingGoogleCredentials()}
            status={status}
            redirectUri={expectedRedirectUri()}
            returnTo="/google-sheet"
          />
        </CardBody>
      </Card>

      {/* --- Picker ----------------------------------------------------- */}
      <Card className="mt-6">
        <CardHeader
          title="Destination"
          description="Search your spreadsheets, pick a worksheet, and set which row holds the headers."
        />
        <CardBody>

          <SpreadsheetPicker
            connected={connected}
            currentSpreadsheetId={sheetConfig?.spreadsheetId ?? null}
            currentSheetName={sheetConfig?.sheetName ?? null}
            currentHeaderRow={sheetConfig?.headerRow ?? 1}
            currentFirstDataRow={sheetConfig?.firstDataRow ?? 2}
          />
        </CardBody>
      </Card>

      {/* --- Tests ------------------------------------------------------ */}
      <Card className="mt-6">
        <CardHeader
          title="Connection tests"
          description="Each test makes one read-only request and reports exactly what succeeded or failed."
        />
        <CardBody>
          <GoogleTestPanel hasSpreadsheet={Boolean(sheetConfig)} />
          {sheetConfig?.lastTestAt ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Last worksheet test {formatRelative(sheetConfig.lastTestAt, now)}:{" "}
              <span
                className={
                  sheetConfig.lastTestOk ? "text-success" : "text-danger"
                }
              >
                {sheetConfig.lastTestMessage ?? "—"}
              </span>
            </p>
          ) : null}
        </CardBody>
      </Card>

      {sheetConfig ? (
        <>
          {/* --- Current destination ----------------------------------- */}
          <Card className="mt-6">
            <CardHeader
              title="Selected destination"
              actions={
                sheetConfig.spreadsheetUrl ? (
                  <a
                    href={sheetConfig.spreadsheetUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm text-link hover:underline"
                  >
                    Open in Google Sheets
                  </a>
                ) : null
              }
            />
            <CardBody>
              <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-3">
                <div>
                  <dt className="text-xs text-muted-foreground">Spreadsheet</dt>
                  <dd className="truncate text-sm text-foreground">
                    {sheetConfig.spreadsheetName}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Spreadsheet ID</dt>
                  <dd className="truncate font-mono text-xs text-muted-foreground">
                    {sheetConfig.spreadsheetId}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Worksheet</dt>
                  <dd className="text-sm text-foreground">
                    {sheetConfig.sheetName}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Worksheet ID</dt>
                  <dd className="font-mono text-sm text-foreground">
                    {sheetConfig.sheetGid ?? "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Dimensions</dt>
                  <dd className="text-sm text-foreground">
                    {sheetConfig.gridRowCount !== null &&
                    sheetConfig.gridColumnCount !== null
                      ? `${formatNumber(sheetConfig.gridRowCount)} × ${formatNumber(
                          sheetConfig.gridColumnCount,
                        )}`
                      : "Not reported"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Headers read</dt>
                  <dd className="text-sm text-foreground">
                    {formatDateTime(sheetConfig.lastDetectedAt)}
                  </dd>
                </div>
              </dl>
            </CardBody>
          </Card>

          {/* --- Options ------------------------------------------------ */}
          <Card className="mt-6">
            <CardHeader
              title="Write behaviour"
              description="How rows will be positioned once syncing is implemented."
            />
            <CardBody>
              <SheetOptionsForm
                initial={{
                  headerRow: sheetConfig.headerRow,
                  firstDataRow: sheetConfig.firstDataRow,
                  writeMode: sheetConfig.writeMode,
                  matchColumn: sheetConfig.matchColumn,
                  rowMode: sheetConfig.rowMode,
                  syncMode: sheetConfig.syncMode,
                }}
                columns={sheetConfig.columns.map((column) => column.header)}
              />
            </CardBody>
          </Card>

          {/* --- Headers ------------------------------------------------ */}
          <Card className="mt-6">
            <CardHeader
              title={`Headers in row ${sheetConfig.headerRow}`}
              description={`Read from "${sheetConfig.spreadsheetName}" / ${sheetConfig.sheetName}. These are the real values in your sheet.`}
              actions={
                <Badge tone="success">Live from Google</Badge>
              }
            />
            {sheetConfig.columns.length === 0 ? (
              <EmptyState
                title="No headers found"
                description={`Row ${sheetConfig.headerRow} of this worksheet is empty. Change the header row above, or add headers to the sheet and re-read.`}
              />
            ) : (
              <>
                <div className="scroll-area overflow-x-auto border-b border-border">
                  <table className="w-full min-w-[520px] text-sm">
                    <tbody>
                      <tr className="border-b border-border">
                        <th className="w-28 px-5 py-2 text-left text-xs font-medium text-muted-foreground">
                          Column
                        </th>
                        {sheetConfig.columns.map((column) => (
                          <td
                            key={`letter-${column.id}`}
                            className="px-3 py-2 text-center font-mono text-xs text-muted-foreground"
                          >
                            {column.letter ?? "—"}
                          </td>
                        ))}
                      </tr>
                      <tr>
                        <th className="px-5 py-2 text-left text-xs font-medium text-muted-foreground">
                          Header
                        </th>
                        {sheetConfig.columns.map((column) => (
                          <td
                            key={`header-${column.id}`}
                            className="px-3 py-2 text-center text-sm whitespace-nowrap text-foreground"
                          >
                            {column.header}
                          </td>
                        ))}
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div className="px-5 py-3 text-xs text-muted-foreground">
                  {sheetConfig.columns.length} column
                  {sheetConfig.columns.length === 1 ? "" : "s"} detected. Data
                  rows start at row {sheetConfig.firstDataRow}.
                </div>
              </>
            )}
          </Card>

          {/* --- Write plan --------------------------------------------- */}
          {plan ? (
            <Card className="mt-6">
              <CardHeader
                title="Write plan"
                description="Exactly which columns this app would write, and which it will never touch."
                actions={
                  <Badge tone={plan.safe ? "success" : "warning"}>
                    {plan.safe ? "Safe to sync" : "Needs attention"}
                  </Badge>
                }
              />
              <CardBody className="space-y-4">
                {plan.blockers.map((blocker) => (
                  <div
                    key={blocker}
                    className="rounded-md border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger"
                  >
                    {blocker}
                  </div>
                ))}
                {plan.warnings.map((warning) => (
                  <div
                    key={warning}
                    className="rounded-md border border-warning-border bg-warning-bg px-4 py-3 text-sm text-warning"
                  >
                    {warning}
                  </div>
                ))}

                {plan.mapped.length > 0 ? (
                  <div className="scroll-area overflow-x-auto rounded-md border border-border">
                    <table className="w-full min-w-[560px] text-sm">
                      <thead>
                        <tr className="border-b border-border bg-muted text-left text-xs text-muted-foreground">
                          <th className="px-4 py-2 font-medium">Column</th>
                          <th className="px-4 py-2 font-medium">Header</th>
                          <th className="px-4 py-2 font-medium">
                            Filled from (eBay field)
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {plan.mapped.map((column) => (
                          <tr
                            key={column.letter}
                            className="border-b border-border last:border-0"
                          >
                            <td className="px-4 py-2 font-mono text-xs text-muted-foreground">
                              {column.letter}
                            </td>
                            <td className="px-4 py-2 text-foreground">
                              {column.header}
                            </td>
                            <td className="px-4 py-2 font-mono text-xs text-muted-foreground">
                              {column.sourceField}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No enabled mapping resolves to an existing column yet.{" "}
                    <a
                      href="/field-mapping"
                      className="text-link hover:underline"
                    >
                      Configure mappings
                    </a>
                    .
                  </p>
                )}

                <p className="text-xs text-muted-foreground">
                  {plan.mapped.length} column
                  {plan.mapped.length === 1 ? "" : "s"} would be written.{" "}
                  {plan.untouched.length} existing column
                  {plan.untouched.length === 1 ? "" : "s"} would be left
                  untouched. No column outside this list is ever modified.
                </p>
              </CardBody>
            </Card>
          ) : null}
        </>
      ) : (
        <Card className="mt-6">
          <EmptyState
            title="No destination selected yet"
            description="Choose a spreadsheet and worksheet above. Its headers will then appear here and become the available mapping targets."
          />
        </Card>
      )}
    </>
  );
}
