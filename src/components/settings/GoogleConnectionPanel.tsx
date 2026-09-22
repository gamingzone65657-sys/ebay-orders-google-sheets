"use client";

import { useState } from "react";
import { ExternalLink, Plug, Unplug } from "lucide-react";

import { FeedbackBanner } from "@/components/FeedbackBanner";
import { Button } from "@/components/ui/Button";
import { useApiAction } from "@/components/useApiAction";

export function GoogleConnectionPanel({
  configured,
  missingVars,
  status,
  redirectUri,
  returnTo = "/google-sheet",
}: {
  configured: boolean;
  missingVars: string[];
  status: string;
  /** Shown so it can be pasted into the Cloud console verbatim. */
  redirectUri: string;
  returnTo?: string;
}) {
  const { run, pending, feedback } = useApiAction();
  const [navigating, setNavigating] = useState(false);

  const connected = status !== "DISCONNECTED";
  const isLive = status === "CONNECTED" || status === "EXPIRED";
  const busy = pending !== null || navigating;

  // Consent has to be a full-page navigation: the user signs in on Google's
  // own domain, and an XHR would be blocked.
  const startOauth = () => {
    setNavigating(true);
    window.location.href = `/api/auth/google/start?returnTo=${encodeURIComponent(
      returnTo,
    )}`;
  };

  return (
    <div className="space-y-4">
      {!configured ? (
        <div className="rounded-md border border-warning-border bg-warning-bg px-4 py-3 text-sm text-warning">
          <p className="font-medium">Google credentials are not configured</p>
          <p className="mt-1">
            Set{" "}
            <code className="rounded bg-foreground/10 px-1 py-0.5 font-mono text-xs">
              {missingVars.join(", ")}
            </code>{" "}
            in <code className="font-mono text-xs">.env</code> and restart. In
            the Google Cloud console create an{" "}
            <strong>OAuth client ID</strong> of type{" "}
            <strong>Web application</strong>, enable the{" "}
            <strong>Google Sheets API</strong> and{" "}
            <strong>Google Drive API</strong>, and add this exact authorized
            redirect URI:
          </p>
          <code className="mt-2 block rounded bg-foreground/10 px-2 py-1 font-mono text-xs break-all">
            {redirectUri}
          </code>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {configured ? (
          <Button variant="primary" onClick={startOauth} disabled={busy}>
            <Plug className="h-4 w-4" />
            {navigating
              ? "Redirecting to Google…"
              : isLive
                ? "Reconnect Google"
                : "Connect Google"}
            <ExternalLink className="h-3.5 w-3.5 opacity-70" />
          </Button>
        ) : null}

        {connected ? (
          <Button
            variant="danger"
            disabled={busy}
            onClick={() =>
              run(
                "disconnect",
                {
                  url: "/api/connections/google",
                  body: { action: "disconnect" },
                },
                {
                  successMessage:
                    "Google disconnected and stored tokens deleted.",
                },
              )
            }
          >
            <Unplug className="h-4 w-4" />
            {pending === "disconnect" ? "Disconnecting…" : "Disconnect Google"}
          </Button>
        ) : null}


      </div>


      {configured ? (
        <p className="text-xs text-muted-foreground">
          Connecting opens Google&apos;s own sign-in and consent screen. This
          application never sees your Google password, and both tokens are
          encrypted before they are stored. Disconnecting also revokes the
          grant at Google.
        </p>
      ) : null}

      <FeedbackBanner feedback={feedback} />
    </div>
  );
}
