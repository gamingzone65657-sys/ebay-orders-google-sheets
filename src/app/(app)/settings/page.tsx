import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/layout/PageHeader";
import { EbayConnectionPanel } from "@/components/settings/EbayConnectionPanel";
import { GoogleConnectionPanel } from "@/components/settings/GoogleConnectionPanel";
import {
  ProfileForm,
  SecurityPreferencesForm,
  SyncPreferencesForm,
} from "@/components/settings/PreferenceForms";
import { ConnectionBadge } from "@/components/StatusBadge";
import { ButtonLink } from "@/components/ui/Button";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  DetailList,
  Notice,
} from "@/components/ui/primitives";
import { prisma } from "@/lib/db";
import {
  EBAY_MARKETPLACE_OPTIONS,
  isEbayConfigured,
  missingEbayCredentials,
  resolveEnvironment,
} from "@/lib/ebay/config";
import { EBAY_ERROR_MESSAGES, type EbayErrorCode } from "@/lib/ebay/errors";
import { describeTokenStatus } from "@/lib/ebay/tokens";
import {
  expectedRedirectUri,
  grantsSheetsWrite,
  isGoogleConfigured,
  missingGoogleCredentials,
} from "@/lib/google/config";
import {
  GOOGLE_ERROR_MESSAGES,
  type GoogleErrorCode,
} from "@/lib/google/errors";
import { describeTokenStatus as describeGoogleTokenStatus } from "@/lib/google/tokens";
import { formatDateTime, formatRelative } from "@/lib/format";
import { getCurrentUser } from "@/lib/session";

