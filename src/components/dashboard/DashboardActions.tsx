"use client";

import { useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";

import { FeedbackBanner } from "@/components/FeedbackBanner";
import { Button, ButtonLink } from "@/components/ui/Button";
import { useApiAction } from "@/components/useApiAction";

interface SyncResult {
  imported?: number;
  updated?: number;
  skipped?: number;
  errors?: number;
  pages?: number;
  apiCalls?: number;
  status?: string;
  errorMessage?: string;
  summary?: string;
}

export function DashboardActions({
  ebayConnected,
  ebayLive,
  ebayConfigured,
  googleConnected,
}: {
  /** A stored connection of any status. */
  ebayConnected: boolean;
  /** A real OAuth connection that can call the API. */
  ebayLive: boolean;
  ebayConfigured: boolean;
  googleConnected: boolean;
}) {
  const { run, pending, feedback, setFeedback } = useApiAction();
  const [navigating, setNavigating] = useState(false);
  const busy = pending !== null || navigating;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {ebayLive ? (
          <ButtonLink href="/settings#ebay">Manage eBay connection</ButtonLink>
        ) : ebayConfigured ? (
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => {
              // Consent happens on eBay's domain, so this is a navigation.
              setNavigating(true);
              window.location.href = "/api/auth/ebay/start";
            }}
          >
            {navigating ? "Redirecting to eBay…" : "Connect eBay"}
            <ExternalLink className="h-3.5 w-3.5 opacity-70" />
          </Button>
        ) : (
          <ButtonLink href="/settings#ebay" variant="primary">
            Connect eBay
          </ButtonLink>
        )}

        {googleConnected ? (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() =>
              run(
                "google",
                {
                  url: "/api/connections/google",
                  body: { action: "disconnect" },
                },
                { successMessage: "Google disconnected." },
              )
            }
          >
            {pending === "google" ? "Working…" : "Disconnect Google"}
          </Button>
        ) : (
          // Connecting is a top-level navigation to Google's consent screen,
          // not a fetch, so it has to be a link rather than a button action.
          <ButtonLink href="/settings#google" variant="primary">
            Connect Google
          </ButtonLink>
        )}

        <Button
          disabled={busy || !ebayConnected}
          onClick={async () => {
            const result = await run(
              "import",
              { url: "/api/ebay/import", body: { lookbackDays: 30 } },
            );
            const data = (result.data ?? {}) as SyncResult;
            if (!result.ok) return;

            if (data.status === "FAILED") {
              setFeedback({
                tone: "error",
                message:
                  data.errorMessage ??
                  data.summary ??
                  "The import could not run.",
              });
              return;
            }

            setFeedback({
              tone: data.status === "PARTIAL" ? "error" : "success",
              message:
                `Imported from eBay: ${data.imported ?? 0} new, ${data.updated ?? 0} updated, ` +
                `${data.skipped ?? 0} skipped, ${data.errors ?? 0} error(s). ` +
                "Use Sync Now below to write them into the sheet.",
            });
          }}
        >
          <RefreshCw className="h-4 w-4" />
          {pending === "import" ? "Importing…" : "Import orders only"}
        </Button>

        <ButtonLink href="/field-mapping">Configure Mapping</ButtonLink>
      </div>

      {!ebayConnected ? (
        <p className="text-sm text-muted-foreground">
          Connect eBay before syncing — there is nothing to import yet.
        </p>
      ) : null}

      <FeedbackBanner feedback={feedback} />
    </div>
  );
}