export const metadata: Metadata = { title: "Settings" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function firstParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

const SECTIONS = [
  { id: "profile", label: "Profile" },
  { id: "ebay", label: "eBay" },
  { id: "google", label: "Google" },
  { id: "sync", label: "Sync" },
  { id: "automation", label: "Automation" },
  { id: "security", label: "Security" },
];

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const user = await getCurrentUser();
  const query = await searchParams;
  const oauthErrorCode = firstParam(query.ebay_error);
  const oauthConnected = firstParam(query.ebay) === "connected";
  const googleErrorCode = firstParam(query.google_error);
  const googleJustConnected = firstParam(query.google) === "connected";
  // Both callbacks use `detail`; attribute it to whichever one reported.
  const detail = firstParam(query.detail);
  const oauthErrorDetail = oauthErrorCode ? detail : "";
  const googleErrorDetail = googleErrorCode ? detail : "";

  const [ebayConnection, googleConnection, automation, preferences, sessionCount] =
    await Promise.all([
      prisma.ebayConnection.findFirst({
        where: { userId: user.id, isActive: true },
      }),
      prisma.googleConnection.findFirst({
        where: { userId: user.id, isActive: true },
      }),
      prisma.automationSetting.findUnique({ where: { userId: user.id } }),
      prisma.userPreference.findMany({ where: { userId: user.id } }),
      prisma.session.count({ where: { userId: user.id } }),
    ]);

  const recentApiCalls = ebayConnection
    ? await prisma.ebayApiCall.findMany({
        where: { connectionId: ebayConnection.id },
        orderBy: { createdAt: "desc" },
        take: 8,
      })
    : [];

  const googleApiCalls = googleConnection
    ? await prisma.googleApiCall.findMany({
        where: { connectionId: googleConnection.id },
        orderBy: { createdAt: "desc" },
        take: 8,
      })
    : [];

  const tokenStatus = describeTokenStatus(ebayConnection);
  const googleTokenStatus = describeGoogleTokenStatus(googleConnection);
  const ebayConfigured = isEbayConfigured();
  const now = new Date();

  const prefs = Object.fromEntries(
    preferences.map((preference) => [preference.key, preference.value]),
  );

  const ebayStatus = ebayConnection?.status ?? "DISCONNECTED";
  const googleStatus = googleConnection?.status ?? "DISCONNECTED";

  return (
    <>
      <PageHeader
        title="Settings"
        description="Account, integrations, sync behaviour, and security for this workspace."
      />

      <nav className="mb-6 flex flex-wrap gap-2">
        {SECTIONS.map((section) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground hover:bg-muted"
          >
            {section.label}
          </a>
        ))}
      </nav>

      <div className="space-y-6">
        {/* Profile ------------------------------------------------------ */}
        <Card>
          <div id="profile" className="scroll-mt-20" />
          <CardHeader
            title="Profile"
            description="Identifies this workspace. Sign-in and multi-user access are added in a later phase."
          />
          <CardBody>
            <ProfileForm
              initialName={user.name ?? ""}
              initialTimezone={user.timezone}
              email={user.email}
            />
          </CardBody>
        </Card>

        {/* eBay --------------------------------------------------------- */}
        <Card>
          <div id="ebay" className="scroll-mt-20" />
          <CardHeader
            title="eBay"
            description="Source of the orders this tool imports."
            actions={<ConnectionBadge status={ebayStatus} />}
          />
          <CardBody className="space-y-4">
            {oauthConnected ? (
              <div className="rounded-md border border-success-border bg-success-bg px-4 py-3 text-sm text-success">
                eBay connected. Open the Orders page and run an import to pull
                your orders in.
              </div>
            ) : null}

            {oauthErrorCode ? (
              <div className="rounded-md border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger">
                <p className="font-medium">Could not connect to eBay</p>
                <p className="mt-1">
                  {EBAY_ERROR_MESSAGES[oauthErrorCode as EbayErrorCode] ??
                    "eBay returned an error during authorization."}
                </p>
                {oauthErrorDetail ? (
                  <p className="mt-1 font-mono text-xs break-words">
                    {oauthErrorDetail}
                  </p>
                ) : null}
              </div>
            ) : null}

            <DetailList
              items={[
                {
                  label: "eBay account",
                  value:
                    ebayConnection?.ebayUsername ??
                    (ebayConnection?.ebayUserId
                      ? `User ${ebayConnection.ebayUserId}`
                      : "Not connected"),
                },
                {
                  label: "Connection status",
                  value: <ConnectionBadge status={ebayStatus} />,
                },
                {
                  label: "Environment",
                  value: ebayConnection?.environment ?? "—",
                },
                {
                  label: "Marketplace",
                  value: ebayConnection?.marketplaceId ?? "—",
                },
                {
                  label: "Token status",
                  value: (
                    <span
                      className={
                        tokenStatus.health === "VALID"
                          ? "text-success"
                          : tokenStatus.health === "MISSING"
                            ? "text-muted-foreground"
                            : "text-warning"
                      }
                    >
                      {tokenStatus.label}
                    </span>
                  ),
                },
                {
                  label: "Access token expires",
                  value: tokenStatus.expiresAt
                    ? `${formatRelative(tokenStatus.expiresAt, now)} (${formatDateTime(
                        tokenStatus.expiresAt,
                      )})`
                    : "—",
                },
                {
                  label: "Authorization valid until",
                  value: tokenStatus.refreshExpiresAt
                    ? formatDateTime(tokenStatus.refreshExpiresAt)
                    : "—",
                },
                {
                  label: "Last refreshed",
                  value: formatDateTime(ebayConnection?.lastRefreshedAt),
                },
                {
                  label: "Connected at",
                  value: formatDateTime(ebayConnection?.connectedAt),
                },
                {
                  label: "Scopes granted",
                  value: ebayConnection?.scopes
                    ? `${ebayConnection.scopes.split(" ").filter(Boolean).length} scope(s)`
                    : "—",
                },
                {
                  label: "Last successful API request",
                  value: ebayConnection?.lastApiSuccessAt
                    ? `${formatRelative(
                        ebayConnection.lastApiSuccessAt,
                        now,
                      )} (${formatDateTime(ebayConnection.lastApiSuccessAt)})`
                    : "None yet",
                },
                {
                  label: "Last request path",
                  value: ebayConnection?.lastApiPath
                    ? `${ebayConnection.lastApiPath} → ${
                        ebayConnection.lastApiStatus ?? "?"
                      }`
                    : "—",
                },
              ]}
            />

            {ebayConnection?.rateLimitedUntil &&
            ebayConnection.rateLimitedUntil.getTime() > now.getTime() ? (
              <Notice tone="warning" title="Rate limited">
                eBay is rate limiting this application until{" "}
                {formatDateTime(ebayConnection.rateLimitedUntil)}. Imports will
                refuse to start until then.
              </Notice>
            ) : null}

            {ebayConnection?.lastError ? (
              <div className="rounded-md border border-warning-border bg-warning-bg px-4 py-3 text-sm text-warning">
                <p className="font-medium">
                  Last error{" "}
                  {ebayConnection.lastErrorCode
                    ? `(${ebayConnection.lastErrorCode})`
                    : ""}
                </p>
                <p className="mt-1 break-words">{ebayConnection.lastError}</p>
                <p className="mt-1 text-xs">
                  {formatDateTime(ebayConnection.lastErrorAt)}
                </p>
              </div>
            ) : null}

            <EbayConnectionPanel
              configured={ebayConfigured}
              missingVars={missingEbayCredentials()}
              status={ebayStatus}
              environment={ebayConnection?.environment ?? resolveEnvironment()}
              marketplaceId={ebayConnection?.marketplaceId ?? "EBAY_US"}
              marketplaces={EBAY_MARKETPLACE_OPTIONS.map((option) => ({
                id: option.id,
                label: option.label,
              }))}
              defaultEnvironment={resolveEnvironment()}
            />

            {recentApiCalls.length > 0 ? (
              <details className="rounded-md border border-border bg-muted px-4 py-3">
                <summary className="cursor-pointer text-sm font-medium text-foreground">
                  Recent eBay API calls ({recentApiCalls.length})
                </summary>
                <ul className="mt-2 space-y-1 font-mono text-[11px] text-muted-foreground">
                  {recentApiCalls.map((call) => (
                    <li key={call.id} className="flex flex-wrap gap-2">
                      <span className={call.ok ? "text-success" : "text-danger"}>
                        {call.status ?? "ERR"}
                      </span>
                      <span>{call.method}</span>
                      <span className="break-all">{call.path}</span>
                      <span className="text-muted-foreground">
                        {call.durationMs ?? "?"}ms
                        {call.attempt > 1 ? ` · attempt ${call.attempt}` : ""}
                      </span>
                      <span className="text-muted-foreground">
                        {formatDateTime(call.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </CardBody>
        </Card>

        {/* Google ------------------------------------------------------- */}
        <Card>
          <div id="google" className="scroll-mt-20" />
          <CardHeader
            title="Google"
            description="Account that owns the destination spreadsheet."
            actions={<ConnectionBadge status={googleStatus} />}
          />
          <CardBody className="space-y-4">
            {googleJustConnected ? (
              <div className="rounded-md border border-success-border bg-success-bg px-4 py-3 text-sm text-success">
                Google connected. Choose a spreadsheet on the Google Sheet page.
              </div>
            ) : null}

            {googleErrorCode ? (
              <div className="rounded-md border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger">
                <p className="font-medium">Could not connect to Google</p>
                <p className="mt-1">
                  {GOOGLE_ERROR_MESSAGES[googleErrorCode as GoogleErrorCode] ??
                    "Google returned an error during authorization."}
                </p>
                {googleErrorDetail ? (
                  <p className="mt-1 font-mono text-xs break-words">
                    {googleErrorDetail}
                  </p>
                ) : null}
              </div>
            ) : null}

            <DetailList
              items={[
                {
                  label: "Google account",
                  value: googleConnection?.email ?? "Not connected",
                },
                {
                  label: "Connection status",
                  value: <ConnectionBadge status={googleStatus} />,
                },
                { label: "Name", value: googleConnection?.displayName ?? "—" },
                {
                  label: "Token status",
                  value: (
                    <span
                      className={
                        googleTokenStatus.health === "VALID"
                          ? "text-success"
                          : googleTokenStatus.health === "MISSING"
                            ? "text-muted-foreground"
                            : "text-warning"
                      }
                    >
                      {googleTokenStatus.label}
                    </span>
                  ),
                },
                {
                  label: "Access token expires",
                  value: googleTokenStatus.expiresAt
                    ? `${formatRelative(
                        googleTokenStatus.expiresAt,
                        now,
                      )} (${formatDateTime(googleTokenStatus.expiresAt)})`
                    : "—",
                },
                {
                  label: "Refresh token stored",
                  value: googleTokenStatus.hasRefreshToken ? "Yes" : "No",
                },
                {
                  label: "Connected at",
                  value: formatDateTime(googleConnection?.connectedAt),
                },
                {
                  label: "Scopes granted",
                  value: googleConnection?.scopes
                    ? `${googleConnection.scopes.split(" ").filter(Boolean).length} scope(s)`
                    : "—",
                },
                {
                  label: "Can write to sheets",
                  value:
                    grantsSheetsWrite(googleConnection?.scopes)
                      ? "Yes"
                      : "No (read-only)",
                },
                {
                  label: "Last successful API request",
                  value: googleConnection?.lastApiSuccessAt
                    ? `${formatRelative(
                        googleConnection.lastApiSuccessAt,
                        now,
                      )} (${formatDateTime(googleConnection.lastApiSuccessAt)})`
                    : "None yet",
                },
              ]}
            />

            {googleConnection?.lastError ? (
              <div className="rounded-md border border-warning-border bg-warning-bg px-4 py-3 text-sm text-warning">
                <p className="font-medium">
                  Last error
                  {googleConnection.lastErrorCode
                    ? ` (${googleConnection.lastErrorCode})`
                    : ""}
                </p>
                <p className="mt-1 break-words">{googleConnection.lastError}</p>
                <p className="mt-1 text-xs">
                  {formatDateTime(googleConnection.lastErrorAt)}
                </p>
              </div>
            ) : null}

            <GoogleConnectionPanel
              configured={isGoogleConfigured()}
              missingVars={missingGoogleCredentials()}
              status={googleStatus}
              redirectUri={expectedRedirectUri()}
              returnTo="/settings"
            />

            {googleApiCalls.length > 0 ? (
              <details className="rounded-md border border-border bg-muted px-4 py-3">
                <summary className="cursor-pointer text-sm font-medium text-foreground">
                  Recent Google API calls ({googleApiCalls.length})
                </summary>
                <ul className="mt-2 space-y-1 font-mono text-[11px] text-muted-foreground">
                  {googleApiCalls.map((call) => (
                    <li key={call.id} className="flex flex-wrap gap-2">
                      <span
                        className={call.ok ? "text-success" : "text-danger"}
                      >
                        {call.status ?? "ERR"}
                      </span>
                      <span className="break-all">{call.path}</span>
                      <span className="text-muted-foreground">
                        {call.durationMs ?? "?"}ms
                        {call.attempt > 1 ? ` · attempt ${call.attempt}` : ""}
                      </span>
                      <span className="text-muted-foreground">
                        {formatDateTime(call.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}

            <div>
              <ButtonLink href="/google-sheet" size="sm">
                Manage destination sheet
              </ButtonLink>
            </div>
          </CardBody>
        </Card>

        {/* Sync --------------------------------------------------------- */}
        <Card>
          <div id="sync" className="scroll-mt-20" />
          <CardHeader
            title="Sync"
            description="Defaults applied to every run, manual or scheduled."
          />
          <CardBody>
            <SyncPreferencesForm initial={prefs} />
          </CardBody>
        </Card>

        {/* Automation --------------------------------------------------- */}
        <Card>
          <div id="automation" className="scroll-mt-20" />
          <CardHeader
            title="Automation"
            description="Scheduling lives on its own page; this is a summary."
            actions={
              <Badge tone={automation?.enabled ? "success" : "neutral"}>
                {automation?.enabled ? "Enabled" : "Disabled"}
              </Badge>
            }
          />
          <CardBody className="space-y-4">
            <DetailList
              items={[
                {
                  label: "Frequency",
                  value: automation
                    ? `Every ${automation.intervalMinutes} minutes`
                    : "—",
                },
                { label: "Timezone", value: automation?.timezone ?? "—" },
                {
                  label: "Look back",
                  value: automation ? `${automation.lookbackDays} days` : "—",
                },
                {
                  label: "Next run",
                  value: automation?.enabled
                    ? formatDateTime(automation.nextRunAt)
                    : "Not scheduled",
                },
                {
                  label: "Notify on error",
                  value: automation?.notifyOnError ? "Yes" : "No",
                },
                {
                  label: "Notification email",
                  value: automation?.notifyEmail ?? "Not set",
                },
              ]}
            />
            <ButtonLink href="/automation" size="sm">
              Edit automation
            </ButtonLink>
          </CardBody>
        </Card>

        {/* Security ----------------------------------------------------- */}
        <Card>
          <div id="security" className="scroll-mt-20" />
          <CardHeader
            title="Security"
            description="Session and credential handling."
          />
          <CardBody className="space-y-5">
            <Notice tone="info" title="Authentication status">
              The schema already carries users, hashed passwords, and sessions,
              and every page and API route resolves its data through a single
              <code className="mx-1 rounded bg-foreground/10 px-1 py-0.5 font-mono text-xs">
                getCurrentUser()
              </code>
              call. Until the sign-in screen exists, that call falls back to the
              workspace owner, so this build should not be exposed publicly.
            </Notice>

            <DetailList
              items={[
                { label: "Active sessions", value: String(sessionCount) },
                { label: "Password set", value: user.passwordHash ? "Yes" : "No" },
                { label: "Role", value: user.role },
                {
                  label: "Last login",
                  value: formatDateTime(user.lastLoginAt),
                },
                {
                  label: "Token storage",
                  value: "AES-256-GCM encrypted at rest",
                },
                {
                  label: "Workspace created",
                  value: formatDateTime(user.createdAt),
                },
              ]}
            />

            <SecurityPreferencesForm initial={prefs} />


          </CardBody>
        </Card>
      </div>

      <p className="mt-6 text-xs text-muted-foreground">
        Looking for field mappings? They live on the{" "}
        <Link href="/field-mapping" className="text-link hover:underline">
          Field Mapping
        </Link>{" "}
        page.
      </p>
    </>
  );
}
